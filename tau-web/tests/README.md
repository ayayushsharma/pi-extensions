# tau-web e2e suite

End-to-end integration tests for the headless-only hub, layered
cheapest-first (`docs/testing.md` §1). Layers A–C run anywhere
(CI-friendly, no TTY, no `pi` binary). Layer D needs a real `pi`
process and stays opt-in via `TEST_REAL_HUB=1`.

## Layout

```text
tests/
  run.mjs            # orchestrator: `node tests/run.mjs [--filter H3] [--real-hub]`
  helpers.mjs        # ports, polling, asserts, process hygiene (§2)
  static-server.mjs  # Layer A: hub-shaped static (302 /→/hub/), WS refused
  fake-backend.mjs   # Layer B: static + scripted WS (default/late-file/no-ack)
  hub-stub.mjs       # CI hub: headless-only HTTP + WS contracts without a pi process
  hub-real.mjs       # Real hub boot (`pi -e ./tau-web --mode rpc`, stdin held open)
  browser.mjs        # CDP driver: system Chrome, pageerror-first, screenshots on fail
  e2e/               # one file per case (H1–H11 P0, D1/D5 + P2 guards)
```

## Run

```bash
# P0 (default): stub hub + fake backends + system Chrome. No pi process.
node tests/run.mjs
# single case / subset
node tests/run.mjs --filter H3
node tests/run.mjs --filter "H7,H8,H9"
# against a real hub (needs `pi`; slower, spawns headless children)
TEST_REAL_HUB=1 node tests/run.mjs --filter H6
```

Requirements: node ≥ 18, system Chrome (`/opt/google/chrome/chrome`
or `google-chrome-stable` on PATH). No downloaded browsers, no new
npm deps — the CDP driver reuses the `ws` dependency. If
`playwright-core` happens to be installed it is used instead (same
assertions, same selectors).

Env knobs (all optional, all per-run so ports never bump):

| Var | Effect |
|---|---|
| `TAU_E2E_PORT` | base port for the run (default: random free ≥ 18000) |
| `TEST_REAL_HUB=1` | boot a real `pi` hub for H6 instead of the stub |
| `TAU_E2E_KEEP=1` | keep `tests/.tmp/` (screenshots, logs) after a green run |
| `CHROME_BIN` | chrome binary override |

## Hygiene (testing.md §2)

- Test ports are never 8192; a pre-flight check fails the run if the
  chosen port is already bound (a second server on one port silently
  bumps +1 and serves stale code).
- Teardown kills by **parent PID** (`pkill -P <hubpid>`, then the hub).
  Never `pkill -f <pattern>` — it matches the killer's own command
  line and suicides mid-run.
- Real-hub runs hold stdin open (`tail -f /dev/null` pipe); a hub
  booted with stdin closed exits immediately with no error.
- Every browser case fails on any uncaught `pageerror`. Console errors
  from a refused WS (Layer A) are expected noise and are filtered —
  `pageerror` is the signal.

## Coverage

P0 (CI): H1–H11 (H7–H9 cover the uplink attach relay: list/instances,
live section, preview-then-drive; H10 covers the live-process list +
kill UI against a stub fixture, plus an opt-in real-hub pass that
reaps an `exec -a pi sleep` double; H11 is a real-hub-only guard that
session rejoin never re-sends switch_session, that the rejoin ack
carries isAgentRunning, and that /api/headless/status tracks the run
(skipped without TEST_REAL_HUB=1). The background-run history watch
itself is browser-only (no Chrome on this box) — covered by the H11
server contract plus manual check: rejoin a running session, see
progress appear within ~3s. H6 uses os.tmpdir() as the child cwd:
"/tmp" does not exist on some hosts (Termux / is read-only) and the
spawn silently breaks. `startHubStub` accepts a
`processes` fixture table for H10. P1: D1 (dead-frame silence),
D5 (auth), traversal + rebinding guards. Manual-only (documented
skips with reasons): real-hub dialog relay, reload re-attach,
two tabs, D6 (history window fixture), mobile coarse-pointer,
TTL/LRU reap, SW version bump, streaming epoch.
