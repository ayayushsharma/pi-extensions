# ADR-006 — Tau Basic auth only, gate first expose second

Status: accepted (2026-10-09, dialogue: "normal Tau auth — yes")

## Context
R6/C2: `pi.sharmaayush.com` is public; pi-web was once exposed unauthenticated by mistake. Never again.

## Decision
Keep Tau's normal user/pass HTTP Basic auth (`TAU_USER`/`TAU_PASS` env or `~/.pi/agent/settings.json` `tau.user/pass`, `authEnabled` flag). No bearer-token scheme; no Cloudflare Access as substitute (leaves LAN `192.168.1.3:8192` ungated). `TAU_HOST` defaults to `127.0.0.1` in Termux; `0.0.0.0` only with auth configured. Uplink reuses same creds from memory only, re-read per connect (L6).

## Alternatives rejected
Bearer token in `localStorage`; Access-only gating.

## Consequences
- Auth check on HTTP + WS handshake; 401 shows login prompt, never silent hang.
- Tunnel points at `127.0.0.1`-bound server; public exposure decision (P3) is config-only.

## Implementation note (2026-10-11)
Browsers authenticate with the HttpOnly `tau_auth` cookie (the WS handshake
cannot carry headers). Server-to-server uplink dials authenticate with the
same user/pass over the `Authorization: Basic` header — the WS upgrade
accepts either. Cookie tokens are per-process memory and are never forwarded.
