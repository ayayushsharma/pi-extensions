# ADR-001 — Base on tau copy, port pi-web behaviour

Status: accepted (2026-10-09, dialogue)

## Context
Two working halves: `tau` extension (in-process mirror, vanilla UI, auth, PWA) and `pi-web` fork (standalone headless RPC server + React UI). pi-web backend verified working (`get_state/messages/commands/prompt` → `agent_settled`), but its 2,960-line `App.tsx`, `__new__::shared` singleton, and missing auth/uplink make it fragile on Termux (3.7 GB RAM, bionic, no `node-pty`).

## Decision
`tau-web` starts as `cp -r tau tau-web`, then ports pi-web ideas as vanilla JS modules: quick-switcher, `/` autocomplete via `get_commands`, no-fallback stream tagging, 60-message window, optimistic-echo removal, `message_end` upsert. React `App.tsx` retired; no framework migration.

## Alternatives rejected
Evolve pi-web fork — heavier, non-Pi-native, manual `vite build` + `cp -r dist`, 596 MB dev tree.

## Consequences
- `tau/` untouched until `tau-web` passes harness.
- New files only in `tau-web/` (quarantine, no fork drift into `tau/`).
- `npm install` inside `tau-web/` is author's responsibility.
