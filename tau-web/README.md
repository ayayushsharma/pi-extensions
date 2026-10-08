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
windowed history render, Live section with attach/detach, prompt routing
(uplink → mirror-live → headless → direct). Harness: **ALL PASS**
(health, authed WS, ping/pong, `uplink_list` discovery of live tau, `start_session`
+ headless `HEADLESS-OK` round-trip, uplink attach/detach).

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
| legacy mirror commands | unchanged (`prompt`, `abort`, `get_commands`, `mirror_sync_request`, …) |

Prompt routing in the UI: attached uplink first (the TUI owns the run), then the
mirror-live session, then the headless backend, then legacy direct send.
One WS = one headless backend (server keys by connection); a second browser
tab/window gets its own backend, so phone + laptop stay independent.
Session switching bumps a binding epoch — stale stream events from the old
session are dropped. History renders the last 60 entries; full history stays on disk.
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

## Security

Same rules as `tau`: loopback bind by default, Basic auth before any internet
exposure, uplink targets verified (instance registry + `/api/health` fingerprint
+ `/proc/<pid>/cmdline` + loopback-only + Basic re-auth), headless session files
resolved under `~/.pi/agent/sessions/` with traversal rejection.
