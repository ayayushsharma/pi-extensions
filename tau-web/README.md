# tau-web

Unified Pi web UI: **live TUI mirror + headless sessions in one package, one port**.
Drive the terminal session from the browser, attach to any other live TUI on the
box, or run headless `pi --mode rpc` backends per browser connection — with full
web dialogs (`select` / `confirm` / `input` / `editor`) and Tau Basic auth throughout.

Started as a copy of `tau`; `tau/` stays untouched until tau-web passes the harness
below. See `docs/adr/` for the accepted decisions.

## Status

Implemented end to end and harness-verified (P0–P2 core): headless bridge,
uplink proxy, unified `{type: rpc_event}` envelope, epoch-guarded streaming,
windowed history render, Live section with preview-then-attach (ADR-009), prompt
routing (uplink → mirror-live → headless → direct). The header follows the
attached backend: model, thinking level, session cost and effective context
window come from the live session (not the web server), and model/thinking can
be changed from the web UI while driving. Compaction (manual, threshold and
overflow) is a first-class UI state: an amber **Compacting…** pill plus an inline
transcript message that resolves to the summary, a cancellation, or the failure —
headless sessions are covered by tau-web itself; attached live TUIs forward it once
the TUI runs the patched `tau` extension. History renders the last 100 entries with
an incremental **Load earlier messages** control (window grows 100 at a time, scroll
anchor preserved); the full session stays in memory and on disk. The active session
is encoded in the URL (`#session=<file-basename>&drive=1`), so a reload re-attaches
the same session and separate tabs drive separate sessions independently. Messages
queued while a run is in flight are forwarded immediately as `steer` prompts — pi
holds them in its own queue and delivers them after the current turn; a rejected
prompt is surfaced instead of failing silently. Harness: **ALL PASS**
(health, authed WS, ping/pong, `uplink_list` discovery of live tau, `start_session`
+ headless `HEADLESS-OK` round-trip, uplink attach/detach + live `mirror_sync`).

## Layout

```text
tau-web/
  extensions/mirror-server.ts   # HTTP+WS server: mirror + headless + uplink + dialogs
  extensions/headless-bridge.ts # HeadlessRegistry: one `pi --mode rpc` child per WS
  public/                       # vanilla JS UI (app.js, dialogs.js, websocket-client.js, …)
  docs/adr/                     # 001 base on tau … 007 full dialogs, no fallbacks
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

`TAU_DISABLED=1` disables the mirror server (headless children always run with it).

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

Unified envelope: every backend event arrives as `{type: "rpc_event", event, uplink?, port?}`.

| Client → server | Effect |
|---|---|
| `start_session {cwd?, sessionFile?}` | bind (or rejoin) headless backend; ack `{sessionKey}` |
| `rpc_command {command}` | forward to headless stdin (e.g. `{type:"prompt"}`, `{type:"abort"}`) |
| `detach_session` | release headless binding (TTL would reap it anyway) |
| `uplink_list` | list verified live Tau instances `{instances:[{port,pid,sessionFile,cwd}]}` |
| `uplink_attach {port,pid}` | proxy a live TUI (fingerprint + `/proc` check + loopback-only) |
| `uplink_detach` / `uplink_command {command}` | leave / drive the attached TUI |
| `extension_ui_response {id, …}` | answer a dialog; routed to uplink owner, headless child, or mirror waiter |
| `ping` | `pong` |
| legacy `prompt` `/reload` | built-in `/reload` command reloads extensions/skills/prompts |
| legacy mirror commands | unchanged (`prompt`, `abort`, `get_commands`, `mirror_sync_request`, …) |

HTTP auth endpoints: `POST /api/login` (Basic → HttpOnly `tau_auth` cookie,
works for fetches **and** the WS handshake, which can't carry headers) and
`POST /api/logout`. Any API 401 raises the inline login overlay — the native
browser prompt is never used. Settings shows server version + uptime (from
`/api/health`) and a Log-out button. `Ctrl/⌘+K` toggles the command palette.

Prompt routing in the UI: attached uplink first (the TUI owns the run), then the
mirror-live session, then the headless backend, then legacy direct send.
One WS = one headless backend (server keys by connection); a second browser
tab/window gets its own backend, so phone + laptop stay independent.
Session switching bumps a binding epoch — stale stream events from the old
session are dropped. History renders the last 100 entries with an incremental
**Load earlier messages** control; full history stays in memory and on disk.
Per-tab sessions: `#session=<file-basename>` pins the view (add `&drive=1` to
auto-attach a live TUI); the key is never a filesystem path.
Command palette (`/` browsing + fuzzy search) with unknown-slash guard; no `ttyd`
fallback anywhere — failures surface as UI errors, and a dead uplink offers
**Continue headless** on the same file.

## Config (env, then `~/.pi/agent/settings.json` `tau` block)

| Var | Default | Purpose |
|---|---|---|
| `TAU_MIRROR_PORT` / `PI_WEB_PORT` | `8192` | listen port (dev: use `8199`) |
| `TAU_HOST` / `PI_WEB_HOST` | `127.0.0.1` | bind address — never `0.0.0.0` without auth |
| `TAU_USER` / `TAU_PASS` | — | Basic auth (HTTP + WS); gate first, expose second |
| `TAU_STATIC_DIR` | bundled `public/` | static override for UI work |
| `TAU_DISABLED` | — | `=1` disables the server (injected into headless children) |
| `PI_WEB_PI_BIN` / `TAU_PI_BIN` | `pi` | binary spawned for headless backends |
| `PI_WEB_TTL_MS` / `TAU_HEADLESS_TTL_MS` | `900000` (15 min) | idle reap of headless backends |

## UI notes

- No emoji anywhere: all glyphs are inline SVG (`public/icons.js`), so themes
  apply via `currentColor` and phones render identically.
- Thinking level is a header dropdown (off…max); attaching shows the driven
  session's model/thinking/context window, re-polled every 60s.
- Tool cards carry light start-time/duration stamps; Edit diffs render
  GitHub-style (gutter + line numbers) and never trap vertical touch scroll.
- Settings is tabbed (Appearance/Agent/Voice/Server); auth has no toggle —
  login is cookie-based and logout lives under Server.
- On coarse pointers all WS-driven infinite motion freezes to a resting state
  (no Android flicker); compaction stays a first-class Compact… state.

## Security

Same rules as `tau`: loopback bind by default, Basic auth before any internet
exposure, uplink targets verified (instance registry + `/api/health` fingerprint
+ `/proc/<pid>/cmdline` + loopback-only + Basic re-auth), headless session files
resolved under `~/.pi/agent/sessions/` with traversal rejection.
