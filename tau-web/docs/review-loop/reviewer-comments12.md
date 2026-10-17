VERDICT: PASS-WITH-NITS

Round-3 re-review of T12 (P3/P4/P6/P7 + round-2 blocker B1). The B1 stale-page
race is fixed and I proved the repro is non-vacuous: the prior reviewer's exact
2.5 s-delayed `before=` fetch + session-switch repro now leaves only the new
session's 6 entries (0 contamination), while the same repro against a copy of
`app.js` with the guard removed still yields 50 foreign entries. P3 windowing,
P4 coalescing/ordering, P6 math gate, P7 cache headers, 16/16 tests, real-hub
H6 and the deep-UI driver all pass. Remaining items are minor follow-ups only.

---

## 1. Evidence

### Working tree / diff inspected

- `git status --porcelain` → `M tau-web/extensions/mirror-server.ts`,
  `M tau-web/public/app.js`, `M tau-web/public/message-renderer.js`,
  `?? tau-web/docs/review-loop/coder-comments12.md`,
  `?? tau-web/docs/review-loop/reviewer-comments12.md` (this file, overwritten).
- `git diff 8abcd28f769df6c0c04abc430c3da59a0db9934c -- {extensions/mirror-server.ts,public/app.js,public/message-renderer.js}`
  read in full, then the surrounding code in each file:
  - `fetchOlderHistory()` (public/app.js:3440-3510): `reqEpoch/reqDir/reqFile`
    captured at 3447-3451 **before** `await fetch(...)`; after `await res.json()`
    the first statement is the bail-out at 3460
    (`if (reqEpoch !== bindingEpoch || reqDir !== historyDirName || reqFile !== historyFile) return;`)
    with no state/DOM write before it; the `finally` uses the positive form of
    the same predicate (3504-3507). `historyLoadingOlder = true` is set after
    capture and before the await, so no interleave is possible.
  - `switchSession` tail fetch + bind (2217-2258), `handleMirrorSync` (2337-2369),
    `refreshWatchedHistory` (2723-2729), `renderLoadMoreControl` (3400-3430),
    `loadEarlierMessages` (3514-3545), `renderSessionHistory` (3548-3595).
  - `serveSessionFile` windowing + route query handling (mirror-server.ts:2678-2688,
    3195-3262); `limit` clamped to ≤5000, `before` exclusive, unknown `before` → `[]`,
    missing/invalid limit → full file, response shape still `{entries:[...]}`.
  - `extractStreamDelta` / `withCombinedDelta` / `flushWsDeltas` / `dropWsDeltas`
    / `sendTo` (mirror-server.ts:754-836), `flushBroadcastDeltas` / `broadcast`
    (838-878), `stopServer` cleanup (884-893), WS close/error/heartbeat cleanup
    (3625-3668), `handleMirrorFrame` hub relay (1176-1186).
  - `_renderMath` gate (public/message-renderer.js:67-90) and its three call
    sites (135, 187, 281); configured delimiters are only `$$`/`$`.
  - `serveStaticFile` cache-control branch (mirror-server.ts:1988-2010).
- Checked for regressions: epoch/stale-stream guards (`activeStreamEpoch`, `bindingEpoch`,
  `myEpoch`) untouched; `startBackgroundWatch` still polls the full file and marks
  the view complete; `handleMirrorSync` treats snapshots as complete; traversal
  jail still enforced after `decodeURIComponent`; H12/H13 route shape unchanged.

### Tests

`node tests/run.mjs`:

```
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6054ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3546ms) late session_file pins #session + tab
  PASS H4 (3538ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18197ms) no-ack backend shows exact 15s timeout message
  PASS H6 (13ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1522ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (4244ms) Live section lists the running TUI with Drive controls
  PASS H9 (3162ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4534ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1268ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1284ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3510ms) uplink relay frames answered, dead frames silent
  PASS D5 (4320ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (517ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

`TEST_REAL_HUB=1 node tests/run.mjs --filter H6` → `PASS H6 (4562ms) ... 1/1 passed`.

### B1 — the reviewer's exact repro, re-run

Ran the round-1 reviewer's own script unchanged (`/tmp/tau-b1-fix/b1_browser_repro.py`,
real hub + real Chromium, 240-entry BIG / 6-entry SMALL fixtures, 2.5 s route delay
on `before=`, switch 150 ms after the click). Result:

```
PASS big first paint renders tail  messages=50
PASS big first paint is windowed (Load earlier visible)
PASS server tail window is 50 entries and smaller than full  bytes=10930 full=57446 ratio=19.0%
PASS stale BIG page not merged into SMALL view  messages=6 contamination=0
PASS SMALL view still shows its own 6 messages  small=6
PASS normal Load-earlier prepends the next page  before=50 after=100 first_before='BIG user message 96…' first_after='BIG user message 71…'
PASS ?v= static is immutable  public, max-age=31536000, immutable
PASS plain static is no-cache  no-cache
pageerrors_count: 0, console_error_count: 0
```

Sensitivity (non-vacuous repro): copied `public/` to `/tmp/t12-review-buggy-public`
and removed the two guard spots (the bail-out after `await res.json()` and the
`finally` predicate, making it unconditional), then ran the same script with
`TAU_STATIC_DIR` pointed at the copy:

```
FAIL stale BIG page not merged into SMALL view  messages=56 contamination=50
FAILURES: ['stale BIG page not merged into SMALL view']
```

So the repro still detects the exact round-2 symptom, and the current tree passes it.

### P3 — payload + traversal, independently

- First paint `?limit=50` transfers **10,930 B = 19.0 %** of the 57,446 B file
  (240 entries); `before=` paging walked 50-entry pages and the final short page
  exhausted the history (round-1 trace: 4 pages to `User message 1`, scroll
  anchor preserved).
- Traversal probes against a live real hub:
  `%2e%2e/…`, `..%2f..%2f…`, `%2e%2e%2f%2e%2e%2f…`, `....//....//…` → all 404
  (non-200); H12/P2 still pass.

### P4 — deterministic coalescing/ordering (fake mirror → real hub → browser WS)

Wrote `/tmp/t12-review-p4.mjs`: a fake mirror dials the hub's `hub.sock`, sends
40 `text_delta` (~6 ms apart) + 6 `thinking_delta` (~42 ms apart), then `text_end`
and `message_end`; a raw browser WS client attaches via `uplink_attach`.

```
INFO sent 40 text/6 thinking deltas; received 6 text/6 thinking frames
PASS text reconstructed exactly via coalesced frames (6 frames)
PASS thinking reconstructed exactly (6 frames)
PASS text deltas coalesced (40 sent -> 6 frames)
PASS envelope unchanged: every rpc_event carries uplink:true
PASS message_end delivered
PASS no delta frame after message_end (0)
PASS message_end flushed promptly after last delta (1ms)
PASS text_end ordered after all deltas (lastDelta=11 < firstEnd=12)
T12-P4-REVIEW: ALL PASS
```

### P6 / P7

- P6: `_renderMath` early-returns unless `element.textContent` contains `$`;
  the only configured delimiters are `$$`/`$` and all three call sites go
  through this method, so no configured math can be skipped.
- P7: `/app.js?v=99` → `public, max-age=31536000, immutable`; `/app.js` →
  `no-cache`; ETag/304 logic untouched (both measured in the B1 repro above).

### Deep-UI UX pass

`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui ... python scripts/review-loop/deep_ui.py`
→ exit 0, `"errors": [], "pageerrors": [], "requestfailed": []`, and
`run-complete {'ms': 4011, 'user_bubbles': 1, 'assistant_bubbles': 1, 'tools': 0}`.
Reload-rejoin kept the same hash; mobile `horiz_overflow_px: 0`. Console noise is
the expected pre-login 401s plus one stale sidebar session 404 pair (the P3 tail
request and its documented full-read fallback, both 404 — pre-existing dead entry).

---

## 2. Issues

### Blocking

None.

### Nits (follow-ups, not blockers)

- **N1 (carried). Cost pill undercounts windowed sessions until fully paged.**
  `public/app.js:3568` sets `sessionTotalCost = histCost` from the loaded tail;
  older assistant costs are folded in only by `fetchOlderHistory` (3479-3484).
  Documented coder trade-off; a future opt-in `total`/first-page-cost field would
  fix it without changing `{entries:[...]}`.
- **N2 (carried). `toolcall_delta` is not coalesced.** `extractStreamDelta`
  (mirror-server.ts:767-776) batches only `text_delta`/`thinking_delta`;
  tool-argument fragments still go one frame per token. Deliberate, lower impact.
- **N3 (carried). `?v=` versions are not bumped.** `public/hub/index.html:403`
  still loads `app.js?v=4`. With P7 making `?v=` immutable, the *next* `app.js`
  change will be invisible to browsers that cached `app.js?v=4` unless the query
  is bumped. Worth an automatic bump at release, or bump now.
- **N4 (new, cosmetic). Exactly-50/100/…-entry sessions show a spurious
  "more on server" control.** `exhausted = entries.length < VISIBLE_MESSAGE_WINDOW`
  (app.js:2235) is false when the tail is full even if the file has no older
  entries, so the button renders; one click fetches an empty page and
  `renderLoadMoreControl` then removes the control instead of showing the
  "beginning of session · all N entries shown" state (3405, 3462). Two requests
  instead of one and a missing completion label at exact page boundaries.
- **N5 (new, low-confidence follow-up). Tail window may omit
  `model_change` / `thinking_level_change` entries.** `renderSessionHistory`
  derives the model/thinking pill by scanning the loaded entries (3554-3563);
  on long sessions those entries can sit above the 50-entry tail. My hub probe
  could not demonstrate a visible break (the hub's own model overwrote the label
  for both a small and a large session, pre-existing), but a history-only view
  on another deployment could show a stale model. Consider carrying the last
  `model_change`/`thinking_level_change` in the tail window if it is ever
  observed in practice.

---

## 3. Regression checks summary

- Streaming: coalesced deltas reconstruct exactly; `message_end` flushes in 1 ms;
  no delta after terminal frames; real-model H6 and deep-UI run complete with the
  full final text and one user + one assistant bubble.
- Paging: tail-first paint, `Load earlier` pages correctly and terminates at the
  beginning (round-1 UI trace re-confirmed by the B1 repro's paging check).
- Stale guards: session-switch repro clean; removing the guard reproduces the
  old contamination, so the guard is what prevents it.
- Existing contracts: H1-H13/D1/D5/P2 16/16; H12 content jail; H13 picker;
  traversal probes non-200; auth/Basic flows unchanged; background watch still
  full-file and marks the view complete.

VERDICT: PASS-WITH-NITS
