# ADR-020 — Cross-platform browser test drivers

Status: **proposed** (2026-10-18, dialogue). Companion to ADR-019 and
`docs/testing.md` §1.2.

## Context

pi-hub's acceptance gate is a browser suite (`docs/testing.md`), and the
homeserver is a Galaxy F12 running Termux/Android. Playwright's bundled
Chromium cannot run there — it needs glibc system libraries Android lacks.
The `auto-mate` project on the same phone hit this and solved it: it drives
**system Firefox via geckodriver + selenium-webdriver** in headless mode,
with screenshots and a JS-error dump (`tools/uishot/`), plus a zero-dep
`firefox --headless --dump-dom` / `--screenshot` smoke (`tools/shot.sh`).
Verified working versions on the phone: Firefox 158.0, geckodriver 0.37.1
(linux-aarch64), node 26.4; `selenium-webdriver@4`; `ttf-dejavu` needed or
screenshots render blank text; `MOZ_HEADLESS=1` and explicit `timeout`
wrappers; one browser at a time on the 4 GB box.

Requirement: capability specs (C1 preview/drive live TUI, C2 resume, C3 new
session, C4 running headless) must be testable on a dev box **and** on the
phone itself, without maintaining two suites.

## Decision

1. **One facade, three backends.** Specs are functions over
   `PageDriver { goto, eval, waitFor, click, fill, screenshot, errors, close }`:
   - `playwright` — `@playwright/test` (Chrome channel or cached Chromium)
     for the full suite, traces, `route()` interception, multiple
     contexts, touch/mobile, adversarial raw probes.
   - `firefox` — `selenium-webdriver` → geckodriver → system Firefox
     headless; runs on Termux and anywhere Playwright can't.
   - `cli` — no npm at all: `firefox --headless --dump-dom` for assertions
     and `--screenshot --window-size` for captures (the `auto-mate`
     `shot.sh` pattern).
2. `PI_HUB_E2E_DRIVER=auto|playwright|firefox|cli`; `auto` prefers
   Playwright, falls back to Firefox, then CLI. `PI_HUB_STRICT=1` requires
   the full Playwright suite (CI); the phone runs the `termux-smoke`
   profile.
3. **Capability specs are shared**; cases use Playwright-only features only
   when marked `requires: "playwright"` (route interception, multi-context,
   touch gestures, traces, raw CDP/WS injection, adversarial layer). Those
   SKIP on the Termux runner with a reason, never silently.
4. **No vendored binaries/deps by default.** geckodriver is fetched by a
   setup script into `tests/.bin/` (gitignored) with a version documented
   against system Firefox, or resolved via `PI_HUB_GECKODRIVER`/`$PATH`;
   `selenium-webdriver` is an optional devDependency installed only where
   the Firefox backend is used.
5. **Testability contract in the app** (P4): `body[data-ready="1"]` after
   first paint + WS `hello`; `window.__errs` collects `error` +
   `unhandledrejection` and every browser case asserts it is empty; stable
   `data-runner-*` / `data-view` / `data-testid` hooks for assertions;
   `body[data-app-version]` for cache-bust checks; screenshot helper waits
   for `data-ready` and `document.fonts.ready`.

## Alternatives rejected

- **Playwright's own Firefox build**: same bundled, patched, glibc-linked
  problem — it is not system Firefox and cannot start on Android.
- **`connectOverCDP` against system Chrome/Chromium**: Firefox speaks
  WebDriver, not CDP; no Chromium is installed on the phone, and the
  Termux `chromium` package was explored by `auto-mate` as unreliable.
- **Remote-drive a dev box's browser over the tunnel**: works for a smoke
  eye-check but makes the phone workflow depend on a second machine being
  online; the point is phone-local verification.
- **Two divergent spec sets** (Playwright specs + Firefox smoke scripts):
  capability logic drifts. The facade keeps one home for assertions.
- **Skip browser tests on Termux entirely**: the phone is the production
  host; a UI that only passes on a dev box is exactly the flakiness class
  this rewrite is fixing.

## Consequences

- The driver facade is small (~150 lines) and must stay minimal; when a
  case needs Playwright-only power, it is declared, not faked.
- `termux-smoke` (CP3/CP4 in `docs/testing.md`) becomes the phone gate:
  boot/login, C1 preview banner, C2 resume, C3 new session, C4 headless
  view, empty `__errs`, screenshots at 390×844 / 768×1024 / 1280×800.
- The full Playwright run remains the CI gate; a driver or browser missing
  produces an explicit SKIP (failure under `PI_HUB_STRICT=1`), never a
  green run with untested UI.
- The `cli` backend keeps a zero-dependency sanity path that works on a
  bare Termux with only `firefox` + `ttf-dejavu` installed.
