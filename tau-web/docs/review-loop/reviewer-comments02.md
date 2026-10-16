# VERDICT: PASS-WITH-NITS

Task **T2 — Harden headless children: no zombie binding on spawn failure, no inherited hub credentials**.
Baseline `10be42777f74ca9ef86b2cba5df480c90948d6f0`; reviewed working tree
(`tau-web/extensions/headless-bridge.ts`, `tau-web/extensions/mirror-server.ts`
+ `docs/review-loop/coder-comments02.md`). No product code was edited during
review; all scratch probes live in `/tmp`.

## 1. Evidence — commands and results

### Scope / diff inspected
- `git status --porcelain`: only `M tau-web/extensions/headless-bridge.ts`,
  `M tau-web/extensions/mirror-server.ts`, untracked
  `?? tau-web/docs/review-loop/coder-comments02.md`. 54 insertions, 5 deletions;
  no other package touched.
- `git diff 10be427 --stat` + full diff read. `git diff --check` clean.
- Code paths read end-to-end: `RpcSession` ctor / event wiring / `send` / `kill`,
  `buildHeadlessChildEnv`, `assertValidHeadlessCwd`, `HeadlessRegistry.attach /
  newSession / create / statusFor / listSessions / retire`, the
  `start_session` / `new_session` / `rpc_command` cases and outer catch in
  `mirror-server.ts`, the `HeadlessRegistry` hooks (onError/onExit →
  `session_ended`), the `/api/headless/status` handler, and the frontend
  consumers (`public/app.js` `bindHeadless`/`applyFreshSession`/`routeCommand`,
  `public/websocket-client.js` rpcResponse routing, `public/session-actions.js`).
- All spawn sites in the package enumerated
  (`grep -n "spawn(" extensions/**`): only `RpcSession` spawns a long-lived
  agent child; the two `execFileSync(pi --export)` calls are one-shot, not
  prompt-injectable agents, and are outside the S2 finding.

### Project tests (required)
`node tests/run.mjs` →
```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (35ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6028ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (4602ms) late session_file pins #session + tab
  PASS H4 (3527ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (19131ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1512ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3347ms) Live section lists the running TUI with Drive controls
  PASS H9 (3168ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4719ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1271ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1378ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3513ms) uplink relay frames answered, dead frames silent
  PASS D5 (3345ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```
Note: the stub-hub matrix does **not** execute `headless-bridge.ts` (the stub
answers the WS protocol itself), so the real-hub runs below are the ones that
exercise the changed code.

### Real-hub round-trip / regression cases (`~/.pi/agent/bin/pi` available)
- `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` → `1/1 passed`
  (`PASS H6 (4259ms) start_session + prompt HEADLESS-OK round-trip`).
- `TEST_REAL_HUB=1 node tests/run.mjs --filter H10,H11` → `2/2 passed`
  (`PASS H10 (1455ms) live pi processes list + kill`, `PASS H11 (2201ms)
  session rejoin: no re-switch + running state for the background watch`).
  Normal spawn / switch / kill / rejoin behavior intact.

### Direct module probes via jiti (`/tmp/tau-t2-probe.mjs`)
Raw Node premise and the real module, 29/29 checks PASS:
```text
PASS raw-spawn: error ENOENT — {"error":"ENOENT","close":-2,"exit":null}
PASS raw-spawn: sawClose
PASS raw-spawn: sawExit=false
PASS cwd: nonexistent throws — invalid cwd "/nonexistent-cwd-xyz": does not exist or is not accessible
PASS cwd: file throws not-a-directory / tmpdir accepted / trailing slash accepted
PASS env: TAU_USER / TAU_PASS / TAU_AUTH / TAU_AUTH_TOKEN / TAU_AUTH_EXTRA stripped (base + explicit extra)
PASS env: TAU_PROJECTS_DIR, KEEPME, PATH, HOME kept; TAU_DISABLED=1
PASS env: remaining TAU_* == TAU_DISABLED,TAU_PROJECTS_DIR only
PASS RpcSession: bad cwd throws sync, zero callbacks (nothing spawned)
PASS RpcSession: bad binary onError + onExit exactly once with code null
PASS RpcSession: normal kill → onExit exactly once
PASS child env dump: no TAU_USER/TAU_PASS/TAU_AUTH_TOKEN, TAU_DISABLED=1

29/29 probe checks passed
```

### Real-hub acceptance probe (`/tmp/tau-t2-hub-probe.mjs`, real hub + stub `PI_WEB_PI_BIN`)
```text
PASS bad cwd: success:false — {"command":"start_session","success":false,"error":"invalid cwd \"/nonexistent-cwd-xyz\": does not exist or is not accessible"}
PASS bad cwd: clear error
PASS bad cwd: list_sessions empty — {"sessions":[]}
PASS bad cwd: status not active — {"isActive":false,"isWorking":false}
PASS bad cwd retry (same key): success:false
PASS bad cwd new_session: success:false
PASS good cwd: success:true / sessionKey present / list_sessions has 1 / status active
PASS child env: no TAU_USER, no TAU_PASS, no TAU_AUTH_TOKEN; PATH/HOME kept
PASS close_session ok; after close list_sessions empty; no stray session_ended on bad-cwd paths

19/19 hub checks passed
```

### Real-hub terminal-event cleanup (`/tmp/tau-t2-hub-probe2.mjs`)
```text
PASS bad-binary: ack=true (valid cwd, async failure) / registry clean after exit / session_ended exactly once / status false
PASS fast-exit: ack=true / registry clean after exit / session_ended exactly once / status false

8/8 hub checks passed
```
This is the B3 zombie scenario: a dead child no longer stays in the registry,
`list_sessions` / `/api/headless/status` go clean, and `session_ended` fires
exactly once (error → close; no `exit`).

### Real-browser deep-UI pass (Playwright available)
`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui TAU_REVIEW_REPO=<repo>
~/.local/share/uv/tools/playwright/bin/python scripts/review-loop/deep_ui.py` →
exit 0, `"errors": []`, `"pageerrors": []` (0 page errors), 19 steps incl.
login, new session, model menu, prompt round-trip (`PONG`), reload-rejoin,
files, live preview, logout/login, mobile. Inspected 2 screenshots
(`02-new-session.png`, `04-after-reply-full.png`): chat rendering and input
unchanged. The red `Failed to switch session: Not found` visible there is the
pre-existing **B4 / task T3** finding (`docs/code-review.md:34`, T3 in
`scripts/review-loop/tasks.json`), on the unrelated `/api/sessions/switch`
path — not a T2 regression.

## 2. What was verified

- **B3 (cwd) fixed**: `assertValidHeadlessCwd()` runs as the first statement of
  the `RpcSession` ctor, i.e. before `spawn` and before `HeadlessRegistry.create`
  reaches `sessions.set`. `attach`/`newSession` propagate the throw before they
  detach/rebind, so no `ManagedHeadless` is registered and existing bindings are
  untouched. Both `start_session` and `new_session` catch it and reply
  `success:false` with the clear `invalid cwd …` message (the outer
  `{type:"error"}` catch is not double-fired). Retry with the same
  `sessionKey` re-enters `create` and fails identically.
- **B3 (spawn failure) fixed**: one `settled`/`done(code)` guard across
  `error`, `close`, `exit`; `onExit` fires exactly once (`null` on the error
  path). Normal `exit` behavior is unchanged (exit still reports first, then
  close is a no-op). Verified for ENOENT binary, immediate-exit child, normal
  kill, and both callback ordering variants.
- **S2 fixed**: `buildHeadlessChildEnv()` merges `process.env` + explicit
  `opts.env`, deletes `TAU_USER`, `TAU_PASS`, `TAU_AUTH`, `TAU_AUTH_*`, then
  forces `TAU_DISABLED=1`. Non-auth vars (`PATH`, `HOME`, `TAU_PROJECTS_DIR`)
  survive; no `TAU_*` secret remains in the child dump. The scrub is applied to
  explicit caller env too.
- **Not changed**: one-backend-per-session model (`attach` rejoin by
  `sessionKey` then cwd+file scan is untouched; only `create` validates the
  cwd), WS protocol shape (success acks identical, failure uses the existing
  `success:false` response shape), normal spawn/switch/kill (H6/H10/H11 + probe
  5), and the UI (no frontend files in the diff).

## 3. Issues by severity

**Blocking: none.**

**Nits (non-blocking, optional follow-ups):**
1. `public/app.js` `bindHeadless()` (~2630) and `applyFreshSession()` (~2085)
   treat any non-timeout `start_session`/`new_session` response as success:
   on the new `success:false` reply they set `headlessSessionKey = 'bound'`
   and persist the binding. Nothing crashes and a later prompt surfaces
   `no active session` via `serverError`, but the client could inspect
   `data.success` and show the actual `invalid cwd` message / stay unbound.
   Aligned with T3 (new-session view state); out of T2's "no UI change" scope.
2. The env denylist covers the only credential names present today
   (`TAU_USER`/`TAU_PASS`) plus the specified `TAU_AUTH*`; a future secret under
   a different `TAU_*` name (e.g. `TAU_TOKEN`) would not be stripped without
   extending the list. The task explicitly required deleting the named secrets
   while keeping non-auth `TAU_*` vars, so this is acceptable hardening debt.
3. A **missing/invalid `pi` binary** with a valid cwd still acks
   `success:true` and then cleans up asynchronously via the new `error`/`close`
   path (no zombie, `session_ended` once, registry empty — verified). The task
   only required synchronous rejection for a bad cwd; a pre-flight binary check
   would be an optional follow-up.
4. `this.proc.on("error", …)` wraps `opts.onError` in an empty `catch {}` to
   guarantee `done(null)` runs. Intentional and safe; logging the swallowed
   error would be marginally nicer.

## 4. Required changes next round

None — the findings are fixed and independently verified. The nits above are
optional follow-ups only.

VERDICT: PASS-WITH-NITS
