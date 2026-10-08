# ADR-002 — Single package, dual role, one port

Status: accepted (2026-10-09, dialogue)

## Context
R5 needs live TUI + headless (other projects) in one UI. Two packages/two ports doubles auth, tunnel, and RAM surface.

## Decision
One package (`tau-web`), one extension factory registering two roles; servers/sockets start only on `session_start`, torn down idempotently on `session_shutdown` (thin factory per `AGENTS.md`). One port: `127.0.0.1:8192` for dev; takes canonical main port only when complete (frees `12045` via `/taustop`, Tau stays LAN-only per L9). Backend lifetime ties to TUI lifetime; Termux:Boot covers both (P3).

## Alternatives rejected
Two packages or two ports; fusing processes (two writers to one JSONL — corruption-adjacent).

## Consequences
- Port endgame explicit; no mid-migration port steal.
- `TAU_DISABLED` guard retained for headless children (C3).
