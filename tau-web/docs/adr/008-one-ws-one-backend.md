# ADR-008: One WS, one headless backend — sidebar is the switcher

Date: 2026-10-08 · Status: accepted

## Context

The server keys headless backends by browser connection (`HeadlessRegistry`
attaches one `ManagedRpcSession` per WS). True multi-tab concurrency (one
backend per tab inside a single browser window) would need one WS per tab.

## Decision

v1 does **not** add an in-page tab bar. The session sidebar is the switcher:
picking a session loads windowed history and re-binds the headless backend to
that file; switching bumps a binding epoch so stale stream events are dropped.
Concurrent sessions use separate browser tabs/windows (separate WS → separate
backends), which also keeps phone + laptop independent. Uplink attach/detach
covers fast switching between ≥2 live TUIs.

## Consequences

- Simpler client: no per-tab socket pool, no cross-tab state sync.
- One live headless binding per browser connection; switching files reuses or
  respawns the backend (TTL reaps idle ones).
- A multi-WS tab bar remains possible later without protocol changes.
