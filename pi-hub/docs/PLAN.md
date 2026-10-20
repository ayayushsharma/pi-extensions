# pi-hub — implementation plan

Status: **implemented (P0–P6)** (2026-10-18 overnight; updated 2026-10-21).
Current gate: **70 unit · 90 integration · 170 Playwright** checks green
(including one real model round-trip with `PI_HUB_E2E_PROMPT=1`); `--firefox`
adds the zero-dependency CLI smoke (skips where system Firefox cannot render
headless). As-built deltas from the original plan: `playwright-core` + a small
node runner instead of `@playwright/test` (same Chromium/system Chrome, no
test-runner dependency); the selenium/Firefox backend is scaffolded as the CLI
smoke only; the `tests/cases.json` registry is still not in place (results are
printed by name — see `code-review.md` D2). Since P6: ADR-021 singleton
enforcement, live-command parity + server-enforced single driver, the security
hardening batch, and the review fixes R1–R5 — all logged with pins in
`docs/code-review.md` §4/§7. **ADR-022 makes pi-hub independent:** its own
client/wire is canonical, tau-web's wire aliases and third-gate harness are
dropped by decision, and tau-web browser features that were never ported are
tracked as deferred (M1–M4), not as parity debt. tau-web is still the live
service — the flip (P7)
is pending.
Companions: `docs/adr/019-pi-hub-parallel-rewrite.md` (decision),
`docs/adr/022-pi-hub-independence.md` (wire independence + deferred
features), `docs/testing.md` (case matrix). Continues tau-web ADR-001–018; superseded
ADR-012 (headless-only hub) is **not** implemented — the attach relay
(ADR-014) is.

## 1. Why a rewrite instead of more patches

tau-web works, but the fork left three structural problems that show up as
flakiness:

1. **Three routing paths** (legacy direct ctx / headless child / relayed
   TUI) are re-branched in the server command handler and again in almost
   every client handler. Every new behavior needs three implementations and
   three tests; drift produced B3–B6, N1–N3.
2. **State is scattered**: ~60 module-level mutable variables in
   `app.js` (`uplinkActive`, `uplinkPreview`, `uplinkLastDetached`,
   `serverOwnSessionFile`, `isMirrorMode`, `viewingActiveSession`, …) encode
   one state machine that nobody can see whole. That is where reconnect /
   fresh-session / banner bugs live.
3. **Dead legacy control plane** carried from pre-hub tau: `~/.pi/tau-instances`
   registry, zombie reaping, port bumping, sibling detection, direct-browser
   mirror surface. ~400 lines of code paths that can only misbehave
   (B9 hub.sock races).

The fix is not fewer features — it is **one runner abstraction** for every
way a pi session can be driven, one state machine per browser, and push
instead of polling.

## 2. Product capabilities (first-class)

Everything the UI offers is one of four flows over the same `Runner`
registry. Each flow has explicit states, explicit failure semantics, and
no silent drops.

### C1 — Preview and drive a live running TUI (ADR-009/014)

```text
idle ──select live runner──▶ previewing ──Drive──▶ driving ──Detach──▶ detached
   ▲                             │                    │                  │
   └────────── another session ──┴── mirror death ────┴── mirror death ──┘
                                            ▼
                                    dead (offer: continue headless on same file)
```

- Select = **read-only history from disk** + banner (pid, cwd, last active,
  "also attached in terminal" warning). No input.
- Drive = `attach`; only one driver at a time. A second browser gets
  `driver_busy {heldBy}` and an explicit **Take over** action — never a
  silent hijack.
- Detach freezes the view (`detached`), re-attach resumes; navigating away
  returns to the freeze point.
- Mirror dies while previewing/driving → row removed, banner shows why,
  one-click **Continue headless** on the same file (safe: the TUI is gone,
  one writer again).
- Prompts route to the driven TUI only while `driving`; otherwise the
  normal runner. A prompt is never dropped silently — it acks or errors.

### C2 — Resume a historical session (ADR-015/016)

- Picker → `bind {file}`.
- **One process per session file** is a registry invariant: if the file is
  owned by a live TUI, resume drives that TUI (C1); if owned by a headless
  child, resume binds that same child (C4); only an unowned file spawns a
  new child.
- Rejoin of the currently loaded file is a **no-op bind** — never
  `switch_session` (pi cancels the in-flight turn). The guarantee lives in
  the runner, not the client.
- First paint comes from the windowed file API (fast, works with no child),
  then the stream attaches. Windowing: 50 entries, `before=` paging, no
  gaps/dupes; whole-file `model`/`thinkingLevel` returned alongside the
  window (X6/N3).
- Fork = byte-copy transcript to a fresh name in the same project (ADR-016);
  the copy opens through the ordinary resume path.

### C3 — Create a brand-new session from anywhere on the server

- "New session" opens the server-side directory browser (roots: `$HOME`,
  plus `PI_HUB_FS_ROOTS`) + recent projects + free-text path.
- Server validates cwd (exists, directory, readable) **before** spawn.
- The bind ack resolves only after the child is ready (`ready` = first
  successful `get_state` or short grace), so a failed spawn is an honest
  error, never a zombie binding (B3).
- File discovery (`session_file`) pins `#session=`; card/header render
  "new session" → real identity without the client fetching anything
  (B4/B6).
- One-level mkdir exists (ADR-018); no delete/rename/write anywhere.

### C4 — View and add to a running headless session

- The registry lists **all** runners with status (pid, cwd, model,
  agentRunning, viewers, last active) and pushes changes
  (`runner_added` / `runner_status` / `runner_removed`) — the UI never
  polls the session store to stay current.
- Opening a running runner from another tab binds the **same child**
  (no respawn); both tabs see the same stream. Steering/queueing from any
  viewer is allowed (the child is the single writer); abort from any viewer
  stops the run for all.
- Explicit **Close session** is the only kill (confirm while running);
  killing frees resources and keeps the file on disk.
- Pool cap (`PI_HUB_MAX_HEADLESS`, 3 on the phone): evicts idle only,
  never a running agent; the UI is told which runner was evicted and
  the file stays resumable.

## 3. Server architecture

```text
extensions/index.ts                 thin factory: role branch + lifecycle
extensions/lib/
  env.ts log.ts role.ts protocol.ts
  hub/
    hub.ts           wire everything, own start/stop
    http.ts          createServer, route table, readJson (cap), sendJson
    router.ts        Route[] assembly; guards = auth | origin | bodyLimit
    static.ts        ETag / immutable assets, CSP + security headers
    auth.ts          cookie sessions, basic fallback, backoff, host/origin
    ws.ts            one WS = one binding; typed frame dispatch
    relay.ts         hub.sock mirror registry (records, attach/detach)
    dialogs.ts       single-driver dialog broker (local/headless/mirror)
    stream.ts        per-destination delta coalescer (~25–40 ms)
    scheduler.ts     one heartbeat tick; visibility-independent push
    routes/          health.ts auth.ts runners.ts sessions.ts files.ts
                     processes.ts instances.ts
  runners/
    runner.ts        Runner interface + shared state machine
    headless.ts      pi --mode rpc child (spawn, framing, ready, rejoin)
    live.ts          hub.sock dial-in runner
    registry.ts      the switchboard: one process per file; caps; binding
  mirror/
    mirror.ts        dials hub.sock; forwards events; executes drive/dialog
    socket.ts        NDJSON over unix socket; stale-socket detection
  store/
    sessions.ts      list / window / fork / rename over an append-aware index
    files.ts         browse roots, realpath jails, mime, preview, mkdir
  processes.ts       /proc scan (Linux + Android) + TERM→KILL (ADR-013)
```

### 3.1 The Runner contract

```ts
type RunnerKind = "headless" | "live";

interface Runner {
  readonly id: string;                 // stable identity (file or pid)
  readonly kind: RunnerKind;
  identity(): { cwd: string; sessionFile: string | null; pid?: number; title?: string };
  status():   { agentRunning: boolean; streaming: boolean; model?: string;
                thinkingLevel?: string; viewers: number; lastActiveAt: number };
  history(o: { limit: number; before?: string }): Promise<Window>;
  command(cmd: RpcCommand): void;      // prompt / steer / abort / set_model / …
  subscribe(seq?: number): Unsubscribe; // events with monotonic seq
  bind(ws): void; unbind(ws): void;    // viewer registration
  close(): void;                       // explicit kill (headless) / no-op (live)
}
```

Registry invariants (each one is a test):

1. **One process per session file.** `bind(file)` returns the existing
   runner (live > headless) or spawns one; never a second writer.
2. **No re-switch.** Same-file bind is a no-op; `switch_session` is sent
   only when the file differs, and never while `agentRunning` (returns
   `busy` → UI offers wait / open a copy).
3. **Honest readiness.** `bind` resolves `bound` only after ready;
   spawn failure/exit retires the runner exactly once (`error`/`close`/`exit`
   all funnel through one idempotent retire) and rejects the bind (B3).
4. **Bounded memory.** N children max (LRU, idle only), per-runner event
   ring buffer (200 events) for reconnect replay, session cache LRU.
5. **Push, not poll.** Registry changes emit `runner_*` frames; no timer
   walks the session store.

Extensibility: a new backend kind = one `Runner` implementation + one
`registry.registerKind()`. Routes are `Route[]` modules; guards compose.

### 3.2 Browser protocol (WS `/ws`)

| Direction | Frame | Notes |
|---|---|---|
| S→C | `hello {version, auth, features}`, `runners {list}` | first frames; capabilities + current runners |
| C→S | `bind {runnerId}` \| `{dirName, file, cwd}` \| `{cwd}` | ack `bound {runner, lastSeq}` after readiness; binding **is** viewing |
| C→S | `command {command}` (alias `rpc_command`) | id-correlated `ack` / `error`; images + export paths validated server-side |
| C→S | `attach {runnerId, take?}` / `detach` | live TUI drive only; `driver_busy` on conflict, consent when enabled |
| C→S | `unbind` / `close {runnerId}` | release the view / kill a headless child |
| S→C | `event {runnerId, seq, event}` | **one envelope for all runners** (ADR-004), 200-frame replay |
| S→C | `runner_added` / `runner_status` / `runner_removed` | list updates without polling |
| S→C | `dialog {request}`, `dialog_cancelled` / C→S `extension_ui_response` | ADR-007, single driver |
| both | `ping` / `pong` | heartbeat |

**Not wire-compatible with tau-web (ADR-022).** The dialect above is
pi-hub's own; `start_session`, `rpc_event`, `tui_command` and route aliases
were planned in ADR-019 §4 and deliberately dropped when pi-hub became
independent. Product-level parity is what is maintained.

### 3.3 Client architecture

```text
core/store.js     one state object + subscribe; persists UI prefs only
core/ws.js        connect/backoff/resume-with-seq; token 401 → login
core/api.js       fetch wrappers (401 overlay, no native prompt)
core/runner.js    client handle: subscribe/command/attach; seq tracking
core/events.js    event → store reducers (one place per event type)
core/fsm.js       C1/C4 view FSM (previewing→driving→detached→dead)
views/*           render from store slices; own no cross-module state
render/*          markdown, tool cards, diffs (DOM-built, no raw innerHTML)
media/*           tts, service worker
```

Rules that kill the current class of bugs: views never mutate shared
state directly (actions only), URL hash is the session key, all
reconnect/rejoin logic lives in `core/ws.js` + `core/fsm.js`, and a free-call
guard test (H20-style) runs in CI.

### 3.4 Testability contract (built in, not bolted on)

Adopted from `auto-mate`'s Firefox/Selenium harness so the same specs run on
the phone and on a dev box (ADR-020):

- `body[data-ready="1"]` after first paint + WS `hello`; screenshot
  helpers wait for it and `document.fonts.ready`.
- `window.__errs` collects `error` + `unhandledrejection`; every browser
  case asserts it is empty at the end.
- Stable semantic hooks on runner rows/controls (`data-runner-id/kind/state`,
  `data-view`, `data-testid`); specs never assert on CSS classes.
- `body[data-app-version]` for cache-bust checks.

## 4. Security

Port the tau-web posture and fix its findings by construction:

- Cookie-session auth (ADR-006): HttpOnly + SameSite=Lax, backoff, TTL,
  per-process memory; WS upgrade accepts the cookie; no `WWW-Authenticate`.
- Host/Origin allowlist (rebinding) on `/api/*` + upgrade; loopback bind
  unless auth is configured; `PI_HUB_ALLOWED_HOSTS` for the tunnel.
- Child env is **allow-list scrubbed**: `PI_HUB_USER/PASS`, `PI_HUB_AUTH*`
  never reach children (S2). Children get `PI_HUB_DISABLED=1` +
  `TAU_DISABLED=1`.
- No raw-HTML sinks: markdown escapes first; images validated (mime
  allowlist, base64 charset, size cap); code highlight/math render into
  DOM nodes (S1/B1, B2 placeholder-safe).
- Strict CSP (`default-src 'self'; script-src 'self'; img-src 'self' data:;
  frame-ancestors 'none'`), `nosniff`, no inline scripts (self-hosted
  highlight.js/KaTeX; lazy KaTeX).
- realpath + fd-based jails for file read/preview (symlink/TOCTOU safe,
  S4), single-level mkdir (ADR-018), no delete/rename/write, SVG never
  rendered same-origin.
- export writes only under the session store with generated names (S3).
- Body caps on every POST (S5), beacon rate limit (S7), WS `maxPayload` +
  backpressure drop (S10), bounded maps (S9).
- Process kill keeps the fingerprint rules (ADR-013): argv or `exe` must be
  pi (argv[0] `pi`, a `pi-coding-agent` install path, `bundle/cli.js`,
  `bin/pi`, or the `pi-node.sh` wrapper), re-checked at kill time; never
  self, never pid ≤ 1. The scan works on Linux and Android/Termux (`/proc`);
  other platforms report unsupported.

## 5. Performance budgets (the box is a Galaxy F12, ~2 GB free)

| Budget | Target |
|---|---|
| Idle hub RSS (no children) | < 80 MB |
| 3 headless children | fits `PI_HUB_MAX_HEADLESS=3`; eviction never kills a run |
| `GET /api/runners` warm | < 30 ms, never parses all session files |
| `GET .../history` first window | tail-read only; < 50 ms for a 10k-entry file |
| History read after the first | reads only the tail lines (a 39 MB session ⇒ < 1 MB window) |
| Listing after an append | reads only the appended bytes; no full re-parse of the growing file |
| Stream fan-out | delta coalescing ≈ 25–40 ms; no per-token WS frames |
| Client first interactive (warm cache, local) | < 1 s; parser budget < 300 ms JS |
| Phone UX | 390 px first, no layout thrash (`contain` on rows), one scroller |
| Network | push updates, zero periodic session-store polling; health check only while visible |

Session-store index: append-aware, per file — inode + head/tail fingerprints,
256 KB streaming chunks, and a 4096-line offset ring. Totals (tokens, cost),
title, model, thinking level and the entry count are updated incrementally as
bytes are appended; a listing reads only the delta since the last call, and a
history window reads only the lines it returns. First touch after hub start
streams the file once (CPU O(file), RAM constant) and is then cached; a
truncate/rewrite is detected and rebuilt. `/api/runners` stays metadata-only.

## 6. Coexistence & deployment

While parallel, everything is namespaced so tau-web and pi-hub can load in
one pi process without fighting:

| Concern | tau-web | pi-hub |
|---|---|---|
| Env prefix | `TAU_*` | `PI_HUB_*` |
| Disable | `TAU_DISABLED=1` | `PI_HUB_DISABLED=1` |
| Hub socket | `~/.pi/tau/hub.sock` | `~/.pi/pi-hub/hub.sock` |
| Cookie | `tau_auth` | `pi_hub_auth` |
| Dev port → final | 12045 (live) | 8292 → 12045 at flip |

Spawned children get both disable flags, so an installed tau-web stays
inert inside pi-hub children. Tests scrub `TAU_*`/`PI_HUB_*` and set
`TAU_DISABLED=1` for the hub under test.

Deployment (myserver / Termux, per its AGENTS.md):

- runit service `pi-hub` cloned from `stow/services/tau-web/`:
  `sleep infinity |` on stdin, `PI_HUB_PI_BIN=$HOME/scripts/pi-node.sh`
  (runsv has no LD_PRELOAD), env from `~/.env` (mode 600),
  `PI_HUB_HOST=127.0.0.1`, `PI_HUB_PORT=12045`, `PI_HUB_ALLOWED_HOSTS=pi.sharmaayush.com`,
  `PI_HUB_MAX_HEADLESS=3`, `TAU_DISABLED=1` during coexistence.
- Socket lifecycle: bind to `hub.sock.tmp-<pid>` then `rename`; on stale
  path, connect-probe before unlink (fixes B9 races).
- Flip: `sv down tau-web` → `sv up pi-hub` → verify → remove tau-web from
  settings packages. Rollback = swap the service back (files untouched).
- Phone UX: self-hosted assets (no CDN) so first load is not tunnel-bound;
  immutable `?v=` caching; service worker caches the shell.

## 7. Phases and gates

| Phase | Content | Exit gate |
|---|---|---|
| P0 | Scaffold, env/role/log/protocol, Runner interface, fake `pi` double | unit tests green |
| P1 | Hub core: http/router/static/auth/WS + headless runner + registry | C3 + C4 contract specs; A/X auth specs |
| P2 | Session store, windowed history, files jails, processes | C2 specs; X1–X4, X6 |
| P3 | hub.sock + live runner + relay + dialogs | C1 specs; D1; dialog relay |
| P4 | Client core (store/ws/runner/fsm/events) + transcript/composer/settings + testability contract (§3.4) | C1–C4 UI specs; R/U core |
| P5 | CSS tokens, remaining views, mobile/PWA | U specs, phone project green |
| P6 | Real-pi end-to-end, Termux Firefox smoke (ADR-020), perf budgets, docs, myserver service | full suite `--project=real`; CP3/CP4 on the phone; manual smoke |
| P7 | Flip: service + settings + README | tau-web removable; rollback documented |

LOC budget (2026-10-21 actuals, after LoC batch 2: server ≈ 5.2k, client JS
≈ 4.8k, CSS ≈ 1.5k, HTML ≈ 0.3k, tests ≈ 4.5k → **≈ 16.3k vs tau-web's
≈ 23.8k incl. tests**). The 1.9k server budget is blown, hence the
standing rule below. The client is less than half of tau-web's; the **server
(5.2k) still exceeds tau-web's server (4.9k)** but the gap is closing
(+430 → +239). `sessions.ts` is down to ~0.8k and falling.

**Standing rule: product LoC goes down or stays flat.** Every remaining item
below must pay for itself — implement it by deleting more than it adds
(unify, privatize, drop dead code first; add code last). Tests are exempt:
pins are load-bearing, never cut a pin to hit a number. Track the count per
batch in the change log (`docs/code-review.md` §7):
`wc -l` over `extensions/` + `public/` before and after.

## 7.1 Remaining work (what's left)

Every open item in one register. Status words: **open** (do it),
**manual** (human action, cannot be a test), **decision** (needs an ADR
before code), **deferred** (only if wanted). Each row names the cheapest
shape that fits the LoC rule.

| ID | What | Status | Cheapest shape |
|---|---|---|---|
| H1 | Cap over-eviction: `enforceCap` loops while `close()` is async, evicts every idle runner | **open** (High) | Mark closing / evict-one-per-bind in `registry.ts`; net-new lines ≈ 0 |
| H2 | No bind serialization: concurrent binds for one file spawn two children | **open** (High) | Per-file bind promise memo; X20 workaround already waits it out |
| H4 | Delta coalescer merges text+thinking under the first template's type | **open** (Med) | Split accumulators in `ws.ts` `flushDeltas`; small |
| H5 | Backpressure drop still advances `lastSeq`, gap never replayed | **open** (Med) | Advance `lastSeq` only on deliver; small |
| H6 | Per-IP keys collapse behind the tunnel (all clients `127.0.0.1`) | **decision** (Med) | ADR first (trusted-proxy flag or loopback exemption), then a branch |
| P4 | Streaming re-renders full markdown per frame in the browser (≈0.5 s CPU on 20k chars) | **open** (Med) | Stream as text node, render markdown once on `message_end` (`transcript.js`) |
| D1 | Spawn throttle (20/min) has no pin — needs 21 real children | **manual** | Document-only; do not build a 21-child test |
| D2 | `tests/cases.json` registry + meta-test absent; matrix enforced by review | **open** (Info) | Small JSON + one meta-test; pays by catching doc/test drift |
| M1–M4 | Deferred tau-web features (KaTeX math, highlighting, TTS, PWA SW) | **deferred** | Only if wanted; each must fit the LoC rule or stay deferred |
| P7 | Flip: runit service still runs old 0.1.0 build; tau-web is still live | **manual** | Deploy today's build, phone smoke (`testing.md` §5.4), then swap with rollback noted |
| LoC | Server exceeds tau-web's server (5.2k vs 4.9k) | **open** (batches 1–2 done: −339 lines) | Keep unifying/dropping dead code; next candidates: app.js sections, CSS tokens; see §7 change log |

Notes that used to live here and are now owned elsewhere:

- First scan after start (~0.3 s per 87 MB, constant RAM) still blocks the
  event loop — follows from the incremental index; async-ify only if the
  phone feels it (no complaint yet, no work planned).
- Reconnect re-binds and refetches the window; `sinceSeq` + the 200-event
  ring replays the gap (H10b, done).
- Fork/rename/export/delete all have UI affordances (context menu); delete
  closes a running owner first, then unlinks (ADR-018 amendment, done).
- The selenium/geckodriver backend is a CLI smoke only (interaction-heavy
  browser cases still require Playwright) — environmental, not work.

## 8. Open decisions (need sign-off)

1. **Playwright**: `@playwright/test@1.64` as devDep, `channel: "chrome"`
   (system Chrome; cached chromium fallback). No downloaded browsers needed.
2. **Drop the direct/hub-local channel**: the hub's own pi session is never
   a browser session (ADR-011); every session is headless or live.
3. ~~**Self-hosted highlight.js + lazy KaTeX** instead of CDN (CSP + snappy).~~
   **Deferred (ADR-022 M1/M2):** pi-hub renders code as plain text today.
4. **Serve the shell at `/`** (`/hub/` → 302 → `/`) instead of tau-web's
   `/` → `/hub/`.
5. ~~**Optional third gate**: parameterize tau-web's harness extension root
   (test-only edit) to run its 31 H/X cases against pi-hub during P6.~~
   **Superseded (ADR-022):** pi-hub's own suites are the only gate.
6. **Cross-platform browsers (ADR-020)**: `PI_HUB_E2E_DRIVER=auto` (default)
   prefers Playwright, falls back to system Firefox + geckodriver +
   selenium-webdriver on Termux, plus a zero-dep `cli` Firefox smoke. No
   geckodriver vendored; optional devDep installed only where used.
7. **Testability contract** (`body[data-ready]`, `window.__errs`,
   `data-*` hooks) adopted from `auto-mate` and shipped in the app from P4.
