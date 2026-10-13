# ADR-014: Attach relay — drive live sessions through the hub

Status: accepted (restores the hub.sock/uplink halves of ADR-010 and
ADR-011 that ADR-012 removed; the hub-only port/auth/dialog halves of
ADR-011 stand unchanged).

## Context

ADR-012 removed the entire Hub-to-TUI flow on the grounds that the hub
already does everything the browser needs via headless children. That
conflated two different things:

- **drive** (hub → TUI input): genuinely removed, and stays removed —
  the hub never injects prompts into a foreign process.
- **mirror attach** (TUI → hub → browser): the feature that let a
  browser observe a live session and take it over. ADR-012 cut this too,
  and the cut was wrong: resuming a live session's file headless puts
  two writers on one session file (the running TUI + a headless child),
  which ADR-003 forbids. Driving the running TUI through the hub is the
  only sound way to work a live session from the web.

So the attach path comes back — but scoped to what it is: a relay. The
hub owns no session content here; it forwards frames between a dialed-in
mirror and an attached browser.

## Decision

Restore the attach relay exactly as it was, with one structural change
carried forward:

- Mirrors dial the hub over `~/.pi/tau/hub.sock`
  (`extensions/lib/hub-socket.ts` restored verbatim):
  hello/status/snapshot/event frames in, drive/snapshot/dialog_relay
  out. **No per-TUI port**: mirrors never serve browsers directly
  (ADR-011 stands) — attach and drive go only through the hub.sock
  relay, addressed by pid, never by port dial.
- Uplink RPC is live again: `uplink_list` / `uplink_attach` /
  `uplink_detach` / `uplink_command` over WS (HTTP answers 400
  requires-WebSocket, like every other binding command).
  `/api/instances` lists live rows again.
- Client: Live section, session banner, preview-then-drive (ADR-009),
  `drive=1` hash param, and uplink state restored in `app.js`,
  `websocket-client.js`, `dialogs.js`, `hub.js`, `index.html`, and
  `style.css`. Prompt routing is uplink → headless → direct.
- ADR-013 is untouched: process list/kill stays process management
  only — no transcript proxy, no snapshots through the kill path, no
  prompt injection. The only signal the hub sends a foreign process is
  still TERM/KILL from the kill switch.

## Consequences

- A browser can observe and drive a live TUI again, preview-first
  (read-only history + confirm banner, then "Drive this TUI").
- `pi` processes with the extension loaded announce themselves over
  hub.sock as before; nothing listens on a per-TUI port.
- Tests: H7–H9 and D1 are presence tests again (relay contract, Live
  section, preview→drive→detach, dead-frame silence). The stub hub
  answers the relay protocol directly with one fake live TUI — no
  hub.sock listener in the stub.
