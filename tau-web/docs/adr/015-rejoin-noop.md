# ADR-015: Rejoin is a no-op for the same session file

Status: accepted (2026-10-16, dialogue).

## Context

Sessions are persistent (ADR-008; TTL 0 = never auto-reap): closing the
browser detaches, it does not stop the run. So (re)entering a session is
routine — reload, tab reselect, a second tab, a deep link — and every
entry sends `start_session {cwd, sessionFile}` to the hub.

The first implementation always followed with `switch_session`. pi's
`switch_session` cancels the in-flight turn, so rejoining the session
that was already running killed the run and baked "Command aborted"
into the transcript. The switch was the bug, not the rejoin.

## Decision

The headless registry records the absolute path it last switched to
(`switchedFile`). `start_session` issues `switchToFile` **only when the
target file differs**; a same-file entry is a no-op bind that reports
state instead of changing it. The ack carries `isAgentRunning`, and
`GET /api/headless/status` reports the same for background tabs.
Comparison uses resolved absolute paths — clients legitimately send
basenames (session keys) and relative paths.

## Alternatives rejected

- Always re-issue `switch_session` and accept the abort as a cost of
  re-entering: it kills live runs.
- Guard in the client (skip `start_session` when the file matches):
  reload/second-tab/reconnect paths re-trigger it, and the guarantee
  belongs where the socket is bound, not in one of its clients.
- Spawn a fresh child for rejoin: loses the live run and doubles the
  child count on a box with a three-backend budget.

## Consequences

- Rejoin cannot change a run's state; it reports it. "Still working"
  now survives reload because the state lives in the child and is
  re-announced on bind.
- `isAgentRunning` is part of the `start_session` ack contract; the UI
  keeps the Stop affordance and the working dot from it, with the
  read-only status poll covering the gap between page load and ack.
- H11 (real hub) guards the no-re-switch contract; H6's stub keeps the
  plain round-trip.
