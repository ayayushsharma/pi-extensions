# tau-web — agent notes

Package-local notes. Read the repo-root `AGENTS.md` first (pi-package rules,
lifecycle, no-stdout rule); this file covers only what is specific to this
package.

## Identity

- Directory / npm package: `tau-web`. Only extension entry:
  `extensions/mirror-server.ts` (see `package.json` → `pi.extensions`).
- Fork of the retired `deflating/tau` (MIT). The original copyright notice is
  retained in `LICENSE`; do not re-attribute upstream code.
- Docs: `README.md` (protocol + config), `docs/architecture.md` (diagrams),
  `docs/testing.md` (e2e design), `docs/code-review.md` (security/perf
  findings), `docs/adr/001–018` (accepted decisions), `ROADMAP.md` (carried
  over from tau, not planned), `MOBILE.md` (mobile-specific UX).

## Architecture

One package, two roles, resolved from the pi mode by
`extensions/lib/config.ts` (`TAU_ROLE=hub|mirror` forces it):

- **hub** — `pi --mode rpc`, no TUI. Owns the only browser port, the
  `hub.sock` listener, and all headless children.
- **mirror** — any interactive pi process. Starts no HTTP; dials
  `~/.pi/tau/hub.sock` and executes relayed commands.

Headless children are spawned as `pi --mode rpc` with `TAU_DISABLED=1`, so
they resolve to mirror and start nothing.

| File | Responsibility |
|---|---|
| `extensions/mirror-server.ts` | hub: HTTP+WS, `/api/*`, static serving, browser command router, relay fan-out, role lifecycle, event forwarding |
| `extensions/headless-bridge.ts` | `HeadlessRegistry` / `RpcSession`: one persistent `pi --mode rpc` child per browser WS, LF-JSONL framing |
| `extensions/lib/config.ts` | hub/mirror role resolution |
| `extensions/lib/hub-socket.ts` | `hub.sock` NDJSON transport (hub listens, mirrors dial; 0700 dir = auth) |
| `extensions/lib/processes.ts` | `/proc` `pi` process scan + TERM→KILL (ADR-013) |
| `public/` | vanilla-JS UI, no build step; `public/hub/` is the hub shell mounted at `/hub/` |
| `tests/` | layered e2e harness (`npm run test:e2e`) |
| `scripts/review-loop/` | coder↔reviewer fix orchestration (output in `docs/review-loop/`) |

Flows (details and diagrams in `docs/architecture.md`):

- **Browser**: one WS `/ws` = one headless backend, keyed by connection;
  separate tabs stay independent. Session identity is
  `#session=<file-basename>` (never a path). The stream epoch guard is
  client-side (`bindingEpoch` in `public/app.js`) — it drops in-flight events
  from a previous session after a switch.
- **Events → browser**: backend streams as `{type:"rpc_event", event}`;
  dialogs as `{type:"event", event:{type:"extension_ui_request"}}`; plus
  `session_file` / `session_ended`. The hub role never broadcasts its own
  session events (only mirror role forwards).
- **Attach relay (ADR-014)**: mirrors announce over hub.sock
  (`hello` / `status` / `event` / `snapshot` / `response`); the hub forwards
  `instances`, `attach`→`attached`, `tui_command`→`drive`,
  `detach`→`detached`, `mirror_sync`, `tui_dead`, `mirrors_changed`.
  Mirrors serve no browsers and there is no per-TUI port (ADR-011).
- **Prompt routing** (client decides, server executes): driven TUI
  (`tui_command`) → bound headless (`rpc_command`) → direct send. Driving is
  preview-first; detach freezes the view and never resumes the file headless
  (two writers, ADR-003/009).
- **Dialogs (ADR-007)**: the browser owns `select` / `confirm` / `input` /
  `editor` when connected (TUI shows a notice instead of a second prompt);
  with no browser the native prompt runs. `extension_ui_response` routes to
  the headless child, the relayed mirror, or the hub waiter.
- **Sessions**: persistent by default (`PI_WEB_TTL_MS` /
  `TAU_HEADLESS_TTL_MS` `0` = never reap); `TAU_MAX_HEADLESS` LRU-evicts
  idle sessions, never a running agent. Rejoining the same file must not
  re-send `switch_session` — pi cancels the in-flight turn (ADR-015).
  Session files resolve under `~/.pi/agent/sessions/`, traversal rejected.

Security (README + `docs/code-review.md`): cookie auth (`POST /api/login` →
HttpOnly `tau_auth`) gates `/api/*` and the WS upgrade; the static shell stays
public so the login overlay can render. Host/Origin allowlist against DNS
rebinding. Loopback bind by default — never `0.0.0.0` without auth. Auth env
(`TAU_USER` / `TAU_PASS` / `TAU_AUTH*`) is stripped from headless children.

## Dev loop

```bash
cd tau-web && npm install
TAU_MIRROR_PORT=8199 TAU_HOST=127.0.0.1 TAU_STATIC_DIR=$(pwd)/public pi -e .
# from the repo root: pi -e ./tau-web
```

- `.ts` change: `node ../clear-jiti.mjs`, then `/reload` in the TUI.
- `public/` change: browser reload only. Bump the `?v=` query in
  `public/hub/index.html` when editing `app.js` — versioned URLs are served
  immutable, everything else revalidates via ETag.
- Never run `tau` and `tau-web` in one process (sibling port bump + stale UI);
  the server logs `WARNING: sibling mirror`. Full note in `README.md`.
- Useful env: `TAU_ROLE` (force role), `TAU_DISABLED=1` (server off),
  `TAU_DEBUG=1` + `TAU_LOG_FILE` (log, default `~/.pi/tau/tau.log`),
  `TAU_FS_ROOTS` (extra browse roots, used by tests).
- Runtime deps: `ws` only. Pi APIs are `import type` (erased at runtime).

## Tests

```bash
npm run test:e2e        # node tests/run.mjs — auto-SKIPs missing deps
npm run test:e2e:p0     # H1–H11 only
node tests/run.mjs --filter H7,H8,H9
TEST_REAL_HUB=1 node tests/run.mjs --filter H6   # Layer D (real pi)
TAU_STRICT=1 node tests/run.mjs                  # CI: SKIP becomes failure
```

Layers A–D (static → fake WS backend → stub hub → real hub) are defined in
`docs/testing.md` §1; cases H1–H21, D1/D5, P2, X1–X6 live in `tests/e2e/`.
Hygiene: tests never use port 8192 and kill by parent PID — never
`pkill -f <pattern>` (`tests/README.md`, `docs/testing.md` §2).

## Gotchas

- Never write to stdout/stderr — it corrupts the TUI. `tauLog` / `tauDebug`
  (`TAU_DEBUG=1`) write to the log file; UI output goes via
  `ctx.ui.notify()` / `ctx.ui.setStatus()`.
- Do not re-add per-TUI slash commands (`/tau`, `/taustart`, …) or a per-TUI
  server; attach/drive flows through the hub relay only.
- Compaction: pi emits `session_before_compact` / `session_compact` /
  `session_compact_failed`; the server normalizes them to
  `compaction_start` / `compaction_end`. `auto_compaction_*` never fired.
- Dialogs must stay single-driver: browser wins when connected, otherwise
  native; don't let the TUI prompt and the web modal race.
- No emoji in the UI — inline SVG (`public/icons.js`) so themes and phones
  render identically.
- Session-list caches key parsed summaries by (path, mtimeMs, size); keep
  `/api/sessions` response shapes stable when touching the store.
