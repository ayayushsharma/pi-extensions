# pi-hub code, security & functionality review

Status: **living document** — findings are fixed in batches, each with a pinning
case. Reviewed `pi-hub` against `tau-web` (the "tau-hub") as the baseline:
`extensions/mirror-server.ts` + `headless-bridge.ts` + `lib/hub-socket.ts`.
Line references drift; re-grep before editing.

Companions: `PLAN.md` (architecture), `testing.md` (case matrix),
`adr/019` (rewrite), `adr/020` (browser drivers), `adr/021` (singleton).
S-IDs (`S3`, `S12`, …) refer to the findings in `tau-web/docs/code-review.md`;
`H*`/`R*` IDs are pi-hub's own.

## 1. Method

Full static read of `extensions/**`, `public/js/**`, routes, store, tests and
docs; targeted greps for `innerHTML`/`html:`, image handling, auth and jail
paths; finding-by-finding comparison with tau-web's review; jiti load of every
touched module (the loader pi uses); live throwaway hubs for behaviours the
suite cannot cheaply cover (singleton refusal, drive consent, frame caps).
Suites are re-run after each batch; claims in this document are test-backed
unless marked manual.

Committed gate on the fast dev host: **73 unit · 94 integration · 170
Playwright** green (`--all`: 336 checks: 335 pass, 1 Firefox SKIP), jiti load
of every touched module (see §6). **On Termux this gate does not run as
checked out** — see T1; with test-only portability fixes the measured Termux
result is 72/72 unit (8.7 s) and 93/93 integration (124 s, `jobs=3`), E2E
unavailable (T2).

## 2. Verdict

pi-hub's Runner registry, push envelope and hub-only shape remove tau-web's
bug factory (three routing paths, ~60 module-level state variables, the dead
instance registry). Every headline tau-web defect is closed **by
construction**, not by patching: stored XSS, markdown placeholder crash, spawn
zombie, socket hijack, child credential leak, SVG preview, unbounded bodies,
missing headers, unbounded maps. The remaining work has been correctness
inside that shape, not another rewrite.

## 3. Tau-web findings — status in pi-hub

| tau-web | Finding | pi-hub |
|---|---|---|
| B1/S1 | Stored XSS via session image blocks | **Closed.** DOM-built rendering only; `innerHTML` is static icon markup. History images normalized and validated (`transcript.js`), SVG/mime/base64 rejected. E41/E41b. |
| B2 | `%%CODEBLOCK_n%%` crashes markdown | **Closed by construction.** No placeholder extract/substitute; unknown constructs degrade to text. |
| B3 | Failed spawn leaves a dead binding | **Closed.** `RpcSession` settles once on `error`/`close`/`exit`; cwd validated pre-spawn; `ready()`/`resume()` failures fail the bind ack. H2 below is a narrower race. |
| B4–B6 | New-session / reconnect / stale-card view bugs | **Closed.** UX-1/5/12/14 in `UX.md`, pinned by E9/E15/E25/E33. |
| B9 | hub.sock takeover races | **Closed.** Probe-live-before-unlink + own-inode unlink + connect-tested candidate list (UX-25). |
| S2 | Credentials inherited by children | **Closed.** `buildHeadlessChildEnv` strips `*_USER/PASS`, `*_AUTH*`, and hub/mirror topology keys. Unit-pinned. |
| S3 | `export_html` arbitrary write | **Partially closed.** `validateExportPath` (lexical prefix + realpath of existing parent) runs before the command reaches the child; the download route streams, size-capped. A final-component symlink can still escape, and any file under the store can be overwritten; generated names are not enforced (H11). X20/X20b only cover paths outside the store. |
| S4 | Symlink-following file jail / inline SVG | **Closed.** `realpath` jail on every read and browse; preview allowlist excludes SVG; `nosniff`. |
| S5 | Unbounded request bodies | **Closed.** `readJson` caps (300 K / 10 K login / 4 K small) with 413 + destroy. |
| S6 | Missing security headers | **Closed.** CSP (`script-src 'self'`), `nosniff`, `DENY`, `no-referrer`, CORP. |
| S7 | Beacon flood | **Closed.** `/api/client-error` is authenticated, 4 K capped and 20/min per key. X21c. |
| S9 | Unbounded maps | **Partially closed.** Tokens, failures, search/beacon buckets, session cache, replay ring and relay confirm waiters are bounded. The dialog broker is not: no cap/timeout and it broadcasts to every client (H10). |
| S10 | WS payload/backpressure | **Partially closed.** `maxPayload` 2 MB + per-peer connection cap; deltas coalesced. H5's delivered-only `lastSeq` is better, but an empty delta still advances past a pending coalesced batch (H9); H2 is incomplete on TTL/spawn-failure paths (H8). |
| S12 | Basic auth without backoff | **Closed.** One async auth gate for HTTP + WS; failures back off (500 ms × fails, cap 2 s) and 429 past 20; colon passwords intact. |
| S14 | mkdir through a symlinked parent | **Closed.** Parent realpath must stay under `$HOME`. |

## 4. pi-hub findings

| ID | Severity | Finding | Status | Pin |
|---|---|---|---|---|
| H1 | High | `enforceCap` loops while `close()` is async, so one bind over the cap evicts **every** idle runner | **Closed — accepted**: aggressive eviction protects the phone's 3.7 GB; it only ever kills idle runners, never a run. Deliberate trade-off, not a bug. Note: viewers are not protected, so a viewed idle session can be evicted. | — |
| H2 | High | No bind serialization: concurrent binds for one file spawn two children; a retry can reuse a child mid-`SIGTERM` | **Partially fixed** — explicit `closeById`/`closeByPid`/eviction unindex up front; TTL and spawn-failure paths do not, and unindex-before-exit permits a second writer during SIGTERM grace (H8) | Integration H2/H2b–H2d (explicit paths only) |
| H3 | High | Live runners keyed by file collapsed two TUIs on one session and orphaned the first relay | **Fixed** (`26a0a7a`, ADR-019 amendment) | `registry.test.ts`, ADR-019 |
| H4 | Med | Delta coalescer merges text+thinking into one `delta` under the first template's type | **Closed — accepted**: cosmetic mislabel only, on the single-driver preview path nobody reported; splitting the hot-path accumulators is not worth it. | — |
| H5 | Med | Backpressure drop still advances `lastSeq`, so the gap is never replayed | **Partially fixed** — delivered-only `lastSeq` works for non-delta frames, but an empty delta still advances past a pending coalesced batch (H9) | `ws.test.ts` (drop/replay, healthy advance, dropped flush) |
| H6 | Med | Per-IP keys collapse behind a tunnel (all clients are `127.0.0.1`): 32-socket cap and rate limits are global | **Open — needs a decision** (trusted-proxy flag, or exempt loopback) | — |
| H7 | High | Session-index cache cliff: with >200 files, `INDEX_MAX=200` eviction by `lastAt` makes every listing rebuild every file (260 files → 260 full scans on two consecutive calls; 285 ms then 165 ms). P2 is undone at real store sizes. | **Open** (measured 2026-10-22) | Needs a 250-file regression: second listing must scan 0 |
| H8 | High | H2's close paths are incomplete: `scheduleTtl` and the `spawnHeadless` catch call `close()` without unindexing; `HeadlessRunner.close()` leaves `state` `idle`, so a retry binds a child mid-SIGTERM (`RpcSession.send` silently drops). Unindex-before-exit also permits a second writer during the SIGTERM grace. | **Open** | TTL/failure pin + a `closing` state; H2a–H2d only cover explicit close |
| H9 | Med | Empty delta advances `lastSeq` while a coalesced batch is pending; if the flush drops on backpressure, the batch is discarded and the gap is never replayed (repro: `lastSeq=4`, only seq 3/4 sent). | **Open** | One-line guard + `ws.test.ts` case |
| H10 | Med | Dialog broker is unbounded and unscoped: no timeout/cap, broadcasts to every client, `Mirror.ask` never times out. A background tab or a second session can hang the TUI or cross modals. | **Open** (S9 claim was premature) | Timeout + per-runner delivery + cap + disconnect cancel |
| H11 | Med | Export path uses a lexical prefix + parent realpath only: a final-component symlink escapes the store and any file under the store can be overwritten; no generated-name enforcement. | **Open** (S3 partially closed) | lstat final, require `.html`, derive name server-side |
| H12 | Low | Process fingerprint accepts any argv path ending `bundle/cli.js`/`bin/pi`; the kill route rechecks the same broad rule, so a user project named that way can be killed. | **Open** | Tighten to pi install roots; fail closed |
| H13 | Low | Relay drive-confirm waiters are uncapped for 25 s; authenticated attach spam allocates timers. | **Open** | Per-pid cap |
| H14 | Med | `forkSession`/`relocateSession` write `SESSIONS_DIR/<dirName>/` even when the store is flat; `resolveSessionPath` is flat-aware but the writes are not → ENOENT on a flat `PI_CODING_AGENT_SESSION_DIR`. | **Open** | Use `isFlatDir` for the destination |
| R1 | Med | History images with no `mimeType` or a `data:` URL payload were dropped (tau-web's hardened renderer accepted both) | **Fixed** | E41/E41b |
| R2 | Med | Composer accepted mimes the server rejects (AVIF/HEIC/BMP/SVG), lost the attachment on a failed send, and let an 8 MB file hit the 2 MB frame cap (close 1009) | **Fixed** (allowlist + downscale + budgets + restore) | E42/E42b/E43, X10 |
| R3 | Low | `PI_HUB_DRIVE_CONFIRM` was armed after the server accepted sockets — a startup attach could bypass consent | **Fixed** | `relay.test.ts`, manual |
| R4 | Low | A synchronous throw from a custom `ui.confirm` left `forceNative` stuck, disabling browser dialogs for the session | **Fixed** | `mirror.test.ts` |
| R5 | Low | `Hub.stop()`/`start()` reuse could leave the advert claim and an unclosed server after a failed restart | **Fixed** (latent, single-use in practice) | — |
| R6 | Med | Transcript DOM is unbounded (entries grow forever) and every `set()` re-renders the whole view; long sessions accumulate nodes/layout cost. P4 (streaming markdown) is a separate browser-CPU item. | **Open** | Cap visible rows + "N earlier hidden"; keyed append |
| R7 | Low | Client nits: `findTabByFile` matches basename only; `IMAGE_EXT` accepts svg/bmp/avif while the server preview allows 4 mimes; `el({html})` is a dead footgun; the live-row X calls headless-only close; welcome copy says "type below" after the composer hide; picker Tab on a typed outside path; browse failure keeps stale entries. | **Open** | One small client batch |
| P1 | Low | Search read every session file per request; export download buffered the whole file | **Fixed** (file/budget caps, streamed download) | `store.test.ts`, X20 |
| P2 | High | History and listing parsed the **whole** JSONL every time: a 39 MB session cost ~+120 MB hub RSS (HWM 479 MB on a 3.7 GB phone) and a cold 99 MB store listing +200 MB | **Fixed** (append-aware per-file index; windows read tail lines, first touch streams in 256 KB chunks) | `store.test.ts` (incremental/partial/truncate/deep) |
| P3 | High | The actively-growing session was re-parsed on **every token**: the summary cache keyed `(mtime,size)`, so each append invalidated the entry | **Fixed** (index consumes appended bytes only; a 12 KB append reads 12 KB) | `store.test.ts` |
| P4 | Med | Streaming re-renders the full markdown per frame in the **browser** (533 ms vs 2.6 ms for 20k chars as plain text) — client CPU, not hub RAM | **Open** (deferred; safe to do after the server fix) | — |
| F1 | Med | Process panel said "not supported on this platform" on the homeserver: Node reports `process.platform === "android"` on Termux, and pi's argv[0] is `node`/`sh`, never `pi` | **Fixed** (Linux+Android gate; argv/`exe` fingerprint: `pi-coding-agent` path, `bundle/cli.js`, `bin/pi`, `pi-node.sh`) | `processes.test.ts` |
| D1 | Info | Spawn throttle has no test (needs 21 real children) | **Open (manual)** | — |
| D2 | Info | `tests/cases.json` registry + meta-test still absent, so the matrix is enforced by review, not by CI | **Open** | — |
| D3 | Info | Firefox CLI smoke SKIPs on hosts whose system Firefox cannot render headless | **Environmental** | FC0 |
| T1 | High (gate) | Termux gate is not runnable as checked out: eager `playwright-core` import in `run.mjs`; `--test tests/unit/` fails on Node 26; `/tmp` hardcoded in store tests/helpers/fixtures; `pi` shim `#!/usr/bin/env node` fails when Node spawns it. With test-only patches: 72/72 unit (8.7 s), 93/93 integration (124 s). | **Open** | Lazy e2e import, file list/glob, `os.tmpdir()`, `PI_BIN` wrapper |
| T2 | Med | ADR-020 Firefox/Selenium backend is design-only: no `PI_HUB_E2E_DRIVER`/`PageDriver`; E2E is Playwright API. POC works (Firefox 158 + geckodriver 0.37.1 + selenium-webdriver 4.51: `data-ready`, `__errs=[]`, fixture resume, screenshot; 44 s incl. 16.4 s hub boot). The `cli` backend (`--dump-dom`) stalls on this phone, so CP2/CP6 are wrong. | **Open** | Facade + `termux-smoke`; persistent Selenium, not CLI (`docs/termux-browser-poc.md`) |
| T3 | Info | Doc/count drift: UX §7 (72/90/170, 328) vs PLAN/testing/README (73/94/170/336); S10 row says H5 open while §4 says fixed; "dev phone" timings 0.3/3.0/13 s vs measured 8.7/124 s/n-a. | **Open (doc)** | This batch; add a count check to D2 |
| M1 | Deferred | Math rendering (KaTeX); raw LaTeX shows as text | **Deferred — ADR-022** | — |
| M2 | Deferred | Syntax highlighting in code blocks + file viewer | **Deferred — ADR-022** | — |
| M3 | Deferred | Read-aloud TTS (dictation *is* ported) | **Deferred — ADR-022** | — |
| M4 | Deferred | PWA offline service worker (manifest exists, installs at `/`) | **Deferred — ADR-022** | — |
| M5 | Closed | tau-web wire aliases / third-gate harness | **Dropped by decision — ADR-022** | ADR-022 |

## 5. Security posture (as built)

- Cookie sessions (`HttpOnly`, `SameSite=Lax`, `Secure` over TLS), sliding TTL,
  token/failure maps capped; constant-time, length-hiding credential compare.
- Login **and** Basic obey the same per-key failure budget; no
  `WWW-Authenticate` anywhere, so no native browser prompt can appear.
- Host/Origin: exact loopback + own bind address + explicit pins. No
  any-IPv4, no `*.ts.net` suffix trust; `@`/whitespace-smuggled hosts refused.
- Wildcard bind without credentials refuses at boot (A9).
- Children: secrets and topology scrubbed; `PI_HUB_DISABLED`/`TAU_DISABLED` set.
- Files: realpath jails for browse/view/preview/export/relocate; the only
  mutations are single-level `mkdir` under `$HOME`, session rename (append-only
  `session_info`), fork/relocate (copy), and delete (jailed, refuses a running
  owner). Export is only parent-realpathed: a final symlink or another store
  file can still be overwritten (H11).
- Live: single driver enforced server-side; preview sockets may read state but
  not drive; opt-in per-attach native consent (fail-closed).
- Floods: WS connections per peer, search, beacons, spawns and relay confirm
  waiters; the dialog broker's pending map is **not** capped or timed out
  (H10).
- Frames: 2 MB cap; attachments downscaled client-side to fit it.

**Known trade-off (documented, not a bug):** an authenticated browser can read
any file under `$HOME` through the text viewer. That is the "auth = the user"
model; keep loopback bind and strong credentials off-loopback.

## 6. Testing notes & honest gaps

- Every fix above ships with a pin in `tests/unit/*.test.ts`,
  `tests/integration.mjs` (A/X/D/G/H/P groups) or `tests/e2e.mjs` (E-cases,
  including the `images` group).
- The case matrix in `testing.md` is now accurate about semantics (X10 closes
  with 1009 rather than staying alive) and about what is unpinned (spawn
  throttle, drive-consent timeout leg).
- Store pins: an append reads only the appended bytes (12 KB append ⇒ 12 KB),
  an unterminated trailing line stays invisible until its newline arrives, a
  truncate/rewrite rebuilds instead of serving stale totals, and paging older
  than the 4096-line offset ring still returns the right window.
  `processes.test.ts` builds a fake `/proc` and pins the Termux argv shapes
  (`node …/pi-coding-agent/…`, `sh …/pi-node.sh`, `bun`, `node …/bundle/cli.js`)
  and that `node app.js` never matches.
- Firefox CLI smoke requires a system Firefox that can render headless
  (`--dump-dom`); it SKIPs with a reason elsewhere (CP2/CP6). On this phone it
  **stalls** in the renderer, so the CLI path is not a Termux gate. The
  Selenium/geckodriver POC does work (T2).
- **Termux measurements (2026-10-22, Galaxy F12, Node 26.4, 7 cores, 3.7 GB):**
  `pi --version` 9.7 s, hub boot 16.4 s, headless child spawn ~11 s. With
  test-only portability fixes: unit 72/72 in 8.7 s; integration 93/93 in
  124 s at `jobs=3` (165 s serial); E2E unavailable. The process-startup cost,
  not the test bodies, is the floor.
- **Selenium POC:** Firefox 158 + geckodriver 0.37.1 + selenium-webdriver
  4.51.0 loaded `/hub/`, reached `data-ready=1`, reported `window.__errs=[]`,
  listed and resumed the fixture, and captured a transcript screenshot. Hub
  boot 16.4 s, Firefox launch 9.6 s, first paint+ready 1.3 s, browser-side
  smoke 23.2 s (≈44 s end-to-end). One persistent browser, one at a time on
  this device; no full E2E port yet (T2).
- Manual per release: phone smoke (`testing.md` §5 item 4), UI parity screenshots,
  drive-consent timeout against a real TUI.

## 7. Change log

| Batch | Commit | Scope |
|---|---|---|
| 1 | `26a0a7a` | Singleton (ADR-021); live parity + single-driver enforcement; security hardening (S2/S3/S4/S7/S9/S10/S12/S14 equivalents, A8/A9, cookies, floods, topology scrub, drive consent); caps (search/fence/export); ADR-019 amendment; matrix X17–X22, A2/A4–A9 corrected. |
| 2 | `6fcff39` | R1–R5 from this review: history image normalization, composer allowlist + downscale + budgets + restore, consent window, `forceNative` reset, `stopped` reset; X10 semantics corrected and pinned; X21/X21c flood pins; E41–E43; docs (this file, README/PLAN/testing/UX counts and rows). |
| 3 | `a0e25cc` | **Independence (ADR-022):** pi-hub owns its client/wire; tau-web aliases + third-gate harness dropped; deferred features M1–M4 recorded instead of implied; ADR-019 §4/§5 annotated; manifest `start_url` fixed to `/`; PLAN protocol table corrected to the real dialect (`subscribe`/`dialog_response` rows removed). |
| 4 | `432a389` | **Server RAM + Termux:** append-aware session index (window reads 0.8 MB of a 31 MB file instead of all of it; cold 87 MB store +13 MB RSS instead of +200 MB; append listing reads only the 12 KB delta); history meta still exact (tokens/cost/title) from the index; Android process scan fixed (platform gate + argv fingerprint; `/proc` works in Termux); unit pins for both; docs. |
| 5 | `8220f51` | **LoC reduction, batch 1 (−103 product lines, 12,155 → 12,052):** `sessions.ts` 846 → 793 — one chunked line walker (`eachLine`) replaces `consume` + `forEachLineSync`, one shared `foldEntry` for index + search (titles now agree), `intact` reuses the fingerprint helpers, `isFlatDir`/`projectDirs` deduped, dead `readAll` + privatized internals; dropped dead routes `GET /api/projects` (superset: `/api/sessions`) and `GET /api/headless/status` (superset: `/api/runners`) — both zero callers, unpinned, absent from ADR-022's canonical list; dropped dead client helpers (`listProjects`, `sessionFileExists`, `listRunners`, `listInstances`, `headlessStatus`, `clientError`) + `debounce` + `runnerList` + `errorResponse`. Pinned routes (`/api/runners`, `/api/instances`, `/api/client-error` limiter, `/api/session-file-exists` canonical) untouched. Full gate green. |
| 6 | `2bd5c83` | **LoC reduction, batch 2 (−236 product lines, 12,052 → 11,816):** one `LineBuffer` (protocol.ts) replaces three NDJSON loops (RPC child, hub.sock server+client) with a unit pin; `mirror.messageContent` reuses `isValidMessageImage` instead of re-validating; dialog wrappers table-driven; one `fail` helper for 7 catch bodies; `probePort`/`probeSocket` share one prober; dead WS `instances` verb, `isDriver`/`driverId`/`broadcastDialog`, `sendDrive`, `pendingCount`, `HeadlessRunner.request`, `settled` emit, `hasClient`, `clientCount`, `configured`, dead CSS rules (banner-icon/brand-logo/cursor/fsize/fav-row/live-title/sr-only), 14 unused icons + shadowed `message` + 5 unused logo marks collapsed to one, dead `state.banner` branch, `offer`/`confirm` merged + dead `prompt`/`pending`, settings toggles table-driven, `shortCwd`/`shortenPath` share `collapseHome`, routes share `sessionAnchor`/`rootsFor`, unused mime rows/imports/exports dropped, 3 dead state fields. Deliberately NOT cut: sub-threshold dups (composer foot/search, transcript usage lines, registry pid loops — abstraction costs more than it saves), write-only `connState`/`authRequired` (entangled in live lines), pinned routes. Full gate green (70/90/170). |
| 7 | _(this change)_ | **H1/H4 accepted, H2 + H5 partially fixed (residuals H8/H9):** H1 aggressive eviction and H4 delta mislabel closed as deliberate trade-offs (documented rationales); H2 bind serialization — per-file in-flight spawn promise shared by concurrent resumes, `closeById`/`closeByPid`/eviction unindex the file up front, dead indexed runners never reused; H5 — `lastSeq` tracks delivered frames only (`send` boolean, flush commits on success, binds start at head, replay guard simplified). Pins: integration H2/H2b (one runner, one pid), H2c/H2d (retry-after-close spawns fresh and answers), new `ws.test.ts` (3 backpressure cases). Full gate green (73/94/170; `--all` 336). |
| 8 | `935088a` | **Round-2 review + Termux/Selenium findings:** H7–H14, R6–R7, T1–T3 recorded; S3/S9/S10 and H2/H5 downgraded to partial; ADR-020, testing/PLAN/README/UX corrected; no product code changed. Linux gate unchanged (73/94/170); Termux gate open. |
| 9 | _(docs runbook)_ | **Termux Firefox/Selenium POC runbook** (`termux-browser-poc.md`): setup, tested driver snippet, measured timings, capability limits, CP3/CP4 porting plan; linked from testing/ADR-020/T2. |
| next | — | H7/H8/H9 first (P2/H2/H5 completion), then H10/H11; H6 (trusted proxy) decision in an ADR; `tests/cases.json` + meta-test; T1/T2 Termux gate; pick up M1–M4 if wanted; deploy/flip (P7). |

## 8. Deferred scope & deliberate differences

See **ADR-022**. Short version: pi-hub is independent at the wire level, so
`start_session` / `rpc_event` / `tui_command` / route aliases do not exist and
tau-web's harness is not a gate. Features tau-web had that pi-hub does not are
tracked as M1–M5 above (math, highlighting, TTS, PWA SW, wire aliases) and are
*not* regressions. Capabilities dropped for security/architecture reasons
stay dropped: `/api/open`, `/api/rpc`, `set_auth`/`get_auth`, the instance
registry, and the direct/hub-local channel.

## 9. Reproducing

```bash
cd pi-hub && npm install
node tests/run.mjs --unit          # 73 pure contracts (Linux)
node tests/run.mjs                 # 94 HTTP/WS checks (real pi, fake model)
node tests/run.mjs --e2e           # 170 Playwright checks
node tests/run.mjs --all -j1       # + Firefox smoke, serial logs
```

On Termux this does not run as checked out (T1). The measured recipe used a
test-only copy with `os.tmpdir()/TMPDIR` instead of `/tmp`, a working
`PI_BIN` launcher (`node …/bundle/cli.js`), explicit unit files instead of
`--test tests/unit/`, and a driver script that imports `runIntegration`
without the eager Playwright import. See `testing.md` §1.1 for the checklist.

Selenium POC setup (Termux, auto-mate recipe):

```bash
pkg install x11-repo firefox ttf-dejavu
# geckodriver 0.37.1 linux-aarch64 -> tests/.bin/geckodriver (gitignored)
npm i --no-save selenium-webdriver
# facade not implemented yet; see T2 / testing.md §1.2
```

Frame-cap probe (what made R2 visible): send a prompt whose images total
> 2 MB over `/ws`; the socket closes with 1009 and the hub stays healthy
(integration X10).
