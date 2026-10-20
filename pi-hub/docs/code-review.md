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

Last verified: **69 unit · 90 integration · 170 Playwright** green (`--all`:
328 checks: 327 pass, 1 Firefox SKIP), jiti load of every touched module (see §6).

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
| S3 | `export_html` arbitrary write | **Closed.** `validateExportPath` (prefix + realpath of existing parent) runs before the command reaches the child; the download route streams, size-capped. X20/X20b. |
| S4 | Symlink-following file jail / inline SVG | **Closed.** `realpath` jail on every read and browse; preview allowlist excludes SVG; `nosniff`. |
| S5 | Unbounded request bodies | **Closed.** `readJson` caps (300 K / 10 K login / 4 K small) with 413 + destroy. |
| S6 | Missing security headers | **Closed.** CSP (`script-src 'self'`), `nosniff`, `DENY`, `no-referrer`, CORP. |
| S7 | Beacon flood | **Closed.** `/api/client-error` is authenticated, 4 K capped and 20/min per key. X21c. |
| S9 | Unbounded maps | **Closed.** Tokens, failures, search/beacon buckets, session cache, replay ring, dialog waiters (timeout) all bounded. |
| S10 | WS payload/backpressure | **Partially closed.** `maxPayload` 2 MB + per-peer connection cap; deltas coalesced. Loss on backpressure is still open (H5). |
| S12 | Basic auth without backoff | **Closed.** One async auth gate for HTTP + WS; failures back off (500 ms × fails, cap 2 s) and 429 past 20; colon passwords intact. |
| S14 | mkdir through a symlinked parent | **Closed.** Parent realpath must stay under `$HOME`. |

## 4. pi-hub findings

| ID | Severity | Finding | Status | Pin |
|---|---|---|---|---|
| H1 | High | `enforceCap` loops while `close()` is async, so one bind over the cap evicts **every** idle runner | **Open** | — |
| H2 | High | No bind serialization: concurrent binds for one file spawn two children; a retry can reuse a child mid-`SIGTERM` | **Open** (worked around in X20) | — |
| H3 | High | Live runners keyed by file collapsed two TUIs on one session and orphaned the first relay | **Fixed** (`26a0a7a`, ADR-019 amendment) | `registry.test.ts`, ADR-019 |
| H4 | Med | Delta coalescer merges text+thinking into one `delta` under the first template's type | **Open** | — |
| H5 | Med | Backpressure drop still advances `lastSeq`, so the gap is never replayed | **Open** | — |
| H6 | Med | Per-IP keys collapse behind a tunnel (all clients are `127.0.0.1`): 32-socket cap and rate limits are global | **Open — needs a decision** (trusted-proxy flag, or exempt loopback) | — |
| R1 | Med | History images with no `mimeType` or a `data:` URL payload were dropped (tau-web's hardened renderer accepted both) | **Fixed** | E41/E41b |
| R2 | Med | Composer accepted mimes the server rejects (AVIF/HEIC/BMP/SVG), lost the attachment on a failed send, and let an 8 MB file hit the 2 MB frame cap (close 1009) | **Fixed** (allowlist + downscale + budgets + restore) | E42/E42b/E43, X10 |
| R3 | Low | `PI_HUB_DRIVE_CONFIRM` was armed after the server accepted sockets — a startup attach could bypass consent | **Fixed** | `relay.test.ts`, manual |
| R4 | Low | A synchronous throw from a custom `ui.confirm` left `forceNative` stuck, disabling browser dialogs for the session | **Fixed** | `mirror.test.ts` |
| R5 | Low | `Hub.stop()`/`start()` reuse could leave the advert claim and an unclosed server after a failed restart | **Fixed** (latent, single-use in practice) | — |
| P1 | Low | Search read every session file per request; export download buffered the whole file | **Fixed** (file/budget caps, streamed download) | `store.test.ts`, X20 |
| P2 | High | History and listing parsed the **whole** JSONL every time: a 39 MB session cost ~+120 MB hub RSS (HWM 479 MB on a 3.7 GB phone) and a cold 99 MB store listing +200 MB | **Fixed** (append-aware per-file index; windows read tail lines, first touch streams in 256 KB chunks) | `store.test.ts` (incremental/partial/truncate/deep) |
| P3 | High | The actively-growing session was re-parsed on **every token**: the summary cache keyed `(mtime,size)`, so each append invalidated the entry | **Fixed** (index consumes appended bytes only; a 12 KB append reads 12 KB) | `store.test.ts` |
| P4 | Med | Streaming re-renders the full markdown per frame in the **browser** (533 ms vs 2.6 ms for 20k chars as plain text) — client CPU, not hub RAM | **Open** (deferred; safe to do after the server fix) | — |
| F1 | Med | Process panel said "not supported on this platform" on the homeserver: Node reports `process.platform === "android"` on Termux, and pi's argv[0] is `node`/`sh`, never `pi` | **Fixed** (Linux+Android gate; argv/`exe` fingerprint: `pi-coding-agent` path, `bundle/cli.js`, `bin/pi`, `pi-node.sh`) | `processes.test.ts` |
| D1 | Info | Spawn throttle has no test (needs 21 real children) | **Open (manual)** | — |
| D2 | Info | `tests/cases.json` registry + meta-test still absent, so the matrix is enforced by review, not by CI | **Open** | — |
| D3 | Info | Firefox CLI smoke SKIPs on hosts whose system Firefox cannot render headless | **Environmental** | FC0 |
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
  owner).
- Live: single driver enforced server-side; preview sockets may read state but
  not drive; opt-in per-attach native consent (fail-closed).
- Floods: WS connections per peer, search, beacons, spawns, dialog waiters.
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
  (`--dump-dom`); it SKIPs with a reason elsewhere (CP2/CP6).
- Manual per release: phone smoke (`testing.md` §5.4), UI parity screenshots,
  drive-consent timeout against a real TUI.

## 7. Change log

| Batch | Commit | Scope |
|---|---|---|
| 1 | `26a0a7a` | Singleton (ADR-021); live parity + single-driver enforcement; security hardening (S2/S3/S4/S7/S9/S10/S12/S14 equivalents, A8/A9, cookies, floods, topology scrub, drive consent); caps (search/fence/export); ADR-019 amendment; matrix X17–X22, A2/A4–A9 corrected. |
| 2 | `6fcff39` | R1–R5 from this review: history image normalization, composer allowlist + downscale + budgets + restore, consent window, `forceNative` reset, `stopped` reset; X10 semantics corrected and pinned; X21/X21c flood pins; E41–E43; docs (this file, README/PLAN/testing/UX counts and rows). |
| 3 | `a0e25cc` | **Independence (ADR-022):** pi-hub owns its client/wire; tau-web aliases + third-gate harness dropped; deferred features M1–M4 recorded instead of implied; ADR-019 §4/§5 annotated; manifest `start_url` fixed to `/`; PLAN protocol table corrected to the real dialect (`subscribe`/`dialog_response` rows removed). |
| 4 | `432a389` | **Server RAM + Termux:** append-aware session index (window reads 0.8 MB of a 31 MB file instead of all of it; cold 87 MB store +13 MB RSS instead of +200 MB; append listing reads only the 12 KB delta); history meta still exact (tokens/cost/title) from the index; Android process scan fixed (platform gate + argv fingerprint; `/proc` works in Termux); unit pins for both; docs. |
| 5 | _(this change)_ | **LoC reduction, batch 1 (−103 product lines, 12,155 → 12,052):** `sessions.ts` 846 → 793 — one chunked line walker (`eachLine`) replaces `consume` + `forEachLineSync`, one shared `foldEntry` for index + search (titles now agree), `intact` reuses the fingerprint helpers, `isFlatDir`/`projectDirs` deduped, dead `readAll` + privatized internals; dropped dead routes `GET /api/projects` (superset: `/api/sessions`) and `GET /api/headless/status` (superset: `/api/runners`) — both zero callers, unpinned, absent from ADR-022's canonical list; dropped dead client helpers (`listProjects`, `sessionFileExists`, `listRunners`, `listInstances`, `headlessStatus`, `clientError`) + `debounce` + `runnerList` + `errorResponse`. Pinned routes (`/api/runners`, `/api/instances`, `/api/client-error` limiter, `/api/session-file-exists` canonical) untouched. Full gate green. |
| next | — | H1, H2, H4, H5; P4 (client streaming render); decide H6 (trusted proxy) in an ADR; `tests/cases.json` + meta-test; pick up M1–M4 if wanted. |

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
node tests/run.mjs --unit          # 69 pure contracts
node tests/run.mjs                 # 90 HTTP/WS checks (real pi, fake model)
node tests/run.mjs --e2e           # 170 Playwright checks
node tests/run.mjs --all -j1       # + Firefox smoke, serial logs
```

Frame-cap probe (what made R2 visible): send a prompt whose images total
> 2 MB over `/ws`; the socket closes with 1009 and the hub stays healthy
(integration X10).
