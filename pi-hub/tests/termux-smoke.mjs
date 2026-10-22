// termux-smoke — the CP3/CP4 browser smoke on a real Firefox via
// geckodriver + selenium-webdriver. Playwright's Chromium cannot run on
// Termux, but a persistent Selenium session can (ADR-020/T2).
//
// This is intentionally a smoke, not a port of the 170-check Playwright
// suite: boot, no JS errors, resume a fixture, and survive a reload.
// Selenium is an optional runner dependency, so a host without it skips the
// group instead of failing the Linux gate.
//
//   PI_HUB_SELENIUM=/path/to/node_modules/selenium-webdriver \
//   GECKODRIVER=/path/to/geckodriver \
//   node tests/run.mjs --termux
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import { fixtureSessionDir, freePort, startHub } from "./helpers.mjs";

const require = createRequire(import.meta.url);

function loadSelenium() {
  const paths = [process.env.PI_HUB_SELENIUM, "selenium-webdriver"].filter(Boolean);
  for (const p of paths) {
    try {
      return { Builder: require(p).Builder, firefox: require(`${p}/firefox`) };
    } catch {}
  }
  return null;
}

/** Minimal page facade over Selenium: the E2E plan's PageDriver seam can grow
 *  from here without making this smoke depend on Playwright APIs. */
class SeleniumPage {
  constructor(driver) {
    this.driver = driver;
  }
  async goto(url) {
    await this.driver.get(url);
  }
  async js(script, ...args) {
    return this.driver.executeScript(script, ...args);
  }
  async waitFor(script, timeoutMs = 30000, ...args) {
    return this.driver.wait(async () => !!(await this.js(script, ...args)), timeoutMs);
  }
  async click(selector) {
    await this.js("document.querySelector(arguments[0])?.click()", selector);
  }
  async text(selector) {
    return this.js("return document.querySelector(arguments[0])?.textContent || ''", selector);
  }
  async screenshot(file) {
    fs.writeFileSync(file, await this.driver.takeScreenshot(), "base64");
  }
}

export async function runTermuxSmoke({ log }) {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok, detail });
    log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  };
  const skip = (detail) => {
    results.push({ name: "TC0 Selenium + Firefox available", ok: false, skip: true, detail });
    log(`SKIP ${detail}`);
    return results;
  };

  const selenium = loadSelenium();
  if (!selenium) return skip("selenium-webdriver not installed (set PI_HUB_SELENIUM)");
  const { Builder, firefox } = selenium;
  const gecko = process.env.GECKODRIVER;
  if (gecko && !fs.existsSync(gecko)) return skip(`geckodriver does not exist: ${gecko}`);
  if (!gecko && !process.env.PATH?.split(":").some((d) => fs.existsSync(`${d}/geckodriver`))) {
    return skip("geckodriver not found (set GECKODRIVER)");
  }
  try {
    execFileSync(process.env.FIREFOX_BIN || "firefox", ["--version"], { timeout: 3000 });
  } catch {
    return skip("Firefox not found (set FIREFOX_BIN)");
  }

  const port = await freePort();
  const hub = await startHub({ port, sessionDir: fixtureSessionDir() });
  const options = new firefox.Options().addArguments("-headless").windowSize({ width: 390, height: 844 });
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  const service = gecko ? new firefox.ServiceBuilder(gecko) : new firefox.ServiceBuilder();
  let driver = null;
  try {
    driver = await new Builder().forBrowser("firefox").setFirefoxService(service).setFirefoxOptions(options).build();
    const page = new SeleniumPage(driver);
    await page.goto(`${hub.url}/hub/#test`);
    await page.waitFor("return document.body.dataset.ready === '1'", 40000);
    const errors = await page.js("return window.__errs || []");
    check("TC1 client boots with no JS errors", errors.length === 0, JSON.stringify(errors));
    // Keep the test seam across the session hash changes/reload below.
    await page.js('sessionStorage.setItem("pi-hub-test", "1"); return true');

    await page.click('#session-list .sb-row[data-session-file$="fixture.jsonl"]');
    await page.waitFor("return document.body.dataset.view === 'session'", 45000);
    await page.waitFor(
      "return (document.querySelector('#messages')?.textContent || '').includes('FIXTURE-ASSISTANT-05')",
      30000,
    );
    const text = await page.text("#messages");
    check("TC2 fixture session resumes in the browser", text.includes("FIXTURE-ASSISTANT-05"), text.slice(0, 80));

    // Reload is the reconnect path: history must come back without duplicates
    // or a blank pane.
    await driver.navigate().refresh();
    await page.waitFor("return document.body.dataset.ready === '1'", 30000);
    await page.waitFor("return document.body.dataset.view === 'session'", 30000);
    await page.waitFor(
      "return (document.querySelector('#messages')?.textContent || '').includes('FIXTURE-ASSISTANT-05')",
      30000,
    );
    check("TC3 reload keeps the resumed transcript", true);

    const shot = `${os.tmpdir()}/pi-hub-termux-smoke.png`;
    await page.screenshot(shot);
    check("TC4 screenshot captured", fs.existsSync(shot) && fs.statSync(shot).size > 5000, shot);
    const after = await page.js("return window.__errs || []");
    check("TC5 no JS errors after navigation", after.length === 0, JSON.stringify(after));

    // R6: the 300-node cap is the only practical browser-level pin for trim
    // behavior. Append synthetic completed messages through the `#test` seam;
    // the DOM must stay bounded and expose the hidden-entry control. Optional
    // on a memory-tight phone (`PI_HUB_SKIP_TRIM_TEST=1`).
    if (process.env.PI_HUB_SKIP_TRIM_TEST !== "1") {
      const trim = await page.js(`return (() => {
        const t = window.__piHubTest?.transcript;
        if (!t) return { missing: true };
        for (let i = 0; i < 340; i++) {
          const message = { id: "smoke-" + i, role: "assistant", content: [{ type: "text", text: "synthetic " + i }], stopReason: "stop" };
          t.handleEvent({ type: "message_start", message });
          t.handleEvent({ type: "message_end", message });
        }
        return { count: document.querySelectorAll("#messages > *").length, trim: document.querySelector(".trim-note")?.textContent || "" };
      })()`);
      check("TC6 transcript stays under its DOM cap", trim && !trim.missing && trim.count <= 301 && /Show earlier/.test(trim.trim), JSON.stringify(trim));
    }
  } finally {
    try { await driver?.quit(); } catch {}
    await hub.close();
  }
  return results;
}
