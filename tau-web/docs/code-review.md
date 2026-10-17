# tau-web code, security & performance review

Status: **complete — findings open** (fix scopes in §8; one review-fix landed,
§10). Reviewed as `tau-web` 0.1.0 on the working tree at 2026-10-17,
before any of the fixes below were applied. Line numbers refer to that
baseline — re-grep before editing.

Read with `docs/architecture.md` (system shape) and `docs/testing.md`
(harness layers). This review is not an ADR: nothing here is a design
decision until a finding gets its own ADR or a fix PR.

## 1. Summary

| Class | Count | IDs |
|---|---|---|
| Functional bugs | 9 | B1–B9 |
| Security findings | 14 | S1–S14 |
| Performance findings | 7 | P1–P7 |
| UX polish | 3 | U1–U3 |
| Test-harness bug (fixed) | 1 | B10 |

Severity of the headline items:

- **B1 / S1 — stored XSS** via session-file image blocks (proven PoC).
  Needs a crafted `.jsonl` opened by the user, then runs as the hub
  origin: can call `set_auth(false)` (persisted), `/api/open`, file
  reads, arbitrary-path `export_html`.
- **B2 — a literal `%%CODEBLOCK_0%%` line in model output breaks
  markdown rendering** (live: uncaught TypeError; history: silent
  transcript truncation). Easy to hit.
- **B3 — a failed headless spawn leaves a permanently dead binding**
  that `start_session` happily rejoins; prompts disappear silently.
- **B4/B5/B6 — three new-session / reconnect UI defects** visible in the
  deep-UI run: a red "Failed to switch session: Not found" on every New
  Session, a transcript stuck on "Loading session…" after any WS
  reconnect, and a fresh session card that reads "No session".
- **S2 — `TAU_USER`/`TAU_PASS` are inherited by headless children**, so
  any prompt injection that reaches a bash tool can read the web
  password with `printenv`.
- **P1 — `GET /api/sessions` costs 0.31–0.41 s** (95–98 sessions) and is
  polled every 15 s by the hub shell. Biggest single performance win.

## 2. Method & evidence

Everything below was verified against a real hub (`pi -e ./tau-web
--mode rpc`, one dev port per run, stdin held open):

| Activity | Result |
|---|---|
| Code read | all of `extensions/*.ts`, `extensions/lib/*.ts`, `public/*.js`, `public/hub/*`, `tests/*` (~18k LOC) |
| Project e2e (`node tests/run.mjs`, Playwright path) | **16/16 pass** |
| Real-hub e2e (`TEST_REAL_HUB=1 … --filter H6,H10,H11`: real `pi`, real child, real model) | **3/3 pass** |
| Playwright deep-UI run (uv playwright 1.64 + cached chromium): login → new session → real model round-trip → reload rejoin → settings → palette → file viewer → live-TUI preview → logout/login → mobile 390 px | **19 steps, 0 pageerrors, 0 exceptions** |
| HTTP/WS adversarial probes (auth, rebinding, traversal, jails, symlinks) | **26/26 pass** |
| PoCs | XSS, markdown crash, spawn-failure zombie — all reproduced |

Measured timings (this box, 95–98 sessions): `/api/sessions` **0.31–0.41 s**,
`/api/search` 43 ms, `/api/sessions/summaries` 68 ms, `/api/processes`
13 ms, `/api/instances` 2 ms. Model round-trip 2.9–4.8 s with smooth
streaming.

Deep-UI artifacts (ephemeral): `/tmp/tau-review/deep-ui-report.json`,
`/tmp/tau-review/shots/*.png`, `/tmp/tau-review/security-probes.sh`.
Reproduction recipes are in §9.

## 3. Functional bugs

### B1 — 🔴 Stored XSS via session image blocks (see also S1)

History user messages rebuild images from session entries
(`app.js:3290`: `{data: b.source?.data || b.data, mimeType: …}`) and
`message-renderer.js:84-90` interpolates them raw into an attribute:

```js
img.data .startsWith('data:') ? img.data : `data:${img.mimeType||'image/png'};base64,${img.data}`
```

A crafted `.jsonl` in the session store executes arbitrary JS in the hub
origin. PoC (sandboxed `PI_CODING_AGENT_SESSION_DIR`) returned
`document.body.dataset.xss === "yes"` with zero page errors; payload
used an `image` block whose `data` is `"><img src=x onerror=…>`.

Impact beyond a normal tab: same-origin JS can persist auth-off
(`set_auth`, S8), launch local files (`/api/open`), read HOME files
(`/api/files/content`), and write arbitrary paths (`export_html`,
S3). Requires the user to open a crafted session file.

**Fix scope:** build image elements with DOM APIs (`thumb.src = …`) and
validate `mimeType ∈ VALID_MIME_TYPES` + base64 charset on the history
path. Small.

### B2 — 🔴 Markdown placeholder collision crashes rendering

`markdown.js` extracts code/math blocks into `%%CODEBLOCK_n%%` /
`%%DMATH_n%%` markers and substitutes them back by index. Source text
containing a marker line breaks the lookups:

```
renderMarkdown('%%CODEBLOCK_0%%') -> TypeError: Cannot read properties of undefined (reading 'lang')
renderMarkdown('%%DMATH_0%%')     -> TypeError: Cannot read properties of undefined (reading 'replace')
renderMarkdown('%%MATHX0%%')      -> "undefined"
renderMarkdown('%%ICODE0%%')      -> "undefined"
```

Browser PoC (assistant message whose first text block is
`%%CODEBLOCK_0%%`, second block `SECOND-BLOCK-REACHED`): the second
block never renders; the console shows
`[App] History fetch error: TypeError: Cannot read properties of
undefined (reading 'lang')`. Live streaming is worse — the exception
escapes `handleMessageEnd` and the client-error beacon fires.

**Fix scope:** guard `if (!block) …` for both block types (render the
line as text) and pick a marker user text cannot contain. Tiny.

### B3 — 🔴 Failed headless spawn poisons the binding forever

`RpcSession` (`headless-bridge.ts:56-77`) wires cleanup to `'exit'`
only; Node emits `'error'` + `'close'` and **never `'exit'`** when
spawn fails (verified). `HeadlessRegistry.create`'s `onExit` therefore
never removes the `ManagedHeadless`, and `attach()` rejoins it by
`sessionKey`:

```
start_session {cwd:"/nonexistent-cwd-xyz"}  -> success, sessionKey "…::new-…"
error event: "spawn pi ENOENT"
start_session {same sessionKey}              -> success again (dead entry)
/api/headless/status                         -> { isActive:false, isWorking:false }
```

Prompts are then dropped silently (`RpcSession.send` no-ops when stdin
is not writable; `command()` still returns `ok`).

**Fix scope:** treat `'error'`/`'close'` as terminal with an idempotent
`onExit`, validate `cwd` before spawning, and fail the `start_session`
ack when the child did not come up. Small/medium.

### B4 — 🟠 New Session always shows a red error

`app.js:2243` still POSTs to `/api/sessions/switch`, **a route the hub
does not implement**. Every fresh session renders
`Failed to switch session: Not found` under the welcome (screenshot
`02-new-session.png`). Binding is already owned by the WS
`start_session` / `mirror_sync` path; the fetch is legacy tau.

### B5 — 🟠 WS reconnect wipes the transcript and sticks on "Loading session…"

`restoreSessionFromUrl()` (`app.js:2760-2773`) clears the transcript
and paints `Loading session...` on every call, but when the pinned
session is a live TUI already present in `sidebar.activeSessionFile`,
`previewAttach()` (`app.js:2941-2988`) skips `switchSession()` — so
nothing repopulates the view. Reproduced with logout → login (final
desktop screenshot); the same happens on any socket drop/Wi-Fi flap
while viewing a live TUI.

**Fix scope:** only paint the early loading state when the active key
differs (or the transcript is empty), and reload history in the
already-active live branch.

### B6 — 🟠 Fresh session card/header says "No session"

After `#tab-new`, the deep-UI probe records `state: "No session"`,
`card: "New session"`, `title_bar_hidden: true` even though the backend
is bound and the hash is already pinned. The `session_file` event
updates the URL but never `sidebar.activeSessionFile` /
`mirrorActiveSessionFile`, which `currentConnectionInfo()` reads.

**Fix scope:** set the active view file on discovery and let the
existing signature-guarded `renderCurrentSessionCard()` repaint.

### B7 — 🟡 Dead protocol traffic from the current UI

`app.js:2240/2920/2929` still send `mirror_sync_request`, while P2
asserts the server intentionally ignores it ("dead frames stay
silent"). Harmless, but the current UI is itself a stale client.
Related: `pendingRequests` (`mirror-server.ts:586`) is declared and
never used.

### B8 — 🟡 Duplicate function declarations

`mirror-server.ts` defines `cwdToSessionDir`,
`lossyDecodeSessionDir`, `resolveHeadlessSessionPath` twice in the same
closure (`:811/:864`, `:820/:873`, `:823/:876`, with
`buildStateSnapshot` between them). Last-wins today; it will fail
`tsc` (`TS2393`) the day a tsconfig lands.

### B9 — 🟡 hub.sock lifecycle races

`HubSocketServer.start()` unlinks any existing socket path before
binding (`lib/hub-socket.ts:88`) — a second hub silently hijacks a live
hub's path. `stop()` unlinks unconditionally (`:175`) — an old hub
shutting down can delete a newer hub's socket. Same-UID/local only, but
"one hub" should not be this easy to break. Bind-unique-temp-then-rename
or an inode check fixes both.

### B10 — 🟡 Test harness: Playwright `waitForFunction` dropped its value (fixed, §10)

H3/H4/H5 failed (`assert: … undefined`) as soon as `playwright-core`
was resolvable; the CDP branch returns the matched value, the
Playwright branch did not. One-line fix applied in
`tests/browser.mjs`; the suite is back to 16/16 on the Playwright path.
Latent: `newPage()` always wraps the *same* page — fine for every
current test, but a future two-page test needs `ctx.newPage()` per
call.

## 4. Security findings

Verified strong (do not regress): cookie-only browser auth, HttpOnly +
SameSite=Lax, no `WWW-Authenticate`; `timingSafeEqual`; login backoff
(500 ms × failures, 10 min decay); Host/Origin rebinding gates with
explicit-port matching; traversal jails for sessions/download/rename/
fork/delete; headless session-path jail; kill-time re-fingerprint of
`pi` processes; hub-only uplink attach; 0600 socket in a 0700 dir.

| # | Severity | Finding | Where |
|---|---|---|---|
| S1 | High | Stored XSS via session image blocks (B1). Post-XSS reach includes persistent auth-off, file reads, `/api/open`, arbitrary-path export. | `message-renderer.js:88`, `app.js:3290` |
| S2 | High | `TAU_USER`/`TAU_PASS` are inherited by headless children (`env: { ...process.env, TAU_DISABLED:"1" }`). The child is a full agent; its bash tool can `printenv TAU_PASS`. Prompt injection → web-UI password leak. | `headless-bridge.ts:56` |
| S3 | Med | `export_html` passes client `outputPath` straight to `pi --export` → arbitrary file write (the HTTP export route is properly jailed). With XSS: overwrite settings/dotfiles. | `mirror-server.ts:1480` |
| S4 | Med | `/api/file/preview` and `/api/open` trust a string-prefix jail and follow symlinks. Verified: `secret.png → ~/.pi/agent/settings.json` served as `image/png` (200, full bytes). SVG is served inline, so a planted SVG document executes in the hub origin. | `mirror-server.ts:1736,2207,2808` |
| S5 | Med | Unbounded request bodies: `/api/login` and ~12 other POST routes accumulate with no cap (`/api/client-error` is the only capped one). Unauthenticated login POST is a memory-DoS lever. | `mirror-server.ts:1647…2478` |
| S6 | Med | No `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, or `X-Content-Type-Options` on any response. CSP is non-trivial here (inline handlers/scripts); frame + nosniff are free. | `serveStaticFile` |
| S7 | Low | `/api/client-error` is auth-exempt with no rate limit → log flood / disk fill. | `mirror-server.ts:1637` |
| S8 | Low | `set_auth` has no re-auth/confirm and persists `authEnabled:false` to settings — XSS becomes permanent auth-off. | `mirror-server.ts:1505` |
| S9 | Low | `loginFailures`, `apiAccessLog`, `hubDialogOwner`, `pendingDialogs` grow by key and are never evicted; pending headless dialogs survive the requesting client's disconnect. | `mirror-server.ts:104,107,180,990` |
| S10 | Low | WS server uses the default `maxPayload` and has no backpressure check; a slow client during a long stream buffers unbounded. | `mirror-server.ts:591,600` |
| S11 | Low | `/api/health` is auth-exempt **and** `Access-Control-Allow-Origin: *` → any page can read mode/version/uptime/platform. | `mirror-server.ts:1627` |
| S12 | Low | Basic auth on every API call has no backoff (only `/api/login` does); cleartext over plain LAN/Tailscale. | `checkWsAuth` |
| S13 | Low | In-memory cookie tokens never expire until restart (30-day cookie, no rotation). | `mirror-server.ts:100` |
| S14 | Info | `/api/files/mkdir` jails the target string but not a symlinked parent (`~/link → /etc` + `…/link/new` passes). The realpath hardening for S4 covers the intent. | `mirror-server.ts:2050` |

## 5. Performance findings (measured)

| Endpoint | Time | Notes |
|---|---|---|
| `GET /api/sessions` | **0.31–0.41 s** | parses every `.jsonl` fully + 3 subprocess `execSync` calls (`tmux`/`pgrep`/`lsof`) |
| `GET /api/search?q=` | 43 ms | full scan, early-exits at 30 results |
| `GET /api/sessions/summaries?cwd=` | 68 ms | per-project; already the better shape |
| `GET /api/processes` | 13 ms | `/proc` scan |
| `GET /api/instances` | 2 ms | |

- **P1 — `/api/sessions` full parse every 15 s.** `hub.js:396`
  (`setInterval(loadIndex/loadLive, 15000)`) plus connect/refresh/picker
  opens. That is ~1 full session-store parse every 2.5 s plus subprocess
  churn. Cache per file keyed `(path, mtimeMs, size)` with a 10–30 s
  TTL (invalidate on rename/delete/fork); gate tmux detection on
  `which tmux` once and give it a 5–10 s TTL. Biggest single win.
- **P2 — `pollInstances` every 5 s** (`app.js:3191`) is mostly redundant
  with the hub's `mirrors_changed` push (already handled). Lengthen to
  20–30 s as a safety net.
- **P3 — `serveSessionFile` returns all entries in one JSON**
  (`mirror-server.ts:2740`) while the client windows rendering at
  50/100. Add `?limit=&before=` so huge sessions don't ship/parse the
  whole log.
- **P4 — per-token `message_update` broadcast.** Coalesce deltas
  server-side (~30–60 Hz); the client already rAF-coalesces but still
  pays WS + JSON cost per delta.
- **P5 — `buildSessionInfoMap` stats every session file on each
  `/api/projects`.** Same TTL-cache pattern as P1.
- **P6 — KaTeX auto-render on every finalized message.** Gate on
  `content.includes('$')`; `renderMathInElement` is the heaviest DOM
  work in the renderer otherwise.
- **P7 — static assets revalidate on every load.** `?v=` URLs could be
  `Cache-Control: immutable` for a year. Minor.

None of these need a contract or visual change — they are caches and
batches behind the existing endpoints.

## 6. UX polish

- **U1 — mobile preview banner squeeze.** At 390 px the
  `Previewing "…"` text is crushed into a 6-line column while
  `Drive this TUI`/`Cancel` hold the right half (`style.css:955-1008`).
  At `max-width:768px`, give `.sb-text { flex-basis:100%; }` (buttons
  wrap to a second row) or `min-width:220px` to force wrapping. Applies
  to all banner variants.
- **U2 — B4's red error is sticky** until the next session switch;
  removing the dead fetch removes it.
- **U3 — fresh card/title state (B6)** should read `Headless runner`
  immediately; the title bar appears once the hash is pinned. The
  Settings process list scrolls (`max-height:240px`) but its last row
  looks clipped at the panel edge — a few px of bottom padding would
  read better. Cosmetic.

Desktop, mobile chat, sidebar, settings, palette, viewer and live
preview all rendered correctly; mobile had **0 px horizontal overflow**.

## 7. Verified good (regression guards)

From the deep-UI run and probes, all with zero page errors:

- login overlay → cookie session → WS handshake; logout revokes; forged
  cookie 401; 401-on-fetch raises the overlay; no native prompt.
- real model round-trip renders one user + one assistant bubble,
  thinking block, cost/context pills; `Working…`/abort chrome correct.
- reload with `#session=<basename>` rejoins the same backend, same
  hash, no duplicate transcript; H11 confirms no re-`switch_session`.
- live-TUI preview → banner → Cancel (relay snapshot + cancel path).
- settings version/uptime/process list; command palette; file explorer
  → viewer with highlighting; mobile layout.

## 8. Fix scopes (recommended order)

1. **`tau-web: fix stored XSS + markdown placeholder crash`** — B1,
   B2 (small, highest value).
2. **`tau-web: harden headless children`** — S2 (scrub child env), B3
   (close/error handling + cwd validation + honest ack).
3. **`tau-web: fix fresh-session and reconnect view state`** — B4
   (delete dead fetch), B5, B6, B7.
4. **`tau-web: session-store caching`** — P1, P2, P5.
5. **`tau-web: server hardening`** — S3–S6, S9, S10 (shared body-cap
   helper, realpath jail, export-path jail, WS `maxPayload`, security
   headers, map eviction).
6. **`tau-web: stream/transcript transfer`** — P3, P4.
7. Any of the above can fold in the B10 harness fix (already in the
   working tree) and U1–U3.

## 9. Reproducing this review

```bash
cd tau-web && npm install

# project suite (Playwright when playwright-core is resolvable, CDP otherwise)
node tests/run.mjs
TEST_REAL_HUB=1 node tests/run.mjs --filter H6,H10,H11
```

**Deep UI** was driven by a scratch Playwright script (uv-installed
playwright + cached/system chromium, login → new session → real model
round-trip → reload → settings → palette → viewer → uplink preview →
mobile). The durable contracts it exercised are already covered by the
e2e suite; the screenshots and the run report are ephemeral artifacts
(`/tmp/tau-review/…` on the reviewing machine) and are not checked in.

**Adversarial probes** (boot a real hub with auth and a sandboxed
`TAU_FS_ROOTS`):

```bash
# Host/Origin gates: 200 same-origin, 403 wrong Host/Origin
curl -s -o /dev/null -w '%{http_code}\n' -u tau:tpass -H 'Host: evil.example' \
     http://127.0.0.1:$PORT/api/sessions
curl -s -o /dev/null -w '%{http_code}\n' -u tau:tpass -H 'Origin: https://evil.example' \
     http://127.0.0.1:$PORT/api/sessions

# Traversal + jails
curl -s -o /dev/null -w '%{http_code}\n' -u tau:tpass \
     "http://127.0.0.1:$PORT/api/sessions/..%2f..%2fsettings.json"        # 404
curl -s -o /dev/null -w '%{http_code}\n' -u tau:tpass \
     "http://127.0.0.1:$PORT/api/file/download?path=/etc/passwd"          # 403

# S4 symlink follow: secret.png -> ~/.pi/agent/settings.json inside a root
ln -s ~/.pi/agent/settings.json "$TAU_FS_ROOTS/secret.png"
curl -s -u tau:tpass "http://127.0.0.1:$PORT/api/file/preview?path=$TAU_FS_ROOTS/secret.png" \
     -o leaked && head -c 40 leaked                                        # 200, JSON bytes
```

**In-browser PoCs:**

- **XSS:** write a session file whose user message has
  `{"type":"image","data":"\"><img src=x onerror=…>","mimeType":"image/png"}`,
  point `PI_CODING_AGENT_SESSION_DIR` at a throwaway store, open
  `/hub/#session=<file>`, then read `document.body.dataset.xss`.
- **Markdown crash:** `renderMarkdown('%%CODEBLOCK_0%%')` in the
  browser console (or a session file with that line as a whole assistant
  text block; the following block silently disappears).
- **Spawn zombie:** real hub, `start_session {cwd:"/nonexistent-cwd-xyz"}`
  over WS, then repeat with the returned `sessionKey` and watch it ack
  success while `/api/headless/status` reports inactive.

## 10. Review-driven fixes already applied

- `tests/browser.mjs` — the Playwright branch of `waitForFunction` now
  returns `handle.jsonValue()` like the CDP branch, so the "prefer
  playwright-core" path passes H3/H4/H5. (`tests/browser.mjs`, function
  `launchBrowser`.)

Everything else in this document was fixed by the review-fix loop — see §11.

## 11. Fix loop — final status (2026-10-17)

All 13 tasks in `scripts/review-loop/tasks.json` ran through an independent
coder (`opencode-go/muse-spark-1.3-contributor`, xhigh) + reviewer
(`opencode-go/deepseek-v4.1-flash`, max) pair, one git commit per passed task.
Final result: **13/13 passed, 0 failed** on branch `code-review-fixes`;
`node tests/run.mjs` = 16/16 on the final tree. `main` is untouched.

| Findings | Task | Verdict | Commit |
|---|---|---|---|
| B1, S1, B2 | T1 stored XSS + markdown placeholder crash | PASS-WITH-NITS | `10be427` |
| B3, S2 | T2 headless spawn failure + env credential leak | PASS-WITH-NITS | `2d9c6dd` |
| B4, B6, B7 | T3 new-session view state | PASS | `5d9cc98` |
| B5 | T4 reconnect transcript wipe | PASS-WITH-NITS | `a5987f8` |
| B8, B9 | T5 duplicate declarations + hub.sock takeover | PASS-WITH-NITS | `003556d` |
| S3, S4, S14 | T6 realpath jails + export path | PASS-WITH-NITS | `19b3acb` |
| S5, S7 | T7 body caps + beacon rate limit | PASS | `0232956` |
| S6, S11 | T8 security headers + health CORS | PASS-WITH-NITS | `ed4aa58` |
| S8, S12, S13 | T9 auth lifecycle hardening | PASS-WITH-NITS | `023f8a8` |
| S9, S10 | T10 leak cleanup + WS backpressure | PASS-WITH-NITS | `88ef361` |
| P1, P2, P5 | T11 session-store cache | PASS-WITH-NITS | `fb27a4f` |
| P3, P4, P6, P7 | T12 windowed transfer + stream coalescing | PASS-WITH-NITS | `749c413` |
| U1, U3 | T13 mobile preview banner | PASS | `869c318` |
| B10 | test-harness `waitForFunction` fix | pre-loop | baseline `6e0f9ea` |

Notes:

- T12's `fetchOlderHistory` epoch guard was failed twice by a reviewer on
  byte-identical code; a fresh review after fixing the reviewer harness
  (deepseek cannot accept images — the prompt no longer reads screenshots)
  confirmed the guard present and correct. The orchestrator now preserves a
  failed attempt as `docs/review-loop/logs/failed-T12.patch` and stashes it so
  the next task can never sweep it into its own commit.
- `PASS-WITH-NITS` means correct with optional follow-ups; the full ledger is in
  `docs/review-loop/reviewer-comments<NN>.md`. Main ones: `export_html`
  symlink/extension jail edges and missing regression tests (T6);
  history-fetch failure UX (T4); windowed-session cost pill, `?v=` bump and the
  exact-page-boundary "more on server" control (T12).
- New fixes run the same way: add a task to `scripts/review-loop/tasks.json`,
  then `python3 scripts/review-loop/fix_loop.py --only T<n> --commit --branch code-review-fixes`.

## 12. Markup & accessibility pass (hub shell)

Follow-up to §6: the hub's HTML was audited against what the DOM actually
renders, then fixed with **add-only** changes (no element removed, reordered,
renamed, or re-styled). Evidence that nothing moves is in the notes below.

Findings and fixes:

| # | Finding | Fix |
|---|---------|-----|
| M1 | `#toggle-show-thinking` had no `</button>` — the HTML parser implicitly closed it at the next `</div>`, so the toggle and everything after it in that row were siblings, not nested (an HTML-validity bug, invisible only because the CSS happened not to care) | closed the button; the settings row is now the DOM the source describes |
| M2 | 23 of 31 buttons had no `type` — inside a form they would have defaulted to `submit` | `type="button"` on all 32 |
| M3 | Three icon-only buttons (`#settings-close`, `#toggle-show-thinking`, `#toggle-auto-read`) had no accessible name | `aria-label` / `aria-labelledby` to their visible label; `role="switch"` + `aria-checked` on both toggles |
| M4 | Shell had no landmarks: sidebar, main column, chat header and file pane were all plain `<div>`s | `<aside aria-label>` / `<main>` / `<header>` / `<aside aria-label>`; `#tab-strip` and `#vtabs` are `role="tablist"` |
| M5 | The four overlays (settings, command palette, login, session home) were unnamed divs | `role="dialog"` + `aria-modal="true"` + `aria-labelledby`/`aria-label`; settings tabs are a `tablist` with `role="tab"`/`aria-selected`/`aria-controls` and `role="tabpanel"` panes |
| M6 | Model picker / thinking menu exposed no state | `#model-dropdown-btn`/`#thinking-btn` carry `aria-haspopup`/`aria-expanded`/`aria-controls`; the menus are `listbox`es with `role="option" aria-selected="true"` on the current model/level; the model search is a `combobox` wired to `#model-dropdown-list` |
| M7 | `dialogs.js` built modal dialogs (`ui.select`/`confirm`/`input`/`editor`, `confirmLocal`, `promptLocal`) as unnamed divs | one `makeDialogAccessible()` handle adds `role="dialog"`, `aria-modal`, `aria-labelledby` from the title row; notifications get `role="status"` |
| M8 | Login fields, session search, composer, command search, file-browser buttons had no accessible names | `aria-label` on each; `#proc-error`/`#login-error` are `role="alert"`, `#session-banner` is `role="status"` |

State is carried twice on purpose — the `on`/`active` class paints it, ARIA
exposes it — and a single `setToggleState()` helper keeps the pair from
drifting.

Proof of UI-neutrality (both captured on this branch):

- `/tmp/tau-a11y/fingerprint.mjs` (stub hub, 40 computed-style props + rects for
  every element, desktop 1280×800 and phone 390×844, animations frozen) renders
  **0 rect diffs and 0 style diffs** before vs. after across `boot` and
  `settings`; the three PNGs are byte-identical (md5).
- The one non-identical state pair in the wider 16-state sweep (`sidebar`,
  `home`, `file-sidebar`) reproduces **before vs. before** with the same pixel
  counts and bounding boxes — it is antialiasing noise of the animated status
  dots, not the edit.
- Only CSS rule in the codebase that keys off ARIA is the pre-existing
  `.login-reveal[aria-pressed="true"]`; no JS reads `role`/`aria-*`, so the new
  attributes cannot change layout or behaviour.

Regression guard: **H16** (`tests/e2e/h16-markup-aria.test.mjs`) audits the
served `/hub/` HTML (tag balance, duplicate ids, button `type`, accessible
names, labelled inputs, `alt`, dialog/switch/tab/listbox attributes with live
id targets) and then drives the live widgets (settings tabs, toggles, model
picker round-trip, thinking menu, session tab in strip + sidebar mirror),
asserting the ARIA state tracks the visual one. It fails on the pre-fix tree
(38 markup issues; `aria-selected`/`aria-expanded` absent) — see
`docs/testing.md`. `#model-dropdown-menu`'s structure is unchanged, so H15's
scroll/pin contract still holds.

## 13. Post-review smoke findings (2026-10-17)

Two pre-existing bugs surfaced on the phone after the fix loop, both present
on `main` since the unified UI landed, neither caught by the review or by
`node --check`.

| # | Symptom | Root cause | Fix | Guard |
|---|---------|-----------|-----|-------|
| N1 | Sidebar `+` → "Start new session" did nothing: no session created, picker closed, and on phones the drawer's overlay stayed over the composer so a prompt could not be sent ("new session + prompt does nothing") | `session-picker.js` `#sp-start` read `S.opts.onNew` *after* `closeSessionPicker()` had set `S = null` → `TypeError: Cannot read properties of null (reading 'opts')` inside the click handler. The drawer then stayed open because `onNew` never ran, so `resetToScratchView()`'s `closeSidebarOnMobile()` never fired | capture `onNew` before closing (`public/session-picker.js`) | H19 |
| N2 | Auto-compaction start (and the "Live session ended → Continue headless" affordance) threw `ReferenceError: scrollToBottom is not defined` in the browser; on the phone this was reported through `/api/client-error`. The compaction handler died after already flipping the header to "Compacting…" | `app.js` called `scrollToBottom()` as a free function, but it exists only as `messageRenderer.scrollToBottom()` / `toolCardRenderer.scrollToBottom()`. The identifier was never declared anywhere in the module's history | call `messageRenderer.scrollToBottom()` at both sites | H20 |

Both were reproduced live (phone-emulated Chromium against the running hub),
fixed, and re-verified end-to-end: picker start binds the session, closes the
picker/drawer, and a prompt sent afterwards streams its reply. H19 fails with
the old handler (the binding never changes, page error), H20 fails with the
old calls (unresolved `scrollToBottom`). Neither bug was introduced by the
review loop — `git show main:...` carries both verbatim.
