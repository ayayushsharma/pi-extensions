# tau-web

Unified Pi web UI: **sessions in one package, one port**. The hub owns
headless `pi --mode rpc` backends per browser connection — and relays
live terminal sessions through the attach path (ADR-014): mirrors dial
the hub over `~/.pi/tau/hub.sock`, browsers preview-then-drive them, no
per-TUI port. Full web dialogs (`select` / `confirm` / `input` /
`editor`) and Tau cookie-session auth throughout.

Started as a copy of `tau`; `tau/` stays untouched until tau-web passes the harness
below. See `docs/adr/` for the accepted decisions.

## Status

Implemented end to end and harness-verified (P0–P2 core): headless bridge,
attach relay for live sessions, unified `{type: rpc_event}` envelope,
epoch-guarded streaming, windowed history render, prompt routing
(uplink → headless → direct). The header follows the
bound backend: model, thinking level, session cost and effective context
window come from the headless session (not the hub process), and
model/thinking can be changed from the web UI. Compaction (manual,
threshold and overflow) is a first-class UI state: an amber **Compacting…**
pill plus an inline transcript message that resolves to the summary, a
cancellation, or the failure. History renders the last 100 entries with an
incremental **Load earlier messages** control (window grows 100 at a time,
scroll anchor preserved); the full session stays in memory and on disk. The
active session is encoded in the URL (`#session=<file-basename>`), so a
reload resumes the same session and separate tabs run separate sessions
independently. Messages queued while a run is in flight are forwarded
immediately as `steer` prompts — pi holds them in its own queue and delivers
them after the current turn; a rejected prompt is surfaced instead of failing
silently. Harness: **ALL PASS** (health, authed WS, ping/pong,
`start_session` + headless `HEADLESS-OK` round-trip).
Test design: `docs/testing.md` (layers, doubles, P0–P2 matrix).

## Layout

```text
tau-web/
  extensions/mirror-server.ts   # HTTP+WS hub server: headless backends + dialogs
  extensions/headless-bridge.ts # HeadlessRegistry: one `pi --mode rpc` child per WS
  public/                       # vanilla JS UI (app.js, dialogs.js, websocket-client.js, …)
  docs/adr/                     # 001 base on tau … 014 attach-relay, 015 rejoin-noop,
                              # 016 fork-by-copy, 017 preview-first-files, 018 file-mutation-scope
                              # (012 headless-only: superseded, kept as history)
  docs/testing.md               # e2e test design: layers, doubles, P0–P2 matrix
  docs/code-review.md           # code/security/perf review + open fix scopes (2026-10)
```

## Run

```bash
cd tau-web && npm install
# dev port (canonical/main port taken only when complete):
TAU_MIRROR_PORT=8199 TAU_HOST=127.0.0.1 TAU_STATIC_DIR=$(pwd)/public pi -e .
# whole-package load:  pi -e ./tau-web
# single-file iteration: pi --extension ./tau-web/extensions/mirror-server.ts
```

`.ts` changes: `rm -rf $TMPDIR/jiti`, restart Pi. `public/` changes: browser reload.

`TAU_DISABLED=1` disables the server (headless children always run with it).

## tau supersession

tau-web replaces `tau` — never run both. The `tau` package is installed in
`~/.pi/agent/settings.json` (`packages`), so it loads inside **every** pi
process, including `pi -e ./tau-web` dev servers and headless children. Both
read the same `TAU_MIRROR_PORT`; whichever starts second bumps +1 and serves
stale old-code UI (no login, no version) from inside the same process. The
server logs a `WARNING: sibling mirror` line when it detects this.

Adopting tau-web: remove `"../../projects/work/pi-extensions/tau"` (or the
installed `tau`) from settings `packages` and restart Pi. Headless children
are unaffected (they run with `TAU_DISABLED=1`, which both packages honor).

## Persistence (Termux:Boot)

To survive reboots, start the canonical instance at boot. Example
`~/.termux/boot/tau-web.sh` (Termux:Boot):

```bash
#!/data/data/com.termux/files/usr/bin/bash
# Boot persistence for tau-web: loopback-only, auth from env.
cd ~/projects/work/pi-extensions/tau-web
sleep 90 | TAU_HOST=127.0.0.1 TAU_MIRROR_PORT=12045 \
  TAU_USER=... TAU_PASS=... TAU_STATIC_DIR=$PWD/public \
  exec pi -e $PWD --mode rpc >> ~/.tau-web-boot.log 2>&1
```

Keep `TAU_USER`/`TAU_PASS` in the script (mode `600`), never in the repo.
Take the canonical port only when tau-web is verified; until then use a dev
port (e.g. `8199`) and leave live tau untouched.

## Protocol (browser ↔ server, WS `/ws`)

Unified envelope: every backend event arrives as `{type: "rpc_event", event}`.

| Client → server | Effect |
|---|---|
| `start_session {cwd?, sessionFile?, backendKey?}` | bind (or rejoin) headless backend; ack `{backendKey}` |
| `rpc_command {command}` | forward to headless stdin (e.g. `{type:"prompt"}`, `{type:"abort"}`) |
| `release_session` | release headless binding (persistent by default — TTL only if configured) |
| `instances` | list live TUIs dialed in over hub.sock (relay) |
| `attach {port, pid}` | previewed → drive the live TUI; answers `attached` |
| `detach` | stop driving (frozen view + Drive-again banner) |
| `tui_command {command}` | route a command to the driven TUI (prompt, abort, …) |
| `extension_ui_response {id, …}` | answer a dialog; routed to headless child, driven TUI, or hub waiter |
| `ping` | `pong` |
| legacy `prompt` `/reload` | built-in `/reload` command reloads extensions/skills/prompts |
| legacy commands | unchanged (`prompt`, `abort`, `get_commands`, …) |

HTTP auth endpoints: `POST /api/login` (JSON credentials → HttpOnly `tau_auth` cookie,
works for fetches **and** the WS handshake, which can't carry headers) and
`POST /api/logout`. Session rename (`POST /api/sessions/rename`, history files
only — live sessions rename in their own TUI), per-item export
(`POST /api/sessions/export`, same `pi --export` CLI pointed at the selected
history file — the WS `export_html` command only knows the server's own
session), and export download
(`GET /api/file/download?path=`, HTML under the session store only) are
traversal-guarded. `GET /api/instances` lists live TUIs dialed in over
hub.sock (ADR-014). Any API 401 raises the inline login overlay — the server never
sends `WWW-Authenticate`, so the native browser prompt cannot appear. Settings shows server version + uptime (from
`/api/health`), a Log-out button, and a **Live pi processes** block (`GET /api/processes` →
per-row Kill via `POST /api/processes/kill {pid}`): read-only visibility into terminal sessions
and hub backends on the box plus an on-demand kill switch. Hub-owned pids retire through the
headless registry; live pids get SIGTERM then SIGKILL. Killing frees resources — session files
stay on disk. Process management only: no transcript proxy, no session driving (ADR-013).
`Ctrl/⌘+K` toggles the command palette.

Prompt routing in the UI: the driven live TUI (uplink) first, then the
bound headless backend, then legacy direct send. Driving is
preview-first: read-only history with a confirm banner, then "Drive
this TUI" wires the uplink (ADR-009); detaching freezes the view with a
Drive-again affordance instead of resuming the file headless (two
writers on one file, ADR-003).
One WS = one headless backend (server keys by connection); a second browser
tab/window gets its own backend, so phone + laptop stay independent.
Session switching bumps a binding epoch — stale stream events from the old
session are dropped. History renders the last 100 entries with an incremental
**Load earlier messages** control; full history stays in memory and on disk.
Per-tab sessions: `#session=<file-basename>` pins the view; the key is never
a filesystem path.
Command palette (`/` browsing + fuzzy search) with unknown-slash guard; no `ttyd`
fallback anywhere — failures surface as UI errors.

## Config (env, then `~/.pi/agent/settings.json` `tau` block)

| Var | Default | Purpose |
|---|---|---|
| `TAU_MIRROR_PORT` / `PI_WEB_PORT` | `8192` | listen port (dev: use `8199`) |
| `TAU_HOST` / `PI_WEB_HOST` | `127.0.0.1` | bind address — never `0.0.0.0` without auth |
| `TAU_USER` / `TAU_PASS` | — | Cookie-session auth (HTTP + WS); gate first, expose second |
| `TAU_STATIC_DIR` | bundled `public/` | static override for UI work |
| `TAU_DISABLED` | — | `=1` disables the server (injected into headless children) |
| `PI_WEB_PI_BIN` / `TAU_PI_BIN` | `pi` | binary spawned for headless backends |
| `PI_WEB_TTL_MS` / `TAU_HEADLESS_TTL_MS` | `0` (never — persistent) | idle reap of headless backends; set positive ms to opt back in |
| `TAU_MAX_HEADLESS` / `PI_WEB_MAX_HEADLESS` | `0` (unlimited) | hard cap on concurrent headless children; LRU-evicts the least-recently-active idle session (never a running agent) |
| `TAU_ALLOWED_HOSTS` | — | extra `Host` names allowed on WS/API (anti-rebinding); localhost, IP literals and `*.ts.net` are always allowed |
| `TAU_ALLOW_ANY_HOST` | — | `=1` disables the Host/Origin check (dev only) |

## UI notes

- No emoji anywhere: all glyphs are inline SVG (`public/icons.js`), so themes
  apply via `currentColor` and phones render identically.
- Thinking level is a header dropdown (off…max); the header shows the bound
  session's model/thinking/context window.
- The connection dot is a fixed traffic light in every theme — green
  connected, amber working/summarizing, red disconnected — so its colour is
  never a theme consequence (see `.status-indicator` in `public/style.css`).
- Tool cards carry light start-time/duration stamps; Edit diffs render
  GitHub-style (gutter + line numbers) and never trap vertical touch scroll.
- Settings is tabbed (Appearance/Voice/Server); Appearance carries the display
  toggles (Show thinking, Hide costs); auth has no toggle — login is
  cookie-based and logout lives under Server.
- On coarse pointers all WS-driven infinite motion freezes to a resting state
  (no Android flicker); compaction stays a first-class Compact… state.

## Security

Same rules as `tau`: loopback bind by default, cookie-session auth before any internet
exposure — so there is no unauthenticated TCP port and no PSK.
All browser UI goes through the hub port — mirrors serve nothing
directly (no per-TUI port, ADR-011/014). The hub never injects into a
foreign process except through an explicitly attached drive (uplink) or
TERM/KILL from the auth-gated live-process kill switch (ADR-013) —
never anything else, never without the user asking.
WS upgrades and `/api/*` additionally enforce a Host/Origin allowlist against DNS
rebinding (localhost, IP literals, `*.ts.net`, plus `TAU_ALLOWED_HOSTS`). Headless
session files are resolved under `~/.pi/agent/sessions/` with traversal rejection.
