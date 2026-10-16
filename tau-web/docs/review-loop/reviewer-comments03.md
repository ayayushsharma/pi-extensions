# VERDICT: PASS

Task **T3 — Fix new-session view state: drop the dead /api/sessions/switch
fetch, set the fresh-session identity, remove dead frames** (findings B4, B6,
B7). Baseline `2d9c6dd1974507eddb31a39402f7e8d693998b66`; reviewed the actual
working tree, not the coder summary. No product code was edited during review.

## 1. Evidence — commands and results

### Scope / diff inspected

- `git status --porcelain` (repo root `pi-extensions`) → only
  `M tau-web/public/app.js` plus untracked `?? tau-web/docs/review-loop/coder-comments03.md`.
  No other package touched, no product files added/removed.
- `git diff 2d9c6dd... -- tau-web/public/app.js` → one file, +9/−26, exactly
  three hunks:
  1. `sessionFile` WS handler: after `updateSessionHash(file, false)`, adds
     `if (sessionKeyOf(sidebar.activeSessionFile) !== key) sidebar.setActive(file);`
     followed by `renderCurrentSessionCard()` (B6).
  2. `switchSession()`: removes the `else { fetch('/api/sessions/switch', …) →
     renderError('Failed to switch session: …') }` branch and the inner
     `wsClient.send({type:'mirror_sync_request'})`; keeps the mirror-mode
     bookkeeping (`viewingActiveSession`, `updateMirrorInputState()`) (B4 + B7).
  3. `backToLive()`: removes `wasMirror` and both remaining
     `wsClient.send({type:'mirror_sync_request'})` sends (B7).
- `grep -rn "mirror_sync_request\|sessions/switch" public/ extensions/` → no
  sends and no server route anywhere in product code; only the new explanatory
  comment in `app.js:2256` and the test/doc references (the stub/tests still
  own the server-side dead-frame contract).
- `node --check public/app.js` → OK; `node --check public/session-actions.js` → OK.
- `git diff --check` → clean.
- Confirmed `/api/sessions/switch` really is absent from the hub: route table in
  `extensions/mirror-server.ts` has `/api/sessions` (GET), `/summaries`, `/fork`,
  `/delete`, `/rename`, `/export`, `/download`, `/api/sessions/:dirName/:file` —
  no `/switch`, so the removed fetch could only produce "Not found" (B4 root cause).
- Confirmed the server still intentionally ignores the removed frames:
  `tests/hub-stub.mjs:33` + `tests/e2e/p2-guards.test.mjs` + `d1-drive-attach.test.mjs`
  treat `mirror_sync_request` as a dead frame; no server handler was added
  (as required).

### Code paths inspected end-to-end

- `sessionFile` listener (`app.js:556-577`): guard order is
  `file` → `uplinkOwnsView()` → foreign-hash guard
  (`pinned?.key && pinned.key !== key`) → binding bookkeeping →
  `updateSessionHash` → new `sidebar.setActive` + `renderCurrentSessionCard()`.
  The added identity adoption can only run for a discovery that already
  matched the pinned key or when nothing is pinned; preview/driven and
  URL-pinned-other views still bail before it.
- Ordering proof for the `#tab-new` flow: `mirror-server.ts` `new_session`
  sends the ack synchronously right after `headless.newSession()` returns
  (`:1106-1117`); `onFileDiscovered` only fires later from the child's async
  `get_state` response (`headless-bridge.ts:275`) and only when
  `hashDiscovery` is set (fresh attach). So `applyFreshSession` →
  `resetToScratchView` (`updateSessionHash(null)` + `sidebar.clearActive()`)
  always runs before the discovery lands; the new handler then paints the
  identity. The 300 ms-delayed stub `session_file` (`tests/fake-backend.mjs:71-83`)
  exercises the same ordering.
- `currentConnectionInfo()` (`app.js:2391`) + `renderCurrentSessionCard()`
  (`app.js:2454`): with `sidebar.activeSessionFile` set, the card signature
  changes to `headless`/`Headless runner`, `#title-bar` un-hides
  (`show = !!activeFile`), `#tb-title` gets the basename name and `#tb-state`
  gets `Headless runner` (B6).
- `switchSession()` (`app.js:2180-2265`): history load, `bindHeadless` for
  non-TUI-owned files, `myEpoch` stale-switch guard, mirror bookkeeping, and
  the trailing `updateMirrorInputState()` all intact; `myEpoch` still used at
  `:2228` (no dead variable).
- `backToLive()` (`app.js:2908-2946`): `found` and quiet branches keep
  `setActive/clearActive`, hash update, history/`renderSystemMessage`,
  `refreshFileBrowser`, trailing `updateMirrorInputState()/syncUplinkControls()`
  — only the ignored sends were dropped.
- Hash/tab/selection behavior: no changes to `updateSessionHash`,
  `parseSessionHash`, `restoreSessionFromUrl`, `handleSessionSelect`,
  `hub.js` replaceState observer, or tab persistence.

### Project tests (required) — `node tests/run.mjs`

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6026ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3561ms) late session_file pins #session + tab
  PASS H4 (3545ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18159ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1514ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3091ms) Live section lists the running TUI with Drive controls
  PASS H9 (3170ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4587ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1268ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1275ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3513ms) uplink relay frames answered, dead frames silent
  PASS D5 (3167ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (511ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

Focused re-run `node tests/run.mjs --filter H3,H4,H5` → `3/3 passed`
(H3 late-file pinning, H4 fail-fast, H5 timeout), so the touched paths
(`sessionFile`/`switchSession`) have no H3/H4/H5 regression.

### Deep-UI real-browser pass (available and run)

`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui … scripts/review-loop/deep_ui.py` →
exit 0, JSON report `pageerrors: []`, `errors: []`. Key steps:

```text
new-session     ms=435 hash=#session=2026-10-16T20-48-37-915Z_01a14679-….jsonl
                state="Headless runner"
                card="2026-10-16T20-48-37-915Z_01a14679-501a-762a-8714-a1585d938029"
                title_bar_hidden=false error_msgs=[]
reload-rejoin   same_hash=true hash=#session=2026-10-16T20-48-37-915Z_….jsonl
                user_bubbles=1 (PONG reply preserved)
```

Screenshots `02-new-session.png` and `06-after-reload.png` confirm visually:
title bar visible with the session basename + `HEADLESS RUNNER`, welcome view,
no `.error-message` bubble in `#messages`; after reload the same session, same
hash, same card/title, PONG transcript still rendered. This is the acceptance
criteria check with a real hub + real headless child (basename-shaped
`session_file`), covering B4/B6 and the H3 late-pinning reload path.

## 2. Issues by severity

**Blocking:** none.

**Nits:** none required to merge. Non-blocking observations only (out of the
task's explicit scope):
- With a real hub the discovery carries a basename, so
  `sidebar.setActive(basename)` sets the view identity but cannot strictly
  match a sidebar row's full `dataset.filePath` until a later refresh/reload
  re-selects via `restoreSessionFromUrl` (which uses the full path). The
  card/title — the acceptance target — are correct via `sessionKeyOf`/tail
  match; the highlight gap predates this change and the task explicitly
  scoped out selection/highlight changes.
- `renderCurrentSessionCard()` is now called unconditionally on discovery; the
  existing signature guard makes it a cheap no-op when nothing changed.

## 3. Regression checks

- B4: no `.error-message` on the fresh-session path (deep UI `error_msgs=[]`,
  step screenshot), and the fetch/error branch is gone from the tree.
- B6: `#cs-state` = `Headless runner`, `#title-bar` visible with the basename
  name and `Headless runner` state, hash `#session=<basename>` (deep UI), and
  H3 still pins late `session_file` + keeps the "New session" tab.
- B7: zero `mirror_sync_request` sends in `public/`; D1/P2 (dead-frame
  contract) still pass and no server handler was added.
- No hash-pinning, tab-persistence, or normal-selection code was touched; H3,
  H4, H5 and the deep-UI reload-rejoin all pass. No CSS files changed.

VERDICT: PASS
