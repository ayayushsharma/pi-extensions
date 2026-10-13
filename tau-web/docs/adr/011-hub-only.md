# ADR-011: Hub-only — the mirror role serves nothing

Status: accepted (supersedes the direct-browser half of ADR-010).
Note: the hub.sock/uplink halves below were cut by ADR-012 and restored
by ADR-014 (attach relay, no per-TUI port). The hub-only port/auth/dialog
halves stand throughout.

## Context

ADR-010 split tau-web into hub (control plane: owns sessions, serves the
browser UI) and mirror (data plane: a live TUI dialing the hub over
`~/.pi/tau/hub.sock`). But the mirror role kept its full direct-browser
surface: its own HTTP+WS server, per-TUI port, cookie auth, static UI,
`/qr`, `/tau*` commands, and a client mirror-view (`isMirrorMode`,
`viewingActiveSession`, `mirror_sync_request`, `session_switch` stub).

With a single consumer on `0.1.0`, that surface is pure cost: a listener,
auth stack and port per TUI, plus two view models in the client. The hub
already carries everything that matters — Live list, preview-then-drive
(ADR-009), dialog relay (ADR-007), headless backends — over the socket.

## Decision

Hub-only. The hub (`pi -e tau-web --mode rpc`) is the sole browser UI;
a live TUI ("mirror") dials the hub and executes drive commands, and
serves nothing itself:

- Mirror role never calls `startServer`: no HTTP port, no WS, no static
  UI, no per-TUI auth surface. Live state reaches browsers as
  hello/status/snapshot/event frames over hub.sock.
- Removed: `/tau`, `/taustart`, `/taustop`, `/qr` commands, `openUrlNative`,
  `/api/qr` + the `qrcode` dependency, `mirror_sync_request`,
  `/api/sessions/switch`, the root `public/index.html` shell (hub shell at
  `/hub/` is the only entry; `/` already 302s there), and all client
  mirror-view state (`isMirrorMode`, `viewingActiveSession`,
  `mirrorActiveSessionFile`, `serverOwnSessionFile`, top-level
  `mirror_sync`/`session_switch` frames).
- `uplink_attached` reports `port || pid`: port-less mirrors display as
  `Driving · :<pid>` instead of `:0`.
- Prompt routing is uplink → headless → direct. Kept deliberately:
  hub uplink (Preview/Drive), dialog relay, tabs, headless children,
  `session_file` pinning, per-tab `#session=` hashes.

## Consequences

- Opening a TUI's own port in a browser no longer works — nothing
  listens. All UI goes through the hub port.
- The detached banner loses "This server" (the hub has no live session
  to return to); the Live section's own-process row keeps its Live button.
- `/qr` phone onboarding goes through the hub URL instead.
- The Live list is hub.sock-first (file registry rows merge underneath).
- A stale cached client asking `mirror_sync_request` gets no answer and
  is ignored; bump the `app.js?v=` query if that ever bites.
