# ADR-012: Headless-only hub — no Hub-to-TUI flow

Status: SUPERSEDED by ADR-014 (attach relay restored). Kept as history:
the headless-only hub shipped and was verified, then the attach path
came back when ADR-012's conflation of drive with mirror-attach proved
wrong (two writers on one file, ADR-003).

## Context

ADR-011 made the hub the sole browser UI, but kept a live-TUI data plane:
mirrors dial the hub over `~/.pi/tau/hub.sock` (hello/status/snapshot/event
frames) and browsers drive them back through the uplink proxy
(`uplink_list`/`uplink_attach`/`uplink_detach`/`uplink_command`), with a
preview-then-drive client flow (ADR-009) on top.

That flow is a second session authority pointed at files the hub does not
own: two writers on one session file (the TUI + a headless child), a
private socket + forwarder + proxy to maintain, and a whole client view
model (Live section, banner, preview, frozen-detached) for it. The hub
already does everything the browser needs via headless children —
start/resume/new/kill, file browser, dialogs, tabs — with one writer per
file.

## Decision

Headless-only hub. There is no flow from the Hub to a live TUI, in either
direction:

- No hub.sock: `extensions/lib/hub-socket.ts` deleted; no private
  listener, no forwarder, no hello/status/snapshot/event frames.
- No uplink RPC: `uplink_list` / `uplink_attach` / `uplink_detach` /
  `uplink_command` removed from the WS deny-list passthrough; the server
  answers them with `Unknown message type` like any other unknown frame.
- No `/api/instances`: live-TUI discovery endpoint removed (the hub owns
  no live sessions; headless children are listed via
  `list_sessions`/`rpc_command` like any other session op).
- Client: Live section, session banner, preview/attach/detach/drive UI,
  instance polling, `drive=1` hash param, and all uplink state removed
  from `app.js`, `websocket-client.js`, `dialogs.js`, `hub.js`,
  `index.html`, and `style.css`. Prompt routing is headless → direct.
- Any non-hub role is inert: `resolveRole` still maps `rpc` → hub and
  everything else → mirror, but the mirror branch of `session_start`
  starts nothing — no server, no dial-out.
- Kept deliberately: hub port/auth, `/api/*`, `/ws`, headless children
  (`start_session`/`rpc_command`/…), web dialogs (local + headless
  owner), tabs, per-tab `#session=` hashes, session switchboard.

## Consequences

- A browser can never observe or drive a live TUI. To work a session
  from the web, resume its file headless (one writer per file, ADR-003).
- `pi` processes with the extension loaded behave as before from the
  terminal side; they just no longer announce themselves anywhere.
- Tests (at the time): uplink contract tests (H7/H8/H9/D1) became
  absence tests. ADR-014 flips them back to presence tests.
