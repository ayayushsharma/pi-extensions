# Coder comments — T2 (B3 spawn-failure zombie + S2 child env leak), round 1

## 1. What changed

Two files, no new dependencies, no protocol change, no change to the
one-backend-per-session model or to normal spawn/switch/kill behavior.

### `extensions/headless-bridge.ts` — `RpcSession` + new helpers

**S2 — child env scrub (`RpcSession` spawn `env:` path):**
- Before: `env: { ...process.env, TAU_DISABLED: "1", ...(opts.env || {}) }` —
  headless children inherited `TAU_USER`/`TAU_PASS` (and any `TAU_AUTH_*`),
  readable via the child's bash tool (`printenv`).
- After: new exported `buildHeadlessChildEnv(extra?)` builds
  `{ ...process.env, ...(extra||{}) }`, deletes `TAU_USER`, `TAU_PASS`,
  and every key `=== "TAU_AUTH"` or starting with `"TAU_AUTH_"`, then forces
  `TAU_DISABLED = "1"`. `RpcSession` spawns with
  `env: buildHeadlessChildEnv(opts.env)`, so explicit `opts.env` secrets are
  scrubbed too and `TAU_DISABLED=1` plus all non-auth vars (`PATH`, `HOME`,
  `TAU_PROJECTS_DIR`, …) are kept.

**B3a — cwd validation (`RpcSession` constructor entry):**
- Before: no validation; `spawn(piBin, …, { cwd: "/nonexistent-cwd-xyz" })`
  fails async and the `ManagedHeadless` was already registered.
- After: new exported `assertValidHeadlessCwd(cwd)` (`statSync` exists + is a
  directory, throws `invalid cwd "<cwd>": …` otherwise), called first in the
  `RpcSession` constructor before `spawn`. A throw aborts
  `HeadlessRegistry.create` before `sessions.set`, so no `ManagedHeadless` is
  ever registered for a bad cwd. Rejoin-by-`sessionKey` is untouched (only the
  create path validates), so normal reload rejoin still works.

**B3b — terminal exit handling (`RpcSession` `proc.on(...)` wiring):**
- Before: only `proc.on("error", …onError)` + `proc.on("exit", …onExit)`.
  Spawn failure emits `error` then `close` and never `exit`, so `onExit`
  never fired and the dead entry stayed in the registry (`start_session`
  kept acking success, `send` no-oped on unwritable stdin).
- After: `settled`/`done(code)` guard calls `opts.onExit` exactly once across
  all three events: `error → onError(msg) + done(null)`,
  `close → done(code)`, `exit → done(code)` (exit behavior unchanged).
  Normal exit (`exit` then `close`) reports once; spawn failure
  (`error` then `close`) reports once with `null`. The registry's existing
  `onExit` then deletes the entry, clears `socketBinding`, and fans out
  `session_ended` — so `list_sessions` / `statusFor` go clean and later
  `command()` returns `no active session` instead of silent `ok`.

### `extensions/mirror-server.ts` — `handleCommand` `start_session` / `new_session`

- Before: `const managed = headless.attach(...)` / `headless.newSession(...)`
  then unconditional `success: true` ack — even when the cwd was invalid.
- After: both calls are wrapped in `try/catch`; on throw the handler replies
  `{ type: "rpc_event", event: { type: "response", command, success: false,
  error: e?.message || "invalid cwd" }, id }` and returns without binding.
  The outer `try/catch` (`{ type: "error" }`) is untouched; valid-cwd flow,
  `switchToFile` skip logic, and all other commands are unchanged.

## 2. How it was verified

- Raw Node spawn semantics (confirms the B3 premise):
  `spawn("pi", ["--mode","rpc"], { cwd: "/nonexistent-cwd-xyz" })` →
  `error event: spawn pi ENOENT`, `close event code= -2`, never `exit`.
  `FINAL sawError=true sawClose=true sawExit=false`. Same with absolute
  `~/.pi/agent/bin/pi` + bad cwd. — OK
- Idempotency probe (same `settled`/`done` shape as the implementation,
  bad binary + `/tmp` cwd): `calls=1 codes=[null] sawError=true
  sawClose=true sawExit=false` → `IDEMPOTENT-OK`. — OK
- Real-hub bad-cwd acceptance (real `pi` hub via `bootRealHub`, WS `rpc`
  helper):
  `start_session { cwd: "/nonexistent-cwd-xyz" }` →
  `{"type":"response","command":"start_session","success":false,
  "error":"invalid cwd \"/nonexistent-cwd-xyz\": does not exist or is not accessible"}`;
  `list_sessions` → `[]`; `GET /api/headless/status?cwd=…&file=x.jsonl` →
  `{"isActive":false,"isWorking":false}`; retry with
  `sessionKey="/nonexistent-cwd-xyz::new-fake"` → same `success:false`. — OK
- File-as-cwd: `start_session { cwd: "/tmp/tau-cwd-file-<pid>.txt" }` →
  `success:false, error: "... not a directory"`; `list_sessions` → `[]`. — OK
- S2 stub-binary env test (hub env has `TAU_USER=secret-user`,
  `TAU_PASS=secret-pass`, `TAU_AUTH_TOKEN=secret-token`; `PI_WEB_PI_BIN` =
  stub that runs `env > dump` then idles): child dump shows
  `TAU_USER in child? false`, `TAU_PASS in child? false`,
  `TAU_AUTH_TOKEN in child? false`, `TAU_DISABLED=1`, `PATH`/`HOME` kept. — OK
- Bad-binary async cleanup (hub with `PI_WEB_PI_BIN=/nonexistent-pi-binary-xyz`,
  valid `/tmp` cwd): first `start_session` acks `success:true` (sync, cwd
  valid), after 1.5 s `list_sessions` → `[]`, `/api/headless/status` →
  `{"isActive":false,"isWorking":false}`, `session_ended` observed exactly
  once. No permanent zombie. — OK
- `node tests/run.mjs` (stub hub, default matrix) → exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (38ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6016ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3535ms) late session_file pins #session + tab
  PASS H4 (3520ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18078ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1510ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3477ms) Live section lists the running TUI with Drive controls
  PASS H9 (3174ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4689ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1875ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1276ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3512ms) uplink relay frames answered, dead frames silent
  PASS D5 (3792ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

- `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` (real `pi` binary at
  `~/.pi/agent/bin/pi` available) → `1/1 passed`
  (`PASS H6 (3271ms) start_session + prompt HEADLESS-OK round-trip`). — OK
- `TEST_REAL_HUB=1 node tests/run.mjs --filter H6,H10,H11` → `3/3 passed`
  (`H6` 4858 ms, `H10` 1447 ms, `H11` 2189 ms). Normal spawn/switch/kill and
  the H11 no-re-switch invariant are intact. — OK

## 3. Double-checks and residual risk

- Env denylist is `TAU_USER`, `TAU_PASS`, `TAU_AUTH`/`TAU_AUTH_*`. If a future
  auth secret uses a different `TAU_*` name (e.g. `TAU_TOKEN`), it would not
  be stripped — reviewer should confirm the denylist matches every current
  and planned `TAU_*` credential. I deliberately did not strip all `TAU_*`
  because non-auth vars (`TAU_PROJECTS_DIR`, `TAU_ALLOWED_HOSTS`, …) must be
  kept per the task.
- Bad-binary (valid cwd, missing `pi`) still acks `success:true`
  synchronously and cleans up ~immediately after (`session_ended` once, no
  zombie). Only the bad-cwd path fails the ack synchronously, per the task.
  A reviewer wanting sync rejection for bad binaries would need a `piBin`
  existence check — explicitly out of scope here.
- `assertValidHeadlessCwd` uses `statSync` (follows symlinks). A symlinked
  cwd pointing at a directory passes; a dangling symlink fails with
  "does not exist". TOCTOU (deleted between check and `spawn`) falls back to
  the async `error`/`close` cleanup path — still no zombie.
- `new_session` got the same honest-`success:false` treatment as
  `start_session` for consistency; the task only names `start_session`, but
  leaving `/new` on the old unconditional-ack path would have kept one
  zombie route open.

## 4. Retry round

Not a retry — first coder pass for T2. No prior reviewer comments to address.
