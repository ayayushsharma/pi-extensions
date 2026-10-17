# tau-web e2e suite

End-to-end integration tests for the headless-only hub, layered
cheapest-first (`docs/testing.md` §1). Layers A–C run anywhere
(CI-friendly, no TTY, no `pi` binary). Layer D needs a real `pi`
process.

## Layout

```text
tests/
  run.mjs            # orchestrator: `node tests/run.mjs [--filter H3] [--real-hub]`
  helpers.mjs        # ports, polling, asserts, skip/process hygiene (§2)
  static-server.mjs  # Layer A: hub-shaped static (302 /→/hub/), WS refused
  fake-backend.mjs   # Layer B: static + scripted WS (default/late-file/no-ack)
  hub-stub.mjs       # CI hub: headless-only HTTP + WS contracts without a pi process
  hub-real.mjs       # Real hub boot (`pi -e ./tau-web --mode rpc`, stdin held open)
  browser.mjs        # CDP driver: system Chrome, pageerror-first, screenshots on fail
  e2e/               # one file per case (H1–H18, D1/D5, P2, X1–X5)
```

## Run

```bash
# full suite (auto-SKIPs anything the host cannot run)
node tests/run.mjs
# single case / subset
node tests/run.mjs --filter H3
node tests/run.mjs --filter "H7,H8,H9"
# only the pure-Node renderer checks (works on any host)
node tests/run.mjs --filter H14
# CI: turn any SKIP into a failure
TAU_STRICT=1 node tests/run.mjs
```

Requirements: node ≥ 18. System Chrome (for the browser cases) and the
`pi` binary (for the real-hub cases) are **optional**: a case whose
requirement is missing is reported as `SKIP (<reason>)` and the run
still exits 0. `TAU_STRICT=1` flips that to exit 1 for CI. No
downloaded browsers, no new npm deps — the CDP driver reuses the `ws`
dependency. If `playwright-core` happens to be installed it is used
instead (same assertions, same selectors; `newPage(viewport)` resizes
that page, so desktop/mobile passes are real in both drivers).

Env knobs (all optional, all per-run so ports never bump):

| Var | Effect |
|---|---|
| `TAU_E2E_PORT` | base port for the run (default: random free ≥ 18000) |
| `TEST_REAL_HUB=1` | boot a real `pi` hub for H6/H11 instead of the stub |
| `TAU_E2E_KEEP=1` | keep `tests/.tmp/` (screenshots, logs) after a green run |
| `CHROME_BIN` | Chrome/Chromium binary override |
| `PI_BIN` | `pi` binary override for real-hub cases (default: `$HOME/.pi/agent/bin/pi`, then PATH) |
| `TAU_NO_BROWSER=1` | force-SKIP the browser cases without probing for Chrome |
| `TAU_NO_PI=1` | force-SKIP the real-hub cases without probing for `pi` |
| `TAU_STRICT=1` | exit 1 if any case was skipped |

## Hygiene (testing.md §2)

- Test ports are never 8192; a pre-flight check fails the run if the
  chosen port is already bound (a second server on one port silently
  bumps +1 and serves stale code).
- Teardown kills by **parent PID** (`pkill -P <hubpid>`, then the hub).
  Never `pkill -f <pattern>` — it matches the killer's own command
  line and suicides mid-run. Where `pkill` is absent (some Termux
  installs), `helpers.mjs` walks `/proc` for descendants instead.
- Real-hub runs hold stdin open (`tail -f /dev/null` pipe); a hub
  booted with stdin closed exits immediately with no error.
- Every browser case fails on any uncaught `pageerror`. Console errors
  from a refused WS (Layer A) are expected noise and are filtered —
  `pageerror` is the signal.
- Real-hub cases scrub inherited `TAU_*` / `PI_WEB_PI_BIN` env: a dev
  shell inside a tau-web agent session exports `TAU_ROLE=hub`,
  `TAU_DISABLED=1`, `TAU_LOG_FILE`, … which would otherwise poison the
  child hub.
- X4 (`set_auth`) boots the hub with a throwaway `HOME`:
  `saveTauSetting()` writes `$HOME/.pi/agent/settings.json` regardless
  of `PI_CODING_AGENT_DIR`, and the real user settings must not be
  touched.
- X1 jail fixtures live in `mkdtemp()` outside the repo tree — the
  repo itself is a configured project root, so an in-repo "outside"
  directory would false-pass the jail assertions.

## Coverage

CI default (no `pi` needed for the stub layer; browser cases need
Chrome):

- H1–H5: health/routing, static shell on desktop+mobile, late
  `session_file` pinning, fail-fast and 15s-timeout messages.
- H6: `start_session` + prompt round-trip (stub by default, real hub
  with `TEST_REAL_HUB=1`).
- H7–H9: uplink relay — list/instances (WS ack, HTTP 400), Live
  section with Drive controls, preview→drive→detach flow.
- H10: live-process list + kill UI (stub fixture; opt-in real-hub pass
  reaps an `exec -a pi sleep` double).
- H11: real-hub-only session-rejoin guard (no re-switch, rejoin ack
  carries `isAgentRunning`, `/api/headless/status` tracks the run);
  self-SKIPs without `TEST_REAL_HUB=1`.
- H12: `/api/files/content` jailed to the viewed session's cwd.
- H13: session-picker endpoints (summaries, mkdir jail, fork).
- H14: pure-Node renderer safety — hostile image blocks accepted/
  rejected by `isValidMessageImage` and markdown placeholder
  collisions (`%%CODEBLOCK_n%%` etc.) staying literal (B1/B2/S1).
- H15: composer popovers — model picker + thinking menu stay inside
  the viewport at 390×844 and at a keyboard-shrunk 390×430 (no
  sideways page scroll); the model search field is the menu's last
  child, below the scrolling list, and the menu height follows
  `min(360px, 45dvh)`.
- H16: hub markup + ARIA — the served HTML is well-formed (every tag
  closes, no duplicate ids, explicit `type` on every button, named
  icon buttons, labelled inputs, `alt` on images, dialog/switch/tab/
  listbox attributes present and pointing at live ids), and the live
  widgets keep their ARIA state in step with the visual one
  (`aria-expanded` on the popovers, `aria-selected` on settings tabs
  and the current model/thinking row, `aria-checked` on the toggles).
- H17: the Settings → Appearance "Hide costs" switch is off by default,
  and when on it hides both the header session-cost pill and the
  per-message usage spans (`body.hide-costs`), with `on` /
  `aria-checked` / `localStorage.tau-hide-costs` in lockstep and the
  preference applied on the next load. Its `.visible` class is forced
  before reading the pill, so the check is about the toggle, not about
  whether the stub happened to have a nonzero cost.
- H18: pure-Node class-namespace guard — the `ctx-*` variant classes
  the context popover applies to its bar segments and legend dots are
  parsed out of `app.js` and asserted to have matching rules in
  `style.css` and to not be bare global classes. (The original
  `.messages` variant collided with the transcript scroller: `flex: 1`
  + scroller padding stretched the legend row to 271px and the popover
  to 443px.)
- D1: relay frames answered, dead mirror frames silent, socket alive.
- D5: auth — 401 + overlay, login → WS, logout revokes.
- P2: hardening — traversal, rebinding, dead WS contract.

Hardening regressions from `docs/code-review.md` (real hub; SKIP
without `pi`):

- X1: S3/S4/S4b/S14 — symlinked preview escape 403, dangling 404,
  non-image 415, `dir.png` 404, SVG attachment+sandbox, `/api/open`
  escape, mkdir jail incl. symlinked parent, `export_html` output
  store jail.
- X2: S5/S7 — 300 KiB JSON body → 413 and health still OK; 20 client
  errors then 429; sessions API unaffected.
- X3: S6/S11 — baseline security headers on `/`, `/hub/`, health and
  401s; no CORS headers for a hostile `Origin`.
- X4: S5/S8/S12/S13 — oversized login 413, per-IP bad-login backoff,
  cookie flags (`HttpOnly`, `SameSite=Lax`, `Max-Age`), token TTL
  expiry → 401 + relogin (`TAU_AUTH_TOKEN_TTL_MS`), `set_auth`
  re-auth.
- X5: B3 — invalid cwd refused, no zombie binding, rejoin reaped.

Manual-only (documented skips with reasons): real-hub dialog relay,
reload re-attach, two tabs, D6 (history window fixture), mobile
coarse-pointer, TTL/LRU reap, SW version bump, streaming epoch.
