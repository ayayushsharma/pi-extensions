# Coder comments — T4 (B5 reconnect wipes transcript / stuck Loading), round 1

## 1. What changed

One file, no new dependencies, no protocol change, no attach/detach or preview-semantics change.

### `public/app.js` — `restoreSessionFromUrl()` early paint (B5, first half)

- Before: the instant-chrome block unconditionally did `sidebar.setActive(file)` → `renderCurrentSessionCard()` → `messageRenderer.clear()` → `renderSystemMessage('Loading session...')` on every call whenever `findSidebarSession(wanted.key)` hit. On a WS reconnect (logout → login, socket drop) while viewing a drivable live TUI, the transcript already showed the wanted session, so this wiped it to the placeholder.
- After: captures `alreadyShowing = sessionKeyOf(sidebar.activeSessionFile) === wanted.key && messagesContainer.childElementCount > 0` before touching anything. `setActive` + `renderCurrentSessionCard()` still run (identity/card stay correct, signature-guarded so no-ops when unchanged), but `clear()` + `Loading session...` only run when `!alreadyShowing` — i.e. only when the active key differs or the message list is empty. A reconnect over a populated view of the same session no longer wipes it; a tab tap to a different session or a fresh load with an empty view still paints instantly as before.

### `public/app.js` — `previewAttach()` already-viewing branch (B5, second half)

- Before: `if (session && project && sidebar.activeSessionFile !== sessionFile)` → `setActive` + `switchSession(..., {preview:true})`, else-if same file → only `refreshFileBrowser(...)`. When the pinned live session was already `sidebar.activeSessionFile` (the reconnect case above), the restore's `previewAttach(live.port, live.pid, live.sessionFile, ..., {fromRestore:true})` took the else-if and skipped `switchSession` entirely — nothing repopulated the view, so it stuck on `Loading session...` forever.
- After: the different-session test uses `sessionKeyOf` on both sides (basename vs full-path safe, consistent with the rest of the file), and the already-viewing else-if now does `await switchSession(sidebar.activeSessionFile || sessionFile, session, project, {preview:true})` instead of only `refreshFileBrowser`. `preview:true` keeps the read-only preview semantics (no headless bind to a TUI-owned file, same as the normal preview path); `switchSession` already roots the file browser, so no separate call is needed. A reconnect over the pinned live TUI now reloads its history; a normal Drive click on the session already on screen just re-renders the same history (one extra fetch, no semantic change).

Untouched, by design: `restoreInFlight` / `urlRestorePending` / `myKey` vs `now` hash-moved re-run convergence, the ghost-session cleanup (`updateSessionHash(null)` + `clearActive` + error), `uplinkActive`-same-port early return, `uplinkAttachPending` guard, `updateSessionHash(..., fromRestore)` downgrade guard, `wanted.drive` → `attachUplink` re-drive, and all attach/detach/banner paths (`attachUplink`, `detachUplink`, `cancelPreview`, `uplinkAttached/Detached/Dead` handlers).

## 2. How it was verified

- `node --check public/app.js` → OK.
- `git diff --check` → clean.
- `node tests/run.mjs` (stub hub, default matrix) → exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6012ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (5036ms) late session_file pins #session + tab
  PASS H4 (3523ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18931ms) no-ack backend shows exact 15s timeout message
  PASS H6 (5ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1513ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3085ms) Live section lists the running TUI with Drive controls
  PASS H9 (3158ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4584ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1374ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1275ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3511ms) uplink relay frames answered, dead frames silent
  PASS D5 (4052ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (518ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

- `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` (real `pi` binary) → `1/1 passed` (`PASS H6 start_session + prompt HEADLESS-OK round-trip`). Confirms the normal headless bind/rejoin path still works after the frontend-only change.
- `git status --short` → only `M public/app.js` plus untracked `docs/review-loop/coder-comments04.md` (and `tests/.tmp/` from the run). No commit, `docs/code-review.md` / `tests/browser.mjs` untouched, no other package touched.

## 3. Double-checks and residual risk

- Reviewer should confirm the reconnect path with the deep-UI driver if available: view a drivable live TUI (preview, transcript populated), then logout → login (or drop the socket) and assert the transcript restores (no permanent `Loading session...` in `#messages`). The stub suite (H8/H9/D1/D5) covers the preview/drive/detach and login/logout contracts but has no logout-while-previewing-transcript test and its fake live session serves no history (`/api/sessions/e2e-live/...` 404s), so it cannot assert transcript content across a reconnect — only the deep-UI run against a real session store exercises the exact repro.
- Normal reload with `#session=<basename>` still rejoins the same backend and renders history: covered by H11 (stub shape) + real-hub H6 above, but the full reload-rejoin with history content is again best confirmed in the deep-UI reload-rejoin step.
- The already-viewing preview now always refetches history (one extra `/api/sessions/<dir>/<file>` fetch when clicking Drive on the session already on screen). This is the behavior the task prescribes (`switchSession with {preview:true}` instead of skipping); the flicker is one transient `Loading session...` replaced by the same history. If the reviewer finds the extra fetch objectionable for the click-Drive-while-viewing case, the narrower alternative is to reload only when the transcript is empty or holds just the loading placeholder — but that would deviate from the task's explicit "still reload its history instead of skipping".
- `sessionKeyOf` comparison in `previewAttach` also fixes a latent basename-vs-full-path downgrade (old strict `!==` would `setActive(basename)` over a full-path active for the same session); the new else branch keeps `sidebar.activeSessionFile` (full path) for the reload. Sidebar highlight and `findSidebarSession` tail-matching are otherwise unchanged.
- No test in this environment drives an in-place `location.reload()` assert through the e2e driver (known harness limit: `newPage()` wraps the same page), so reload was verified via the suite + real-hub H6 rather than an in-place reload assert.

## 4. Retry-round comments addressed

Not a retry — first coder pass for T4. No prior reviewer comments to address.
