# ADR-013: Live process visibility + on-demand kill (no session drive)

Status: accepted.

## Context

ADR-012 had removed the entire Hub-to-TUI flow: no socket, no proxy,
no driving. That also removed the only place a browser could see which
`pi` sessions are alive on the box — and a user who wants to free
resources has to go find terminal sessions by hand and kill them over
SSH. (ADR-014 later restored the attach relay; this ADR stays scoped
to process management either way.)

Visibility is not driving. Listing OS processes and sending SIGTERM to a
verified `pi` pid touches no session file, proxies no transcript, and
drives nothing. It is process management, and it belongs in the hub's
Server pane next to version/uptime.

## Decision

- `GET /api/processes` lists live `pi` OS processes: pid, argv, cwd,
  RSS, age, owner (`hub` for the hub's own headless children,
  `live` for everything else), plus a best-effort `--session` hint.
  Same auth + Host/Origin gates as every other `/api/*` route.
- `POST /api/processes/kill {pid}` terminates one verified process:
  hub-owned pids go through the headless registry (`closeByPid`, so WS
  bindings and bookkeeping stay consistent); live pids get SIGTERM, a
  short grace wait, then SIGKILL.
- Fingerprint is fail-closed and server-side, re-checked at kill time:
  argv[0] basename **or** `/proc` exe basename must equal `pi`
  exactly (no substring matching — `grep pi` must never match). The
  hub never kills itself (pid refuse), never pid ≤ 1, and 404s stale
  pids instead of signaling whatever recycled the number.
- Killed terminal sessions keep their files on disk — kill frees
  resources, it does not delete work. Resume stays a headless
  `start_session` like any other file — or drive the live TUI through
  the attach relay (ADR-014) instead of putting two writers on it.
- Non-`/proc` platforms get a `ps` fallback (darwin) or
  `{processes: [], unsupported: true}` (Windows) — never an error.

## Consequences

- The Server settings pane gains a "Live pi processes" block with
  Refresh + per-row Kill (behind a `confirm()`).
- Scope holds under ADR-014: there is no transcript proxy, no
  snapshot, no prompt injection on the process path. The only signal
  the hub sends a foreign process outside an attached drive is
  TERM/KILL from the kill switch.
- Tests: H10 covers list/kill/refusals against the stub plus a
  `TEST_REAL_HUB=1` pass that spawns an `exec -a pi sleep` double and
  kills it for real.
