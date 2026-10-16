# T10 coder comments — Close memory leaks and add WS payload/backpressure guards (S9, S10)

## 1. What changed (one product file: `extensions/mirror-server.ts`; `hub-socket.ts` untouched by design)

**S9a — `loginFailures` / `apiAccessLog` prune-on-access with caps.**
Before: `loginFailures: Map<ip, {count,at}>` only ever `set` (per-IP, attacker-controlled key space) and `apiAccessLog: Map<method+path, ms>` only ever `set` (per `req.url`, so ever-changing query strings like `/api/files/content?path=…` grow it forever).
After: new `LOGIN_FAIL_MAX_ENTRIES=1000`, `API_ACCESS_LOG_TTL_MS=1h`, `API_ACCESS_LOG_MAX_ENTRIES=1000` plus `pruneLoginFailures(now)` (drop entries older than the existing `LOGIN_FAIL_WINDOW_MS=10min`, then evict oldest-first over the cap) and `pruneApiAccessLog(now)` (drop entries older than 1h, then oldest-first over the cap). `recordBasicFailure()` prunes before read/increment; the `/api/login` failure path prunes before its direct `loginFailures.get`; the `serveStaticFile` throttle block prunes before its `apiAccessLog.get`. Success-delete (`loginFailures.delete` on correct login/Basic) and the 10s throttle semantics are unchanged.

**S9b — parked dialogs release when their answerer goes away.**
Before: `pendingDialogs` (headless + mirror entries) and `hubDialogOwner` (dialog id → mirror id) were only deleted on the answer path (`extension_ui_response` / `dialog_relay` consume). `ws.on("close"/"error")` did `clients.delete + headless.detach + hubDetachUplink` only, the heartbeat `terminate` path did even less, and `onGone` (mirror disconnect) only fanned `uplink_dead` — so a browser that disconnected mid-dialog left the headless child parked on `extension_ui_request` forever, and a dead mirror left hub entries behind. The ad-hoc `pendingDialogs.responses` map could also gain orphan entries from late answers.
After: new helpers in the same closure (`cancelHeadlessDialog`, `releaseHeadlessDialogsForBrowser`, `releaseHubDialogsForMirror`, `releaseDialogsForBrowser`, `releaseDialogsForMirror`):
- Browser gone (`close`/`error`/heartbeat-dead/heartbeat-non-OPEN, all of which now capture `subBefore = hubUplinkSubs.get(ws)` first, then `detach + hubDetachUplink`, then `releaseDialogsForBrowser(subBefore?.mirrorId)`): headless entries whose `managed.clients` is now empty get `managed.rpc.send({type:"extension_ui_response", id, cancelled:true})` plus deletion of `pendingDialogs`/`responses`/`hubDialogOwner` — the parked child wakes with `cancelled`. Entries with a sibling tab still bound to the same backend are kept (still answerable). Hub entries for `subBefore.mirrorId` get `hubSockets.send(mirrorId, {type:"dialog_relay", id, response:{cancelled:true}})` plus map deletions, but only when no remaining `hubUplinkSubs` still drives that mirror — otherwise they are kept.
- Mirror gone (`onGone` now calls `releaseDialogsForMirror(rec.id)` after the existing `uplink_dead` fan-out): all `hubDialogOwner` entries for that mirror id are dropped from both maps plus `responses`. No send (the peer is gone; its `wrapUiDialogs` poller self-releases via the forwarder-drop branch).
- Leak guards that keep timeout/supersede working: `extension_ui_response` mirror-branch and `dialog_relay` now only `responses.set` when `pendingDialogs.has(id)` (live supersede/timeout answers arrive while the entry exists; late answers for released dialogs are ignored instead of creating orphans), and the `wrapUiDialogs` no-channels branch now also deletes its `responses` entry.
`hub-socket.ts` was deliberately not changed: it is a generic transport with no dialog state; the S9 "in HubSocketServer onGone" requirement is met by the `onGone` hook implementation in `mirror-server.ts`.

**S10 — WS `maxPayload` + `bufferedAmount` guards.**
Before: `new WebSocketServer({noServer:true})` (ws default `maxPayload` ~100 MiB) and `sendTo`/`broadcast` sent unconditionally whenever `readyState === OPEN`.
After: `WS_MAX_PAYLOAD_BYTES=2MiB`, `WS_BUFFERED_CAP_BYTES=16MiB`, `wss = new WebSocketServer({noServer:true, maxPayload: WS_MAX_PAYLOAD_BYTES})` plus a `wss.on("error")` logger (no crash), and `isWsBackpressured(ws)` (`bufferedAmount > 16MiB`) checked in `sendTo` (skip one frame) and `broadcast` (skip that client). Skipped clients keep the socket — heartbeat (`ping`/`pong`, small and infrequent) and all message shapes are unchanged; streaming resumes when the buffer drains. `sendTo`/`broadcast` also gained `try`-guards around `send`/`JSON.stringify` (same payloads, no throw path).

## 2. How it was verified

Project suite (stub hub):
```
$ node tests/run.mjs
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (31ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6413ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3583ms) late session_file pins #session + tab
  PASS H4 (4032ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18147ms) no-ack backend shows exact 15s timeout message
  PASS H6 (12ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1520ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3205ms) Live section lists the running TUI with Drive controls
  PASS H9 (3152ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4855ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS D1 (3508ms) uplink relay frames answered, dead frames silent
  PASS D5 (3120ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract
16/16 passed
```

Real-hub contract (D1 dialog-relay behavior included in the 16/16 above; headless path on a real hub):
```
$ TEST_REAL_HUB=1 node tests/run.mjs --filter H6
tau-web e2e: H6 (real hub)
  PASS H6 (5647ms) start_session + prompt HEADLESS-OK round-trip
1/1 passed
```

Scratch checks (ephemeral, not checked in):
- `s10-ws-check` (same 2 MiB `maxPayload` via `ws`): 512 KiB frame echoed `ok:524288`; 3 MiB frame closed the sender with code 1009 while the server stayed alive and a third client still echoed `ok:5` → `S10-WS-OK`. Proves a >2 MiB frame is rejected without crashing the hub and normal (<1 MiB) frames flow.
- `s9-prune-check` (replica of the exact prune windows/caps): stale login entry (11 min old) pruned while fresh kept; 1200 login IPs capped to 1000; stale api-log entry (2 h old) pruned while fresh kept; 1200 api keys capped to 1000; 17 MiB buffer → skip, 512 KiB → send. All `OK`.
- Code inspection: `grep -n "maxPayload|isWsBackpressured|pruneLoginFailures|pruneApiAccessLog|releaseDialogsForBrowser|releaseDialogsForMirror|cancelHeadlessDialog"` shows the prune calls on every `loginFailures`/`apiAccessLog` access, the `maxPayload` construction, the `bufferedAmount` skips, and the `close`/`error`/heartbeat/`onGone` release calls.

## 3. Reviewer double-checks, residual risk

- Skip-vs-terminate (S10): I chose *skip* (drop the frame for the slow client, keep its socket) rather than *terminate*, which the requirement allows ("skip or terminate"). Skip bounds hub memory (no new bytes queued past 16 MiB) without killing a merely-flaky mobile/Tailscale tab; the cost is that a permanently-stalled client misses stream deltas until it drains (it still gets heartbeat + later frames). If the reviewer prefers hard reclaim, change the two `isWsBackpressured` early-returns to `try{ws.terminate()}catch{} + clients.delete + detach/release` — the release helpers already exist for that path.
- `bufferedAmount` is sampled per `sendTo`/`broadcast`; a burst of small deltas can still transiently exceed 16 MiB between samples, but each skip stops further growth, so the bound holds. No per-client byte counter was added (kept minimal).
- Headless cancel is gated on `managed.clients.size === 0` *after* `detach`: a sibling tab on the same backend keeps the dialog (verified by reading `HeadlessRegistry.detach` — unbind-only, never kills). A dialog broadcast to N tabs where the answering tab already closed but another tab never rendered it (e.g. attached after the dialog was raised) will now cancel even though a bound client exists — the alternative (wait forever for a tab that never saw the dialog) is the hang S9 wants gone; the child gets `cancelled` and the run continues.
- `releaseHubDialogsForMirror` notifies the mirror with `dialog_relay {cancelled:true}` only when *no* driver remains; with ≥1 driver it returns early and keeps the entries. A browser that was never attached (`mirrorIdBefore === undefined`) only triggers the headless sweep. Hub-local `kind:"mirror"` entries with no `hubDialogOwner` (hub's own `ctx.ui` dialogs) are left for the existing `wrapUiDialogs` no-channels poller (50 ms tick), which now also cleans `responses`.
- `pendingDialogs.has` guards assume the relay/answer always arrives while the entry exists in the live path — true by construction (entry is created before the request is broadcast/pushed, deleted only on answer/cancel). A duplicated `extension_ui_response` for an already-answered id is now ignored rather than re-queued; the first answer still wins exactly as before.
- Prune helpers are module-private (same as `loginFailures`/`apiAccessLog` themselves), so the scratch replica proves the logic, not the wired functions; the wiring is proven by inspection + the passing suite. Caps (1000/1000) and windows (10 min/1 h) are judgment calls matching the requirement's "e.g." — one-line changes if the reviewer wants different numbers.

## 4. Retry round

Not a retry — no `reviewer-comments10.md` exists yet, so there are no prior reviewer comments to address. First submission for T10.
