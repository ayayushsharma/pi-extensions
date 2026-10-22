# Termux browser POC — Firefox + geckodriver + Selenium

Status: **POC verified and the CP3/CP4 smoke is implemented** (T2 in
`code-review.md`; `npm run test:termux`). Companion to `testing.md` §1.2 and
ADR-020.

## Why

Playwright's bundled Chromium is a glibc build and cannot start on
Termux/Android. The phone is the production host, so a browser gate must run
there. `auto-mate` proved the working substitute: drive the installed
**system Firefox** through **geckodriver** with **selenium-webdriver**, in one
persistent headless session. This note records the setup, the run against
pi-hub, the measured numbers and the porting limits.

## Environment

| Component | Version |
|---|---|
| Device | Galaxy F12, Termux/Android |
| Node | 26.4.0 |
| Firefox | 158.0 (`pkg install x11-repo firefox`) |
| geckodriver | 0.37.1, linux-aarch64 |
| selenium-webdriver | 4.51.0 |
| Fonts | `ttf-dejavu` (without it screenshots render tofu) |

## Setup (once)

```bash
cd pi-hub
pkg install x11-repo firefox ttf-dejavu

# geckodriver 0.37.1 (aarch64); keep it out of git
mkdir -p tests/.bin
curl -sL -o $TMPDIR/gd.tgz \
  https://github.com/mozilla/geckodriver/releases/download/v0.37.1/geckodriver-v0.37.1-linux-aarch64.tar.gz
tar xzf $TMPDIR/gd.tgz -C tests/.bin geckodriver && rm $TMPDIR/gd.tgz

# optional: only where the Firefox backend is used
npm i --no-save selenium-webdriver
```

`auto-mate/tools/uishot/` on this phone has the same binary and
`selenium-webdriver` install; it can be used as an external source instead of
re-downloading (keep it out of pi-hub's manifest).

## Minimal driver

The tested shape: launch once, keep the session, wait for the app's own
readiness marker, assert `window.__errs`, then interact.

```js
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
// Optional: use an existing install, e.g. auto-mate/tools/uishot/node_modules
const load = process.env.PI_HUB_SELENIUM_DIR
  ? createRequire(path.join(process.env.PI_HUB_SELENIUM_DIR, "package.json"))
  : require;
const { Builder } = load("selenium-webdriver");
const firefox = load("selenium-webdriver/firefox");

const url = process.env.PI_HUB_URL || "http://127.0.0.1:8292";
const gecko = process.env.PI_HUB_GECKODRIVER || path.join(process.cwd(), "tests/.bin/geckodriver");
const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxService(new firefox.ServiceBuilder(gecko))
  .setFirefoxOptions(new firefox.Options().addArguments("-headless").windowSize({ width: 390, height: 844 }))
  .build();

try {
  await driver.get(`${url}/hub/`);
  await driver.wait(async () => (await driver.executeScript(
    "return document.body.dataset.ready || ''")) === "1", 30000);
  const errs = await driver.executeScript("return window.__errs || []");
  if (errs.length) throw new Error(`client errors: ${JSON.stringify(errs)}`);
  fs.writeFileSync(
    path.join(process.env.TMPDIR || "/tmp", "pi-hub-selenium.png"),
    await driver.takeScreenshot(),
    "base64",
  );
} finally {
  await driver.quit();
}
```

For a session smoke, click the fixture row via `executeScript` (the list
re-renders, so a stored WebElement can go stale) and wait for
`document.body.dataset.view === "session"`.

## What the POC observed

Run against a real pi-hub with the fixture store:

| Step | Result |
|---|---|
| Hub boot (test harness) | **16.4 s** |
| Firefox launch | **9.6 s** |
| `goto /hub/` + `data-ready` | **1.3 s** |
| Browser-side smoke (load, fixture row, resume, screenshot) | **23.2 s** |
| End-to-end incl. hub boot/teardown | **≈44 s** |
| Page title | `Pi Hub` |
| `window.__errs` | `[]` |
| Screenshot | 66 KB, transcript rendered |
| Resume | fixture row found and opened; `document.body.dataset.view === "session"` |

The hub was started by the test harness with the Termux portability patches
described in `testing.md` §1.1.1; the browser part itself has no `/tmp`
dependency.

## Findings

1. **It works.** Selenium drives the real pi-hub client on this phone:
   navigation, JS evaluation, waits, clicks, screenshots and error capture.
2. **Persistent session is mandatory.** A cold `firefox --headless
   --dump-dom` probe stalls in the renderer here (SWGL; 30 s timeout). The
   `auto-mate` session found the same thing: launching Firefox per screenshot
   is what made the CLI path stall. Launch once and keep the driver.
3. **One browser at a time** on this 3.7 GB phone. Playwright's 4-group fan-out
   is not available, so a Termux run is sequential (or small `-j2` at most).
4. **Overhead sets the floor.** ~16 s hub boot + ~10 s Firefox launch before
   the first assertion. A suite is therefore **minutes**, not 13 s; acceptable
   for a release gate, not for a per-edit loop.
5. **Capability split.** Selenium has `get`, `executeScript`, find/click/fill,
   waits, screenshots and window size — enough for the C1–C4 capability subset.
   It does **not** provide Playwright's `route()` interception, multiple
   browser contexts, CDP/WS injection, traces or real touch gestures; those
   cases must stay Playwright-only and be declared `requires: "playwright"`.
6. **`auto-mate`'s `uishot.js` is a recipe, not a harness.** It is a ~60-line
   screenshot/JS-error loop that injects localStorage credentials and captures
   a PNG. It proves the driver stack; it does not provide assertions, fixtures
   or a test runner.
7. **Wired in.** `tests/termux-smoke.mjs` now ships a minimal `SeleniumPage`
   facade and TC1–TC6 (boot/no JS errors, fixture resume, reload, screenshot, DOM cap; CP3/CP4 subset)
   against a real hub. `npm run test:termux` runs it; measured 6/6 in ~38 s.
   Full 171-check Playwright parity is still Linux/Chrome-only by decision.

## Running the implemented smoke

```bash
# optional deps only on the phone/host that runs the smoke
npm i --no-save selenium-webdriver
PI_HUB_SELENIUM=$PWD/node_modules/selenium-webdriver \
GECKODRIVER=/path/to/geckodriver \
FIREFOX_BIN=firefox \
npm run test:termux
```

The runner resolves `GECKODRIVER`/`PATH` and `PI_HUB_SELENIUM` (absolute
package path) and skips with a reason if either is absent. One browser per run;
`ttf-dejavu` is required for legible screenshots. The smoke owns its hub and
Firefox handles only — it never signals other pi processes — and
`PI_HUB_SKIP_TRIM_TEST=1` skips the synthetic DOM-cap check on a memory-tight
phone. Full Playwright parity stays on the Linux/Chrome gate.

## Related

- `testing.md` §1.1 (Termux gate + T1 portability checklist)
- `testing.md` §1.2 (driver design, POC summary, porting plan)
- `adr/020-cross-platform-browser-drivers.md`
- `code-review.md` T1/T2
