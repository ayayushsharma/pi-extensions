# pi-hub UX flows, findings & recommendations

How this doc is built: scripted Playwright flows drive the real client
against the real hub (seeded store + live mirror where noted), every
finding below was reproduced in the UI and screenshotted before it became
a test case or a recommendation. E2E pins live in `tests/e2e.mjs` (E15+);
the case matrix in `docs/testing.md` (§U) is the index.

Run them: `PI_HUB_CHROME_BIN=$(echo ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome)
node tests/run.mjs --e2e` (also honoured by the plain `chromium.launch`
fallback when no system Chrome exists).

## 1. Scripted user flows (all pass)

| Flow | Steps | Pins |
|---|---|---|
| F-home | Cold load, no tabs/hash → welcome, sessions listed, composer disabled with "Pick or start a session…" | E1, E18 |
| F-resume | Click session row → tab opens, transcript renders, card shows runner, composer shows session model, `?limit` paging via Load-earlier | E2 |
| F-compose | Focus input → `/` palette lists commands → Esc clears | E3 |
| F-new | New-session picker browses cwd → starter `/ask` delivered → dialog answered → tab + file discovery | E4, E5 |
| F-dialog | `/askselect` → select card → answer `beta` → `DIALOG-beta` in transcript | E6 |
| F-drive | Mirror dials in → live row → preview banner, input disabled → Drive → composer enabled, model list via TUI → Detach → preview again → mirror death clears row | E8–E8f |
| F-kill-resume | Card X → confirm → session closed (tab removed, homepage, hash cleared) → reload still closed → sidebar reopen resumes | E9–E9d |
| F-tabs | Two sessions → two tabs → close active → next tab binds (hash/card/transcript follow) → close last → homepage | E15 |
| F-backend-kill | Close tab (runner survives) → Headless-backends row X → confirm → Cancel keeps / Confirm kills quietly | E16, E17 |
| F-model-think | Model menu filters (fzf-style) and lists models; thinking menu renders the bound model's level set (5 for muse, 7 for haiku); pill follows the switch | E19, E21, E22a–c |
| F-touch | 390px + touch → drawer opens → session ⋯ taps open the context menu with no hover | E20 |
| F-rename-delete | Fork → right-click → Rename (inline) → title updates → Delete → confirm → file gone from disk | E10 |
| F-flap | Offline → online → status returns to Connected, no client errors | E11 |
| F-files-settings | File panel jailed (up disabled at root); settings themes + server info | E12 |
| F-auth | 401 → login overlay → login → sessions listed | E14 |
| F-titles | Tab + card show the store's prompt-derived title; a fresh session is "new session" until prompted; live/back-end rows never show `.jsonl` | E5b, E25, E33, E34a |
| F-live-block | Mirror dials in → LIVE TERMINALS first in the sidebar (even when tabbed) + Drive card on home → preview → detach | E34a–E34e |
| F-compact-nudge | Over-budget ctx pill turns into a confirm→compact button; healthy pill is inert | E30, E30b |

## 2. Bugs found by driving (fixed, with tests)

| ID | Finding | Fix | Test |
|---|---|---|---|
| UX-1 | Closing the **active** tab never switched sessions. `closeTab` compared `state.activeKey === key` **after** `removeTab` had already moved `activeKey` to the next tab, so the clear/rebind branch was dead: the closed transcript stayed on screen under the newly-"active" tab, hash stale. Reproduced with two tabs (`probe-closetab.png`: one tab left, transcript + hash of the closed one). | Capture `wasActive` before `removeTab`; on active-close clear + `activateTab(nextKey)` or homepage. Also removed a duplicated `bound: null` key. | E15 (+E15b/E15c) |
| UX-2 | Sidebar "Headless backends" row X killed a backend with **no confirmation**, while the session-card X confirms. One stray click could end a running agent. | Sidebar `closeRunner` now passes `confirm: true`. | E16 (+E16b cancel keeps backend) |
| UX-3 | Killing an **unbound** backend toasted "Backend closed — resume from the banner to continue" when no banner exists (bound session untouched). Misleading; screenshot showed the toast over a healthy session. | Toast mentions the banner only when the killed runner was the bound one. | E17 (+E17b) |
| UX-4 | Row actions (session ⋯, backend X) are `display:none` until `:hover` — unreachable on touch devices. No rename/fork/delete/favourite possible on phones (context menu is right-click only). | `@media (hover: none) { .sb-row .row-actions { display:flex } }`. | E20 (tap opens menu) |
| UX-6 | Saved theme/display prefs were never applied until Settings opened (`applyPrefs` only ran on open/toggle). A saved theme or wrap pref silently did nothing on cold load. | `boot()` now calls `settings.applyPrefs()` before first paint. | E28b |
| UX-8 | Tool cards showed absolute session paths (`/home/ayush/…/store.js`) as the summary hint — pure noise, worse on phones. Bash commands were fine (they are the hint). | `shortenPath()` (cwd-relative, else `~`): history and live cards pass the session cwd; full path kept in the summary `title`. | E31 |
| UX-9 | The 147%-ctx pill was a dead readout: pi reports genuine over-budget usage and the UI offered no recourse (verified: `contextUsage.percent: 147.35`, `isCompacting: false`). | At ≥90% the pill becomes a button → confirm → `compact`; inert otherwise (also guards while streaming/compacting/unbound). Compaction progress itself was already first-class (pill + inline messages). | E30/E30b |
| UX-10 | **Stale assets disguised as broken UI.** `/css/app.css?v=2` and `/js/app.js?v=2` are served `Cache-Control: immutable, max-age=1y`, but the `?v=2` literal in `index.html` was never bumped while every JS/CSS file changed. The browser then keeps year-old CSS/JS while the `no-cache` HTML updates — old styles + new markup = elements that are present, clickable, and invisible (and submodules, which revalidate by ETag, drift out of sync with `app.js`). | `index.html` now carries `?v=__ASSETV__`; the shell handler stamps in a live version (newest mtime under `public/`, 1s cache) with `no-cache` + ETag on the HTML. Versioned assets stay immutable; any edit changes the URL, so a stale cache can never be paired with fresh HTML again. | H12a–H12e |
| UX-11 | Always-visible row actions on touch (`@media (hover: none)`) overlaid the session title — titles clipped mid-word under the star/⋯ buttons (visible in the phone screenshot). | The row reserves the actions' full width (`padding-right: 72px` via `:has(.row-actions)`; 4px inset + 12px gradient pad + 2×24px buttons + 2px gap), so titles ellipsize cleanly. | E32 |
| UX-12 | **File names leaked into the UI as titles.** A fresh session's tab/card was renamed to the discovered `.jsonl` name (`adoptRunnerFile`, the `session_file` handler, and the tab-strip fallback all used it), and live/backend rows fell back to a path basename. A session you just prompted showed as `2026-10-18T…jsonl` instead of its title. | New `titleForFile()` + `adoptSessionTitles()` (run on every store refresh) adopt the prompt-derived title and treat the filename stem as "no title"; a fresh session stays "new session" until its first prompt names it; live rows fall back to "Live TUI", backend rows to `cwd · pid`. Never a `.jsonl` name. | E5b, E25, E33, E34a, E34e |
| UX-13 | Live TUIs were buried: the section sat mid-sidebar, was hidden whenever a live session was open in a tab, and did not exist on the home screen at all. | Dedicated **Live terminals** block on top of the sidebar (accent header + icon, always listed even when tabbed), plus a home-screen card with a one-click **Drive**. | E34a–E34e |
| UX-14 | **Closing the current session was not durable.** The card X killed the backend and kept a dead tab; on reload the tab (or a stale `#s=` hash, when the fallback tab could not bind) re-bound the session and spawned a fresh child — the session came back from the dead. | Card X now closes the session: backend stops, its tab is removed, the hash is cleared before any fallback switch, and the UI returns to the homepage. Reopening is an explicit click in the sidebar; the transcript stays on disk. Unexpected deaths (crash, process-list kill) still surface the "Session ended → Resume from disk" banner. | E9/E9b/E9c/E9d |
| UX-15 | A TUI could not find a hub whose socket was not at the default path (dev hubs with `PI_HUB_DIR`), so "Live terminals" stayed empty and live sessions looked unsupported. | The hub writes `~/.pi/agent/pi-hub/hub.json` (`sock`, `port`, `pid`) on start and withdraws it on graceful stop; the mirror uses its configured socket if present, else the advert (ignoring a stale one whose pid is gone). | D5, D6, D7 |
| UX-16 | Settings was a cramped 640px card with three pill tabs, a flat theme list of three colour dots and raw checkboxes — no descriptions, no grouping, and twelve plausible palettes had no representation. | Two-column sheet: vertical icon rail (horizontal strip on phones, full-screen sheet), panes with title + description, grouped field rows, restyled native switches, theme tiles with palette previews grouped Light/Dark (6+6), and a server pane as a definition grid + process list + logout. | E12b–E12b5, E12c1–E12c3, E13c |
| UX-17 | The session titlebar was a full-width sibling above the shell, so its title sat behind the sidebar and opening a session shoved the sidebar down 33px; "Load earlier messages" hugged the left edge of a centred column, and the titlebar had no separation from the transcript. | The titlebar now lives inside `main` (title + chip + close over the session column only, no sidebar shift) with a 1px `--border` hairline underneath; the load-earlier control is centred in the transcript column. | E37c, E37h2, E37h3, E2d1 |
| UX-18 | The composer collapsed to a single line (≈44px) at rest, so it read like a search box, and the mic/send cluster floated at its top — leaving a dead band underneath once the field was taller. | The textarea rests at two lines (`--composer-min-h: 68px`, `autoGrow()` clamps to it and never shrinks below), and the controls are anchored bottom-right inside the new `.composer-input` wrapper so they follow the last line. | E3d–E3g |
| UX-19 | The context pill was a dead readout: a percentage you could not expand, disabled below 90% and (past it) a one-click compact with no numbers to justify it. | The pill always opens a small card — percent, a slim usage bar, and Used / Limit / Left in tokens — refreshing stats on open, closing on Escape/outside click. The over-budget **Compact now** action moved inside the card (same confirm + guard). | E30–E30e |
| UX-20 | "Load earlier messages" and its "showing N of M entries" caption sat side by side, so the pair read as one long off-centre label and the caption looked like a suffix of the button. | Two centred lines: the button owns the first line, the count caption sits under it (`flex-direction: column`, `align-items: center`), with the caption in `--fs-xs`/`--text-3`. | E2d1, E37c |
| UX-21 | The statusline showed only the session directory, so two sessions in the same repo were indistinguishable by branch — the one thing that actually explains diverging edits. | The branch now sits beside the path (`git` icon + name, max 140px, hairline separator, full name in the tooltip). Served by `GET /api/git?cwd=…`, which reads `.git/HEAD` directly (5s cache, walks up 12 levels, follows worktree `gitdir:` files, shows the short sha when detached, 403 outside the file jail). Hidden when the cwd is not a repo. | G1–G5, E2b3 |
| UX-22 | The home screen scrolled horizontally (29px on every phone width) and, on short viewports, opened scrolled to its bottom — logo and title hidden. Cause: detail lines reclaimed hover-action space with `margin-right: -58px` even on rows with no actions (welcome recents), and the transcript's empty render called `scrollToBottom()` + left a hidden "New session" placeholder in the shared `#view`. | The reclaim is scoped to `.sb-row:has(.row-actions)`; `renderHistory([], null)` now means "clear only" (no placeholder, no scroll) and `scrollToBottom()` no-ops on an empty pane; the home view resets `#view.scrollTop`. Welcome also went responsive: stacked full-width actions under 430px, tighter rhythm under 640px height, compact composer under 480px. | E13a, E13b2 |
| UX-23 | The floating "↓ Latest" pill turned transparent on hover: the shared `.btn:hover` swaps the solid surface for `--hover`, a translucent wash that only reads correctly on a card, and this button floats directly over transcript text. | `.jump-latest:hover/:active` keep `--panel-solid` and layer the tint as a `linear-gradient` image on top, plus a `--border-3` edge, so the pill stays opaque while still reacting. | E29a |
| UX-24 | Sidebar icons were inconsistent (12/13/14/15px, some outlined buttons, some border-free) and the favourite star was **stroke-only in both states** — a starred row still showed a hollow star, so "Unfavourite" read as "add to favourites". Two bugs surfaced while pinning it: `icon(name, size).innerHTML` drops the sized `.icon` wrapper (the size argument was silently ignored in 9 call sites), and the Favourites block was emitted from inside the project loop, so starring the *only* visible session made the entire list disappear. | One sidebar icon language: 22px border-free targets with 13px glyphs (matching `#cs-close`), 12px section labels, 16px header actions; row action icons now append the icon node instead of injecting its HTML. New `starFill` glyph: starred = filled accent star (and it stays visible on hover-capable devices, with the menu dots appearing on hover), unstarred = outline; the duplicate title-line star is gone. Favourites render before the project loop, so a starred sole session stays listed. | E25b, E26d, E12h |
| UX-25 | After installing pi-hub for real, a TUI still showed nothing under Live terminals: a **stale `hub.sock` file** from an earlier hub (killed hard, file left behind) satisfied `existsSync`, so the mirror dialed the dead path forever instead of using the advert. | Socket choice is now connection-tested, not existence-tested: `HubSocketClient` takes a candidate list (configured path, then the advert's live socket) and walks it on every dial attempt, so a dead file is skipped in milliseconds and a hub that starts later is picked up on the next retry. | D6b, D5, D6 |
| UX-26 | The sign-in card was a bare form: plain `<h1>`, unlabelled-looking fields, a permanently reserved error line, no way to check what you typed, no feedback while the request ran, and no logo. | Rebuilt as a proper auth card: 64px logo tile (the pi-hub mark) + name + "Sign in to this hub", labelled fields with focus rings, a password reveal toggle (`aria-pressed`), inline error that takes no space when empty, a full-width submit that shows "Signing in…" while in flight, and a quiet privacy footer; user field is focused when the wall appears. | E14e–E14g |
| UX-7 | Favourites were keyed on `session.filePath` — a field the server never sends in listings. Every session shared the key `undefined`: starring one session starred **all** of them, the `live` chip on owned sessions could never appear, and Copy-path fell back to a bare basename. Found because E26 showed two rows after starring. | New `favKey()` (`dirName/file`, matching search-hit pairs); `liveOwned` compares by path suffix; Copy-path falls back to `dirName/file`. Old stored keys silently stop matching (0.1.0, re-star once). | E26/E26b |
| UX-5 | Activating a tab **duplicated** it. `activateTab` on a tab with a runner rebound via `bindRunner`, which always minted a runner-keyed tab (`r:…`, bare-filename title, empty dirName → hash `#s=/file`) instead of updating the file tab. Found because E15b showed the right session under the wrong title/hash after the UX-1 fix. | `bindRunner` takes the calling tab and `applyBound` reuses its key/title/dirName. | E15b/E15c |

## 3. Verified already-good (asked about, confirmed in code + UI)

- **Greyed-out input with no session (ask #8).** Implemented: `composer.render` disables input/send/attach when unbound, binding, previewing, dead, or offline, with per-state placeholders ("Pick or start a session…", "Preview only — press Drive to take over", "Session ended — resume to continue", "Reconnecting…"). Pinned by E18 (home) and E8b/E8e (preview). No work needed.
- **Favourites render first (ask #10).** The Favourites block is the first section inside `#session-list`, above all project groups (probed section order: `["Favourites", <project>]`). It only drops below the transient runner blocks (running tabs/terminals/backends) and only when those exist. See R-6 for the remaining nit.
- **Kill-last-tab shows the homepage (ask #7, tab half).** `closeTab` on the final tab clears bound/transcript and sets `view: "welcome"`; pinned by E15c. The *backend*-kill path intentionally keeps the dead transcript with a "Session ended / Resume from disk" banner (transcript preservation beats a blank page; resume is one click) — E9/E9b. Decision, not a bug.

## 4. Recommendations (not yet built — acceptance criteria double as future tests)

Priority order; each is a small, testable change.

| ID | Recommendation | Rationale | Acceptance (future E-case) |
|---|---|---|---|
| R-1 | **Model menu: fuzzy search.** DONE — filter input atop `#model-menu` (`.menu-search`), live narrowing over name/id/provider, Enter picks top match, Esc closes. | Scales to 50+ models; matches existing palette UX. | E21/E21b |
| R-2 | **Per-model thinking levels.** DONE — thinking menu queries `get_available_thinking_levels` for the bound model and renders exactly what the backend offers (probed: this pi returns `minimal…xhigh`, no `off`/`max`); static list survives as the fallback for unbound/failed queries. | Prevents setting a level the model ignores; "correct thinking level in place". | E19b (server shape), E22 (follows model switch) |
| R-3 | **Suspected steer+queue double-send.** While streaming, `send()` both `steer`s the text (pi queues it internally) **and** `addQueue`s it locally — and `agent_end` pops the local queue into a fresh `prompt`. One user message likely reaches the model twice. Needs an E7-gated (real model) test to prove. | Duplicate model calls cost money and confuse. | E23 (gated): steer during a run → child receives exactly one post-turn message. Until then: pick one path (steer OR queue, not both). |
| R-4 | **Live-terminal distinction (ask #1).** DONE — live rows get `.live-row` (accent edge) plus the shared `chip live` badge in Running-terminals, Currently-running-tabs, and session rows already had it. | At a glance: what is a terminal I can drive vs a headless I own. | E24 |
| R-5 | **Backend row identity (ask #9).** DONE — rows resolve the session title from the on-disk store by `absFile` (same string as tab titles); sub-line shows full `cwd · basename`, truncation removed. | Rows currently unidentifiable when titles matter. | E25 |
| R-6 | **Favourites: dedupe + affordance (ask #10 cont.).** DONE — favourited sessions are excluded from project groups while the Favourites block shows (search still shows everything), and every session row carries a one-click star (`.fav-btn`, `aria-pressed`) next to ⋯. | Halves long-list noise; starring becomes discoverable. | E26/E26b |
| R-7 | **Icon/button placement + sizing pass (asks #2/#3).** PARTLY DONE — fixed this pass: `#sidebar-collapse` was rendering **two icons** (duplicate append, the « ‹ cluster), tab-close had an 11 px hit area (flex-shrink; now `flex: none` + 22 px), "Load earlier" now aligns with the transcript column instead of floating centred over the pane, `#sidebar-toggle` got a title, and the 390 px composer reserves 88 px for the action cluster with 36/32 px buttons and ellipsizing pills. Remaining nits: header icon affordances could carry visible labels in a wider layout; settings/viewer headers unify. | Death by a thousand cuts; each is cheap alone. | E37a–E37d |
| R-8 | **Text-wrap option (ask #4).** DONE — `wrapCode` display pref (Settings → Chat, beside the other display toggles), applied via `html[data-wrap-code]` and persisted; boot applies all prefs before first paint. | Phones + narrow panes; accessibility. | E28/E28b |
| R-9 | **Code-block copy parity.** DONE — fenced blocks render a header row (language + Copy, same pattern as tau-web) wired to the existing clipboard helper. `testing.md` R2's copy-button demand now holds for fences. | Copying code is a core chat-UI action. | E29 (lang + clipboard readback) |
| R-10 | **Resume with a dead cwd refuses to open.** Deep-linking a session whose recorded cwd no longer exists fails closed (`invalid cwd…`) instead of falling back to the hub default cwd (C2 regression vs tau-web, found during the screenshot comparison). | Old sessions (the ones you most want to resume) die with moved/deleted directories. | E30: seed session with bogus cwd → opens, banner notes the fallback cwd. |
| R-11 | **Dead code + small hygiene.** DONE — `renderImages()` stub and its call removed; the doubled `show(refs.vtabs, …)` collapsed to one call; the tab-strip fallback no longer prints a file name; the duplicate collapse icon (R-7) was the same class of bug. | Keeps the "one obvious path" codebase honest. | E37a |
| R-12 | **Unify backend-row tabs with file tabs (residual of UX-5).** DONE — `runnerTabHint()` maps a runner that owns a session file onto that file's tab key, so the backend list, the session list and the tab strip converge on one tab; live/new runners keep their runner key. | One tab per session, always. | E36 |

## 5. Manual checklist (eyes-on, per release)

1. Two tabs → close active → transcript, card, hash all follow (E15 automates; eyeball the transition).
2. Kill flows: card X, sidebar X, Cancel vs Confirm, bound vs unbound toasts (E9/E16/E17 automate; read the toast copy).
3. Phone: drawer open/pick/close, tap every ⋯, composer above the keyboard, no horizontal overflow (E13/E20 automate).
4. Themes × (light/dark): status dot stays traffic-light, banners readable, code contrast.
5. Fresh-seed run: delete all sessions → "No sessions on disk yet" + working New-session.
6. Long-session: 10k-entry file → windowed history, Load-earlier anchor, no jank.

## 6. Handoff — session state, next steps (2026-10-18)

Written for a fresh session: everything below is current as of the last
verified run.

### Verified green

- Unit **6/6** (`npm run test:unit` or `node tests/run.mjs --unit`, ≈0.2 s) —
  Node strips the `.ts` types, so `tests/unit/protocol.test.ts` imports the lib directly
- Integration **45/45** (`node tests/run.mjs`, ≈6 s)
- E2E **74/74** (`PI_HUB_CHROME_BIN=… node tests/run.mjs --e2e`, ≈30 s;
  `--e2e` replaces integration, so run both for a full gate)
- `--all` 126 checks / ≈64 s (unit + integration + e2e + firefox smoke; firefox SKIPs without system Firefox)
- Live dev hub: `http://192.168.1.6:8292` (pid in `/tmp/pi-hub-dev-8292/`),
  started with `tail -f /dev/null | env TAU_DISABLED=1 PI_HUB_PORT=8292 … pi -e pi-hub --mode rpc`.
  Client-only changes need no restart — the shell stamps a fresh `?v=`.

### Uncommitted working tree (needs review + commit)

`git status` in the repo root: `pi-hub/` modified — `README.md`,
`docs/testing.md`, `docs/PLAN.md`, `extensions/lib/hub/http.ts`,
`extensions/lib/hub/ws.ts`, `extensions/lib/protocol.ts`,
`public/{index.html,css/app.css,js/**}`, `tests/{e2e,integration}.mjs`;
untracked `docs/UX.md`. Version still `0.1.0`. Nothing else in the monorepo
was touched (tau-web is untouched).

### Semantics decided this session (do not re-litigate silently)

- **Close = durable.** Card X stops the backend *and* removes the tab,
  clearing the `#s=` hash before any fallback switch; reload stays on the
  homepage. The "Session ended → Resume from disk" banner is only for
  *unexpected* deaths (crash, process-list kill).
- **Titles only.** Tabs/cards/rows show the store's prompt-derived title;
  a fresh session is "new session" until its first prompt; live runners
  without a title are "Live TUI"; backend rows show `cwd · pid`. The string
  "new session" and filename stems are the only placeholders.
- **Live block.** "LIVE TERMINALS" is the first sidebar section (listed even
  when open in a tab) and a Drive card on the home screen.
- **Assets.** `index.html` carries `?v=__ASSETV__`; `serveShell` stamps the
  newest mtime under `public/` with `no-cache` + ETag, so immutable
  `?v=` caching can never pair stale CSS/JS with fresh HTML. Never hardcode
  a version literal again.
- **Model/thinking.** RPC mode sends no `model_select` event; after
  `set_model`/`set_thinking_level` the client re-reads `get_state`
  (`refreshSessionState`). Thinking levels come from
  `get_available_thinking_levels`, static list only as fallback.

### Ordered queue — what is left to build

1. **R-3 steer+queue double-send** (correctness, needs a decision first:
   mid-run message should *steer* the current turn or *queue* for the next —
   implement exactly one; today both happen).
2. **R-10 dead-cwd resume** (correctness; decide silent fallback vs. a
   visible "cwd missing → opened in ~" banner, then allow `bindHeadless` to
   fall back to the hub default cwd).
3. ~~R-12 one tab per session~~ — DONE (`runnerTabHint`, E36).
4. **R-7 placement/sizing** — first pass DONE (double icon, tab-close hit
   area, load-earlier alignment, 390 px composer, E37a–d). Remaining nits:
   visible labels for header icons in wide layouts, settings/viewer headers.
5. ~~R-11 hygiene~~ — DONE (`renderImages` stub, doubled `show`, tab fallback).
6. **Tail-read history** (PLAN P3 budget): `readWindow()` still reads the
   whole JSONL; needs a reverse chunk reader for 10k-entry files.
7. **Test debt**: unit coverage now covers the wire helpers *and* the session
   store; LRU/TTL/pool-cap are still integration-only; `tests/cases.json`
   registry + meta-test missing; e2e should auto-discover a Playwright Chromium
   when system Chrome is absent; the Playwright tier is 13 s at `-j4` (11
   parallel groups) — the last gap to the 5 s target is per-group boot cost.
8. **Stray session file per resumed bind (found while splitting the tests).**
   pi creates a throwaway session file at child startup; the hub then calls
   `switch_session` to the real one, leaving an empty `.jsonl` behind and, until
   the `resume()` fix, an index/client entry pointing at it. Fix direction:
   spawn the child with the session already open (`pi --session <abs>`) so no
   switch and no stray file. (The `resume()` identity-event fix is in.)
8. **Deployment / flip (P7)**: `deploy/runit/{run,log/run}` are ready —
   install service, `sv down tau-web` → `sv up pi-hub`, verify tunnel on
   :12045, remove tau-web from `~/.pi/agent/settings.json` packages.

### Fastest repro for each fixed class

| Symptom | Where it came from | Case |
|---|---|---|
| Elements visible-but-clickable / phantom UI after a deploy | stale immutable assets vs fresh HTML | H12a–e |
| Tab title shows `…jsonl` | `adoptRunnerFile` / `bindRunner` fallback | E5b, E33, E34c2 |
| Session reappears after reload | stale `#s=` hash on close | E9c |
| Pills show the old model | no `model_select` over RPC | E22c |
| Live TUI not visible | filtered out when tabbed | E34d |
