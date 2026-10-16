# VERDICT: PASS-WITH-NITS

T10 review — S9 (stale-map pruning + parked-dialog release) and S10 (WS
`maxPayload` + `bufferedAmount` backpressure). Reviewed diff:
`git diff 023f8a8afae1a767ab19ccdedace0de92ccb60c9` + untracked files.
Working tree: only `tau-web/extensions/mirror-server.ts` modified (+145/−11) and
`tau-web/docs/review-loop/coder-comments10.md` untracked. No product code was edited by
this review.

The diff does what the task asked: it prunes `loginFailures` / `apiAccessLog` on access
with TTL + cap, releases parked headless and hub-relayed dialogs when the last
browser/mirror goes away (sending `cancelled` so the child/poller wakes), constructs the
`WebSocketServer` with a 2 MiB `maxPayload`, and skips `sendTo`/`broadcast` for clients
whose `bufferedAmount` exceeds 16 MiB. All 16 stubbed e2e tests pass, and I independently
exercised the changed code against **real** hub/mirror/headless processes (the e2e suite
runs against `tests/hub-stub.mjs`, so it does not exercise this diff by itself).

## Evidence

### 1. Project suite — exact result

```
$ node tests/run.mjs
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (30ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (5977ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3558ms) late session_file pins #session + tab
  PASS H4 (3497ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18085ms) no-ack backend shows exact 15s timeout message
  PASS H6 (5ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1512ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3278ms) Live section lists the running TUI with Drive controls
  PASS H9 (3178ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4582ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1275ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1281ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3511ms) uplink relay frames answered, dead frames silent
  PASS D5 (3072ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (509ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

Real-hub headless smoke (the coder's claimed probe, re-run):

```
$ TEST_REAL_HUB=1 node tests/run.mjs --filter H6
tau-web e2e: H6 (real hub)
  PASS H6 (3757ms) start_session + prompt HEADLESS-OK round-trip

1/1 passed
```

Note: `D1` runs against `tests/hub-stub.mjs` and is therefore a regression gate only, not
evidence about `mirror-server.ts`. The load-bearing evidence for this diff is §3.

### 2. Deep UI pass (optional, run because it was available)

```
$ TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui ... ~/.local/share/uv/tools/playwright/bin/python scripts/review-loop/deep_ui.py
EXIT=0, steps: 19
{"errors": [], "pageerrors": [], ... "metrics": {..., "pageerrors": 0, ...}, "elapsed_s": 53.4}
```

Real hub (`pi -e <repo> --mode rpc`), real headless child, real prompts/reload/login/mobile.
`pageerrors: 0`; the 401 console lines are the expected pre-login probes. I inspected two
screenshots: `02-new-session.png` (new tab, HEADLESS RUNNER state, composer/model/thinking
controls intact) and `99-final-desktop.png` (user + assistant "PONG" bubbles, tabs, status).
No UI/UX regression.

The script's `/model` dialog probe did **not** produce a dialog (`dialog-probe {got:False}`),
so it gives no dialog evidence in this pi version; I built the dedicated harness in §3.

### 3. Independent real-hub probes (scratch files in `/tmp/t10-review/`, not checked in)

All probes boot the actual extension (`pi -e <repo> --mode rpc` via
`tests/hub-real.mjs`), with a per-run `TAU_HUB_SOCKET`.

**(a) S9 headless mid-dialog release (the acceptance criterion).**
A scratch child extension (injected through `TAU_PI_BIN` wrapper so every headless child
loads it) calls `ctx.ui.confirm(...)` 3 s after `session_start` and writes the resolved
answer to a file. A raw WS client starts a session, receives the dialog, then closes.

```
child_started_file: true
dialog_received: 04e9af4d-... confirm T10 dialog
RESULT: PASS — dialog released on browser disconnect: answer=false
hub_health_after_disconnect: 200
```

`answer=false` means the hub sent `extension_ui_response {cancelled:true}` to the parked
child (`cancelHeadlessDialog` + `releaseHeadlessDialogsForBrowser`); the child was not left
parked and the dialog cancelled cleanly (pi maps cancelled confirm → false).

**(b) S9 hub↔mirror mid-dialog release (`releaseHubDialogsForMirror`).**
A real mirror TUI (`pi -e <repo> -e mirror-ext.ts --mode rpc`, `TAU_ROLE=mirror`) dials a
real hub over a private socket; the mirror extension raises `ctx.ui.confirm` 6 s in. A raw
WS client attaches via `uplink_attach`, receives the relayed dialog, then closes.

```
mirror_started: true
mirror_listed_pid: 90854
dialog_received: mvbjjrk3-i2i7h9sg T10 mirror dialog
RESULT: PASS — mirror dialog released on browser disconnect: answer=false
hub_health_after_disconnect: 200
mirror_alive: true
```

The mirror's `wrapUiDialogs` poller resolved because the hub sent
`dialog_relay {cancelled:true}` when no driver was left (mirror stayed alive; no infinite park).

**(c) S9 prune logic — executed verbatim source, not a hand-typed replica.**
`awk` extracted the exact `LOGIN_FAIL_WINDOW_MS`…`pruneLoginFailures` region and the
`apiAccessLog`…`pruneApiAccessLog` region from `extensions/mirror-server.ts` into a Node 26
type-stripped scratch file, then asserted:

```
login: stale pruned, fresh kept, size 1000
apiAccessLog: stale pruned, fresh kept, size 1000
S9-PRUNE-PASS
```

Wiring by inspection: `pruneLoginFailures` is called in `recordBasicFailure()` (line 147)
and the `/api/login` failure path (line 1995), immediately before every
`loginFailures.get/set`; `pruneApiAccessLog` is called in the only `apiAccessLog` writer
(the `/api/*` throttle, line 1800) before its `get/set`. Success paths still delete
(`clearBasicFailures`, login success at 1978). Caps 1000/1000 and windows 10 min/1 h match
the task's "e.g." and are enforced oldest-first.

**(d) S10 `maxPayload` against the real hub.**

```
small_frame_pong: true
900KiB_socket_still_open: true
frame_bytes: 3145752
big_frame_close: {"code":1009,"reason":""}
hub_health_after_big_frame: 200 fresh_client_pong: true
RESULT: PASS
```

A 3 MiB client frame is rejected by `ws` (close 1009) without crashing the hub; <1 MiB
frames and a fresh client still flow. `wss = new WebSocketServer({noServer:true,
maxPayload: 2*1024*1024})` plus a non-throwing `error` logger verified at lines 3316-3319.

**(e) S10 `bufferedAmount` skip against the real hub.**
A headless child extension fires 800 × 64 KiB `setStatus` events (~50 MiB) at a browser
whose TCP socket is paused, then resumed:

```
client_paused: sent_by_child=800 received_by_client=295 hub_health=200
RESULT: PASS (guard skipped frames once bufferedAmount exceeded the cap)
```

295 × 64 KiB ≈ 18.4 MiB received — consistent with the 16 MiB cap plus socket/kernel
buffers — so ~505 frames were skipped instead of queued; hub memory is bounded. `ws`'s
`bufferedAmount` getter is `socket._writableState.length + sender._bufferedBytes`
(verified in `node_modules/ws/lib/websocket.js`), so the guard measures real queued bytes.
Heartbeat is untouched (`client.ping()` direct, not `sendTo`); message shapes unchanged.

### 4. Code paths inspected (actual file, not the coder's summary)

- `pruneLoginFailures`/`pruneApiAccessLog` definitions + caps (lines 98-123, 164-176) and
  all three call sites (147, 1800, 1995); old call sites unchanged semantically.
- `cancelHeadlessDialog`/`releaseHeadlessDialogsForBrowser`/`releaseHubDialogsForMirror`/
  `releaseDialogsForBrowser`/`releaseDialogsForMirror` (1139-1188), `onGone` hook (1054-1067),
  `handleMirrorFrame` dialog registration (1074-1103), `handleHubCommand` `dialog_relay`
  guard (1247-1253), `extension_ui_response` handling (1385-1410), `wrapUiDialogs`
  no-channels cleanup (691-698).
- All three disconnect paths now capture `subBefore` first, then
  `clients.delete` + `headless.detach` + `hubDetachUplink` + `releaseDialogsForBrowser`:
  `ws.on("close")` (3380-3392), `ws.on("error")` (3394-3401), heartbeat non-OPEN and
  dead-socket branches (3405-3424).
- `isWsBackpressured` + `sendTo`/`broadcast` guards (754-778), `maxPayload` (3316).
- `headless.detach` is unbind-only and idempotent (`extensions/headless-bridge.ts:367-377`),
  and `managed.rpc.send` is the same channel the pre-existing answer path uses, so the
  cancel payload shape is consistent.
- `HubSocketServer.unregister` → `onGone(rec)` fires once per mirror (`lib/hub-socket.ts:256-261`).
- pi's rpc mode ignores `extension_ui_response` for unknown ids
  (`dist/modes/rpc/rpc-mode.js:616-624`), so cancelling fire-and-forget ids is harmless.

### 5. Regression checks

- Dialog relay: verified end-to-end both ways (§3a, §3b) and by the deep-UI pass.
- Normal streaming/commands: H1-H13, D1, D5, P2 all pass; real-hub H6 round-trip passes.
- Kill flows: H10 (real scan/kill) passes; `onGone` only deletes dialog bookkeeping and
  does not touch process teardown; heartbeat `terminate()` path unchanged apart from the
  extra detach/cleanup.
- Auth/backoff: D5 passes; prune calls are additive and preserve the 10 s throttle and
  failure/decay semantics (§3c).
- Working tree: `git status --porcelain` after review shows only the coder's
  `tau-web/extensions/mirror-server.ts` and `coder-comments10.md`; no reviewer edits.
- No `tsconfig*.json` exists in the package (and no local TypeScript), so `npx tsc --noEmit`
  is unavailable; the runtime probes + suite were the compile/runtime gate.

## Issues

### Blocking

None.

### Nits (non-blocking, pick up later)

1. **`extensions/mirror-server.ts` ~605-615 — fire-and-forget requests still fill
   `pendingDialogs` while a browser stays connected.** `HeadlessRegistry.onEvent` stores
   *every* `extension_ui_request` (including `notify`/`setStatus`, which never get a
   response) as a pending dialog. T10 strictly improves this — a browser disconnect now
   sweeps them (`cancelHeadlessDialog`) — but on a long-lived connected tab the map still
   grows one entry per status update. A follow-up could gate the `pendingDialogs.set` on
   dialog methods (`select|confirm|input|editor`). Pre-existing, bounded per event, no
   functional impact.
2. **`extensions/mirror-server.ts` ~1139-1188 — same "parked forever" class, tiny race.**
   `releaseHeadlessDialogsForBrowser` only runs from browser-disconnect/heartbeat paths.
   If a child raises a dialog in the instant after the last browser's `detach` sweep, the
   entry is created with `managed.clients.size === 0` and nothing later sweeps it (the child
   parks until pi's own dialog timeout, if any). Cancelling in `onEvent` when
   `managed.clients.size === 0` would close it. Also note `releaseHubDialogsForMirror`
   keeps entries when any driver remains (even one that attached after the dialog was
   raised), and a browser that `uplink_detach`es then closes has no `subBefore.mirrorId`,
   so its former mirror's entries are only reclaimed on mirror disconnect/next driver
   close. The coder documented the tradeoff; all of this is bounded by mirror lifetime.
   Not the stated scenario (disconnect mid-dialog is covered).
3. **`docs/review-loop/coder-comments10.md` §2 wording.** "Real-hub contract (D1 dialog-relay
   behavior included in the 16/16 above)" is misleading: D1 runs against the stub hub and
   does not exercise this diff. The actual real-hub verification was the coder's ephemeral
   scratch checks (not checked in) and the probes above. Doc-only.
4. **Observation, not a defect:** a single inbound frame >2 MiB (e.g. an enormous paste)
   now closes the browser socket with 1009 and no dedicated UI message; this is within the
   task's "e.g. 2 MiB" spec but worth remembering if very large prompts are ever a use case.

VERDICT: PASS-WITH-NITS
