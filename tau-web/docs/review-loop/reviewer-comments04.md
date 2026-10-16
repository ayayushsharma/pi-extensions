# Reviewer comments — T4 (B5 reconnect wipes transcript / stuck on 'Loading session...')

VERDICT: PASS-WITH-NITS

## 1. What was actually reviewed

- `git status --porcelain` → only `tau-web/public/app.js` modified plus untracked
  `tau-web/docs/review-loop/coder-comments04.md`. No other file/package touched.
- `git diff 5d9cc98ceab47f560262c5edd5c7f4765a3bef54 -- public/app.js` → 2 hunks,
  15 insertions / 6 deletions, exactly the two sites the task targets:
  1. `restoreSessionFromUrl()` early-paint guard (`public/app.js:2775-2785`):
     `alreadyShowing = sessionKeyOf(sidebar.activeSessionFile) === wanted.key &&
     (messagesContainer?.childElementCount || 0) > 0`; clear + `Loading session...`
     now only when `!alreadyShowing` (active key differs or list empty). Exactly
     the task's "only paint when the active key differs or the message list is
     empty" prescription.
  2. `previewAttach()` already-viewing branch (`public/app.js:2993-3004`):
     different-session test now compares `sessionKeyOf(...)` on both sides, and
     the same-session else-branch now does
     `await switchSession(sidebar.activeSessionFile || sessionFile, session, project, {preview:true})`
     instead of only `refreshFileBrowser()`. `preview:true` is passed, so the
     `if (!opts.preview) bindHeadless(...)` guard in `switchSession` still
     keeps this read-only (no headless bind to a TUI-owned file).
- Convergence logic untouched and still present: `restoreInFlight` / `urlRestorePending`,
  the `finally` re-run for a hash that moved mid-restore, ghost-session cleanup
  (`updateSessionHash(null)` + `sidebar.clearActive()` + error), `uplinkActive`
  same-port early return, `uplinkAttachPending` guard, `wanted.drive` re-drive.
- `node --check public/app.js` → OK. `git diff --check` → clean.

## 2. Evidence (commands + results)

### 2.1 Project test suite (required)

`node tests/run.mjs`:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (5996ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3582ms) late session_file pins #session + tab
  PASS H4 (3588ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18095ms) no-ack backend shows exact 15s timeout message
  PASS H6 (5ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1511ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3378ms) Live section lists the running TUI with Drive controls
  PASS H9 (3131ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4585ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1270ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1274ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3514ms) uplink relay frames answered, dead frames silent
  PASS D5 (3165ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

H11 is the only skip (needs `TEST_REAL_HUB=1`) and is a hub/registry test,
unaffected by a `public/` change; no test fails because of this change.

### 2.2 Deterministic A/B browser probe of the exact B5 repro (reviewer-authored, /tmp only)

Stub hub + Playwright network interception of `/api/sessions` (one `e2e-live`
fixture) and `/api/sessions/e2e-live/<file>` (2 history entries), then:
preview the fake live TUI ("Drive"), assert 2 `.message` render, settings →
server → `#btn-logout`, log back in, snapshot `#messages` + banner.

- Current tree (`/tmp/t4-stub-probe.mjs`, `STATIC_DIR=.../tau-web/public`):

```text
verdict: "FIXED"
before: {"msgs":2,"loading":false,"text":"fixture user message fixture assistant reply ","banner":" Previewing …"}
after:  {"msgs":2,"loading":false,"text":"fixture user message fixture assistant reply ","banner":" Previewing …"}
pageerrors: []
```

- Baseline negative control (detached worktree at 5d9cc98, same probe):

```text
verdict: "B5-PRESENT"
before: {"msgs":2,"loading":false,"text":"fixture user message fixture assistant reply "}
after:  {"msgs":0,"loading":true, "text":"Loading session..."}
pageerrors: []
```

The probe reproduces B5 on the baseline and passes on the fixed tree, so the
finding is genuinely fixed, not masked by environment luck.

### 2.3 Real-hub targeted reconnect probe (reviewer-authored, /tmp only)

Booted a real hub (`pi -e tau-web --mode rpc`, same pattern as `deep_ui.py`),
logged in, previewed a real live TUI (Samsung-F-Custom-ROM session), then
logout → login while the preview stayed pinned, then a normal page reload:

```text
preview ok        {"msgs":23,"loading":false,"banner":" Previewing “<skill name=\"grill-with-d…
after login       {"msgs":23,"loading":false,"banner":" Previewing …"}   # transcript intact
after reload      {"msgs":23,"loading":false,"banner":" Previewing …"}   # #session pin rejoins
{"errors": [], "pageerrors": [], "verdict": "REPRO-FIXED"}
```

This is the acceptance repro (logout/login over a drivable live TUI) and the
`#session=<basename>` reload-rejoin, on a real session store.

### 2.4 Stock deep-UI pass (against the final tree)

`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui TAU_REVIEW_REPO=... scripts/review-loop/deep_ui.py`
(uv Playwright + cached chromium, real hub, 19 steps, 53s):

- `errors: []`, `pageerrors: []`.
- `reload-rejoin {same_hash: true, user_bubbles: 1}` — normal `#session=`
  reload rejoins the same backend and renders the PONG history.
- `logout-login-roundtrip` completed; `nav-timing {msgs: 22}` after it.
- `live-preview` rendered the real live TUI banner; `mobile {pageerrors: []}`,
  no horizontal overflow.
- Only console 401s before login (expected auth noise); no failed requests.
- Screenshots inspected: pre-logout live preview (`11b-live-preview.png` from
  the baseline-time run) shows a fully populated live transcript + banner;
  reviewer's own `after-login.png` in `/tmp/t4-stub-fixed/` shows the fixture
  transcript intact after the logout/login round trip.

## 3. Regression checks

- **Preview/drive semantics:** `previewAttach` still passes `{preview:true}`
  (no `bindHeadless`), keeps the `uplinkActive` same-port early return and the
  `uplinkAttachPending` guard; only the same-session branch gained a reload.
- **Driven view reconnect:** still early-returns (`uplinkActive`/pending) and is
  repopulated by the re-attach `mirror_sync`; the new early-paint guard
  additionally avoids wiping a driven transcript with 'Loading session...'.
- **Headless/pinned non-live path:** unchanged — early paint → `found` branch →
  `switchSession`; H3/H6/D5 pass.
- **Convergence/ghost logic and attach/detach/banner paths:** diff touches only
  the two hunks listed above; H8/H9/D1 pass; deep-UI banner states render.
- **No pageerror/console regression:** deep-UI and both probes show
  `pageerrors: 0`.
- **No stale-first-paint regression:** `sidebar.setActive` + `renderCurrentSessionCard()`
  still run unconditionally in the early block (identity/card stay correct);
  only the destructive clear is guarded.

## 4. Issues

### Blocking

None.

### Nits (non-blocking, follow-ups)

1. **`public/app.js:2998-3004` — redundant Drive on the already-active session now
   flashes 'Loading session...'.** `switchSession()` unconditionally clears the
   message list and paints the placeholder before fetching, so a click on the
   live row for the session already on screen (and the reconnect path itself)
   still shows a transient Loading placeholder. The task explicitly allowed
   `switchSession({preview:true})`, and the transcript settles correctly, so
   this is accepted behavior — but a "lighter reload" that fetches history
   without clearing first would make reconnect truly flicker-free. Same
   observation applies to `restoreSessionFromUrl`'s early guard: it avoids the
   first wipe, but `switchSession` then clears anyway.
2. **`public/app.js:2180-2245` — history-fetch failure leaves the placeholder
   forever.** `switchSession`'s inner `catch (e)` only logs; with the new call
   site, a transient fetch failure during reconnect/Drive-click now leaves the
   view on 'Loading session...' (the outer catch renders 'Failed to switch
   session' only for errors thrown outside the inner try). Pre-existing, but
   newly reachable from a formerly non-destructive path; consider rendering an
   error or keeping the old transcript on fetch failure.

No behavioral, UI, or test regression found; the two items are hardening
follow-ups, not blockers.

VERDICT: PASS-WITH-NITS
