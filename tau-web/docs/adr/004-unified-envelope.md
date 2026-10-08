# ADR-004 — Unified WS envelope, epoch-guarded UI

Status: accepted (2026-10-09)

## Context
R4: fast switch ≥2 live sessions, correct ordering, responsive send. Current race: WS stream vs 1.2 s disk poll both write the view; signature heuristic fragile.

## Decision
Bridge re-wraps Tau events `{type:event}` → `{type:rpc_event}` so browser speaks one dialect; every `start_session` mints `bindingEpoch`, stale arrivals dropped (L4); dedupe by normalised sessionFile (uplink = live, disk = history); disk poll pauses while streaming; reconnect uses backoff, gives up ~2 min → offers headless-continue on same file (L5). Abort on live sessions needs confirm + "also live in terminal" banner (L3); no new/fork/delete into live TUI; `set_model`/compact banner-warned (L7).

## Alternatives rejected
Two sockets / two render paths.

## Consequences
- Stream owns the view when live; disk is history only.
- L1/L2/L6 handled: fingerprint + proc check + loopback-only + no cred-retry; forbid same-file switch while live; re-read creds per connect, never log/forward.
