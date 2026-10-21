# pi-hub testing plan

Extensive, layered, Playwright-first on a dev host and Firefox/Selenium on
Termux. Every capability (C1–C4) and every ADR decision has named cases; every
case has one owning spec file. This document is the contract. `tests/cases.json`
**is not in place yet** (see `PLAN.md` status and `code-review.md` D2), so
nothing machine-checks that a row below is implemented: the matrix is enforced
by review plus the suites' printed case names, not by a meta-test. When in
doubt, grep the case ID in `tests/` — a row without a hit is a documentation
bug, not a passing gate.

### 1.1 As built (2026-10-22)

Two environments are in scope: the **Linux/beefier dev host** and **Termux/Android**.

- **Linux/CI gate (reported):** **76 unit**, **94 integration**, **171
  Playwright** (`--e2e", 12 groups: core, live, close, panels, tabs, models,
  chrome, detail, deadcwd, steer, auth, images). `--all` reports **340 checks**
  (339 pass, 1 documented skip — the Firefox CLI smoke when the host's Firefox
  cannot render headless). Timings reported on the dev box: unit 0.3 s ·
  integration 3.0 s at `-j4` · Playwright 13 s at `-j4` · `--all` ≈ 13 s wall.
- **Termux (measured 2026-10-22, Galaxy F12, Node 26.4, 7 cores/3.7 GB):** the
  gate **does not run as checked out** (T1 in `code-review.md`). With test-only
  portability fixes: **72/72 unit in 8.7 s**, **93/93 integration in 124 s**
  (`jobs=3`; 165 s serial), Playwright **not runnable** (no Playwright-
  compatible browser; T2). `pi --version` alone is 9.7 s; a hub boot is 16.4 s;
  a headless child spawn is ~11 s. Those startup costs set the floor, not the
  test bodies.
- **Parallelism is a knob**: `-j N` / `--jobs N` (or `--serial`), default
  `min(4, cpus)`. Groups are independent (own hub, own store copy, own page),
  so they run concurrently: `-j1` for deterministic logs, higher on a fast box.
  On this phone, three integration groups at `jobs=3` take ~2 min; serial is
  slower because the groups no longer overlap. The committed 3 s/13 s figures
  are fast-host numbers (the original doc called them "dev phone"); this
  Termux phone does not reproduce them.
- `--e2e` replaces integration, `--unit` alone is unit-only; reuse `--all` for a
  full gate. `--integration --jobs 1` is the debugging mode.
- **Tiers** (and why): unit = pure contracts, sub-second on Linux / ~9 s on
  Termux, run constantly; integration = HTTP/WS contract over a real hub,
  seconds on Linux / ~2 min on Termux (process startup dominates), run before a
  commit; Playwright = real browser, the "fire once when the work is done" gate
  on a host with Chrome/Chromium.

#### 1.1.1 Termux portability checklist (T1)

The failures are in the harness, not the product:

1. `run.mjs` statically imports `e2e.mjs`, which imports `playwright-core` — so
   even `--unit` dies with `ERR_MODULE_NOT_FOUND` when the devDependency is not
   installed. Import the browser suites lazily.
2. `tests/unit/` (the argument in `run.mjs`) is rejected by Node 26 (`test at
   tests/unit:1:1`). Pass explicit files or a glob.
3. `/tmp` is hardcoded in `tests/unit/store.test.ts`, `tests/helpers.mjs`
   (`mkdirSync("/tmp/pihub-fixtures")`), the fixture session header and several
   e2e path assertions. Termux has no `/tmp`; use `os.tmpdir()`/`$TMPDIR` and
   make the fixture cwd dynamic. `scripts/dev-hub.sh` also writes pid/log/dir
   under `/tmp`.
4. The `pi` shim is `#!/usr/bin/env node`; Termux has no `/usr/bin/env`, and
   Node's `spawn` does not run `termux-exec`'s rewriter when `LD_PRELOAD` is
   absent. Set `PI_BIN` to a wrapper that execs the absolute `node` and
   `bundle/cli.js` (or launch the hub from a shell where `termux-exec` is
   active). `findPi()` only checks `statSync().isFile()`, not executability.
5. The `cli` Firefox backend (`--dump-dom`) stalls on this phone; use the
   persistent Selenium session instead (§1.2.2).

Measured minimum on this device with the harness fixed: **unit ~9 s**,
**unit+integration ~2 min 5 s** (`--all` without a browser). E2E needs T2.

### Isolation (no more test sessions in the real store)

Every pi process a test spawns gets `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR` pointing inside a temp sandbox
(`tests/sandbox.mjs`), so nothing can write to `~/.pi/agent`. The runner
snapshots the real session store before the run and fails the suite with
`ISO real session store untouched` if a single file appeared or changed.

### The model is fake (no keys, no cost, no variance)

`tests/fixtures/fake-llm.mjs` is an in-process OpenAI-compatible endpoint
(`/v1/chat/completions`, streaming and non-streaming). The sandbox's
`models.json` + `settings.json` point pi at it with a fixed catalog
(`fake/fake-haiku`, `fake/fake-spark`, `fake/fake-plain`), so model/thinking
tests are deterministic and prompt round-trips finish in milliseconds. The
stub records every request: tests assert a message reached the model exactly
once (`llmMentioning`, `llmCopiesInLastRequest`), and `POST /__hold {ms}`
keeps a run open on purpose (steering tests).

### Layers (design) and as-built suites

The L0–L4 matrix is the original design. As built today the runnable suites are
unit, integration, Playwright E2E, Firefox CLI smoke and UI parity. There is no
stub-hub suite, no `@playwright/test` projects/traces, and no Termux runner yet
(T1/T2).

| Layer | What | Runtime | Where |
|---|---|---|---|
| **L0 unit** (`node:test`) | pure logic: protocol guards, session parse, jails, fork naming, registry invariants with a recording fake child, ring replay, coalescer, env scrub | node | everywhere |
| **L1 fakes** | scripted `pi --mode rpc` double + fake hub.sock mirror: slow start, no ack, late file, crash mid-run, ENOENT, stderr spam, huge output, CRLF, U+2028 | node | everywhere |
| **L2 Playwright stub** | UI + protocol flows against a stub hub (deterministic WS/HTTP), DOM/ARIA/mobile | Chrome | CI |
| **L2b Playwright clean-room UI** | the shipped client on a real hub + fixture store: resume, picker/starter, dialogs, live preview→drive→detach, rename/delete, files/settings, auth, phone | Chrome | CI |
| **L2c UI parity (A/B)** | boots tau-web and pi-hub against identical fixture stores and writes welcome/resume screenshots for visual comparison (`npm run test:parity`) | Chrome | dev box |
| **L2t Termux smoke** | same spec functions through the Firefox/Selenium driver (§1.2) against stub + real hub | Firefox + geckodriver | the phone |
| **L3 Playwright real** (`@real`) | full loop with real `pi`: new/resume/prompt/steer/abort/model/dialog/fork/relay | `pi` + Chrome | dev box / strict CI |
| **L4 adversarial** | raw HTTP/WS probes (auth, rebinding, traversal, caps, CSP, XSS payload, dead frames) | node + Chrome | CI |

Run (as built):

```bash
node tests/run.mjs --unit          # L0
node tests/run.mjs --integration   # HTTP/WS over a real hub
node tests/run.mjs --e2e           # Playwright client flows
node tests/run.mjs --all           # all of the above + Firefox smoke
npm run test:parity                # optional A/B screenshots
```

`npm run test` is **unit-only**, not L0+L1+L2. L1 fakes live inside unit and
integration (`fake-llm`, recording child); the L2 stub-hub suite does not exist
— E2E runs the shipped client against a real hub. L3/L4 are partly covered by
integration/e2e; there are no `@real` / `adversarial` projects.

Playwright as built: `playwright-core` + the custom `tests/run.mjs` /
`tests/e2e.mjs` runner (12 groups, `-j N`), not `@playwright/test`. It uses
system Chrome (`channel: "chrome"`, cached Chromium fallback, or
`PI_HUB_CHROME_BIN`); no traces, projects or browser downloads.

### 1.2 Cross-platform browser drivers (ADR-020)

> **Status 2026-10-22 — design + POC, not implemented.** ADR-020 is accepted in
> principle, but no `PageDriver`/`PI_HUB_E2E_DRIVER` exists in `tests/`; the
> committed E2E is Playwright-only. The Selenium recipe from `auto-mate` was
> verified against pi-hub on this phone (§1.2.2). Porting the 171 Playwright
> checks is T2, not a drop-in.

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
  captures (the `auto-mate` `shot.sh` pattern). Runs with no `node_modules` at
  all. **Not viable on the current phone:** a cold `--dump-dom` probe stalls in
  the renderer (SWGL; 30 s timeout) and `auto-mate` found per-shot cold starts
  were the stall. Keep this as a fallback only where `--dump-dom` exits; do not
  use CP2/CP6 as a Termux gate.
- **Playwright-only capabilities** are declared per case
  (`requires: "playwright"`): `route()` interception, multiple browser
  contexts/tabs, touch gestures, traces, raw CDP/WS injection, and the
  `adversarial` layer. They SKIP on the Termux runner with a reason.
- The `termux-smoke` profile is planned to run the capability subset: boot +
  login, C2 resume, C3 new session, C4 headless view, C1 preview banner,
  `__errs` empty, screenshots at 390×844 (phone), 768×1024, 1280×800.
- In the design, the same spec functions run under `@playwright/test` (fixture
  wraps `PageDriver`) and the Termux runner (`node:test` + Firefox backend), so
  capability logic has one home. Today those spec functions do not exist yet.

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

#### 1.2.2 Verified Termux POC (2026-10-22)

The auto-mate recipe was run against a real pi-hub on this phone. Full
runbook, script and findings: `termux-browser-poc.md`.

```bash
pkg install x11-repo firefox ttf-dejavu
# geckodriver 0.37.1 linux-aarch64 (auto-mate has it; keep it out of git)
# npm i --no-save selenium-webdriver
# not wired into run.mjs yet; see T2
```

Observed: hub boot 16.4 s, Firefox launch 9.6 s, first paint + `data-ready`
1.3 s, browser-side smoke 23.2 s (≈44 s including hub boot and teardown).
The driver reached `title: Pi Hub`, `window.__errs` was `[]`, the fixture row
was listed and resumed, and a 66 KB screenshot showed the rendered transcript.
A single persistent Selenium session is required; launching Firefox per shot
is what made the CLI path stall. `auto-mate`'s `uishot.js` is a ~60-line
screenshot/JS-error loop, not an assertion harness — it proves the driver
stack, not a pi-hub E2E suite.

Constraints confirmed:

- One browser at a time on this 3.7 GB phone; Playwright's 4-group fan-out is
  not available.
- Selenium gives `get`, `executeScript`, find/click/fill, waits, screenshots
  and window size — enough for the C1–C4 subset.
- No `route()` interception, multiple browser contexts, CDP/WS injection,
  tracing or real touch gestures. Those stay Playwright-only and must be
  declared `requires: "playwright"`.
- `window.__errs` and the `data-*` hooks make assertions portable; the app side
  of the contract is already shipped.

#### 1.2.3 Porting plan (T2)

1. Add a `PageDriver` facade (`goto/eval/waitFor/click/fill/screenshot/errors/
   close`) and move the shared assertions to it; do **not** port all 171 checks
   first.
2. First milestone is CP3 (stub hub) + CP4 (real hub) as `tests/termux-smoke.mjs`:
   boot, C2 resume, C3 new session, C4 headless view, C1 preview banner, empty
   `__errs`, three screenshots.
3. Keep Playwright for the full CI gate and the Playwright-only cases; use
   Selenium for the phone profile and skip the rest with an explicit reason.
4. `selenium-webdriver` is an optional devDependency, `geckodriver` lives in
   `tests/.bin/` (gitignored) or `PI_HUB_GECKODRIVER`; one browser per run.

Expected wall time on this device: one hub boot (~16 s) + one Firefox launch
(~10 s) + the suite body. A Termux smoke is therefore **minutes**, not 13 s;
that is acceptable for a release gate, not for a per-edit loop.

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
| A2 | Login → cookie | HttpOnly, SameSite=Lax, Max-Age, Secure over TLS; WS handshake accepted |
| A3 | Logout | Cookie revoked; next WS upgrade refused |
| A4 | Bad-login AND bad-Basic backoff | Per-IP delay after N failures on both; success resets |
| A5 | Token TTL | Expired cookie → 401 → re-login overlay (no silent hang); sliding refresh past half-life |
| A6 | `set_auth` | Absent by design — no runtime auth toggle, so XSS cannot persist auth-off |
| A7 | Host/Origin gates | Exact match only (loopback + own bind + pins); any-IPv4/`*.ts.net`/smuggled hosts refused on API + WS |
| A8 | Loopback bind | `0.0.0.0`/`::` without credentials refused at boot (A9, claims nothing) |
| A9 | Basic for scripts | Correct creds authenticate; colon passwords intact; sustained guessing → 429 |

### X — security hardening (S3–S14)

| ID | Scenario | Assertion |
|---|---|---|
| X1 | Hostile image block in session file | No XSS; invalid mime/base64 dropped, legacy blocks (missing mime, `data:` URL) still render (S1/B1; E41) |
| X2 | `%%CODEBLOCK_0%%` / `%%DMATH_0%%` text | Rendered literally; following block still renders (B2) |
| X3 | Symlink/dangling/`dir.png` preview | 403/404; no file bytes served (S4) |
| X4 | SVG attachment | Not rendered same-origin (sandbox or download) |
| X5 | 300 KiB POST | 413; health still OK (S5) |
| X6 | Beacon flood | 429 after threshold; log bounded (S7) |
| X7 | Security headers | CSP, nosniff, frame-ancestors on `/`, shell, health, 401s (S6/S11) |
| X8 | Traversal | `..`, encoded, null byte, backslash in every path param → refused |
| X9 | JS injection via tool/output fields | Rendered as text; no event-handler attributes |
| X10 | WS oversized frame | 2 MB `maxPayload` closes the socket (1009) and the hub stays healthy; clients must fit the budget — composer downscales attachments (E42, integration X10) |
| X11 | Slow consumer | Backpressure drop, no unbounded hub memory (S10) |
| X12 | Process kill | Fingerprint fail-closed (argv/`exe`, Linux + Android); stale pid 404; self/pid≤1 refused (ADR-013) |
| X13 | Dead frames | Unknown WS type ignored silently, no error spam (P2/D1) |
| X14 | `export_html` path | Client path jailed to session store, outside refused (S3; X20) |
| X15 | CSP without inline scripts | Boot works with `script-src 'self'` |
| X16 | hub.sock stale path | Live socket not hijacked; stale path reclaimed (B9) |
| X17 | Relocate jail (ADR-017) | `/api/sessions/relocate` to `/etc` → 403; under `$HOME` → 200 with rewritten header |
| X18 | Command image validation | Hostile `images` on prompt/steer/follow_up rejected before execution (unit + D2b) |
| X19 | Live drive enforcement (ADR-014) | Bound-but-not-attached socket: drive verb refused (`attach first`), preview reads acked (D8/D8b) |
| X20 | Export jail end-to-end | WS `export_html` to `/etc` refused, nothing written; pathless forward acks |
| X21 | Flood guards | WS sockets per IP → 429 (integration X21/X21b), client-error beacon 429 (X21c); headless spawn throttle is unpinned (would need 21 real children — manual) |
| X22 | Drive confirm (opt-in) | `PI_HUB_DRIVE_CONFIRM=1`: attach pends native TUI confirm; deny/timeout fails closed (unit; manual against a real TUI) |

### R — rendering

| ID | Scenario | Assertion |
|---|---|---|
| R1 | Markdown | Headings/lists/tables/links render; raw HTML escaped |
| R2 | Code blocks | Copy button + language label; fence capped at 64 KB with a truncation note. **Syntax highlighting deferred (ADR-022 M2)** — renders as plain text today |
| R3 | Math | **Deferred (ADR-022 M1):** raw LaTeX renders as text; no CDN script is allowed by the CSP, so KaTeX must be vendored when picked up |
| R4 | Tool cards | Live update → final; Edit diffs with gutters; no vertical trap on touch |
| R5 | Thinking blocks | Toggle on/off; streaming and history identical |
| R6 | Unicode/emoji-safe | U+2028/29, RTL, astral chars render; no JSON framing break |
| R7 | Huge message | Windowed render stays responsive; no layout thrash |
| R8 | Compaction | Pill + inline message → summary/abort/failure; failure surfaces |
| R9 | Images | Sent and history images inline; invalid dropped; photos downscaled under the frame budget (E41–E43) |
| R10 | Costs/tokens | Header follows viewed session (N3/H21); hide-costs hides both places |

### P — performance budgets (§5)

| ID | Scenario | Assertion |
|---|---|---|
| P1 | `/api/runners` warm | < 30 ms; no full session parse |
| P2 | History tail | < 50 ms for 10k-entry file; only tail read |
| P3 | Stream | Server coalesces (~40 ms batches stamped with the max seq they cover); client paints on rAF, throttled to 150 ms past ~6k chars; "Format on completion" mode parses once at `message_end` |
| P4 | Idle hub RSS | < 80 MB with zero children |
| P5 | No polling | Network log shows zero periodic session-store requests while idle |
| P6 | Client TTI | Warm local < 1 s; JS parse < 300 ms |
| P7 | Phone scroll | 60 fps-ish on 390 px Chromium throttle; `contain` on rows |
| P8 | Reconnect | Replay window bounded (200 events); no full refetch on flap; replays never repaint history frames (bind-head guard) or re-buffer coalesced deltas (`deltaSeq` ceiling) |

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
| U12 | PWA | Manifest installs at `/` (start_url fixed); asset version bump busts cache. **Offline service worker deferred (ADR-022 M4)** — no SW today |
| U13 | Tab close switches session | Closing the active tab binds the next tab (card/hash/transcript follow); closing the last shows the homepage (UX-1) |
| U14 | Backend kill confirms | Sidebar row X confirms like the card X; Cancel keeps the child (UX-2) |
| U15 | Quiet unbound kill | Killing an unbound backend shows no banner and no banner-hint toast (UX-3) |
| U16 | Home composer inert | Disabled input + guidance placeholder until a session binds |
| U17 | Model/thinking menus | Model list renders; thinking levels are the static 7 (per-model support: UX.md R-2) |
| U18 | Touch row actions | Session ⋯ opens by tap with no hover (UX-4) |
| U19 | Model filter | Menu narrows as you type; Enter picks the top match (R-1) |
| U20 | Per-model thinking | Menu renders backend-offered levels, static list only as fallback (R-2) |
| U21 | Live treatment | Live rows carry `.live-row` + live chip (R-4) |
| U22 | Backend titles | Rows show session titles + full basename sub (R-5) |
| U23 | Favourites once+star | No group dupes; star toggles without the menu; per-session keys (R-6, UX-7) |
| U24 | Wrap prefs | Each toggle flips its own attribute (`data-wrap-code` / `data-wrap-tools`); both persist across reload (R-8, UX-6) |
| U25 | Code copy | Fence header with lang + clipboard-verified Copy (R-9) |
| U26 | Tool hint paths | Session-relative hints, full path on hover (UX-8) |
| U27 | Compact nudge | Over-budget pill compacts via confirm; healthy pill inert (UX-9) |
| U28 | Asset versioning | Shell stamps a live `?v=` on CSS/JS; assets immutable; any edit bumps it (UX-10) |
| U29 | Touch row space | Titles ellipsize clear of the always-visible row actions (UX-11) |
| U30 | Session titles | Tab/card/rows show the title (prompt-derived), never a `.jsonl` name (UX-12) |
| U31 | Live block | Live terminals on top of the sidebar + a Drive card on home, listed even when tabbed (UX-13) |
| U32 | Durable close | Card X closes the session: tab gone, hash cleared, reload stays on home (UX-14) |
| U33 | One tab per session | Backend list + session list converge on one tab (R-12) |
| U34 | Chrome details | One collapse icon, ≥20 px tab-close hit area, load-earlier aligned with the transcript column, phone composer without overflow (R-7, R-11) |
| U35 | Drive/preview banner | One slim line with a bold lead (Driving/Preview); wraps rather than clipping; no session title or pid (UX-31) |
| U36 | Phone tab strip | Strip hidden at ≤520 px, visible and scrollable on tablets (UX-30) |
| U37 | Home detaches | Home clears the binding, the drive lock and `#s=`; tabs stay open (UX-33) |
| U38 | Drive lock scope | Navigating away detaches; rebinding the same runner keeps driving (UX-34) |
| U39 | One card per tool call | Start/end in either order yields a single card that finishes (UX-35) |
| U40 | Stream dedupe | No duplicated text after replay/rebind; empty deltas flush the batch (UX-36, H9) |
| U41 | Queue echo | Queued steer/follow-up pill appears on send while driving; clears on delivery/idle; model sees one copy (UX-37) |
| U42 | Tool input + output | Finished cards show Input above Output; readable text vs raw JSON per pref (UX-38) |
| U43 | Render prefs | Wrap toggles are independent (code vs tools); streaming mode persists; Clean is the default theme |

### CP — cross-platform drivers (ADR-020)

| ID | Scenario | Assertion |
|---|---|---|
| CP1 | Same spec fn under Playwright and Firefox backends (stub hub) | identical pass/fail; facade parity |
| CP2 | `cli` backend smoke (no npm) | `--dump-dom` sees `data-ready="1"`; `--screenshot` produces a non-blank PNG with ttf-dejavu installed |
| CP3 | Termux smoke profile on the phone (stub) | C1–C4 subset green, `__errs` empty, 3 sizes captured |
| CP4 | Termux smoke with real `pi` hub | new + resume + prompt round-trip through Firefox; one browser at a time |
| CP5 | Playwright-only cases on the Termux runner | SKIP with the `requires: playwright` reason; never a silent pass |
| CP6 | Driver unavailable | clear SKIP/failure naming the missing binary; `PI_HUB_STRICT=1` fails, default run does not |

**Status 2026-10-22:** CP1–CP6 are design targets; none are wired into
`tests/` yet. The POC covers page load + C2 resume only. CP2/CP6's CLI premise
fails on this phone (the renderer stalls), so the Termux path is the persistent
Selenium backend (§1.2.2), not `--dump-dom`.

### D — deployment (myserver)

| ID | Scenario | Assertion |
|---|---|---|
| D1 | runit boot | Service survives reboot; stdin held; `sv status` up |
| D2 | No LD_PRELOAD spawn | `PI_HUB_PI_BIN` wrapper spawns children; no ENOENT |
| D3 | Tunnel | Host-pinned remote access works; direct port unreachable from LAN |
| D4 | Credentials | `~/.env` mode 600; creds not in logs or child env |
| D5 | Memory cap | 3 children + hub under available RAM; LMK untouched at idle |
| D6 | Flip/rollback | `sv down tau-web; sv up pi-hub` verified; rollback one command |
| D7 | Singleton (ADR-021) | second hub refuses while the advert claim is live (names owner pid/port/sock); stale claim reclaimed; no port bump — unit-pinned, manual: start hub twice |
| D8 | Process scan per platform | Linux/Android via `/proc`; macOS via one `ps -ax` (same argv fingerprint, kill re-verified). Manual: Settings → Server lists a running TUI with Kill on a Mac; `parsePs` is unit-pinned |

## 5. Definition of done

1. Every C/A/X/R/P/U/D case is implemented in its owning spec and passes
   (L0–L2 everywhere; L3 on a pi+Chrome host; L4 in CI mode). On Termux, T1/T2
   (`code-review.md` §4) must be closed before CP3/CP4 can be claimed; they are
   open today.
2. `npm run test:all` exits 0 with **zero silent skips**; skips require a
   documented reason and `PI_HUB_STRICT=1` fails on any.
3. Budgets in `PLAN.md` §5 measured and recorded.
4. Manual phone smoke per myserver AGENTS.md (boot, tunnel, drive TUI,
   resume, new session, headless view) — logged in `docs/`; plus the
   automated `termux-smoke` profile (CP3/CP4) on the phone itself.
5. ~~tau-web harness (optional gate) run against pi-hub~~ — **superseded by
   ADR-022**: pi-hub is wire-independent and its own suites are the gate.
   Deferred tau-web browser features are tracked as M1–M5 in
   `code-review.md`, not as parity obligations.
