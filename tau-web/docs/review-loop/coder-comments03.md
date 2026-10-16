# Coder comments — T3 (B4 dead switch fetch + B6 fresh-session identity + B7 dead frames), round 1

## 1. What changed

One file, no new dependencies, no CSS, no hash/tab/selection behavior change.

### `public/app.js` — `switchSession()` tail (B4 + B7, first send)

- Before: after the history-load branch, `if (isMirrorMode) { …; if (viewingActiveSession) wsClient.send({type:'mirror_sync_request'}); } else { await fetch('/api/sessions/switch', {method:'POST', body:{sessionFile}}) → on !ok renderError('Failed to switch session: …') }`. Every `switchSession(null)` from `resetToScratchView()` (the `#tab-new` path) took the `else` branch against a hub with no such route → red `Failed to switch session: Not found` under the welcome view.
- After: the `else` fetch branch is gone and the inner `mirror_sync_request` send is gone. What remains is the mirror-mode bookkeeping only:
  `if (isMirrorMode) { viewingActiveSession = sessionFile === mirrorActiveSessionFile; if (uplinkPreview) …; updateMirrorInputState(); }`
  with the comment noting binding is owned by WS `start_session` / `mirror_sync`. History loading, the `myEpoch !== bindingEpoch` stale-switch guard, `resetToScratchView`/`handleSessionSelect` flow, and the trailing `updateMirrorInputState()` are untouched.

### `public/app.js` — `backToLive()` (B7, second + third sends)

- Before: `const wasMirror = isMirrorMode; await switchSession(…); if (!wasMirror) wsClient.send({type:'mirror_sync_request'})` in the `found` branch, and a bare `wsClient.send({type:'mirror_sync_request'})` in the `else if (target)` quiet-session branch.
- After: both sends (and the now-unused `wasMirror` + stale comments) are removed. Both branches keep `sidebar.setActive/clearActive`, `updateSessionHash`, `switchSession` / `renderSystemMessage + refreshFileBrowser`, and the trailing `updateMirrorInputState()/syncUplinkControls()`. No server handler was added — the hub intentionally ignores these frames (P2/D1 dead-frame contract).

### `public/app.js` — `sessionFile` WS handler (B6)

- Before: updated `headlessBinding = {cwd, sessionFile: key, sessionKey}`, `persistBinding()`, `updateSessionHash(file)` — but never `sidebar.activeSessionFile` / `mirrorActiveSessionFile`. `currentConnectionInfo()` reads `sidebar.activeSessionFile || mirrorActiveSessionFile`, so `activeFile` stayed `null` → `{state:'none', label:'No session'}`; `renderCurrentSessionCard()` then hid `#title-bar` (`show = !!activeFile`) and left `#tb-state` empty even though the backend was bound and the hash was pinned.
- After: after the existing `uplinkOwnsView()` / foreign-pin guards, adopt the discovered file as the viewed session and repaint:
  `if (sessionKeyOf(sidebar.activeSessionFile) !== key) sidebar.setActive(file); renderCurrentSessionCard();`
  `sessionKeyOf` comparison keeps a reload-restored full path from being downgraded to a basename (real hub sends basename; fake `late-file` sends a full path; `findSidebarSession` tail-matches either). The signature guard in `renderCurrentSessionCard()` then flips `#cs-state` to `Headless runner` and shows the title bar with the basename-derived name. Hash pinning, tab persistence (`hub.js` observes `replaceState`), and normal `handleSessionSelect` selection are unchanged.

Verified: `grep -n "mirror_sync_request\|sessions/switch" public/app.js` → no hits (only the explanatory comment mentioning the removed route).

## 2. How it was verified

- `node --check public/app.js` → OK (also `session-actions.js` OK).
- `grep -n "mirror_sync_request|sessions/switch|myEpoch" public/app.js` → only `myEpoch` declaration + its one remaining history-guard use; zero dead-frame sends, zero switch fetches. — OK
- `node tests/run.mjs` (stub hub, default matrix) → exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (35ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6211ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3747ms) late session_file pins #session + tab
  PASS H4 (3578ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18084ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1510ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3683ms) Live section lists the running TUI with Drive controls
  PASS H9 (3251ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4647ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1265ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1379ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3512ms) uplink relay frames answered, dead frames silent
  PASS D5 (3328ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (509ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

- `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` (real `pi` binary) → `1/1 passed` (`PASS H6 start_session + prompt HEADLESS-OK round-trip`). — OK
- Stub deep check (`/tmp/t3-probe.mjs`: fake `late-file` backend, click `#tab-new`, wait for `#session=*.jsonl`, 1.5 s settle, read DOM) — fixed tree:

```text
HASH: #session=fresh-mvbfp6fz.jsonl
errCount 0, csState "Headless runner", csName "fresh-mvbfp6fz",
titleHidden false, tbTitle "fresh-mvbfp6fz", tbState "Headless runner",
hash "#session=fresh-mvbfp6fz.jsonl", tabStrip "New session"
PROBE PASS, no pageerrors
```

  Baseline (`git stash -- public/app.js`, same probe) for differential:

```text
errCount 1, csState "No session", csName "New session",
titleHidden true, tbTitle null, tbState null
FAIL: errCount=1; csState; titleHidden; tbTitle; tbState
```

  So B4 (red error) + B6 (No session / hidden title) reproduce on baseline and are gone after the fix. — OK
- Real-hub browser probe (`/tmp/t3-real-probe.mjs`: `bootRealHub`, click `#tab-new`, same DOM reads) — fixed tree:

```text
HASH: #session=2026-10-16T20-43-21-035Z_01a14674-7a4a-745c-9c68-f51de769c379.jsonl
errCount 0, csState "Headless runner", titleHidden false,
tbTitle/tbState basename + "Headless runner", no pageerrors
REAL-HUB PROBE PASS
```

  This also covers the basename-only `session_file` shape (real hub sends `base`, fake sends full path) — both resolve via `sessionKeyOf`. — OK
- `git diff --check` → clean. `git status --short` → only `M public/app.js` (plus untracked `tests/.tmp/` from the run). No commit, `docs/code-review.md` / `tests/browser.mjs` untouched, no other package touched.

## 3. Double-checks and residual risk

- Reviewer should re-run the deep-UI new-session step if available: after `#tab-new`, assert no `.error-message` in `#messages`, `#cs-state` is `Headless runner`, title bar visible with the session name, URL is `#session=<basename>`; then reload and confirm the same view (H3 late-file pinning + real-hub rejoin). The stub suite covers pinning (H3) and the dead-frame server contract (D1/P2); the real-hub probe above covers the basename path, but only the deep-UI exercises the full reload-rejoin against a real session store.
- In-place `location.reload()` re-check via the e2e driver hits the known harness limit (`newPage()` wraps the same page; a post-reload `evaluate` returns `undefined`), so reload was verified via the suite + a same-hash `goto` equivalent rather than an in-place reload assert. If the reviewer has the Playwright deep driver, that is the place to confirm reload.
- `sidebar.setActive(file)` with a basename (real hub) leaves no sidebar row highlighted (row match is strict `dataset.filePath === filePath`) until the index reloads with the full path — the card/title (which use `sessionKeyOf`/tail fallback) are correct, and a strict-equality highlight fix was deliberately left out as beyond B6. Confirm the sidebar highlight on a fresh real-hub session looks acceptable.
- `backToLive()` quiet-session branch no longer sends `mirror_sync_request`; it now relies on the next server `mirror_sync` snapshot for the live tail. That matches the P2 dead-frame contract (the send was always ignored), but if a mirror stays silent the branch shows `Loading live session…` until the next snapshot — same as before minus the dead frame.
- `myEpoch` is still declared and used once (history supersede guard); the second use in the removed error branch is gone. No unused-var lint issue.

## 4. Retry-round comments addressed

Not a retry — first coder pass for T3. No prior reviewer comments to address.
