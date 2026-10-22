# ADR-020 — Cross-platform browser test drivers

Status: **accepted; Termux CP3/CP4 smoke implemented 2026-10-22; full
Playwright parity remains the Linux/Chrome gate** (T2 in `code-review.md`). Companion to ADR-019 and `docs/testing.md` §1.2.

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
- The `cli` backend keeps a zero-dependency sanity path on a host where
  `firefox --headless --dump-dom` exits cleanly. On the current Termux phone it
  **stalls** in the renderer, so it is not a gate there; the persistent
  Selenium session is the working Termux path.

## Update (2026-10-22) — POC result

The Selenium recipe from `auto-mate` was verified against pi-hub on this phone
(runbook: `docs/termux-browser-poc.md`):
Firefox 158 + geckodriver 0.37.1 + selenium-webdriver 4.51.0 loaded `/hub/`,
reached `body[data-ready="1"]`, reported `window.__errs = []`, listed and
resumed the fixture, and captured a transcript screenshot. Timings: hub boot
16.4 s, Firefox launch 9.6 s, first paint 1.3 s, browser-side smoke 23.2 s
(≈44 s including hub boot and teardown). One persistent browser at a time.

What this changes:

- The **decision stands**: one facade, Playwright for the full/CI gate and
  Selenium for Termux.
- The **`cli` backend is not a Termux gate**: a per-shot cold Firefox start
  stalls (the `auto-mate` session already identified this), and the plain
  `--dump-dom` probe times out here. CP2/CP6 must not be claimed on this device.
- **Termux gate implemented**: `tests/termux-smoke.mjs` owns a small
  `SeleniumPage` facade and TC1–TC6 (boot/no errors, fixture resume, reload,
  screenshot, DOM cap); `npm run test:termux` runs it on the phone. The full 171-check
  E2E stays Playwright API on Linux/Chrome; porting it is not a Termux gate.
  A `PI_HUB_E2E_DRIVER` abstraction is therefore not needed for the current
  scope (the smoke is a separate runner, not a fake Playwright).
- Selenium can do `get`, `executeScript`, find/click/fill, waits and
  screenshots, which covers C1–C4. Route interception, multiple contexts,
  CDP/WS injection, traces and real touch gestures stay Playwright-only and
  must be declared `requires: "playwright"`.
