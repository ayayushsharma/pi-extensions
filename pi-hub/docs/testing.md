# pi-hub testing plan

Extensive, layered, Playwright-first. Every capability (C1–C4) and every
ADR decision has named cases; every case has one owning spec file. This
document is the contract; `tests/cases.json` is the machine-readable
registry (added in P0) and a meta-test fails when a case is missing from a
spec, silently skipped, or has no assertion.

### As built (2026-10-18)

- Runner: `node tests/run.mjs` (integration) / `--e2e` (Playwright) /
  `--all` (+ Firefox CLI smoke); there is no `cases.json` registry yet —
  checks print `PASS/FAIL <name>`, and a failing check exits non-zero.
- Browser driver: `playwright-core` + system Chrome (`channel: "chrome"`,
  bundled-Cromium fallback) instead of `@playwright/test`: same engine, no
  test-runner dependency, and the same spec functions can move under
  `@playwright/test` later without rewriting assertions.
- Cross-platform backend implemented as the zero-dependency `CLI` smoke
  (`firefox --headless --dump-dom/--screenshot`, ADR-020). The
  selenium/geckodriver backend for interaction on Termux is the next step.
- Testability contract shipped: `body[data-ready="1"]`, `window.__errs`,
  `data-runner-*` hooks; every browser case asserts no page errors.

## 1. Layers

| Layer | What | Needs | Runs |
|---|---|---|---|
| **L0 unit** (`node:test`) | pure logic: protocol guards, session parse, jails, fork naming, registry invariants with a recording fake child, ring replay, coalescer, env scrub | node | everywhere |
| **L1 fakes** | scripted `pi --mode rpc` double + fake hub.sock mirror: slow start, no ack, late file, crash mid-run, ENOENT, stderr spam, huge output, CRLF, U+2028 | node | everywhere |
| **L2 Playwright stub** | UI + protocol flows against a stub hub (deterministic WS/HTTP), DOM/ARIA/mobile | Chrome | CI |
| **L2t Termux smoke** | same spec functions through the Firefox/Selenium driver (§1.2) against stub + real hub | Firefox + geckodriver | the phone |
| **L3 Playwright real** (`@real`) | full loop with real `pi`: new/resume/prompt/steer/abort/model/dialog/fork/relay | `pi` + Chrome | dev box / strict CI |
| **L4 adversarial** | raw HTTP/WS probes (auth, rebinding, traversal, caps, CSP, XSS payload, dead frames) | node + Chrome | CI |

Run:

```bash
npm run test           # L0 + L1 + L2 (fast)
npm run test:real      # L3 on a pi+Chrome host
npm run test:all       # everything; any skip is a failure (CI mode)
```

Playwright: `@playwright/test`, projects `stub`, `phone` (390×844,
`hasTouch`), `real` (grep `@real`), `adversarial`. `channel: "chrome"`
with cached-chromium fallback; no browser download. Trace on first retry,
screenshot + WS log dump on failure, no delayed screenshots on success.

### 1.2 Cross-platform browser drivers (ADR-020)

Playwright proper cannot run on Termux/Android — its bundled Chromium needs
glibc libs Android lacks. `auto-mate` on the phone proved the working
recipe: **system Firefox + geckodriver + selenium-webdriver**, one
persistent headless session, screenshots and JS-error collection.
pi-hub adopts it as a second backend behind one tiny facade so specs are
not written twice.

```text
spec fn(page: PageDriver)
  ├── playwright backend   goto / evaluate / click / fill / screenshot / errors
  ├── firefox backend      selenium-webdriver → geckodriver → system firefox
  └── (both) markers: body[data-ready="1"], window.__errs, data-* hooks
```

- `PI_HUB_E2E_DRIVER=auto|playwright|firefox|cli` — `auto` prefers
  Playwright, falls back to Firefox when only that is available.
- `firefox` backend: `selenium-webdriver` (optional devDep, installed
  only where used), geckodriver resolved from `PI_HUB_GECKODRIVER`,
  `tests/.bin/geckodriver` (gitignored; setup script downloads the
  aarch64 build matching system Firefox), then `$PATH`. Headless via
  `MOZ_HEADLESS=1`; every browser action wrapped in `timeout`; one
  browser at a time on the phone. `pkg install ttf-dejavu` is a
  prerequisite for readable screenshots.
- `cli` backend: zero dependencies, `firefox --headless --dump-dom` for
  `data-ready`/content assertions and `--screenshot --window-size` for
  captures (the `auto-mate` `shot.sh` pattern). Runs with no
  `node_modules` at all.
- **Playwright-only capabilities** are declared per case
  (`requires: "playwright"`): `route()` interception, multiple browser
  contexts/tabs, touch gestures, traces, raw CDP/WS injection, and the
  `adversarial` layer. They SKIP on the Termux runner with a reason.
- The `termux-smoke` profile runs the capability subset: boot + login,
  C2 resume, C3 new session, C4 headless view, C1 preview banner,
  `__errs` empty, screenshots at 390×844 (phone), 768×1024, 1280×800.
- Same spec functions run under `@playwright/test` (fixture wraps
  `PageDriver`) and the Termux runner (`node:test` + Firefox backend),
  so capability logic has one home.

#### 1.2.1 UI testability contract (built into the app, P4)

- `document.body.dataset.ready = "1"` after first paint + WS `hello`.
- `window.__errs` collects `error` + `unhandledrejection`; specs assert it
  is empty at the end of every browser case (client beacon stays for
  production, never as the test signal).
- Stable hooks: `[data-runner-id]`, `[data-runner-kind]`,
  `[data-runner-state]`, `[data-view]`, `[data-testid]` on actionable
  controls; assertions read those, never CSS classes.
- `body[data-app-version]` for cache-bust assertions; screenshot helper
  waits for `data-ready` and `document.fonts.ready` before capture.

## 2. Fixtures & doubles

| Fixture | Behavior |
|---|---|
| `stubHub` | minimal HTTP+WS hub: health, static shell, auth, scripted runners; UI flows run without `pi` |
| `fakePi` | Node script speaking LF-JSONL RPC; scenario table (below); records every command it receives |
| `hub` | `pi -e ./pi-hub --mode rpc`, temp `HOME`, random port (never 8192/12045), stdin held open, `TAU_DISABLED=1`; kill by parent PID only |
| `mirror` | `pi -e ./pi-hub --mode rpc` with `PI_HUB_FORCE_ROLE=mirror`, temp socket; real relay loop, no TTY |
| `store` | temp session store with fixtures: empty, 1 entry, 10k entries, malformed line, 1 MiB line, hostile image block, `%%CODEBLOCK_0%%`, model_change at top, fork source |
| `fsRoot` | temp directory tree: nested, symlink out, symlink dangling, `dir.png`, SVG, 300 KiB file, unicode/space names |

`fakePi` scenarios: `ready`, `slow-ready` (2 s), `never-ready`,
`no-ack`, `late-file`, `exit-mid-run`, `exit-code-1`, `enoent`, `stderr-spam`,
`invalid-json-line`, `huge-output`, `crlf`, `unicode-separators`,
`switch-counter`, `dialog-request`, `crash-after-prompt`.

Hygiene: ports via `PI_HUB_PORT=0`-style allocator; teardown walks
`/proc` for descendants (never `pkill -f`); hub boot always with stdin
pipe; every browser case fails on `pageerror`; console noise from refused
WS is filtered only in layer-A cases.

## 3. Capability cases

### C1 — preview/drive a live TUI (ADR-009/014)

| ID | Scenario | Assertion | Layer |
|---|---|---|---|
| C1.1 | TUI dials hub.sock (hello/status) | Live row appears via push, no poll; shows pid/cwd/session/last-active | L1/L2 |
| C1.2 | Select live row | Read-only windowed history + banner; composer disabled; no attach frame sent | L2 |
| C1.3 | Drive | `attach` → `driving` banner; prompt reaches TUI; reply streams back into same transcript | L2/L3 |
| C1.4 | Detach | Input locked, `detached` banner, re-attach restores driving without history refetch | L2 |
| C1.5 | Second browser attach | `driver_busy {heldBy}`; explicit Take over moves the driver; loser flips to preview | L2 |
| C1.6 | Mirror closes during preview | Row removed; banner "session ended" + Continue headless on same file | L1/L2 |
| C1.7 | Mirror closes while driving | Same as C1.6, input stays locked, no orphan spinner | L1/L2 |
| C1.8 | TUI restarts with same file, new pid | Rows dedupe by file; attach follows new pid; no duplicate transcript | L2 |
| C1.9 | Abort while driving | Confirm dialog warns "also live in terminal"; cancel = no abort; confirm = TUI aborts | L2 |
| C1.10 | Dialog relay (select/confirm/input/editor) | Browser modal for each; answer returns to TUI; second answer ignored | L2/L3 |
| C1.11 | Browser disconnects with dialog open | TUI native prompt released (no deadlock) | L1/L2 |
| C1.12 | Attach ordering | `snapshot` applied before any live event; no duplicated entry; monotonic seq | L0/L2 |
| C1.13 | Old client sends `mirror_sync_request` | No answer, connection stays alive, no server error log | L4 |
| C1.14 | Heartbeat missed (mirror wedged) | Row marked stale then removed after timeout; attached browser told | L1 |
| C1.15 | TUI renames session / model change | `runner_status` pushes update sidebar + header in every viewer | L2 |
| C1.16 | Mirror role | Mirror process listens on no TCP port (ADR-011) | L3 |
| C1.17 | Prompt while previewing (not driving) | Routes to bound headless runner if any, else explicit error — never into the TUI | L2 |
| C1.18 | Prompt while driving and TUI user types concurrently | Both accepted; both are in the transcript; no lost frame | L3 (manual) |

### C2 — resume historical session (ADR-015/016)

| ID | Scenario | Assertion | Layer |
|---|---|---|---|
| C2.1 | Picker list | Projects grouped, mtime/count/running chip, one pass; no full parse of unrelated projects | L2/L3 |
| C2.2 | Resume unowned file | Child spawns, exactly one `switch_session`, window painted before stream attaches | L1/L2 |
| C2.3 | Rejoin same file | **Zero** extra `switch_session` (fake counter); agent keeps running; ack has `isAgentRunning` | L0/L1 |
| C2.4 | Rejoin while agent running | Stop affordance + working dot survive reload | L2 |
| C2.5 | Resume file owned by live TUI | Binds the live runner; no second process, no file writer duplication | L1/L3 |
| C2.6 | Resume file owned by headless child | Same pid reused; `runner_added` not emitted | L1 |
| C2.7 | Window paging | 50 → load earlier grows; `before=` has no gaps/dupes at boundaries; whole-file model/thinking always applied | L0/L2 |
| C2.8 | 10k-entry file | First window < 50 ms server-side; client scroll stays smooth | L3/L4 |
| C2.9 | Malformed/empty/huge-line session | Malformed lines skipped, empty renders, 1 MiB line capped without crash | L0/L2 |
| C2.10 | Session cwd deleted | Bind fails with the path in the error; no zombie child; retry after restore works | L1 |
| C2.11 | Basename collision across projects | `(dir, file)` pair resolves; wrong file never opened | L1 |
| C2.12 | Fork | Fresh pi-style name, byte-identical copy, opens via normal resume (ADR-016) | L0/L3 |
| C2.13 | Fork while source running | Copy equals bytes at fork time; source transcript unaffected | L3 |
| C2.14 | Rename | History-only; live rename arrives from TUI; sidebar/pickers update without reload | L2 |
| C2.15 | Export/download | Output jailed to session store; traversal and `outputPath` refused (S3) | L4 |
| C2.16 | Two tabs, same file | One child, both streams; a prompt from either appears once in both | L2/L3 |

### C3 — new session anywhere (ADR-018)

| ID | Scenario | Assertion | Layer |
|---|---|---|---|
| C3.1 | New → browser | Roots + recent projects + typed path listed from server | L2 |
| C3.2 | Start in chosen cwd | Spawns, ack after ready, `#session=` pinned, card/header show the new identity (B4/B6) | L1/L2 |
| C3.3 | cwd missing / file / no permission | Rejected before spawn with reason; no child exists afterwards | L0/L1 |
| C3.4 | Spawn ENOENT (bad `PI_HUB_PI_BIN`) | Bind rejects, no zombie binding, retry after fix succeeds (B3) | L1 |
| C3.5 | Child exits before ready | Bind rejects after timeout; error surfaced once; file-free scratch not pinned | L1 |
| C3.6 | Pool cap reached | Idle runner evicted (never running); UI told which; running sessions untouched | L0/L1 |
| C3.7 | Two /new in parallel | Two distinct runners/files; no cross-talk of streams | L1 |
| C3.8 | /new → reload before first prompt | Clean scratch or resumed discovered file; never a dead "Loading session…" (B5) | L2 |
| C3.9 | cwd with spaces/unicode/`-` prefix | Spawns correctly (no shell interpolation) | L0/L1 |
| C3.10 | Project dir with no sessions dir | Sessions store created server-side; resume works | L1 |
| C3.11 | mkdir | One level, parent must exist, 409 exists, HOME escape/symlinked parent refused (ADR-018/X1) | L4 |
| C3.12 | Path outside configured roots | Browsing refused with reason; explicit allowed root works (`PI_HUB_FS_ROOTS`) | L4 |

### C4 — view/add to running headless

| ID | Scenario | Assertion | Layer |
|---|---|---|---|
| C4.1 | Running list | pid/cwd/model/agentRunning/viewers/last-active pushed; live and headless distinguished | L1/L2 |
| C4.2 | Open from second tab | Binds same child (same pid), no respawn | L1/L2 |
| C4.3 | Steer/queue while running from both tabs | Both prompts delivered in order; UI shows queue pills in each tab | L2/L3 |
| C4.4 | Abort from viewer B | Run stops; viewer A updates without reload | L2 |
| C4.5 | Status transitions | agent_start/end, model_change fan out to all viewers | L1/L2 |
| C4.6 | Child crash mid-run | `runner_removed` pushed; transcript frozen with error; file resumable | L1/L2 |
| C4.7 | Close session while running | Confirm required; child reaped; files kept; other viewer told | L2/L3 |
| C4.8 | Reconnect mid-stream | `lastSeq` replay closes the gap; no duplicate or missing message blocks | L0/L2 |
| C4.9 | Cap eviction | Viewer notified, hash cleared (or points at resumable file), no dead composer | L1/L2 |
| C4.10 | Dialog from headless, two viewers | Both see it; first answer wins; second modal dismissed as stale | L1/L2 |
| C4.11 | Background tab misses a push | Focus poll reconciles `/api/runners` without full store parse | L2 |
| C4.12 | Child env | `printenv` inside child shows no `PI_HUB_USER/PASS/AUTH*` (S2) | L1/L3 |

## 4. Cross-cutting cases

### A — auth & sessions (ADR-006/X4)

| ID | Scenario | Assertion |
|---|---|---|
| A1 | Unauthed `/api/*` + WS upgrade | 401/close; inline login overlay; never `WWW-Authenticate` |
| A2 | Login → cookie | HttpOnly, SameSite=Lax, Max-Age; WS handshake accepted |
| A3 | Logout | Cookie revoked; next WS upgrade refused |
| A4 | Bad-login backoff | Per-IP delay after N failures; success resets |
| A5 | Token TTL | Expired cookie → 401 → re-login overlay (no silent hang) |
| A6 | `set_auth` | Requires re-auth; persists only after confirm |
| A7 | Host/Origin gates | Wrong Host/Origin refused on API + WS; explicit port matching |
| A8 | Loopback bind | `0.0.0.0` without credentials refused at boot |

### X — security hardening (S3–S14)

| ID | Scenario | Assertion |
|---|---|---|
| X1 | Hostile image block in session file | No XSS; invalid mime/base64 dropped (S1/B1) |
| X2 | `%%CODEBLOCK_0%%` / `%%DMATH_0%%` text | Rendered literally; following block still renders (B2) |
| X3 | Symlink/dangling/`dir.png` preview | 403/404; no file bytes served (S4) |
| X4 | SVG attachment | Not rendered same-origin (sandbox or download) |
| X5 | 300 KiB POST | 413; health still OK (S5) |
| X6 | Beacon flood | 429 after threshold; log bounded (S7) |
| X7 | Security headers | CSP, nosniff, frame-ancestors on `/`, shell, health, 401s (S6/S11) |
| X8 | Traversal | `..`, encoded, null byte, backslash in every path param → refused |
| X9 | JS injection via tool/output fields | Rendered as text; no event-handler attributes |
| X10 | WS oversized frame | `maxPayload` rejects cleanly; socket stays alive (S10) |
| X11 | Slow consumer | Backpressure drop, no unbounded hub memory (S10) |
| X12 | Process kill | Fingerprint fail-closed; stale pid 404; self/pid≤1 refused (ADR-013) |
| X13 | Dead frames | Unknown WS type ignored silently, no error spam (P2/D1) |
| X14 | `export_html` path | Generated name only, under session store (S3) |
| X15 | CSP without inline scripts | Boot works with `script-src 'self'` |
| X16 | hub.sock stale path | Live socket not hijacked; stale path reclaimed (B9) |

### R — rendering

| ID | Scenario | Assertion |
|---|---|---|
| R1 | Markdown | Headings/lists/tables/links render; raw HTML escaped |
| R2 | Code blocks | Highlighted locally; huge block bounded; copy button |
| R3 | Math | Lazy KaTeX only when `$` present; no CDN request |
| R4 | Tool cards | Live update → final; Edit diffs with gutters; no vertical trap on touch |
| R5 | Thinking blocks | Toggle on/off; streaming and history identical |
| R6 | Unicode/emoji-safe | U+2028/29, RTL, astral chars render; no JSON framing break |
| R7 | Huge message | Windowed render stays responsive; no layout thrash |
| R8 | Compaction | Pill + inline message → summary/abort/failure; failure surfaces |
| R9 | Images | Sent and history images inline; invalid dropped |
| R10 | Costs/tokens | Header follows viewed session (N3/H21); hide-costs hides both places |

### P — performance budgets (§5)

| ID | Scenario | Assertion |
|---|---|---|
| P1 | `/api/runners` warm | < 30 ms; no full session parse |
| P2 | History tail | < 50 ms for 10k-entry file; only tail read |
| P3 | Stream | Server coalesces; client rAF; no per-token frames |
| P4 | Idle hub RSS | < 80 MB with zero children |
| P5 | No polling | Network log shows zero periodic session-store requests while idle |
| P6 | Client TTI | Warm local < 1 s; JS parse < 300 ms |
| P7 | Phone scroll | 60 fps-ish on 390 px Chromium throttle; `contain` on rows |
| P8 | Reconnect | Replay window bounded (200 events); no full refetch on flap |

### U — UX & mobile

| ID | Scenario | Assertion |
|---|---|---|
| U1 | Markup/ARIA audit | H16-class: valid markup, labels, tab/dialog/listbox ARIA live |
| U2 | Popovers | Model/thinking menus inside viewport at 390×844 and keyboard 390×430; no sideways scroll |
| U3 | Sidebar/file panes | One panel at a time, overlay dismiss, swipe edge, no body scroll |
| U4 | Composer | Enter sends, Shift+Enter newline, 16 px no-zoom, no autofocus |
| U5 | Queue pills | Cancel one/all; order preserved; auto-send |
| U6 | Reconnect UX | Banner states (connecting/reconnected/failed) with retry; transcript never blanked (B5) |
| U7 | Fresh-session UX | Card/header identity appear without extra fetches (B4/B6) |
| U8 | Free-call guard | `app.js`-class analysis: every call resolves (H20) |
| U9 | Class-namespace guard | Variant classes have CSS rules; no global collision (H18) |
| U10 | Themes | All themes render, contrast AA, status dot fixed traffic-light |
| U11 | Tabs & home | Real anchors, Ctrl+click, restore, search home |
| U12 | PWA | Manifest/SW installed; offline shell loads; version bump busts cache |

### CP — cross-platform drivers (ADR-020)

| ID | Scenario | Assertion |
|---|---|---|
| CP1 | Same spec fn under Playwright and Firefox backends (stub hub) | identical pass/fail; facade parity |
| CP2 | `cli` backend smoke (no npm) | `--dump-dom` sees `data-ready="1"`; `--screenshot` produces a non-blank PNG with ttf-dejavu installed |
| CP3 | Termux smoke profile on the phone (stub) | C1–C4 subset green, `__errs` empty, 3 sizes captured |
| CP4 | Termux smoke with real `pi` hub | new + resume + prompt round-trip through Firefox; one browser at a time |
| CP5 | Playwright-only cases on the Termux runner | SKIP with the `requires: playwright` reason; never a silent pass |
| CP6 | Driver unavailable | clear SKIP/failure naming the missing binary; `PI_HUB_STRICT=1` fails, default run does not |

### D — deployment (myserver)

| ID | Scenario | Assertion |
|---|---|---|
| D1 | runit boot | Service survives reboot; stdin held; `sv status` up |
| D2 | No LD_PRELOAD spawn | `PI_HUB_PI_BIN` wrapper spawns children; no ENOENT |
| D3 | Tunnel | Host-pinned remote access works; direct port unreachable from LAN |
| D4 | Credentials | `~/.env` mode 600; creds not in logs or child env |
| D5 | Memory cap | 3 children + hub under available RAM; LMK untouched at idle |
| D6 | Flip/rollback | `sv down tau-web; sv up pi-hub` verified; rollback one command |

## 5. Definition of done

1. Every C/A/X/R/P/U/D case is implemented in its owning spec and passes
   (L0–L2 everywhere; L3 on a pi+Chrome host; L4 in CI mode).
2. `npm run test:all` exits 0 with **zero silent skips**; skips require a
   documented reason and `PI_HUB_STRICT=1` fails on any.
3. Budgets in `PLAN.md` §5 measured and recorded.
4. Manual phone smoke per myserver AGENTS.md (boot, tunnel, drive TUI,
   resume, new session, headless view) — logged in `docs/`; plus the
   automated `termux-smoke` profile (CP3/CP4) on the phone itself.
5. tau-web harness (optional gate) run against pi-hub, or an ADR note
   explaining the one behavioral difference.
