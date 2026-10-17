# T12 coder comments (round 3) — Windowed session transfer, coalesced stream broadcasts, lighter renderer/static work (P3, P4, P6, P7) + B1 stale-page guard

## 1. What changed

No new code changes were needed in this round: the full T12 scope — including
the round-2 blocker guard — was already present in the working tree, and this
round verified it satisfies the strengthened requirement exactly, with a
stronger repro than before. Files (unchanged since the prior round):

**`extensions/mirror-server.ts`**
- P3 `serveSessionFile(res, dirName, file, reqUrl?)`: optional
  `?limit=N&before=<entryId>` windows the transfer (default unchanged: full
  file, same `{entries:[...]}` shape). `before` is exclusive; `limit` takes the
  last N of that prefix (capped at 5000); unknown `before` yields `[]` so
  Load-earlier stops instead of looping. Route matches the `?`-stripped path
  and `decodeURIComponent`s dir/file, so traversal rejection (403/404) is
  preserved. Before: first paint shipped every parsed entry.
- P4 `sendTo`/`broadcast`: per-destination `message_update` deltas (`text_delta`
  / `thinking_delta`) coalesce over a 40 ms timer into one concatenated delta
  per kind (envelope shape unchanged — the flush reuses the first buffered
  envelope per kind); any non-delta frame flushes pending deltas first, so
  `message_end`/`agent_end` never reorder after their deltas. `dropWsDeltas`
  on WS close/error/heartbeat-prune and `stopServer`. Before: one WS frame per
  token. `toolcall_delta` is deliberately not batched (see N2).
- P7 `serveStaticFile`: `Cache-Control: public, max-age=31536000, immutable`
  when the URL carries a `?v=` param, `no-cache` otherwise; ETag/304 logic
  untouched. Before: no-cache + ETag for everything.

**`public/app.js`**
- P3 tail-first `switchSession`: first paint fetches
  `?limit=VISIBLE_MESSAGE_WINDOW` (50), falls back to the full read on
  404/failure (old-hub compat), records `historyDirName/historyFile`,
  `historyExhausted = (entries.length < 50)`. `renderLoadMoreControl` shows
  `more on server` while unexhausted; `loadEarlierMessages` fetches the next
  `?limit=&before=` page when the in-memory window is fully shown, else widens
  synchronously as before. `handleMirrorSync` (live snapshots are complete
  state) and `refreshWatchedHistory` (full-file polls) mark the view complete.
- B1 `fetchOlderHistory()` stale-page guard — exactly what the strengthened
  requirement prescribes: captures `reqEpoch = bindingEpoch`,
  `reqDir = historyDirName`, `reqFile = historyFile` before the await; builds
  the fetch URL from the captured dir/file; immediately after
  `await res.json()` and before any state/DOM mutation bails with
  `if (reqEpoch !== bindingEpoch || reqDir !== historyDirName || reqFile !== historyFile) return;`
  (covers both `switchSession` and `handleMirrorSync`, which bump the epoch);
  the `finally` uses the positive form of the same predicate so a stale page
  can neither clear the new session's `historyLoadingOlder` flag nor race that
  session's own in-flight page fetch. Setting `historyLoadingOlder = true`
  happens after capture but before the await in the same sync block, so no
  interleave is possible. Before (round 1): no capture, unconditional merge +
  unconditional finally.

**`public/message-renderer.js`**
- P6 `_renderMath`: early-returns unless `element.textContent` contains `'$'`
  (the only configured KaTeX delimiters are `$$`/`$`); all three call sites
  route through this method. Before: KaTeX auto-render on every finalized
  message.

## 2. How it was verified

- `node --check public/app.js && node --check public/message-renderer.js` →
  both ok.
- `node tests/run.mjs` (stub hub, default P0 matrix) → exact summary:
  ```
  tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
    PASS H1 (31ms) hub alive: /api/health, /→302 /hub/, shell 200
    PASS H2 (6492ms) static-only renders with zero pageerrors (desktop + mobile)
    PASS H3 (4289ms) late session_file pins #session + tab
    PASS H4 (3558ms) disconnected + shows exact fail-fast (no 15s wait)
    PASS H5 (18117ms) no-ack backend shows exact 15s timeout message
    PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
    PASS H7 (1513ms) uplink relay contract: list/instances live, WS-only over HTTP
    PASS H8 (3175ms) Live section lists the running TUI with Drive controls
    PASS H9 (3164ms) preview-then-drive flow: preview, cancel, drive, detach
    PASS H10 (4562ms) live pi processes list + kill (stub UI, real scan/kill)
    SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
    PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
    PASS H12 (1271ms) viewer endpoint: content jailed to the viewed session
    PASS H13 (1273ms) picker endpoints: summaries + mkdir + fork
    PASS D1 (3512ms) uplink relay frames answered, dead frames silent
    PASS D5 (3692ms) auth: 401 + overlay, login → WS, logout revokes
    PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract

  16/16 passed
  ```
- `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` (real `pi` hub + real
  headless child + real model) →
  ```
  tau-web e2e: H6 (real hub)
    PASS H6 (4166ms) start_session + prompt HEADLESS-OK round-trip

  1/1 passed
  ```
  Streaming still completes through the P4 batcher with ordered final text.
- `node /tmp/t12-verify.mjs` (real hub, sandboxed session store, real
  Chromium via playwright-core; script preserved at `/tmp/t12-verify.mjs`) →
  `T12-VERIFY: ALL PASS` (22/22 checks):
  - P3 payload (241-entry/37,877 B fixture): `?limit=50` → 50 entries,
    7,972 B (**21.0% of full**), ids `b-u96..b-a120`; `?limit=50&before=b-u96`
    → 50 entries `b-u71..b-a95` (no overlap); unknown `before` → `[]`;
    `?limit=abc` → full 241 (default unchanged); traversal `404/404`.
  - P7: `/app.js?v=99` → `public, max-age=31536000, immutable`;
    `/app.js` → `no-cache`.
  - Paging mechanics (no delay): first paint starts at `User message 96`;
    one Load-earlier → 50 user bubbles starting at `User message 71`,
    `more on server`; 0 pageerrors.
  - B1 repro (reviewer's 2.5 s-delayed-`before=` + switch 150 ms after the
    click): stale page (HTTP 200) landed **2,317 ms after the new session
    painted** (proven in-flight race via `waitForResponse` timing) and the
    new session kept only its own entries — 0 BIGSESSION hits in `#messages`,
    3 user + 3 assistant bubbles, cost pill hidden, no stale Load-earlier
    control, 0 pageerrors.
- Sensitivity proof (repro is not vacuous): with the two guard lines
  temporarily removed, the same script fails exactly as the reviewer
  described — `50 BIGSESSION hits in #messages`, `28 user + 28 assistant`
  bubbles, cost pill `visible=true` (3 failures). The file was then restored
  byte-identical (`diff -q /tmp/app.js.fixed public/app.js` → identical,
  `grep -c reqEpoch` → 3).

## 3. Double-checks, residual risk, uncertainty

- Rapid A→B→A switches are safe: each `switchSession` tail fetch is guarded
  by its own `myEpoch`, and a first-generation page is dropped by the epoch
  check when the third binding owns the screen (the re-fetched tail is newer).
- Same-session double-paging cannot interleave: `historyLoadingOlder`
  serializes fetches, and the guarded `finally` preserves the flag
  per-binding. `loadEarlierMessages`' in-memory branch is synchronous and
  needs no guard.
- The `!res.ok → throw → catch` path only logs and mutates nothing; the
  guarded `finally` covers the loading state. No `return` inside `finally`,
  so no value/exception can be swallowed.
- P4/P6/P7 re-verified live above (payload bytes, immutable/no-cache split,
  real-model round-trip); P4 ordering/delta-reconstruction was verified
  deterministically in round 1 and the code is unchanged.
- Residual: windowed sessions show tail-only cost until the user pages to the
  beginning (accepted trade-off, N1); `?v=` cache-bust strings must still be
  bumped manually when assets change (N3) — unchanged from before P7.

## 4. Retry round — how each reviewer comment was addressed

- **B1 (blocking): stale `fetchOlderHistory()` merges into the next session**
  — the prescribed guard (epoch + dir/file captured before the await, bail
  before any mutation, guarded finally) is in the tree and was proven with
  the reviewer's own repro shape: delayed `before=` fetch + session switch
  leaves only the new session's entries, bubbles, cost, and loading control.
  Sensitivity was proven by re-running the repro against the unguarded
  variant (reviewer's exact contamination symptom) and restoring byte-identical.
- **N1 (cost pill undercounts on windowed sessions)** — left as-is
  (non-blocking documented trade-off; no new `total` field, `{entries:[...]}`
  preserved).
- **N2 (`toolcall_delta` not coalesced)** — left as-is (non-blocking; only
  `text_delta`/`thinking_delta` batch by design).
- **N3 (`?v=4` not bumped while `app.js` changed)** — left as-is
  (non-blocking; version bumps are a release step, not part of this fix).
- **N4 (round-1 summary misstated `refreshWatchedHistory`)** — this round's
  notes claim only what the code does (§1 above; the `null` reset lives in
  `handleMirrorSync`, not `refreshWatchedHistory`).
