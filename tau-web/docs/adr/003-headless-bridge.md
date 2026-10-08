# ADR-003 — Headless via spawned pi --mode rpc, never dual-write

Status: accepted (2026-10-09)

## Context
Safe access to non-TUI projects without corrupting live session files (`switch_session` documents no locking).

## Decision
`extensions/headless-bridge.ts` (new) spawns `pi --mode rpc` children (pi-web `RpcSession` logic: LF-only framing, backpressure, stderr→error, exit→session_ended), keyed by uuid per tab — fixes `__new__::shared` collision. Idle TTL via env (`PI_WEB_TTL_MS`, default 15 min). Child env injects `TAU_DISABLED=1` (C3). Live TUI files are uplinked, never attached from a second process. `PI_WEB_PI_BIN` defaults to `pi` (no `npx` overhead); config in env/repo, never `sed` on globals (C4).

## Alternatives rejected
Direct JSONL attach from two processes; Go rewrite (saves ~30 MB of small process only — do last).

## Consequences
- One backend per tab; R4 ordering fix.
- Script-testable with Node WS harness, no browser needed (L10).
