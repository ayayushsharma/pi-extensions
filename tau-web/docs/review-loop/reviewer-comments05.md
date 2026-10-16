# Reviewer comments — T5 (B8 duplicate function declarations + B9 hub.sock start/stop lifecycle)

VERDICT: PASS-WITH-NITS

## 1. What was actually reviewed

- `git status --porcelain` → exactly the two expected product files modified,
  plus untracked `tau-web/docs/review-loop/coder-comments05.md`. Nothing under
  `public/`, `tests/`, or any other package touched → **no UI change**, as the
  task requires.
- `git diff a5987f82e8ee04c69f2e4ddaf080f854e23bf974 -- extensions/mirror-server.ts`
  → **0 insertions / 24 deletions**, a single contiguous deletion.
- `git diff a5987f82e8ee04c69f2e4ddaf080f854e23bf974 -- extensions/lib/hub-socket.ts`
  → +147/-10, entirely inside `HubSocketServer` plus three module-private
  helpers (`probeSocketLive`, `isOurSocket`, `removeIfOurs`). `HubSocketClient`
  and the frame/line-reader code are untouched → **no protocol change**.

### B8 verification (not trusting the coder's grep)

- Baseline `mirror-server.ts` contains **6** declarations of the three
  functions (`grep -c` = 6); current contains **3** (one each at :811, :820,
  :823).
- Reviewer-extracted the function block from both revisions:
  `baseline blocks: 2 current blocks: 1`, `baseline copies identical: True`,
  `kept copy == baseline copy: True`. So the surviving copy is byte-identical
  to both deleted originals — pure deletion, no semantic drift.
- All call sites (`resolveHeadlessSessionPath` :1072, `lossyDecodeSessionDir`
  :2525/:2630/:2879, `cwdToSessionDir` :2549) resolve to the kept copy.

### B9 verification (code paths read end-to-end)

- `start()` now probes an existing path with a 500 ms connect: success ⇒
  `onError("refusing to steal it")` + `false`, no unlink; fast failure ⇒ stale
  file unlinked and bound; hang ⇒ treated live (safe direction).
- `boundSocket` (`{path, dev, ino}`) is captured in the `listen` callback;
  `stop()` calls `server.close()` **only** while `isOurSocket()` still holds,
  and `removeIfOurs()` re-checks the inode before `unlinkSync`. Refused/failed
  starts leave `boundSocket == null` and delete nothing.
- `startGen` cancels an in-flight `start()` after `stop()`; teardown then
  closes/unlinks only what is still ours, else `unref()`s.
- **Independent reproduction of the pivotal Node claim:** a plain `net` test
  (bind A → unlink A's path → bind C on the same path → `A.close()`) showed
  `after OLD server.close(): newer file exists: false`. `server.close()` really
  does unlink whatever currently sits at the path, so the new "never `close()`
  a superseded listener" guard is necessary, not over-engineering.

## 2. Evidence (commands + results)

### 2.1 Project test suite (required)

`node tests/run.mjs`:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (35ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6014ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3712ms) late session_file pins #session + tab
  PASS H4 (3816ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18061ms) no-ack backend shows exact 15s timeout message
  PASS H6 (7ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1513ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3070ms) Live section lists the running TUI with Drive controls
  PASS H9 (3123ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4495ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1275ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1288ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3509ms) uplink relay frames answered, dead frames silent
  PASS D5 (3367ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (516ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
EXIT=0
```

### 2.2 Reviewer-authored B9 contract probe (`/tmp/review-t5-probe.cjs`, not the coder's script)

Loads the real TS through pi's jiti with an isolated `TAU_HUB_SOCKET`;
exercises exactly the acceptance criteria plus edges. Result:

```text
ok  1-9   two sequential start/stop cycles (same instance); file exists,
          mode 0600, dir 0700, answers dial, removed on stop
ok 10-12  stale regular file reclaimed, answers, removed on stop
ok 13-19  live hub: second start -> false, inode unchanged, live still
          answers, refusal logged via onError, refused hub's stop() is a
          no-op and live still answers
ok 20     hello after normal flow registers exactly one mirror
ok 21     live hub removes own socket on stop
ok 22-27  takeover (path replaced while old hub still holds its listener):
          new hub binds a new inode; old stop() leaves the new file and it
          still serves; new stop() removes its own file
ok 28-30  concurrent double start() on one instance -> (true,true), one
          listener, stop removes the socket
ok 31-33  refused retry after the first hub stops succeeds

probe result: 33 passed, 0 failed
EXIT=0
```

### 2.3 Failure-path probe (`/tmp/rev-t5-edge.cjs`)

- Socket path > sockaddr_un limit → `start()` resolves `false` with
  `listen EINVAL …` via `onError`; `stop()` after the failed start is a no-op
  and does not throw.
- `mkdirSync` failure (parent component is a regular file) → resolves `false`
  via `onError`.
- Hence the floated `hubSockets.start()` in `mirror-server.ts:893` cannot
  produce an unhandled rejection on any path I could exercise (probe, mkdir,
  synchronous/async listen failure all resolve `false`; `probeSocketLive` never
  rejects). **The `start(): void → Promise<boolean>` signature change is
  accepted.**

### 2.4 Stock deep-UI pass (real hub, real headless pi, Playwright)

`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui TAU_REVIEW_REPO=... deep_ui.py`
(uv Playwright python, 19 steps, 52.4 s, exit 0):

- `errors: []`, `pageerrors: []`, `requestfailed: []`; only expected
  pre-login 401 console noise.
- Hub booted cleanly on `:47867` (real `HubSocketServer.start()` on the
  default `~/.pi/tau/hub.sock`), three pre-existing live TUIs dialed in and
  registered (`[Hub] mirror connected pid=…`), PONG round-trip completed,
  reload-rejoin kept the same hash, live preview + Drive/Cancel banner
  rendered, logout/login round-trip OK, mobile: no horizontal overflow, no
  pageerrors.
- After the run `~/.pi/tau/` contains no `hub.sock` → the real stop() path
  cleaned up its own socket (no stale file left behind).
- Screenshots inspected: `04-after-reply-full.png` (chat render, usage chip,
  toolbar) — normal; `11b-live-preview.png` (live TUI banner, Drive/Cancel,
  live transcript) — normal. No visual regression.

## 3. Regression checks

- **B8:** only a duplicate block was deleted (python equality proof above);
  kept declarations precede every call site; no rename/semantic change.
- **B9 clean single-hub path:** unchanged externally — start binds, 0600 file
  in 0700 dir, dial/hello/stop all behave as before (probe §2.2, suite H1–H13,
  deep-UI real hub).
- **Protocol:** `HubSocketClient`, frame parsing, hello/status/event/response
  handling untouched; mirror registration after a refused probe still works
  (probe ok 20).
- **No UI change:** diff scope is two `.ts` files; `public/` untouched
  (`git status`); deep-UI pageerrors 0.
- **Caller compatibility:** the only `HubSocketServer` consumer floats
  `start()`; every failure path resolves `false` (probe §2.3). `stop()` stays
  synchronous and idempotent.
- **The core Node assumption was independently reproduced** (§1), so the
  "skip `close()` on a superseded listener" branch is justified rather than
  speculative.

## 4. Issues

### Blocking

None.

### Nits (non-blocking, no action required for T5)

1. **`extensions/mirror-server.ts:893` — add `void` to the floating call.**
   `hubSockets.start()` now intentionally returns a promise; prefixing `void`
   (or `.catch(() => {})`) documents the fire-and-forget intent and keeps a
   future `no-floating-promises` lint quiet. Behavior verified identical; style
   only.
2. **`extensions/lib/hub-socket.ts:305-309` — orphaned listener fd on
   takeover.** After a superseded `stop()`, the old listener is `unref()`ed but
   never `close()`d (one fd per takeover until process exit). This is the
   correct trade under the current bind-in-place design because `close()`
   unlinks the path (independently reproduced). If fd accumulation ever
   matters for a long-lived hub under repeated external interference, a
   `bind temp path → linkSync(temp, path)` (EEXIST-aware) design would make
   ownership unambiguous and allow a real close; not needed now.

No functional or UX regression found; both items are optional follow-ups.

## 5. Acceptance criteria

| Criterion | Result |
|---|---|
| Exactly one declaration of each removed function | ✅ grep 3/3; python equality |
| Two sequential start/stop cycles work | ✅ probe ok 1–9 (same + new instance) |
| start() on a live listener does not unlink/steal it | ✅ probe ok 13–19 (inode unchanged, still serving) |
| stop() after another hub took the path does not remove its socket | ✅ probe ok 22–27 (new hub still serving/cleaned by its own stop) |
| `node tests/run.mjs` 16/16 | ✅ exact output in §2.1 |

VERDICT: PASS-WITH-NITS
