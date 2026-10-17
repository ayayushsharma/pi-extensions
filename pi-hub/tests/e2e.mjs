// e2e — Playwright (Chromium/system Chrome) over the real hub and fixture store.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fixtureSessionDir, freePort, jsonFetch, startHub, startMirror, waitFor } from "./helpers.mjs";

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
  const hub = await startHub({ port, sessionDir: sessions });
  const pageErrors = [];
  try {
    // E1 — boot, login-free, ready marker, sessions
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(hub.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    await page.waitForTimeout(800);
    const rows = await page.locator("#session-list .row-item").count();
    const errs1 = await page.evaluate(() => window.__errs || []);
    check("E1 boot + ready + history rows", rows >= 1, `rows=${rows}`);
    check("E1b no client errors on boot", errs1.length === 0 && pageErrors.length === 0, JSON.stringify([...errs1, ...pageErrors]));

    // E2 — resume the fixture and render its transcript (ADR-015 path)
    await page.locator('#session-list .row-item[data-session-file="2026-01-01T00-00-00Z_fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length >= 5, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const transcript = await page.textContent("#messages");
    const header = await page.textContent("#session-meta");
    check("E2 resume renders fixture transcript", transcript.includes("FIXTURE-USER-29"), transcript.slice(0, 80));
    check("E2b header follows the fixture model", header.includes("deepseek-v4.1-flash"), header);
    check("E2c hash pinned to the session", (page.url().includes("#s=") && page.url().includes("fixture")), page.url());

    // E3 — load earlier (windowing, P3)
    const loaded = await page.locator("#messages .msg").count();
    const earlier = page.locator("#messages .load-earlier");
    if (await earlier.count()) {
      await earlier.click();
      await page.waitForFunction((n) => document.querySelectorAll("#messages .msg").length > n, loaded, { timeout: 15000 });
      check("E3 load earlier grows the window", true);
    } else {
      check("E3 load earlier control present", false, "control missing");
    }

    // E4 — new session from anywhere (C3)
    await page.click("#new-session-btn");
    await page.waitForSelector("#picker:not(.hidden)");
    await page.fill("#picker-path", "/tmp/pihub-fixtures");
    await page.click("#picker-start");
    await page.waitForFunction(() => document.querySelector('#runner-list [data-runner-kind="headless"]'), null, { timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector("#input").disabled, null, { timeout: 30000 });
    const inputEnabled = await page.locator("#input").isEnabled();
    check("E4 new session binds a headless runner", inputEnabled);
    const boundInfo = await (await fetch(`${hub.url}/api/runners`)).json();
    const fresh = boundInfo.runners.find((r) => r.kind === "headless" && r.cwd === "/tmp/pihub-fixtures");
    check("E4b runner has a pid", !!fresh?.pid, JSON.stringify(boundInfo.runners.map((r) => r.pid)));
    if (process.env.PI_HUB_E2E_PROMPT === "1" && fresh) {
      // Real model round-trip (opt-in: costs a call). Assert on the
      // ASSISTANT bubble so the prompt echo cannot satisfy the wait.
      await page.fill("#input", "Reply with just the word DONE.");
      await page.click("#send-btn");
      try {
        await page.waitForFunction(
          () => [...document.querySelectorAll("#messages .msg.assistant")].some((m) => (m.textContent || "").includes("DONE")),
          null,
          { timeout: 240000 },
        );
      } catch (e) {
        log(`E8 diagnostic messages: ${(await page.textContent("#messages")).replace(/\s+/g, " ").slice(0, 400)}`);
        log(`E8 diagnostic hub log:\n${hub.log().split("\n").slice(-15).join("\n")}`);
        throw e;
      }
      check("E8 real prompt round-trip", true);
      await page.waitForFunction(() => document.querySelector("#abort-btn").classList.contains("hidden"), null, { timeout: 120000 });
      check("E8b run settled (stop hidden after agent_end)", true);
    }
    if (fresh) await jsonFetch(`${hub.url}/api/runners/close`, { method: "POST", body: { runnerId: fresh.id } });

    // E5 — live TUI preview → drive → detach (C1/ADR-009/014)
    const mirror = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      await page.waitForSelector('#runner-list [data-runner-kind="live"]', { timeout: 30000 });
      await page.locator('#runner-list [data-runner-kind="live"]').first().click();
      await page.waitForSelector("#banner:not(.hidden)", { timeout: 15000 });
      const previewText = await page.textContent("#banner");
      check("E5 live preview banner (read-only)", previewText.includes("Previewing"), previewText);
      check("E5b input disabled while previewing", !(await page.locator("#input").isEnabled()));
      await page.getByRole("button", { name: "Attach & Drive" }).click();
      await page.waitForFunction(() => document.querySelector("#banner").textContent.includes("Driving"), null, { timeout: 15000 });
      check("E5c attach flips to driving + input enabled", await page.locator("#input").isEnabled());
      await page.getByRole("button", { name: "Detach" }).click();
      await page.waitForFunction(() => document.querySelector("#banner").textContent.includes("Previewing"), null, { timeout: 15000 });
      check("E5d detach freezes back to preview", !(await page.locator("#input").isEnabled()));
    } finally {
      await mirror.close();
    }
    await waitFor(async () => (await (await fetch(`${hub.url}/api/instances`)).json()).instances.length === 0, { timeoutMs: 10000, what: "mirror gone" });
    check("E5e dead mirror removed from Live", (await page.locator('#runner-list [data-runner-kind="live"]').count()) === 0);

    await page.screenshot({ path: path.join(hub.dir, "e2e-desktop.png") });

    // E6 — phone viewport, no overflow, drawer
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    phone.on("pageerror", (e) => pageErrors.push(`phone: ${e.message}`));
    await phone.goto(hub.url, { waitUntil: "domcontentloaded" });
    await phone.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    await phone.waitForTimeout(600);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("E6 phone has no horizontal overflow", overflow === 0, `${overflow}px`);
    await phone.click("#sidebar-toggle");
    await phone.waitForFunction(() => document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    const phoneErrs = await phone.evaluate(() => window.__errs || []);
    check("E6b phone drawer + no errors", phoneErrs.length === 0, JSON.stringify(phoneErrs));
    await phone.screenshot({ path: path.join(hub.dir, "e2e-phone.png") });
  } finally {
    await hub.close();
    await browser.close();
  }

  // E7 — auth: overlay, login, logout
  const authPort = await freePort();
  const secure = await startHub({ port: authPort, env: { PI_HUB_USER: "tau", PI_HUB_PASS: "tpass" }, sessionDir: fixtureSessionDir() });
  try {
    const authBrowser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));
    const page = await authBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(secure.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#login:not(.hidden)", { timeout: 15000 });
    check("E7 login overlay appears on 401", true);
    await page.fill("#login-user", "tau");
    await page.fill("#login-pass", "tpass");
    await page.click("#login-form button[type=submit]");
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
    check("E7b login reaches ready state", true);
    await authBrowser.close();
  } finally {
    await secure.close();
  }

  return results;
}
