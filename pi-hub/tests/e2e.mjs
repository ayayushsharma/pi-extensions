// e2e — Playwright over the real hub + fixture store, driving the pi-hub
// client (clean-room UI on the native protocol). Covers the four first-class
// capabilities: resume (E2), create anywhere (E4), drive a live TUI (E8) and
// add to a running headless backend (E6), plus chrome, auth and mobile.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const hubRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { runGroups } from "./groups.mjs";
import { PKG_ROOT, findPi, fixtureSessionDir, freePort, jsonFetch, llmCopiesInLastRequest, llmMentioning, setLlmHold, startHub, startMirror, waitFor } from "./helpers.mjs";

const ready = (page, timeout = 30000) =>
  page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout });

async function openFixture(page) {
  await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
  await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
}

async function launchBrowser() {
  // PI_HUB_CHROME_BIN pins a Chromium executable (hosts whose system Chrome
  // is missing but a Playwright-cached Chromium exists, e.g. Termux/dev).
  if (process.env.PI_HUB_CHROME_BIN) {
    return chromium.launch({ executablePath: process.env.PI_HUB_CHROME_BIN, headless: true });
  }
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (e) {
    try {
      return await chromium.launch({ headless: true });
    } catch (e2) {
      throw new Error(`${e.message} / ${e2.message}`);
    }
  }
}
export async function runE2E({ log }) {
  if (process.env.PI_HUB_NO_BROWSER === "1") return [{ name: "E0 browser available", ok: true, skip: true, detail: "PI_HUB_NO_BROWSER=1" }];
  // Each group boots its own hub + browser and owns its own session copies,
  // so they run concurrently (see groups.mjs). Wall time is the slowest one.
  // PI_HUB_E2E_ONLY=chrome,steer debugs a single group without the rest.
  const only = (process.env.PI_HUB_E2E_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);
  try {
    return await runGroups(
    [
      { name: "core", run: coreGroup },
      { name: "live", run: liveGroup },
      { name: "close", run: closeGroup },
      { name: "panels", run: panelsGroup },
      { name: "tabs", run: tabsGroup },
      { name: "models", run: modelsGroup },
      { name: "chrome", run: chromeGroup },
      { name: "detail", run: detailGroup },
      { name: "deadcwd", run: deadCwdGroup },
      { name: "steer", run: steerGroup },
      { name: "auth", run: authGroup },
    ].filter((g) => !only.length || only.includes(g.name)),
      { log },
    );
  } finally {
    try { await (await getBrowser()).close(); } catch {}
  }
}

/** One Chromium for the whole run: a browser per group would thrash a phone. */
let browserPromise = null;
const getBrowser = () => (browserPromise ??= launchBrowser());

/** One hub + browser + page, wired for the fixture store. */
async function bootCore({ log } = {}) {
  const sessions = fixtureSessionDir();
  const hub = await startHub({
    port: await freePort(),
    sessionDir: sessions,
    env: {
      PI_HUB_PI_BIN: path.join(hubRoot(), "tests", "fixtures", "pi-with-dialog.sh"),
      PI_HUB_TEST_REAL_PI: findPi(),
    },
  });
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) pageErrors.push(`console: ${m.text().slice(0, 200)}`);
  });
  await page.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
  await ready(page);
  const close = async () => {
    try { await page.close(); } catch {}
    try { await hub.close(); } catch {}
  };
  return { hub, browser, page, sessions, pageErrors, close };
}

async function coreGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E1 boot ─────────────────────────────────────────────────────────
    await page.waitForTimeout(200);
    const rows = await page.locator("#session-list .sb-row").count();
    check("E1 boot + ready + session rows", rows >= 1, `rows=${rows}`);
    check("E1b no client errors on boot", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
    // ── E1c UI + mono webfont stacks (Inter / JetBrains Mono) ───────────
    // The families are wired here; H12f pins the Google CDN link + CSP.
    const stacks = await page.evaluate(() => ({
      ui: getComputedStyle(document.body).fontFamily,
      monoVar: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
    }));
    check("E1c UI and mono webfont stacks are applied",
      /^"?Inter"?\s*,/.test(stacks.ui) && stacks.monoVar.startsWith('"JetBrains Mono"'),
      `${stacks.ui.slice(0, 24)} · ${stacks.monoVar.slice(0, 24)}`);

    // ── E2 resume a historical session (C2) ─────────────────────────────
    await openFixture(page);
    await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length >= 5, null, { timeout: 30000 });
    await page.waitForTimeout(200);
    const transcript = (await page.textContent("#messages")) || "";
    check("E2 resume renders the fixture transcript", transcript.includes("FIXTURE-USER-29"), transcript.replace(/\s+/g, " ").slice(0, 80));
    // ── E2e resume opens at the newest message ──────────────────────────
    // The transcript scrolls inside #view, not #messages; the old code scrolled
    // the wrong element, so every resume started at the top of the file. Layout
    // settles a beat after the render (markdown, images), hence the bounded wait.
    const pinned = await page
      .waitForFunction(() => {
        const v = document.querySelector("#view");
        return v.scrollTop > 0 && v.scrollHeight - v.scrollTop - v.clientHeight < 140;
      }, null, { timeout: 5000 })
      .then(() => true, () => false);
    const viewBox = await page.evaluate(() => {
      const v = document.querySelector("#view");
      const first = document.querySelector("#messages .msg");
      return { top: Math.round(v.scrollTop), gap: Math.round(v.scrollHeight - v.scrollTop - v.clientHeight), firstTop: Math.round(first.getBoundingClientRect().top) };
    });
    check("E2e resume lands on the newest message", pinned && viewBox.firstTop < 0,
      `scrollTop=${viewBox.top} gap=${viewBox.gap} firstTop=${viewBox.firstTop}`);
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
    const upText = ((await page.textContent("#picker-up")) || "").replace(/\s+/g, " ").trim();
    check("E4c picker Up button says it once", (upText.match(/Up/gi) || []).length === 1, `label="${upText}"`);
    await page.fill("#picker-starter", "/ask");
    await page.click("#picker-start");
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 60000 });
    // The starter is a dialog command: it only appears if it was actually sent.
    try {
      await page.waitForSelector("#dialog-container .dialog-card", { timeout: 45000 });
    } catch (e) {
      log(`E4 diagnostic view=${await page.evaluate(() => document.body.dataset.view)} picker=${await page.evaluate(() => document.querySelector("#picker")?.className)}`);
      log(`E4 diagnostic transcript=${((await page.textContent("#messages")) || "").replace(/\s+/g, " ").slice(-300)}`);
      log(`E4 diagnostic status=${((await page.textContent("#statusline")) || "").replace(/\s+/g, " ").slice(0, 200)}`);
      log(`E4 diagnostic hub log:\n${hub.log().split("\n").slice(-18).join("\n")}`);
      throw e;
    }
    check("E4b picker starter prompt is delivered", ((await page.textContent("#dialog-container")) || "").includes("Test dialog"));
    await page.getByRole("button", { name: /confirm/i }).first().click();
    await page.waitForTimeout(200);

    // ── E5 session tab + card for the fresh session ─────────────────────
    const tabs = await page.locator("#tab-strip .tab").count();
    check("E5 fresh session opened as a tab", tabs >= 2, `tabs=${tabs}`);
    // The first prompt names the session: never the `.jsonl` file name (and
    // "new session" only until the store has the prompt-derived title).
    await page.waitForFunction(() => {
      const t = document.querySelector("#cs-name")?.textContent || "";
      return !t.includes(".jsonl") && t.trim().length > 0;
    }, null, { timeout: 30000 });
    check("E5b fresh session shows a title, never a file name", !(await page.textContent("#cs-name") || "").includes(".jsonl"), await page.textContent("#cs-name"));

    // ── E6 dialog relay: confirm + select (ADR-007) ─────────────────────
    await page.fill("#input", "/askselect");
    await page.click("#send-btn");
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 30000 });
    await page.getByRole("button", { name: "beta" }).first().click();
    await page.waitForFunction(() => (document.body.textContent || "").includes("DIALOG-beta"), null, { timeout: 30000 });
    check("E6 select answer relayed to the child", true);

    // ── E7 prompt round-trip through the sandbox's fake model ───────────
    // The "model" is a local HTTP stub (tests/fixtures/fake-llm.mjs), so this
    // costs nothing, needs no keys, and answers deterministically.
    await page.fill("#input", "PING-E7");
    await page.click("#send-btn");
    await page.waitForFunction(
      () => [...document.querySelectorAll("#messages .msg.assistant")].some((m) => (m.textContent || "").includes("ACK")),
      null,
      { timeout: 30000 },
    );
    check("E7 prompt round-trip through the fake model", true);
    const e7Calls = (await llmMentioning("PING-E7")).length;
    check("E7b prompt reached the model exactly once", e7Calls === 1, `calls=${e7Calls}`);

  } finally {
    await close();
  }
}

async function liveGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E8 live TUI preview → drive → detach (C1) ───────────────────────
    const mirror = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      await page.waitForSelector('#live-section .sb-row[data-runner-kind="live"]', { timeout: 30000 });
      await page.locator('#live-section .sb-row[data-runner-kind="live"]').first().click();
      await page.waitForSelector("#banner:not(.hidden)", { timeout: 15000 });
      await page.waitForTimeout(200);
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

    // ── E24 live runners carry the live treatment (R-4) ───────────────
    const mirror2 = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      await page.waitForSelector('#live-section .sb-row[data-runner-kind="live"].live-row', { timeout: 30000 });
      const liveChips = await page.locator('#live-section .sb-row[data-runner-kind="live"] .chip.live').count();
      check("E24 live runners carry the live treatment", liveChips >= 1);
    } finally {
      await mirror2.close();
    }
    await waitFor(async () => (await (await fetch(`${hub.url}/api/instances`)).json()).instances.length === 0, { timeoutMs: 10000, what: "second mirror gone" });

  } finally {
    await close();
  }
}

async function closeGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E9 close session: tab goes, reload stays gone (UX-14) ───────────
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.waitForFunction(() => /runner/i.test(document.querySelector("#cs-state")?.textContent || ""), null, { timeout: 30000 });
    const tabsBefore = await page.locator("#tab-strip .tab").count();
    await page.click("#cs-close");
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 10000 });
    check("E9 close asks to close the session", /stops and its tab closes/.test((await page.textContent("#dialog-container")) || ""));
    await page.getByRole("button", { name: /Confirm/i }).first().click();
    await page.waitForFunction((n) => document.querySelectorAll("#tab-strip .tab").length === n - 1, tabsBefore, { timeout: 20000 });
    await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 20000 });
    check("E9b closing the session drops its tab", (await page.locator('#tab-strip .tab[data-tab-key*="fixture.jsonl"]').count()) === 0);
    // Durability: a reload must not resurrect it (the tab is gone from storage).
    await page.waitForTimeout(200);
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);
    await page.waitForTimeout(200);
    const resurrectedTab = await page.locator('#tab-strip .tab[data-tab-key*="fixture.jsonl"]').count();
    const runnersAfterReload = (await (await fetch(`${hub.url}/api/runners`)).json()).runners.filter((r) => (r.absFile || "").endsWith("fixture.jsonl"));
    check("E9c closed session stays closed across reload", resurrectedTab === 0 && runnersAfterReload.length === 0, `tabs=${resurrectedTab} runners=${runnersAfterReload.length}`);
    // …and reopening is an explicit action from the sidebar.
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.waitForFunction(() => /runner/i.test(document.querySelector("#cs-state")?.textContent || ""), null, { timeout: 45000 });
    check("E9d the file is still resumable from the sidebar", true);

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
    await page.waitForTimeout(200);
    await page.context().setOffline(false);
    await page.waitForFunction(() => (document.querySelector("#status-text")?.textContent || "").trim() === "Connected", null, { timeout: 45000 });
    const realErrs = pageErrors.slice(errsBefore).filter((e) => !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|Failed to load resource/.test(e));
    check("E11 reconnect after a WS flap", realErrs.length === 0, JSON.stringify(realErrs));

  } finally {
    await close();
  }
}

async function panelsGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // this group binds its own session: panels need a bound cwd
    await openFixture(page);
    // ── E12 files panel + settings ──────────────────────────────────────
    await page.click("#files-btn");
    await page.waitForSelector("#file-panel:not(.hidden)", { timeout: 10000 });
    await page.waitForTimeout(200);
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
    await phone.waitForTimeout(200);
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
    await close();
  }
}

async function tabsGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E15 tab close: closing the active tab binds the next one ───────
    // Regression: closeTab compared activeKey AFTER removeTab had already
    // moved it, so the dead branch never ran — the UI kept showing the
    // closed tab's transcript under the newly "active" tab (UX-1).
    await page.evaluate(() => { localStorage.removeItem("pi-hub-tabs"); location.hash = ""; });
    const fork2 = await jsonFetch(`${hub.url}/api/sessions/fork`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" } });
    const fork2File = (await fork2.json()).file;
    await jsonFetch(`${hub.url}/api/sessions/rename`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: fork2File, name: "Second session" } });
    await page.evaluate(() => window.location.reload());
    await ready(page);
    await page.waitForTimeout(200);
    check("E15 clean tab strip after storage reset", (await page.locator("#tab-strip .tab").count()) === 0);
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.locator(`#session-list .sb-row[data-session-file="${fork2File}"]`).first().click();
    await page.waitForFunction(() => document.querySelectorAll("#tab-strip .tab").length === 2, null, { timeout: 45000 });
    check("E15 two sessions open as two tabs", true);
    // The running-tabs block is its own panel (framed + accent rail + count),
    // so it is never mistaken for another session list.
    const block = await page.evaluate(() => {
      const b = document.querySelector("#vtabs-section");
      const cs = getComputedStyle(b);
      return {
        tabs: b.querySelectorAll(".sb-row[data-tab-key]").length,
        sessions: b.querySelectorAll(".sb-row[data-session-file]").length,
        label: (b.querySelector(".section-label")?.textContent || "").trim(),
        count: (b.querySelector(".section-label .count")?.textContent || "").trim(),
        framed: cs.borderTopWidth !== "0px" && cs.borderTopLeftRadius !== "0px" && cs.backgroundColor !== "rgba(0, 0, 0, 0)",
      };
    });
    // ── E15e the tab strip scrolls sideways instead of clipping ─────────
    // Squeeze the bar until two tabs no longer fit: the strip must overflow
    // (not shrink the tabs), scroll, and reveal the active tab after a switch.
    await page.setViewportSize({ width: 520, height: 800 });
    await page.waitForTimeout(250);
    const strip15 = await page.evaluate(() => {
      const s = document.querySelector("#tab-strip");
      const first = s.querySelector(".tab");
      return {
        clientWidth: s.clientWidth,
        scrollWidth: s.scrollWidth,
        overflowX: getComputedStyle(s).overflowX,
        shrink: getComputedStyle(first).flexShrink,
      };
    });
    const scrolled = await page.evaluate(async () => {
      const s = document.querySelector("#tab-strip");
      s.scrollLeft = 99999;
      const max = s.scrollLeft;
      s.scrollLeft = 0;
      // Activate the last tab without Playwright's own scroll-into-view, so
      // only the app's reveal logic can bring it back on screen.
      s.querySelectorAll(".tab")[s.querySelectorAll(".tab").length - 1].click();
      await new Promise((r) => setTimeout(r, 250));
      return { max, revealed: s.scrollLeft };
    });
    check("E15e tab strip scrolls instead of clipping its tabs",
      strip15.overflowX === "auto" && strip15.shrink === "0" && strip15.scrollWidth > strip15.clientWidth && scrolled.max > 0 && scrolled.revealed > 0,
      JSON.stringify({ ...strip15, ...scrolled }));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(200);

    check("E15d running tabs render as a framed panel with a count",
      block.framed && block.tabs === 2 && block.sessions === 0 && block.label.startsWith("Currently running tabs") && block.count === "2",
      JSON.stringify(block));
    const activeBefore = (await page.textContent("#tab-strip .tab.active .tab-title")) || "";
    await page.locator("#tab-strip .tab.active .tab-close").click();
    await page.waitForFunction((before) => (document.querySelector("#tab-strip .tab.active .tab-title")?.textContent || "") !== before, activeBefore, { timeout: 20000 });
    const activeAfter = ((await page.textContent("#tab-strip .tab.active .tab-title")) || "").trim();
    const csAfter = (await page.textContent("#cs-name")) || "";
    const hashAfter = await page.evaluate(() => location.hash);
    check("E15b closing the active tab shows the next tab", activeAfter !== activeBefore.trim() && csAfter.includes(activeAfter) && hashAfter.includes("fixture.jsonl") !== hashAfter.includes(fork2File), `was=${activeBefore} now=${activeAfter} card=${csAfter} hash=${hashAfter}`);
    // Closing the last tab returns to the homepage (welcome visible,
    // transcript hidden + drained, composer inert).
    const earlierBefore = await page.locator(".load-earlier-wrap").count();
    await page.locator("#tab-strip .tab.active .tab-close").click();
    await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 20000 });
    const homeClean = (await page.locator("#welcome:not(.hidden)").count()) === 1
      && (await page.locator("#messages:not(.hidden)").count()) === 0
      && (await page.locator("#messages .msg:not(.system)").count()) === 0
      && (await page.locator("#input").isDisabled());
    check("E15c closing the last tab shows the homepage", homeClean);
    const earlierAfter = await page.locator(".load-earlier-wrap").count();
    check("E15c2 homepage drops the load-earlier control", earlierBefore >= 1 && earlierAfter === 0, `before=${earlierBefore} after=${earlierAfter}`);

    // ── E16 sidebar backend kill asks first ───────────────────────────
    // Closing a tab keeps its runner alive under "Headless backends"; the
    // row X must confirm like the session-card X does (UX-2).
    const beRow = page.locator('#sidebar .sb-row[data-runner-kind="headless"]');
    await beRow.first().waitFor({ timeout: 15000 });
    await beRow.first().hover();
    await beRow.first().locator(".row-actions .icon-btn").click();
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 10000 });
    check("E16 sidebar backend kill asks for confirmation", true);
    await page.getByRole("button", { name: /^Cancel/ }).first().click();
    await page.waitForTimeout(200);
    const runnersAfterCancel = (await (await fetch(`${hub.url}/api/runners`)).json()).runners.length;
    check("E16b cancelling keeps the backend", runnersAfterCancel >= 1, `runners=${runnersAfterCancel}`);

    // ── E17 confirmed kill of an unbound backend stays quiet ───────────
    // The "resume from the banner" hint must only appear when the killed
    // backend was the bound one — otherwise no banner exists (UX-3).
    const doomed = await beRow.first().getAttribute("data-runner-id");
    await beRow.first().hover();
    await beRow.first().locator(".row-actions .icon-btn").click();
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 10000 });
    await page.getByRole("button", { name: /^Confirm/ }).first().click();
    await waitFor(async () => !(await (await fetch(`${hub.url}/api/runners`)).json()).runners.some((r) => r.id === doomed), { timeoutMs: 15000, what: "backend gone" });
    check("E17 confirmed kill removes the backend", true);
    await page.waitForFunction(() => !document.querySelector("#toast")?.classList.contains("hidden"), null, { timeout: 10000 });
    const toastText = (await page.textContent("#toast")) || "";
    const bannerShown = (await page.locator("#banner:not(.hidden)").count()) > 0;
    check("E17b no phantom banner hint for an unbound kill", !bannerShown && !/banner/i.test(toastText), `toast=${toastText.slice(0, 60)}`);

    // ── E18 home composer is inert until a session binds ──────────────
    const home = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await home.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await home.evaluate(() => { localStorage.clear(); });
    await home.reload({ waitUntil: "domcontentloaded" });
    await ready(home);
    const homePlaceholder = (await home.locator("#input").getAttribute("placeholder")) || "";
    check("E18 home composer disabled with guidance", (await home.locator("#input").isDisabled()) && homePlaceholder.includes("Pick or start"), homePlaceholder);
    // ── E18b "Kill all" closes every headless backend at once ──────────
    // Two backends must be listed for the section action to appear: bind the
    // fixture again (E17 killed its earlier runner) and close its tab.
    await openFixture(page);
    await page.waitForSelector("#tab-strip .tab.active .tab-close", { timeout: 30000 });
    await page.locator("#tab-strip .tab.active .tab-close").click();
    await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 20000 });
    const killAllBtn = page.locator("#live-section .section-label .label-action");
    await killAllBtn.waitFor({ timeout: 15000 });
    const beforeKill = await page.locator('#sidebar .sb-row[data-runner-kind="headless"]').count();
    await killAllBtn.click();
    await page.waitForSelector("#dialog-container .dialog-card", { timeout: 10000 });
    await page.locator("#dialog-container .dialog-card .btn.primary, #dialog-container .dialog-card .btn.danger").first().click();
    await page.waitForFunction(() => document.querySelectorAll("#sidebar .sb-row[data-runner-kind='headless']").length === 0, null, { timeout: 20000 });
    const remaining = (await (await fetch(`${hub.url}/api/runners`)).json()).runners.filter((r) => r.kind === "headless").length;
    check("E18b kill-all closes every headless backend", beforeKill === 2 && remaining === 0, `before=${beforeKill} server=${remaining}`);
    await home.close();


  } finally {
    await close();
  }
}

async function modelsGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E19 model picker + thinking levels ────────────────────────────
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.click("#model-btn");
    await page.waitForFunction(() => document.querySelectorAll("#model-menu .item").length > 0, null, { timeout: 20000 });
    const modelCount = await page.locator("#model-menu .item").count();
    const modelSearch = await page.locator("#model-menu input").count();
    check("E19 model menu lists models", modelCount > 0, `items=${modelCount} search=${modelSearch}`);
    await page.keyboard.press("Escape");
    await page.click("#thinking-btn");
    await page.waitForFunction(() => document.querySelectorAll("#thinking-menu .item").length > 0, null, { timeout: 10000 });
    const levels = (await page.locator("#thinking-menu .item").allTextContents()).map((s) => s.trim());
    const knownLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    check("E19b thinking menu lists levels", levels.length > 0 && levels.every((l) => knownLevels.includes(l)), levels.join(","));
    await page.keyboard.press("Escape");

    // ── E21 model menu fuzzy search (R-1) ─────────────────────────────
    await page.click("#model-btn");
    await page.waitForFunction(() => document.querySelectorAll("#model-menu .item").length > 0, null, { timeout: 20000 });
    const totalModels = await page.locator("#model-menu .item").count();
    await page.fill("#model-menu .menu-search", "haiku");
    await page.waitForFunction(() => document.querySelectorAll("#model-menu .item").length === 1, null, { timeout: 5000 }).catch(() => {});
    const filtered = await page.locator("#model-menu .item").count();
    check("E21 model menu filters as you type", filtered > 0 && filtered < totalModels, `total=${totalModels} filtered=${filtered}`);
    await page.press("#model-menu .menu-search", "Enter");
    await page.waitForFunction(() => document.querySelector("#model-menu")?.classList.contains("hidden"), null, { timeout: 10000 });
    check("E21b Enter picks the top match", true);

    // ── E22 thinking menu follows the bound model (R-2) ───────────────
    // Server-driven proof, per model, from the sandbox catalog: fake-spark
    // offers off but not max, fake-haiku offers max but not off — no single
    // static list can satisfy both.
    const pickModel = async (query, expect) => {
      await page.click("#model-btn");
      await page.waitForSelector("#model-menu .menu-search", { timeout: 15000 });
      await page.fill("#model-menu .menu-search", query);
      await page.locator("#model-menu .item").first().waitFor({ timeout: 5000 });
      await page.press("#model-menu .menu-search", "Enter");
      await page.waitForFunction(() => document.querySelector("#model-menu")?.classList.contains("hidden"), null, { timeout: 15000 });
      // readiness: reopening the menu asks get_state, so the selected row is
      // the child's own report of the switch
      await page.click("#model-btn");
      await page.waitForFunction(
        (re) => [...document.querySelectorAll("#model-menu .item")].some((i) => new RegExp(re, "i").test(i.textContent || "") && i.getAttribute("aria-selected") === "true"),
        expect, { timeout: 30000 },
      );
      await page.keyboard.press("Escape");
    };
    const readLevels = async () => {
      await page.click("#thinking-btn");
      // Wait for a *visible* item: the menu is only shown once the fresh
      // server-driven list has rendered (a hidden menu still holds the
      // previous model's items).
      await page.waitForSelector("#thinking-menu:not(.hidden) .item", { state: "visible", timeout: 20000 });
      const out = (await page.locator("#thinking-menu .item").allTextContents()).map((s) => s.trim());
      await page.keyboard.press("Escape");
      return out;
    };

    await pickModel("spark", "spark");
    const levelsSpark = await readLevels();
    check("E22 thinking menu follows the bound model", levelsSpark.includes("off") && !levelsSpark.includes("max"), levelsSpark.join(","));

    await pickModel("haiku", "haiku");
    const levelsHaiku = await readLevels();
    check("E22b menu re-renders for a different model", !levelsHaiku.includes("off") && levelsHaiku.includes("max"), levelsHaiku.join(","));
    const pillAfter = (await page.textContent("#model-label")) || "";
    check("E22c model pill follows the switch", /haiku/i.test(pillAfter), pillAfter);

    // ── E20 touch: row actions need no hover ──────────────────────────
    // .row-actions is display:none until :hover — without the (hover:none)
    // override, taps on phones can never reach the session menu (UX-4).
    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await touch.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(touch);
    await touch.click("#sidebar-toggle");
    await touch.waitForFunction(() => document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    await touch.click("#sidebar-collapse");
    await touch.waitForFunction(() => !document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    check("E20b mobile chevron closes the drawer", true);
    await touch.click("#sidebar-toggle");
    await touch.waitForFunction(() => document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    await touch.locator('#session-list .sb-row[data-session-file] .row-actions .icon-btn[title="Actions"]').first().tap();
    await touch.waitForSelector(".ctx-menu", { timeout: 5000 });
    check("E20 session actions open by tap (no hover)", true);
    await touch.close();

  } finally {
    await close();
  }
}

async function chromeGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E25 backend rows show session titles (R-5) ────────────────────
    // This group has its own browser context: make sure the store's titles are
    // loaded before closing the tab, or the row under test has nothing to show.
    await page.waitForFunction(
      () => (document.querySelector('#session-list .sb-row[data-session-file$="fixture.jsonl"]')?.textContent || "").includes("Fixture session"),
      null,
      { timeout: 20000 },
    );
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.locator("#tab-strip .tab.active .tab-close").click();
    await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 20000 });
    const beRow25 = page.locator('#sidebar .sb-row[data-runner-kind="headless"]', { hasText: "Fixture session" });
    await beRow25.first().waitFor({ timeout: 15000 });
    const beText = ((await beRow25.first().textContent()) || "").replace(/\s+/g, " ");
    check("E25 backend rows show session titles", beText.includes("Fixture session") && /pid \d+/.test(beText) && !beText.includes(".jsonl"), beText.slice(0, 100));
    // ── E25b row actions: plain outlines, no masking patch ──────────────
    // They used to sit on `linear-gradient(90deg, transparent, var(--bg))`,
    // which painted an opaque rectangle that did not match the hovered row
    // (read as a grey shadow behind the X). The row now reserves their width
    // instead, so the title ellipsizes without anything painted behind them.
    await beRow25.first().hover();
    const acts25 = await beRow25.first().evaluate((row) => {
      const actions = row.querySelector(".row-actions");
      const btn = actions.querySelector(".icon-btn");
      const a = getComputedStyle(actions);
      const b = getComputedStyle(btn);
      const title = row.querySelector(".row-title");
      return {
        bgImage: a.backgroundImage,
        bg: a.backgroundColor,
        padRight: parseFloat(getComputedStyle(row).paddingRight),
        border: `${b.borderTopWidth} ${b.borderTopStyle}`,
        shadow: b.boxShadow,
        radius: parseFloat(b.borderRadius),
        gap: Math.round(actions.getBoundingClientRect().left - title.getBoundingClientRect().right),
        // The detail line is not under the actions, so it must keep the width
        // the row reserves for them (it used to clip at "pid 175").
        subWider: row.querySelector(".row-sub").clientWidth > title.clientWidth,
      };
    });
    check("E25b row actions are plain outlined buttons",
      acts25.bgImage === "none" && acts25.bg === "rgba(0, 0, 0, 0)" && acts25.padRight >= 66 &&
        acts25.border === "1px solid" && acts25.shadow === "none" && acts25.radius >= 4 && acts25.gap >= 0 &&
        acts25.subWider,
      JSON.stringify(acts25));

    // ── E26 favourites render once, toggle by star (R-6) ─────────────
    // Keys are `dirName/file`: starring the fixture must neither duplicate
    // it nor star the fork (the old `filePath` key was `undefined` for both).
    // This group needs its own second session — the old linear flow inherited
    // one from the tab test, and favourites are only meaningful with 2 rows.
    const fork26 = await jsonFetch(`${hub.url}/api/sessions/fork`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" } });
    const fork2File = (await fork26.json()).file;
    await jsonFetch(`${hub.url}/api/sessions/rename`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: fork2File, name: "Second session" } });
    await page.evaluate(() => window.location.reload());
    await ready(page);

    const favRow = page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first();
    await favRow.hover();
    await favRow.locator(".fav-btn").click();
    await page.waitForTimeout(200);
    const dupeCount = await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').count();
    const firstLabel = await page.evaluate(() => [...document.querySelectorAll("#session-list .section-label")].map((s) => s.textContent.trim())[0]);
    check("E26 favourited session renders once, under Favourites", dupeCount === 1 && firstLabel === "Favourites", `rows=${dupeCount} first=${firstLabel}`);
    const otherRow = page.locator(`#session-list .sb-row[data-session-file="${fork2File}"]`);
    await otherRow.first().hover();
    check("E26b favourite keys are per-session", (await otherRow.count()) === 1
      && ((await otherRow.first().locator(".fav-btn").getAttribute("aria-pressed")) === "false"));
    const onlyRow = page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first();
    await onlyRow.hover();
    await onlyRow.locator(".fav-btn").click();
    await page.waitForTimeout(200);
    check("E26c unstarring returns it to the group", (await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').count()) >= 1
      && (await page.evaluate(() => [...document.querySelectorAll("#session-list .section-label")].map((s) => s.textContent.trim()).includes("Favourites"))) === false);

    // ── E28 wrap toggle persists (R-8) ────────────────────────────────
    await page.click("#settings-btn");
    await page.waitForSelector("#settings:not(.hidden)", { timeout: 10000 });
    await page.locator('.settings-tabs .tab-btn[data-tab="chat"]').click();
    await page.locator("#toggle-wrap").check();
    await page.waitForFunction(() => document.documentElement.dataset.wrapCode === "1", null, { timeout: 5000 });
    check("E28 wrap toggle flips the document flag", true);
    await page.click("#settings-close");
    await page.evaluate(() => window.location.reload());
    await ready(page);
    check("E28b wrap pref persists across reload", (await page.evaluate(() => document.documentElement.dataset.wrapCode)) === "1");

  } finally {
    await close();
  }
}

async function detailGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E29 code blocks carry lang + working Copy (R-9) ───────────────
    // Fresh context per group: bind the fixture before asserting on the
    // transcript (the old linear flow inherited a tab from earlier steps).
    await openFixture(page);
    const fenceId = `e29-${Date.now().toString(36)}`;
    const fenceLine = JSON.stringify({
      type: "message", id: fenceId, parentId: "a0000029", timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "Here is the snippet:\n\n```js\nconst answer = 42;\n```" }], timestamp: Date.now() },
    });
    // E31 companion: an edit toolCall whose absolute path the card must shorten.
    const toolLine = JSON.stringify({
      type: "message", id: `e31-${Date.now().toString(36)}`, parentId: fenceId, timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-e31", name: "edit", arguments: { path: "/tmp/pihub-fixtures/e31-target.ts" } }], timestamp: Date.now() },
    });
    fs.appendFileSync(path.join(sessions, "--tmp-pihub-fixtures--", "2026-01-01T00-00-00Z_fixture.jsonl"), `${fenceLine}\n${toolLine}\n`);
    await page.evaluate(() => window.location.reload());
    await ready(page);
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.waitForSelector("#messages .code-head", { timeout: 30000 });
    const codeLang = ((await page.textContent("#messages .code-head .code-lang")) || "").trim();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator("#messages .code-copy").first().click();
    await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    const copyToast = (await page.textContent("#toast")) || "";
    check("E29 code blocks carry lang + working Copy", codeLang === "js" && (clip.includes("const answer = 42") || copyToast.includes("Copied")), `lang=${codeLang} clip=${clip.slice(0, 30)} toast=${copyToast.slice(0, 20)}`);

    // ── E30 over-budget pill offers compact; healthy pill stays inert ──
    // The fixture sips context, so the pill must be a disabled readout:
    // forcing a click still opens nothing (the handler guards too).
    const ctxChip = page.locator("#context-chip");
    await ctxChip.waitFor({ timeout: 20000 });
    check("E30 context pill inert at healthy usage", await ctxChip.isDisabled());
    await ctxChip.click({ force: true });
    await page.waitForTimeout(200);
    check("E30b no compact dialog from an inert pill", (await page.locator("#dialog-container .dialog-card").count()) === 0);

    // ── E31 tool hints shorten session paths ──────────────────────────
    await page.waitForSelector('#messages .tool[data-tool-name="edit"] .tool-hint', { timeout: 15000 });
    const toolHint = ((await page.textContent('#messages .tool[data-tool-name="edit"] .tool-hint')) || "").trim();
    check("E31 tool hints shorten session paths", toolHint === "e31-target.ts", toolHint.slice(0, 60));

    // ── E32 touch: titles must not run under the row actions ──────────
    // Always-visible row actions on (hover:none) used to overlay the title
    // (clipped mid-word); the row now reserves space so the title ellipsizes.
    await jsonFetch(`${hub.url}/api/sessions/rename`, {
      method: "POST",
      body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", name: "A deliberately long session title that must ellipsize cleanly" },
    });
    const touch32 = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    touch32.on("pageerror", (e) => pageErrors.push(`touch32: ${e.message}`));
    await touch32.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(touch32);
    await touch32.click("#sidebar-toggle");
    await touch32.waitForFunction(() => document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    // The class lands before the drawer's transform transition runs; wait for
    // real geometry so the measurement is not taken at translateX(-102%).
    await touch32.waitForFunction(() => {
      const row = document.querySelector('#session-list .sb-row[data-session-file$="fixture.jsonl"]');
      return !!row && row.getBoundingClientRect().left >= 0;
    }, null, { timeout: 5000 });
    const geo = await touch32.evaluate(() => {
      const row = document.querySelector('#session-list .sb-row[data-session-file$="fixture.jsonl"]');
      if (!row) return null;
      const title = row.querySelector(".row-title");
      const grow = row.querySelector(".row-title .grow");
      const actions = row.querySelector(".row-actions");
      const t = title.getBoundingClientRect();
      const a = actions.getBoundingClientRect();
      return {
        overlap: Math.round(Math.max(0, Math.min(t.right, a.right) - Math.max(t.left, a.left))),
        titleRight: Math.round(t.right),
        actionsLeft: Math.round(a.left),
        truncated: grow.scrollWidth > grow.clientWidth + 1,
      };
    });
    check("E32 touch titles clear the row actions", !!geo && geo.overlap === 0 && geo.titleRight <= geo.actionsLeft + 1 && geo.truncated, JSON.stringify(geo));
    await touch32.screenshot({ path: path.join(hub.dir, "e2e-touch-rows.png") });
    await touch32.close();

    // ── E33 titles everywhere, file names nowhere (UX-12) ─────────────
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { localStorage.removeItem("pi-hub-tabs"); location.hash = ""; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);
    await page.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.waitForFunction(() => {
      const t = document.querySelector("#cs-name")?.textContent || "";
      return t.trim().length > 0 && !t.includes(".jsonl");
    }, null, { timeout: 30000 });
    const titleCard = ((await page.textContent("#cs-name")) || "").trim();
    const titleTab = ((await page.textContent("#tab-strip .tab.active .tab-title")) || "").trim();
    check("E33 tab + card show the session title, never the file",
      titleCard === titleTab && !titleCard.includes(".jsonl") && titleCard.length > 0,
      `card=${titleCard} tab=${titleTab}`);

    // ── E34 the live TUI block is on the home screen, on top (UX-13) ──
    const mirror34 = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      await page.locator("#home-btn").click();
      await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 15000 });
      await page.waitForSelector("#welcome-live .welcome-live-row", { timeout: 30000 });
      const liveRow = (await page.textContent("#welcome-live")) || "";
      check("E34 home shows a Live terminals block", /live terminals/i.test(liveRow) && /pid \d+/.test(liveRow), liveRow.replace(/\s+/g, " ").slice(0, 90));
      check("E34a live rows show a name, never a file name", !liveRow.includes(".jsonl"), liveRow.replace(/\s+/g, " ").slice(0, 90));
      // above the session list in the sidebar, and visible with the drawer closed
      const order = await page.evaluate(() => {
        const live = document.querySelector("#live-section")?.getBoundingClientRect().top ?? Infinity;
        const vtabs = document.querySelector("#vtabs-section")?.getBoundingClientRect().top ?? Infinity;
        const list = document.querySelector("#session-list")?.getBoundingClientRect().top ?? Infinity;
        return { liveBeforeTabs: live <= vtabs, liveBeforeList: live <= list };
      });
      check("E34b sidebar lists live terminals above every other block", order.liveBeforeTabs && order.liveBeforeList, JSON.stringify(order));
      // open it → still visible in the block while also open in a tab
      await page.locator("#welcome-live .welcome-live-row .welcome-live-main").first().click();
      await page.waitForFunction(() => /Read-only preview/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 30000 });
      check("E34c home row opens the read-only preview", true);
      const liveTabTitle = ((await page.textContent("#tab-strip .tab.active .tab-title")) || "").trim();
      check("E34c2 live tab shows a name, never a file name", liveTabTitle.length > 0 && !liveTabTitle.includes(".jsonl"), liveTabTitle);
      await page.locator("#home-btn").click();
      await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 15000 });
      await page.waitForSelector("#welcome-live .welcome-live-row", { timeout: 15000 });
      check("E34d live stays listed while open in a tab", (await page.locator("#welcome-live .welcome-live-row").count()) >= 1);
      const sidebarLive = (await page.textContent("#live-section")) || "";
      check("E34e sidebar live row never shows the file name either", !sidebarLive.includes(".jsonl"), sidebarLive.replace(/\s+/g, " ").slice(0, 80));
      await page.screenshot({ path: path.join(hub.dir, "e2e-home-live.png") });
    } finally {
      await mirror34.close();
    }

    // ── E36 one tab per session across lists (R-12) ─────────────────────
    // Opening a session from the backend list used to mint a runner-keyed tab
    // next to the file-keyed one; both lists must converge on one tab.
    const fork36 = await jsonFetch(`${hub.url}/api/sessions/fork`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" } });
    const fork36File = (await fork36.json()).file;
    await jsonFetch(`${hub.url}/api/sessions/rename`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: fork36File, name: "Single tab session" } });
    await page.evaluate(() => { localStorage.removeItem("pi-hub-tabs"); location.hash = ""; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);
    await page.locator(`#session-list .sb-row[data-session-file="${fork36File}"]`).first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    const startTabs = await page.locator("#tab-strip .tab").count();
    const startFileTabs = await page.locator(`#tab-strip .tab[data-tab-key*="${fork36File}"]`).count();
    await page.locator(`#tab-strip .tab[data-tab-key*="${fork36File}"] .tab-close`).click();
    await page.waitForFunction(() => document.body.dataset.view === "welcome", null, { timeout: 20000 });
    const r36 = (await (await fetch(`${hub.url}/api/runners`)).json()).runners.find((r) => (r.absFile || "").endsWith(fork36File));
    await page.locator(`#live-section .sb-row[data-runner-id="${r36?.id}"]`).first().waitFor({ timeout: 15000 });
    await page.locator(`#live-section .sb-row[data-runner-id="${r36?.id}"]`).first().click();
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    const tabsFromBackend = await page.locator("#tab-strip .tab").count();
    const backendFileTabs = await page.locator(`#tab-strip .tab[data-tab-key*="${fork36File}"]`).count();
    await page.locator(`#session-list .sb-row[data-session-file="${fork36File}"]`).first().click();
    await page.waitForTimeout(200);
    const listFileTabs = await page.locator(`#tab-strip .tab[data-tab-key*="${fork36File}"]`).count();
    check("E36 one tab per session across lists",
      startFileTabs === 1 && backendFileTabs === 1 && listFileTabs === 1 && tabsFromBackend === startTabs,
      `start=${startFileTabs} backend=${backendFileTabs} list=${listFileTabs} tabs=${tabsFromBackend}/${startTabs}`);

    // ── E37 chrome details: one icon per control, real hit areas, aligned ──
    const ui37 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    ui37.on("pageerror", (e) => pageErrors.push(`ui37: ${e.message}`));
    await ui37.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(ui37);
    await ui37.waitForTimeout(200);
    const iconCount = await ui37.evaluate(() => document.querySelectorAll("#sidebar-collapse .icon").length);
    check("E37 sidebar collapse renders one icon", iconCount === 1, `icons=${iconCount}`);
    // The chevron sits *inside* the sidebar, so on desktop it must collapse the
    // column (it used to only clear the mobile drawer flag and did nothing).
    await ui37.click("#sidebar-collapse");
    await ui37.waitForFunction(() => getComputedStyle(document.querySelector("#sidebar")).display === "none", null, { timeout: 5000 })
      .then(() => {}, () => {});
    const hidden37 = await ui37.evaluate(() => ({
      display: getComputedStyle(document.querySelector("#sidebar")).display,
      expanded: document.querySelector("#sidebar-toggle").getAttribute("aria-expanded"),
    }));
    check("E37e desktop chevron collapses the sidebar", hidden37.display === "none", `display=${hidden37.display}`);
    check("E37f collapsed state is reflected on the toggle", hidden37.expanded === "false", `aria-expanded=${hidden37.expanded}`);
    // The titlebar is visible exactly while the sidebar is collapsed; its text
    // must sit on the bar's centre line (asymmetric padding used to push it low).
    const tb37 = await ui37.evaluate(() => {
      const t = document.querySelector("#titlebar");
      const title = document.querySelector("#tb-title");
      const cs = getComputedStyle(t);
      const tr = t.getBoundingClientRect();
      const rr = title.getBoundingClientRect();
      return {
        padTop: parseFloat(cs.paddingTop),
        padBottom: parseFloat(cs.paddingBottom),
        off: Math.abs(rr.top - tr.top + rr.height / 2 - tr.height / 2),
      };
    });
    check("E37h titlebar text is vertically centred", tb37.padTop === tb37.padBottom && tb37.off <= 1, JSON.stringify(tb37));
    // ── E37i the settings button shows a gear, not the theme/sun glyph ──
    // The registry entry named `gear` used to be a sun with rays, so the
    // Settings control read as a theme/brightness toggle.
    const gearSvg = await ui37.evaluate(() => document.querySelector("#settings-btn svg")?.innerHTML || "");
    check("E37i settings button draws a real gear",
      /<circle cx="12" cy="12" r="3">/.test(gearSvg) && !/M12 2v3/.test(gearSvg),
      gearSvg.slice(0, 70));
    await ui37.click("#sidebar-toggle");
    await ui37.waitForFunction(() => getComputedStyle(document.querySelector("#sidebar")).display !== "none", null, { timeout: 5000 })
      .then(() => {}, () => {});
    const back37 = await ui37.evaluate(() => ({
      display: getComputedStyle(document.querySelector("#sidebar")).display,
      expanded: document.querySelector("#sidebar-toggle").getAttribute("aria-expanded"),
      title: document.querySelector("#sidebar-toggle").title,
    }));
    check("E37g the toggle brings the sidebar back", back37.display !== "none" && back37.expanded === "true" && /hide/i.test(back37.title),
      JSON.stringify(back37));
    await ui37.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await ui37.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await ui37.waitForSelector("#tab-strip .tab .tab-close", { timeout: 15000 });
    const closeBox = await ui37.evaluate(() => {
      const r = document.querySelector("#tab-strip .tab .tab-close").getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check("E37b tab close has a usable hit area", closeBox.w >= 20 && closeBox.h >= 20, JSON.stringify(closeBox));
    await ui37.waitForSelector(".load-earlier-wrap button", { timeout: 20000 });
    const align = await ui37.evaluate(() => {
      const wrap = document.querySelector(".load-earlier-wrap");
      const btn = wrap.querySelector("button").getBoundingClientRect();
      const list = document.querySelector("#messages").getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      return { wrapLeft: Math.round(w.left), listLeft: Math.round(list.left), btnOffset: Math.round(btn.left - w.left), paneLeft: Math.round(document.querySelector("#view").getBoundingClientRect().left) };
    });
    check("E37c load-earlier aligns with the transcript column",
      Math.abs(align.wrapLeft - align.listLeft) <= 2 && align.btnOffset <= 24, JSON.stringify(align));
    await ui37.close();

    const phone37 = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    phone37.on("pageerror", (e) => pageErrors.push(`phone37: ${e.message}`));
    // Open by hash: at 390px the sidebar is off-canvas, so clicking a row would
    // sit in Playwright's actionability wait (30s) before ever binding.
    await phone37.goto(`${hub.url}/hub/#s=--tmp-pihub-fixtures--/2026-01-01T00-00-00Z_fixture.jsonl`, { waitUntil: "domcontentloaded" });
    await ready(phone37);
    await phone37.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 30000 });
    const sizes = await phone37.evaluate(() => {
      const send = document.querySelector("#send-btn").getBoundingClientRect();
      const mic = document.querySelector("#mic-btn").getBoundingClientRect();
      const foot = document.querySelector(".composer-footer").getBoundingClientRect();
      const form = document.querySelector("#composer").getBoundingClientRect();
      return { send: Math.round(send.width), mic: Math.round(mic.width), overflow: Math.round(foot.right - form.right), pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    check("E37d phone composer sized without overflow", sizes.send >= 34 && sizes.mic >= 30 && sizes.overflow <= 0 && sizes.pageOverflow === 0, JSON.stringify(sizes));
    await phone37.close();

  } finally {
    await close();
  }
}

async function deadCwdGroup({ check, log }) {
  const { hub, browser, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    // ── E39 (R-10) dead-cwd resume: ask, then continue somewhere real ─────
    // pi refuses to switch to a session whose stored cwd is gone (its TUI
    // shows a Continue/Cancel prompt), so the hub must ask too and relocate.
    const goneDir = path.join(hub.dir, "gone-project");
    const goneProject = "--" + goneDir.replace(/^\//, "").replace(/\//g, "-") + "--";
    fs.mkdirSync(path.join(sessions, goneProject), { recursive: true });
    const deadLines = [
      JSON.stringify({ type: "session", version: 3, id: "dead-cwd-1", timestamp: new Date().toISOString(), cwd: goneDir }),
      JSON.stringify({ type: "message", id: "d1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "survived from a vanished folder" }] } }),
      "",
    ].join("\n");
    const deadFile = path.join(sessions, goneProject, "dead-cwd.jsonl");
    fs.writeFileSync(deadFile, deadLines);
    const deadPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    deadPage.on("pageerror", (e) => pageErrors.push(`dead: ${e.message}`));
    await deadPage.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(deadPage);
    await deadPage.waitForSelector('#session-list .sb-row[data-session-file$="dead-cwd.jsonl"]', { timeout: 20000 });
    await deadPage.locator('#session-list .sb-row[data-session-file$="dead-cwd.jsonl"]').first().click();
    await deadPage.waitForSelector("#dialog-container .dialog-card", { timeout: 20000 });
    const cwdPrompt = (await deadPage.textContent("#dialog-container")) || "";
    check("E39 missing cwd asks before binding (native pi wording)",
      cwdPrompt.includes("Session cwd not found") && cwdPrompt.includes(goneDir) && cwdPrompt.includes(PKG_ROOT),
      cwdPrompt.slice(0, 160));
    const copiesBefore = fs.readdirSync(path.join(sessions, goneProject)).length;
    check("E39b nothing bound and no copy written while the question is open",
      (await deadPage.evaluate(() => document.body.dataset.view)) !== "session" && copiesBefore === 1,
      `view=${await deadPage.evaluate(() => document.body.dataset.view)} files=${copiesBefore}`);
    await deadPage.getByRole("button", { name: "Continue" }).click();
    await deadPage.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await deadPage.waitForFunction(() => (document.querySelector("#messages")?.textContent || "").includes("survived from a vanished folder"), null, { timeout: 30000 });
    check("E39c continued copy keeps the transcript", true);
    const afterFiles = fs.readdirSync(path.join(sessions, goneProject));
    check("E39d relocation wrote a copy, never edited the original",
      afterFiles.length === copiesBefore + 1 && fs.readFileSync(deadFile, "utf8") === deadLines,
      afterFiles.join(","));
    const relocFile = afterFiles.filter((f) => f !== "dead-cwd.jsonl")[0];
    check("E39e the copy stores the hub cwd",
      JSON.parse(fs.readFileSync(path.join(sessions, goneProject, relocFile), "utf8").split("\n")[0]).cwd === PKG_ROOT,
      relocFile);
    check("E39f the client shows the live cwd, not the dead one",
      !((await deadPage.evaluate(() => document.querySelector("#cs-cwd")?.textContent || ""))).includes("gone-project"));
    await deadPage.close();
    // Cancel path: no bind, no copy, nothing written.
    const cancelPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await cancelPage.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(cancelPage);
    await cancelPage.locator('#session-list .sb-row[data-session-file$="dead-cwd.jsonl"]').first().click();
    await cancelPage.waitForSelector("#dialog-container .dialog-card", { timeout: 20000 });
    await cancelPage.getByRole("button", { name: "Cancel" }).click();
    await cancelPage.waitForTimeout(200);
    check("E39g Cancel binds nothing",
      (await cancelPage.evaluate(() => document.body.dataset.view)) !== "session" &&
        fs.readdirSync(path.join(sessions, goneProject)).length === afterFiles.length,
      await cancelPage.evaluate(() => document.body.dataset.view));
    await cancelPage.close();
    fs.rmSync(path.join(sessions, goneProject), { recursive: true, force: true });
  } finally {
    await close();
  }
}

async function steerGroup({ check, log }) {
  // ── E38 (R-3) mid-run messages steer once, never twice ────────────────
  // A real pi child, a fake model that holds its stream open: type while the
  // run is in flight and then count how many times the model saw the text.
  {
    const pageErrors = [];
    const fakeHub = await startHub({ port: await freePort(), sessionDir: fixtureSessionDir() });
    const fakeBrowser = await launchBrowser();
    try {
      const page = await fakeBrowser.newPage({ viewport: { width: 1400, height: 950 } });
      page.on("pageerror", (e) => pageErrors.push(`steer: ${e.message}`));
      await page.goto(`${fakeHub.url}/hub/`, { waitUntil: "domcontentloaded" });
      await ready(page);
      await page.click("#new-session-btn");
      await page.waitForSelector("#picker:not(.hidden)", { timeout: 15000 });
      await page.click("#picker-start");
      await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 30000 });

      await setLlmHold(1500); // the "model" stays busy while we type
      await page.fill("#input", "START-E38");
      await page.click("#send-btn");
      await page.waitForFunction(() => !document.querySelector("#abort-btn").classList.contains("hidden"), null, { timeout: 20000 });
      const steerPlaceholder = (await page.getAttribute("#input", "placeholder")) || "";
      check("E38 running composer explains Enter vs Alt+Enter", steerPlaceholder.includes("Enter steers"), steerPlaceholder);
      await waitFor(async () => (await llmMentioning("START-E38")).length >= 1, { timeoutMs: 20000, what: "first model call" });

      await page.fill("#input", "STEER-E38");
      await page.click("#send-btn");
      await page.waitForSelector(".queue .q-pill.steer", { timeout: 10000 });
      check("E38b steering pill comes from pi's queue_update", ((await page.textContent(".queue .q-pill.steer")) || "").includes("STEER-E38"));
      await page.fill("#input", "LATER-E38");
      await page.keyboard.press("Alt+Enter");
      await page.waitForSelector(".queue .q-pill.later", { timeout: 10000 });
      check("E38c Alt+Enter queues a follow-up", ((await page.textContent(".queue .q-pill.later")) || "").includes("LATER-E38"));

      await setLlmHold(0);
      await page.waitForFunction(() => document.querySelector("#abort-btn").classList.contains("hidden"), null, { timeout: 40000 });
      await waitFor(async () => (await llmMentioning("LATER-E38")).length >= 1, { timeoutMs: 20000, what: "follow-up delivered" });
      const steerCopies = await llmCopiesInLastRequest("STEER-E38");
      const laterCopies = await llmCopiesInLastRequest("LATER-E38");
      check("E38d steering text sits in the conversation exactly once", steerCopies === 1, `copies=${steerCopies}`);
      check("E38e run end does not replay the queue", steerCopies === 1 && laterCopies === 1, `steer=${steerCopies} later=${laterCopies}`);
      check("E38f queue pills clear with the run", (await page.locator(".queue .q-pill").count()) === 0);

      // Abort behaves like pi's Esc: queued text goes back to the editor.
      await setLlmHold(1500);
      await page.fill("#input", "SECOND-E38");
      await page.click("#send-btn");
      await page.waitForFunction(() => !document.querySelector("#abort-btn").classList.contains("hidden"), null, { timeout: 20000 });
      await waitFor(async () => (await llmMentioning("SECOND-E38")).length >= 1, { timeoutMs: 20000, what: "second run" });
      await page.fill("#input", "KEEP-E38");
      await page.click("#send-btn");
      await page.waitForSelector(".queue .q-pill.steer", { timeout: 10000 });
      await page.click("#abort-btn");
      await page.waitForFunction(() => (document.querySelector("#input")?.value || "").includes("KEEP-E38"), null, { timeout: 20000 });
      check("E38g abort returns queued text to the editor", true);
      await setLlmHold(0);
      await page.waitForFunction(() => document.querySelector("#abort-btn").classList.contains("hidden"), null, { timeout: 30000 }).catch(() => {});
      check("E38h aborted steering never reaches the model", (await llmMentioning("KEEP-E38")).length === 0, `calls=${(await llmMentioning("KEEP-E38")).length}`);
      await page.close();
    } finally {
      await setLlmHold(0);
      await fakeBrowser.close();
      await fakeHub.close();
    }
  }

}

async function authGroup({ check, log }) {
  // ── E14 auth ──────────────────────────────────────────────────────────
  const secure = await startHub({ port: await freePort(), env: { PI_HUB_USER: "tau", PI_HUB_PASS: "tpass" }, sessionDir: fixtureSessionDir() });
  try {
    const authBrowser = await launchBrowser();
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

}
