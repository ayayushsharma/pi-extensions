# tau-web end-to-end testing

How to test the hub the way it actually runs, with which doubles, and
what each case proves. Read with `docs/architecture.md` (system shape)
and ADR-014 (attach relay); protocol summary in `README.md`.

## 1. System under test

One hub process plus zero or more headless children, plus zero or more
live TUIs dialed in over hub.sock (ADR-014):

```text
browser ──HTTP/WS──▶ hub (`pi -e ./tau-web --mode rpc`, ONE PORT)
                          │ spawned stdio (JSONL)   │ hub.sock relay
                          ▼                         ▼
                     headless children         live TUIs (mirrors,
                     (`pi --mode rpc`,          driven via uplink)
                      one per WS)
```

Test layers, cheapest first:

| Layer | Serves UI | Backend behind WS | Proves |
|---|---|---|---|
| A. Static-only | `python3 -m http.server <port>` on `public/` | none (WS refused) | shell renders, disconnected fail-fast, no-JS-error baseline |
| B. Static + fake WS backend | same static | node fake speaking the WS contract (§4) | full client flow without a pi process: new-session happy/timeout, tabs, hashes |
| C. Stub hub | stub HTTP+WS (`tests/hub-stub.mjs`) | simulated headless round-trip + one fake live TUI answering the relay protocol | HTTP/WS contract without pi: health/auth/routing, attach relay, dead-frame silence |
| D. Full stack | real hub | real hub + real headless children (+ real dialed-in TUIs for attach) | headless round-trip, real relay, auth, dialogs (opt-in via `TEST_REAL_HUB=1`) |

Layers A–C run anywhere (CI-friendly, no TTY, no `pi` binary). Layer D
needs a real `pi` process. Browser cases need system Chrome. Any case
whose requirement is missing is reported as `SKIP (<reason>)` and the
run stays green; `TAU_STRICT=1` turns skips into failures for CI.

## 2. Environment contract

```bash
# Hub boot (dev). stdin MUST stay open — bare `pi --mode rpc </dev/null`
# exits immediately. Canonical port is 8192; use a dev port until verified.
TAU_MIRROR_PORT=<port> TAU_HOST=127.0.0.1 TAU_STATIC_DIR=$PWD/public \
  pi -e ./tau-web --mode rpc < <(tail -f /dev/null)
```

| Var | Test use |
|---|---|
| `TAU_MIRROR_PORT` / `PI_WEB_PORT` | per-run port; never 8192 in tests |
| `TAU_STATIC_DIR` | point at the working tree so UI edits are live |
| `TAU_USER` / `TAU_PASS` | set for auth cases, unset for the rest (`authEnabled:false`) |
| `TAU_ROLE` | force `hub`/`mirror` without relying on pi mode detection |
| `TAU_DISABLED=1` | injected into headless children; also kills the server (negative case) |
| `TAU_HEADLESS_TTL_MS` / `TAU_MAX_HEADLESS` | small/1 values for reap + LRU-eviction cases |
| `TAU_AUTH_TOKEN_TTL_MS` | token lifetime override (X4 sets 400ms to watch expiry) |
| `TAU_FS_ROOTS` | extra allowed filesystem roots (X1 pins its fixture dirs) |
| `CHROME_BIN` / `PI_BIN` | binary overrides for the browser / real-hub layers |
| `TAU_NO_BROWSER=1` / `TAU_NO_PI=1` | force-SKIP a layer instead of probing |
| `TAU_STRICT=1` | exit 1 if any case was skipped |

Hygiene per run (the suite must be re-runnable, ports must not bump):

- Kill by **parent PID** (`pkill -P <hubpid>` for children, then the hub).
  Never `pkill -f <pattern>` — the pattern matches the killer's own
  command line and suicides mid-run (exit 143, half-torn-down)
  (learned the hard way). On hosts without `pkill` (some Termux
  installs), `helpers.mjs` scans `/proc` for descendants instead.
- Clear the instance registry (`~/.pi/tau-instances/*.json`) and confirm
  `ss -tln` shows the test ports free.
- Bump no ports implicitly: two servers on one port → the second bumps
  +1 and serves stale code. The pre-flight port check catches this.

## 3. HTTP contract (hub)

| Request | Expect |
|---|---|
| `GET /api/health` | `{status:"ok", mode:"hub", mirrorUrl, platform, authEnabled, startedAt, version}` |
| `GET /` | `302 → /hub/` (also for stale `/index.html` bookmarks) |
| `GET /hub/` + static assets | `200`; hub shell is the **only** entry (root `index.html` deleted, ADR-011) |
| `POST /api/login {user,pass}` | HttpOnly `tau_auth` cookie; `POST /api/logout` clears it |
| unauthenticated `/api/*`, `/ws` (when auth on) | `401` + inline login overlay, never `WWW-Authenticate` |
| `POST /api/rpc` | same frame contract as WS (§4); used by tests to avoid WS setup |
| `GET /api/instances` | `{instances:[{port, pid, sessionFile, cwd, local, startedAt}]}` — live TUIs dialed in over hub.sock (ADR-014) |
| `GET /api/processes` | `{processes:[{pid, argv, cwd, rssKb, ageSec, owner, sessionHint}], unsupported}` — live `pi` scan (ADR-013) |
| `POST /api/processes/kill {pid}` | `{ok, owner, signal, exited}`; hub pids retire via the registry, live pids get TERM→KILL; bad pid `400`, stale pid `404`, hub-self `400` |
| `uplink_*` over `/api/rpc` | `400` requires-WebSocket (binding commands never run over HTTP) |
| rename / export / download | traversal-guarded (history files only; `..` rejected) |

## 4. Browser↔server WS contract (`/ws`)

Unified envelope: every backend event arrives as
`{type:"rpc_event", event}`. Client messages carry `id`;
acks return `{type:"response", id, command, success, data}` (correlated by
`pendingRpc`; **15s timeout** → client `onTimeout` hook).

Client → server (all must keep working):

| Message | Effect under test |
|---|---|
| `new_session {cwd?}` | ack `{sessionKey}` → optional `session_file` pin → `#session=<base>` + tab |
| `start_session {cwd?, sessionFile?, sessionKey?}` | bind/rejoin headless backend; ack `{sessionKey}` — replaying it rejoins the exact backend across reloads (stale keys fall back to the file scan, never a wrong backend) |
| `rpc_command {command}` | forwarded to headless stdin (`prompt`, `abort`, …) |
| `detach_session` | release headless binding |
| `extension_ui_response {id,…}` | answer a dialog; routed to headless child or hub waiter |
| `ping` | `pong` |
| `uplink_list` | ack `{instances}` → Live section renders (H7) |
| `uplink_attach {port, pid}` | `uplink_attached` → Driving banner + hash `&drive=1` (H9/D1) |
| `uplink_detach` | `uplink_detached` → frozen view + Drive-again banner (H9/D1) |
| `uplink_command {command}` | relayed to the driven TUI; acked `{success:true}` (D1) |

Server → browser events the client must handle:
`response`, `state`, `session_file`, `extension_ui_request`,
`mirror_sync`, `uplink_attached`, `uplink_detached`, `uplink_dead`,
`mirrors_changed`.
Deleted with ADR-011 and **must stay dead**: top-level `mirror_sync`
(non-uplink), `session_switch`, `mirror_sync_request`,
`session_switch_request` — a stale client sending them gets no answer
and the UI must not hang (D1).

### Fake WS backend (Layer B)

A ~30-line node `ws` (or raw-socket) server with three modes:

- default: ack `new_session` with `{sessionKey, cwd}` and **no**
  `session_file` → UI stays put (no pin, no tab).
- `--late-file`: after ack, send `{type:"session_file", sessionFile, cwd}`
  → expect `#session=fresh-….jsonl` + `New session` tab.
- `--no-ack`: answer nothing → expect the exact timeout message
  (`New session timed out — the server did not answer. …`).

Generic rule: ack any other `{id}` message with
`{type:"rpc_event", id, event:{type:"response", id, command, success:true, data:{}}}`.
Disconnected layer (no backend at all) must show the exact fail-fast
message (`Not connected to the backend — …`) on `+`/Ctrl+T, never a
silent 15s wait.

## 5. Attach relay (ADR-014)

The stub hub binds no unix socket — it answers the relay protocol
directly with one fake live TUI (no listener, nothing to dial; attach
completes without a real `pi`). The fake row is relay-shaped
(port/pid/sessionFile/cwd/local/startedAt) so the full client flow
works: list → Live section → preview → drive → detach (H7–H9, D1):

- `uplink_list` acks `{instances}` over WS; `GET /api/instances`
  lists the fake row; uplink verbs over `/api/rpc` 400 (WS-only);
- `#live-section` renders RUNNING TUIs with Drive buttons;
  `#session-banner` walks preview → Driving → Drive-again;
- the removed mirror frames (`mirror_sync`, `session_switch` +
  `_request` variants) still get no answer and never hang the socket.
- Layer D (real hub) covers the real socket: a dialed-in TUI over
  hub.sock, addressed by pid, no per-TUI port.

## 6. Client behaviors with exact assertions

- **Enter-to-send is desktop-only**: coarse pointers (`matchMedia('(pointer:
  coarse)')`) → Enter inserts newline; fine pointers → Enter sends.
  Test with `page.emulateMedia` / device descriptors, not widths.
- **Single 768px breakpoint** (hub + shell share it): desktop title bar
  is one sequential row; ≤768px the title+state stay glued on line one,
  action buttons stretch full-width on line two.
- **Title-bar states follow the view**: `#tb-state` shows the bound
  headless session, `Driving · :port` / `Preview · :port` / detached
  states while previewing/driving, or the disconnected hint. H8 asserts
  the Live section lists the stub's fake TUI with Drive controls while
  the banner stays hidden until a preview/attach; H9 walks the banner
  preview → Driving → Drive-again.
- **Per-tab sessions**: `#session=<basename>` reload resumes the same
  session; the key is never a path. Two tabs = two WS = two headless backends.
- **Prompt routing order**: driven live TUI (uplink) → bound headless
  backend → direct. No mirror-live branch (deleted with ADR-011).
- **History window**: last 100 entries + `Load earlier messages` (+100,
  scroll anchor kept); full log stays on disk.
- **Zero-tolerance rule**: every Playwright run attaches a `pageerror`
  listener; any uncaught exception fails the run. Console errors from a
  refused WS on Layer A are expected and must be filtered, not asserted
  on — `pageerror` is the signal.

## 7. Test matrix

P0 — hub alive, core loop (Layers A–C, CI):

| # | Setup | Action | Assert |
|---|---|---|---|
| H1 | boot hub, no auth | `GET /api/health`, `GET /`, `GET /hub/` | `mode:"hub"`, `/→302 /hub/`, shell 200 |
| H2 | Layer A, desktop + mobile viewports | load `/hub/`, wait 2.5s | zero `pageerror`s; status pill present |
| H3 | Layer B `--late-file` | click `#tab-new` | `#session=….jsonl`, `New session` tab |
| H4 | Layer A | click `#tab-new` | exact fail-fast message, no 15s wait |
| H5 | Layer B `--no-ack` | click `#tab-new`, wait 17s | exact timeout message |
| H6 | real hub (D-lite, no TUI) | WS `start_session` + prompt | `HEADLESS-OK` round-trip on own backend |
| H7 | stub hub | `uplink_list` via WS + `/api/rpc`, `GET /api/instances` | WS acks `{instances}`; HTTP 400 (WS-only); instances lists the fake TUI |
| H8 | stub hub + browser | read the hub shell DOM | `#live-section` lists RUNNING TUIs with Drive; banner hidden pre-preview |
| H9 | stub hub + browser | Drive → Cancel → Drive → Drive this TUI → Detach | preview banner → cancel clears → Driving banner + notice → Drive-again |
| H10 | stub hub + browser; `TEST_REAL_HUB=1` re-runs against a real hub + `exec -a pi sleep` double | Settings → Server lists fixture rows with owner tags; kill removes the row; `400` bad/self, `404` stale (stub asserts UI, real asserts scan + reap) |
| H11 | real hub (`TEST_REAL_HUB=1`; self-SKIP otherwise) | session rejoin never re-sends `switch_session`, ack carries `isAgentRunning`, `/api/headless/status` tracks the run |
| H12 | real hub | `/api/files/content` jails reads to the viewed session's cwd |
| H13 | real hub | session-picker summaries + mkdir jail + fork |
| H14 | pure Node (no hub, no Chrome) | hostile image blocks accepted/rejected by `isValidMessageImage`; `%%CODEBLOCK_n%%`-style placeholders stay literal (B1/B2/S1) |
| H15 | stub hub + browser, 390×844 and 390×430 (keyboard-shrunk) | open the model picker, then the thinking menu | nothing spills past the viewport (no sideways page scroll); model search field is the menu's last child below the scrolling list; menu height ≤ `45dvh` |
| H16 | stub hub + browser (static audit + live clicks) | audit the served `/hub/` HTML, then open settings, switch tabs, toggle a switch, pick a model, open the thinking menu | no markup issue (tag balance, duplicate ids, button `type`, accessible names, labelled inputs, dialog/switch/tab/listbox attributes with live id targets); `aria-expanded`/`aria-selected`/`aria-checked` follow the widgets, and the announced model row is the painted `.active` one |
| H17 | stub hub + browser | flip Settings → Appearance "Hide costs", reload, flip it back | toggle `on` class, `aria-checked` and `localStorage.tau-hide-costs` agree; `body.hide-costs` hides the header cost pill and a planted `.message-usage` span; the pref is re-applied on load |
| H18 | pure Node (no hub, no Chrome) | parse `app.js` segment colours + `style.css` selectors | every `ctx-*` variant has bar + legend rules and none of them is a bare global class (the old `.messages` variant inherited the transcript scroller's flex/padding) |

Hardening regressions (from `docs/code-review.md` §11; real hub,
SKIP without `pi`):

| # | Covers | Assert |
|---|---|---|
| X1 | S3, S4, S4b, S14 | symlinked preview escape 403, dangling 404, non-image 415, `dir.png` 404, SVG attachment+sandbox, `/api/open` escape, mkdir jail incl. symlinked parent, `export_html` store jail |
| X2 | S5, S7 | 300 KiB JSON body → 413 + health OK; 20 beacons → 429; sessions API unaffected |
| X3 | S6, S11 | nosniff/DENY/no-referrer/`frame-ancestors 'none'` on `/`, `/hub/`, health, 401s; no CORS for hostile `Origin` |
| X4 | S5, S8, S12, S13 | oversized login 413; bad-login backoff; cookie `HttpOnly`/`SameSite=Lax`/`Max-Age`; TTL expiry → 401 + relogin; `set_auth` re-auth |
| X5 | B3 | invalid cwd refused; dead spawn leaves no zombie binding; rejoin reaped |

P1 — sessions, dialogs, dead contracts (C–D):

| # | Case | Needs |
|---|---|---|
| D1 | relay frames answered (`uplink_list` ack, `uplink_attached`/`detached`), dead mirror frames unanswered, unknown rejected, socket alive | stub hub WS |
| D2 | dialog relay: headless `select` → browser modal → answer → run resumes | real hub (wrapUiDialogs is in-process) — manual |
| D3 | reload with `#session=<base>` resumes same headless session | browser + stub/real hub — manual |
| D4 | two tabs run independently (separate headless backends) | two browser contexts — manual |
| D5 | auth on: login → WS works; no cookie → 401 + inline overlay; logout revokes | `TAU_USER/PASS` hub |
| D6 | seeded 250-entry session file → windowed render + `Load earlier` | fixture `.jsonl` — manual |

P2 — hardening:

- Mobile: slide-over sidebar, coarse-pointer Enter,
  36–44px targets (device descriptors, not just narrow desktop).
- Reap/evict: `TAU_HEADLESS_TTL_MS=2000` idle backend dies;
  `TAU_MAX_HEADLESS=1` second bind LRU-evicts the first (never a running agent).
- Rebinding: wrong `Host`/`Origin` → rejected; `TAU_ALLOW_ANY_HOST=1` bypass (dev only).
- Traversal: `../` in rename/export/download → rejected.
- SW: version bump installs `tau-v5`, purges the old `/` shell (see §8).
- Streaming epoch: switch session mid-run → stale `message_start` events dropped.

## 8. Regression notes (traps this suite guards)

- **Ghost on :8192**: the pre-cut service worker precached `/` (the
  deleted mirror shell), so a dead origin can *look* live. Tests must
  assert on network state (health/WS), never on shell pixels alone; the
  `CACHE_NAME` bump is covered by the SW case above.
- **Second-server port bump**: two hubs on one port → silent +1 with
  stale code. Pre-flight port check (§2) exists for this.
- **`saveTauSetting` ignores `PI_CODING_AGENT_DIR`**: it writes
  `$HOME/.pi/agent/settings.json` (and only *updates* an existing
  file). Real-hub cases that toggle auth must run with a throwaway
  `HOME` and a seeded settings file, or the developer's real config
  gets `authEnabled:false` persisted into it (X4).
- **Local commands don't answer as `rpc_event`**: top-level WS frames
  like `export_html` / `set_auth` reply with a plain
  `{type:"response"}` (the browser reaches them through `/api/rpc`),
  unlike `start_session`/`list_sessions`, which are `rpc_event`-wrapped.
  Probes must use the same route the browser uses.
- **Jail fixtures must live outside the repo**: the repo checkout is a
  configured project root, so an in-repo "outside" directory is still
  inside an allowed root and false-passes (X1 uses `mkdtemp()` in the
  OS temp dir).
- **`pkill -f` suicide** (§2): kill by parent PID only.
- **Stdin-closed hub exit**: boot helper must hold stdin open or the hub
  vanishes mid-suite with no error.
- **Default fake backend ≠ happy path**: ack-without-`session_file` pins
  nothing (by design). Happy-path tests must use `--late-file` mode.
- **Sidebar is off-canvas in the hub shell**: session/tab buttons are
  outside the viewport until `#sidebar-toggle` is clicked — browser
  clicks time out otherwise. Open the sidebar first.

## 9. Coverage map (where each layer lands)

| Area | Files | Layers |
|---|---|---|
| Boot/role/static/auth | `extensions/mirror-server.ts`, `lib/config.ts` | H1, P2, X3, X4 |
| WS router + headless spawn/stdio/TTL/LRU | `mirror-server.ts`, `headless-bridge.ts` | H6, P2, X5 |
| FS jails (preview/open/mkdir/files/export) | `mirror-server.ts` | H12, X1 |
| Request/response hardening (body cap, beacon cap, headers, CORS) | `mirror-server.ts` | X2, X3 |
| Auth lifecycle (login cap, backoff, cookie, TTL, set_auth) | `mirror-server.ts` | D5, X4 |
| Renderer safety (images, markdown placeholders) | `public/message-renderer.js`, `public/markdown.js` | H14 |
| Composer popovers (model picker/thinking menu) fit narrow + keyboard-shrunk viewports | `public/app.js` (`clampMenuToViewport`), `public/style.css`, `public/hub/hub.css` | H15 |
| Hub markup well-formedness + ARIA state (buttons, dialogs, tabs, switches, listboxes, toggles) | `public/hub/index.html`, `public/app.js` (picker/tabs/toggles), `public/dialogs.js` | H16 |
| Display prefs (`Hide costs`, `Show thinking`) + settings toggles | `public/hub/index.html`, `public/app.js` (toggle wiring), `public/style.css` (`body.hide-*`) | H17 |
| Context popover geometry (bar segments + legend dots) | `public/app.js` (segment colours), `public/style.css` (`.ctx-*` variants) | H18 |
| Session picker (summaries/mkdir/fork) | `mirror-server.ts`, `app.js` | H13 |
| Attach relay + dead frames | `mirror-server.ts` (relay block), `lib/hub-socket.ts` | H7–H9, D1 |
| Live processes scan/kill | `lib/processes.ts`, `headless-bridge.ts` (`closeByPid`/`childPids`), `app.js` server pane | H10 (stub + real) |
| Dialog relay | `mirror-server.ts`, `public/dialogs.js` | D2 (manual) |
| View model: tabs/hash/routing | `public/app.js`, `hub/hub.js`, `session-actions.js` | H2–H5, D3–D4 (manual) |
| Transport + fail-fast/timeout | `public/websocket-client.js`, `session-actions.js` | H4–H5 |
| Layout/breakpoints/touch | `public/hub/hub.css`, `public/style.css`, `MOBILE.md` | P2 mobile (manual) |

## 10. Minimal harness skeleton

Playwright via `playwright-core` + system Chrome (no downloaded
browsers): `chromium.launch({ executablePath: '/opt/google/chrome/chrome',
args: ['--no-sandbox'] })`. Every script follows the same shape —
`pageerror` listener, `goto …/hub/`, state-changing action, snapshot
assert (`location.hash`, tab strip, message text, `#tb-state`),
screenshot on failure, `browser.close()`, backend
teardown per §2. Viewports: desktop `1280×800`, mobile `390×844`
(iPhone-ish device descriptor for coarse-pointer cases).
