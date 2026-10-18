// e2e — Playwright over the real hub + fixture store, driving the pi-hub
// client (clean-room UI on the native protocol). Covers the four first-class
// capabilities: resume (E2), create anywhere (E4), drive a live TUI (E8) and
// add to a running headless backend (E6), plus chrome, auth and mobile.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const hubRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { findPi, fixtureSessionDir, freePort, jsonFetch, startHub, startMirror, waitFor } from "./helpers.mjs";

const ready = (page, timeout = 30000) =>
  page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout });

async function openFixture(page) {
  await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
  await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
}

export async function runE2E({ log }) {
  const results = [];
  const check = (name, cond, detail = "") => {
    results.push({ name, ok: !!cond, detail });
    log(`${cond ? "PASS" : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  };

  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (e) {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (e2) {
      results.push({ name: "E0 browser available", ok: false, skip: true, detail: `${e.message} / ${e2.message}` });
      log(`SKIP E0 no Chromium/Chrome (${e2.message.split("\n")[0]})`);
      return results;
    }
  }

  const port = await freePort();
  const sessions = fixtureSessionDir();
  const hub = await startHub({
    port,
    sessionDir: sessions,
    env: {
      PI_HUB_PI_BIN: path.join(hubRoot(), "tests", "fixtures", "pi-with-dialog.sh"),
      PI_HUB_TEST_REAL_PI: findPi(),
    },
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error" && !/favicon/.test(m.text())) pageErrors.push(`console: ${m.text().slice(0, 200)}`);
    });

    // ── E1 boot ─────────────────────────────────────────────────────────
    await page.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(page);
    await page.waitForTimeout(400);
    const rows = await page.locator("#session-list .sb-row").count();
    check("E1 boot + ready + session rows", rows >= 1, `rows=${rows}`);
    check("E1b no client errors on boot", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

    // ── E2 resume a historical session (C2) ─────────────────────────────
    await openFixture(page);
    await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length >= 5, null, { timeout: 30000 });
    await page.waitForTimeout(400);
    const transcript = (await page.textContent("#messages")) || "";
    check("E2 resume renders the fixture transcript", transcript.includes("FIXTURE-USER-29"), transcript.replace(/\s+/g, " ").slice(0, 80));
    check("E2b card shows the headless runner", /runner/i.test((await page.textContent("#cs-state")) || ""), await page.textContent("#cs-state"));
    const modelLabel = (await page.textContent("#model-label")) || "";
    check("E2c composer shows the session model", /deepseek|muse|model/i.test(modelLabel) && modelLabel.length > 0, modelLabel);
    const loadEarlier = page.locator(".load-earlier-wrap button");
    if (await loadEarlier.count()) {
      const before = await page.locator("#messages .msg").count();
      await loadEarlier.click();
      await page.waitForFunction((n) => document.querySelectorAll("#messages .msg").length > n, before, { timeout: 15000 });
      check("E2d load earlier grows the window", true);
    } else {
      check("E2d whole transcript already loaded", before === undefined, "");
    }

    // ── E3 composer + slash palette ─────────────────────────────────────
    await page.click("#input");
    await page.type("#input", "/");
    await page.waitForSelector("#slash:not(.hidden)", { timeout: 20000 });
    const slashItems = await page.locator("#slash .item").count();
    check("E3 slash palette lists commands", slashItems > 0, `items=${slashItems}`);
    await page.keyboard.press("Escape");
    await page.fill("#input", "");

    // ── E4 picker: new session anywhere with a working starter (C3) ─────
    await page.click("#new-session-btn");
    await page.waitForSelector("#picker:not(.hidden)", { timeout: 10000 });
    await page.waitForFunction(() => !!document.querySelector("#picker-sessions .sb-row, #picker-dirs .sb-row, #picker-sessions .sb-empty"), null, { timeout: 20000 });
    check("E4 picker browses the bound cwd", ((await page.inputValue("#picker-path")) || "").includes("pihub-fixtures"), await page.inputValue("#picker-path"));
    await page.fill("#picker-starter", "/ask");
    await page.click("#picker-start");
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 60000 });
    // The starter is a dialog command: it only appears if it was actually sent.
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 45000 });
    check("E4b picker starter prompt is delivered", ((await page.textContent("#dialog-container")) || "").includes("Test dialog"));
    await page.getByRole("button", { name: /confirm/i }).first().click();
    await page.waitForTimeout(500);

    // ── E5 session tab + card for the fresh session ─────────────────────
    const tabs = await page.locator("#tab-strip .tab").count();
    check("E5 fresh session opened as a tab", tabs >= 2, `tabs=${tabs}`);
    await page.waitForFunction(() => /\.jsonl$/.test(document.querySelector("#cs-name")?.textContent || ""), null, { timeout: 30000 }).catch(() => {});
    check("E5b fresh session discovered its file", /\.jsonl$/.test((await page.textContent("#cs-name")) || ""), await page.textContent("#cs-name"));

    // ── E6 dialog relay: confirm + select (ADR-007) ─────────────────────
    await page.fill("#input", "/askselect");
    await page.click("#send-btn");
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 30000 });
    await page.getByRole("button", { name: "beta" }).first().click();
    await page.waitForFunction(() => (document.body.textContent || "").includes("DIALOG-beta"), null, { timeout: 30000 });
    check("E6 select answer relayed to the child", true);

    // ── E7 real prompt round-trip (opt-in: costs a model call) ──────────
    if (process.env.PI_HUB_E2E_PROMPT === "1") {
      await page.fill("#input", "Reply with just the word DONE.");
      await page.click("#send-btn");
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll("#messages .msg.assistant")].some((m) => (m.textContent || "").includes("DONE")),
          null,
          { timeout: 240000 },
        );
      } catch (e) {
        log(`E7 diagnostic messages: ${((await page.textContent("#messages")) || "").replace(/\s+/g, " ").slice(0, 400)}`);
        log(`E7 diagnostic hub log:\n${hub.log().split("\n").slice(-15).join("\n")}`);
        throw e;
      }
      check("E7 real prompt round-trip", true);
    }

    // ── E8 live TUI preview → drive → detach (C1) ───────────────────────
    const mirror = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      await page.waitForSelector('#live-section .sb-row[data-runner-kind="live"]', { timeout: 30000 });
      await page.locator('#live-section .sb-row[data-runner-kind="live"]').first().click();
      await page.waitForSelector("#banner:not(.hidden)", { timeout: 15000 });
      await page.waitForTimeout(1500);
      const previewText = (await page.textContent("#banner")) || "";
      check("E8 preview banner (read-only)", /Read-only preview/.test(previewText), previewText.replace(/\s+/g, " ").slice(0, 80));
      check("E8b input disabled while previewing", await page.locator("#input").isDisabled());
      await page.getByRole("button", { name: /^Drive/ }).first().click();
      await page.waitForFunction(() => /Driving/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 15000 });
      check("E8c driving enables the composer", !(await page.locator("#input").isDisabled()));
      await page.click("#model-btn");
      await page.waitForFunction(() => document.querySelectorAll("#model-menu .item").length > 0, null, { timeout: 20000 });
      check("E8d relay drive round-trip (model list via TUI)", true);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /Detach/ }).first().click();
      await page.waitForFunction(() => /Read-only preview/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 15000 });
      check("E8e detach returns to preview", await page.locator("#input").isDisabled());
    } finally {
      await mirror.close();
    }
    await waitFor(async () => (await (await fetch(`${hub.url}/api/instances`)).json()).instances.length === 0, { timeoutMs: 10000, what: "mirror gone" });
    check("E8f dead mirror removed from the sidebar", (await page.locator('#live-section .sb-row[data-runner-kind="live"]').count()) === 0);

    // ── E9 close runner → dead banner → resume ──────────────────────────
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.waitForFunction(() => /runner/i.test(document.querySelector("#cs-state")?.textContent || ""), null, { timeout: 30000 });
    await page.click("#cs-close");
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 10000 });
    await page.getByRole("button", { name: /Confirm/i }).first().click();
    await page.waitForFunction(() => /Session ended/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 20000 });
    check("E9 close surfaces the ended banner", true);
    await page.getByRole("button", { name: /Resume from disk/ }).first().click();
    await page.waitForFunction(() => /runner/i.test(document.querySelector("#cs-state")?.textContent || ""), null, { timeout: 45000 });
    check("E9b banner resumes the session", true);

    // ── E10 rename + delete via the context menu ────────────────────────
    const fork = await jsonFetch(`${hub.url}/api/sessions/fork`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" } });
    const forkFile = (await fork.json()).file;
    await page.evaluate(() => window.location.reload());
    await ready(page);
    const forkRow = page.locator(`#session-list .sb-row[data-session-file="${forkFile}"]`);
    await forkRow.click({ button: "right" });
    await page.waitForSelector(".ctx-menu");
    await page.getByText("Rename", { exact: true }).first().click();
    const renameInput = page.locator("#session-list input.sb-search");
    await renameInput.fill("Renamed by e2e");
    await renameInput.press("Enter");
    await page.waitForFunction(() => (document.querySelector("#session-list")?.textContent || "").includes("Renamed by e2e"), null, { timeout: 15000 });
    check("E10 rename round-trip", true);
    await page.locator(`#session-list .sb-row[data-session-file="${forkFile}"]`).click({ button: "right" });
    await page.waitForSelector(".ctx-menu");
    await page.getByText("Delete", { exact: true }).first().click();
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 10000 });
    await page.getByRole("button", { name: /Confirm/i }).first().click();
    await waitFor(() => !fs.existsSync(path.join(sessions, "--tmp-pihub-fixtures--", forkFile)), { timeoutMs: 15000, what: "fork file deleted" });
    check("E10b delete removes the file from disk", true);

    // ── E11 WS flap ─────────────────────────────────────────────────────
    const errsBefore = pageErrors.length;
    await page.context().setOffline(true);
    await page.waitForTimeout(1500);
    await page.context().setOffline(false);
    await page.waitForFunction(() => (document.querySelector("#status-text")?.textContent || "").trim() === "Connected", null, { timeout: 45000 });
    const realErrs = pageErrors.slice(errsBefore).filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource/.test(e));
    check("E11 reconnect after a WS flap", realErrs.length === 0, JSON.stringify(realErrs));

    // ── E12 files panel + settings ──────────────────────────────────────
    await page.click("#files-btn");
    await page.waitForSelector("#file-panel:not(.hidden)", { timeout: 10000 });
    await page.waitForTimeout(800);
    const upDisabled = await page.locator("#file-up").isDisabled();
    check("E12 files panel opens jailed to the session root", upDisabled, `up disabled=${upDisabled}`);
    await page.click("#file-close");
    await page.click("#settings-btn");
    await page.waitForSelector("#settings:not(.hidden)", { timeout: 10000 });
    const swatches = await page.locator("#theme-grid .theme-swatch").count();
    check("E12b settings exposes themes", swatches >= 4, `swatches=${swatches}`);
    await page.locator('.settings-tabs .tab-btn[data-tab="server"]').click();
    await page.waitForFunction(() => (document.querySelector("#server-info")?.textContent || "").includes("pi-hub"), null, { timeout: 10000 });
    check("E12c server info renders", true);
    await page.click("#settings-close");
    await page.screenshot({ path: path.join(hub.dir, "e2e-desktop.png") });

    // ── E13 phone viewport ──────────────────────────────────────────────
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    phone.on("pageerror", (e) => pageErrors.push(`phone: ${e.message}`));
    await phone.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(phone);
    await phone.waitForTimeout(400);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("E13 phone has no horizontal overflow", overflow === 0, `${overflow}px`);
    await phone.click("#sidebar-toggle");
    await phone.waitForFunction(() => document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    await phone.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await phone.waitForFunction(() => !document.body.classList.contains("sidebar-open") && document.body.dataset.view === "session", null, { timeout: 45000 });
    check("E13b drawer closes on session pick", true);
    await phone.screenshot({ path: path.join(hub.dir, "e2e-phone.png") });
    await phone.close();
  } finally {
    await hub.close();
    await browser.close();
  }

  // ── E14 auth ──────────────────────────────────────────────────────────
  const secure = await startHub({ port: await freePort(), env: { PI_HUB_USER: "tau", PI_HUB_PASS: "tpass" }, sessionDir: fixtureSessionDir() });
  try {
    const authBrowser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
    const page = await authBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${secure.url}/hub/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#login:not(.hidden)", { timeout: 20000 });
    check("E14 login overlay appears on 401", true);
    await page.fill("#login-user", "tau");
    await page.fill("#login-pass", "tpass");
    await page.click("#login-form button[type=submit]");
    await ready(page);
    const rows = await page.locator("#session-list .sb-row").count();
    check("E14b login reaches the app with sessions", rows >= 1, `rows=${rows}`);
    await authBrowser.close();
  } finally {
    await secure.close();
  }

  return results;
}
