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
      { name: "images", run: imagesGroup },
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
  // The fixture cwd is not a git repo; answer the branch probe so the
  // statusline has something deterministic to render.
  await page.route("**/api/git*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ branch: "feature/hub-branch", root: "/tmp/pihub-fixtures", detached: false }),
    }),
  );
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
    // No speaker labels above bubbles ("You" / "Pi"): alignment and markdown
    // carry the roles, so the labels were pure noise.
    const roleLabels = await page.evaluate(() =>
      [...document.querySelectorAll("#messages .role, #messages .msg-label")].map((n) => n.textContent.trim()));
    check("E2b2 transcript has no You/Pi role labels", roleLabels.length === 0, JSON.stringify(roleLabels));
    // ── E2b3 statusline shows the cwd's git branch ──────────────────────
    // The directory alone made it impossible to tell which branch a session
    // was started on; the branch now sits beside the path.
    await page.waitForFunction(() => (document.querySelector(".cwd-branch-name")?.textContent || "").length > 0, null, { timeout: 10000 });
    const branchUi = await page.evaluate(() => {
      const path = document.querySelector(".cwd-text");
      const b = document.querySelector(".cwd-branch");
      const name = document.querySelector(".cwd-branch-name");
      return {
        name: (name?.textContent || "").trim(),
        hasIcon: !!b?.querySelector("svg"),
        afterPath: !!path && !!b && b.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_PRECEDING,
        title: b?.getAttribute("title") || "",
      };
    });
    check("E2b3 statusline shows the git branch beside the cwd",
      branchUi.name === "feature/hub-branch" && branchUi.hasIcon && branchUi.afterPath && /branch/i.test(branchUi.title),
      JSON.stringify(branchUi));
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
      // The recall control is centred in the transcript column, not pinned left.
      const loadBox = await page.evaluate(() => {
        const wrap = document.querySelector(".load-earlier-wrap");
        const wr = wrap.getBoundingClientRect();
        const cs = getComputedStyle(wrap);
        // Button on its own line, count caption under it, both centred.
        const kids = [...wrap.children].map((n) => {
          const r = n.getBoundingClientRect();
          return { tag: n.tagName, top: Math.round(r.top), left: Math.round(r.left - wr.left), right: Math.round(wr.right - r.right) };
        });
        return { dir: cs.flexDirection, alignItems: cs.alignItems, kids };
      });
      check("E2d1 load-earlier stacks and centres",
        loadBox.dir === "column" && loadBox.alignItems === "center"
        && loadBox.kids.length === 2 && loadBox.kids[0].tag === "BUTTON"
        && loadBox.kids[1].top > loadBox.kids[0].top
        && loadBox.kids.every((k) => Math.abs(k.left - k.right) <= 2),
        JSON.stringify(loadBox));
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
    check("E3a slash palette rows carry a source chip",
      (await page.locator("#slash .item .cmd-source").count()) === slashItems);
    await page.keyboard.press("Escape");
    await page.fill("#input", "");

    // ── E3b the commands button opens commands + skills ─────────────────
    // It used to open the session picker; it must list everything pi reports
    // from get_commands — extension commands, prompt templates and skills —
    // with a source chip each, filtered from a sticky footer.
    await page.click("#command-btn");
    await page.waitForFunction(() => document.querySelectorAll("#command-menu .cmd-item").length > 0, null, { timeout: 20000 });
    const pal3 = await page.evaluate(() => {
      const menu = document.querySelector("#command-menu");
      const items = [...menu.querySelectorAll(".cmd-item")];
      const sources = items.map((i) => (i.querySelector(".cmd-source")?.textContent || "").toLowerCase());
      return {
        pickerHidden: document.querySelector("#picker").classList.contains("hidden"),
        count: items.length,
        sources: [...new Set(sources)],
        allChipped: sources.every(Boolean),
        footLast: menu.lastElementChild === menu.querySelector(".menu-foot") && !!menu.querySelector(".menu-search"),
        probeSkill: items.some((i) => (i.querySelector(".cmd-name")?.textContent || "") === "/skill:hub-probe-skill"),
        probePrompt: items.some((i) => (i.querySelector(".cmd-name")?.textContent || "") === "/hub-probe"),
      };
    });
    check("E3b commands button opens the commands + skills palette",
      pal3.pickerHidden && pal3.count > 0 && pal3.allChipped && pal3.footLast && pal3.probeSkill && pal3.probePrompt &&
        ["skill", "prompt", "command"].every((src) => pal3.sources.includes(src)),
      JSON.stringify(pal3));
    await page.fill("#command-menu .menu-search", "hub-probe-skill");
    await page.waitForFunction(() => document.querySelectorAll("#command-menu .cmd-item").length === 1, null, { timeout: 5000 }).catch(() => {});
    await page.press("#command-menu .menu-search", "Enter");
    await page.waitForFunction(() => document.querySelector("#command-menu").classList.contains("hidden"), null, { timeout: 5000 });
    const picked3 = await page.inputValue("#input");
    check("E3c picking a skill prefills the invocation", picked3 === "/skill:hub-probe-skill ", JSON.stringify(picked3));
    await page.fill("#input", "");

    // ── E3d composer rests two lines tall, controls at the bottom ───────
    // A one-line field read like a search box and left the mic/send floating
    // at the top of a tall box.
    const rest3 = await page.evaluate(() => {
      const input = document.querySelector("#input");
      const ir = input.getBoundingClientRect();
      const sr = document.querySelector("#send-btn").getBoundingClientRect();
      const cr = document.querySelector("#composer").getBoundingClientRect();
      return {
        h: Math.round(ir.height),
        line: parseFloat(getComputedStyle(input).lineHeight),
        sendGap: Math.round(ir.bottom - sr.bottom),
        sendRight: Math.round(cr.right - sr.right),
      };
    });
    check("E3d composer rests two lines tall", rest3.h >= rest3.line * 2 && rest3.h <= rest3.line * 3,
      `h=${rest3.h} line=${Math.round(rest3.line)}`);
    check("E3e send controls sit at the bottom-right of the field",
      Math.abs(rest3.sendGap) <= 10 && rest3.sendRight <= 16, JSON.stringify(rest3));
    await page.fill("#input", "one\ntwo\nthree");
    await page.waitForTimeout(120);
    const grown3 = await page.evaluate(() => Math.round(document.querySelector("#input").getBoundingClientRect().height));
    check("E3f composer grows past its resting height", grown3 > rest3.h + 10, `rest=${rest3.h} grown=${grown3}`);
    await page.fill("#input", "");
    await page.waitForTimeout(120);
    const back3 = await page.evaluate(() => Math.round(document.querySelector("#input").getBoundingClientRect().height));
    check("E3g clearing returns to the resting height, never below", back3 === rest3.h, `rest=${rest3.h} back=${back3}`);

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
    // E4's starter prompt was itself `/ask`, so a DIALOG-YES notice may already
    // be in this transcript — wait for this command's own answer.
    const betaNotice = () => [...document.querySelectorAll("#messages .msg.system.notice")].some((n) => n.textContent.includes("DIALOG-beta"));
    await page.waitForFunction(betaNotice, null, { timeout: 30000 });
    const notice6 = await page.evaluate(() => {
      const node = [...document.querySelectorAll("#messages .msg.system.notice")].find((n) => n.textContent.includes("DIALOG-beta"));
      const bubble = node?.querySelector(".bubble");
      return {
        texts: [...document.querySelectorAll("#messages .msg.system.notice")].map((n) => n.textContent.trim()),
        toastText: document.querySelector("#toast")?.textContent || "",
        toastHidden: document.querySelector("#toast").classList.contains("hidden"),
        // Command/skill output is content, not a dismissible capsule.
        radius: bubble ? parseFloat(getComputedStyle(bubble).borderRadius) : -1,
      };
    });
    check("E6 select answer relayed to the child", notice6.texts.includes("DIALOG-beta"), JSON.stringify(notice6.texts));
    // Extension/skill notifications belong to the session: inline chip, not a
    // toast that vanishes after 2.6s.
    check("E6b extension notices render inline, not as a toast",
      notice6.toastHidden && !notice6.toastText.includes("DIALOG-beta"), JSON.stringify(notice6));
    check("E6b2 notice corners stay modest (no capsule)", notice6.radius > 0 && notice6.radius <= 8, `radius=${notice6.radius}px`);
    await page.waitForTimeout(3200); // longer than a toast's lifetime
    check("E6c the notice is still on screen after a toast would be gone",
      await page.evaluate(betaNotice));

    // …and it goes away when the session is resumed (history re-render).
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);
    await openFixture(page);
    await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length >= 5, null, { timeout: 30000 });
    check("E6d resuming the session drops old notices",
      (await page.locator("#messages .msg.system.notice").count()) === 0);

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
      check("E8 preview banner (read-only)", /Preview/.test(previewText), previewText.replace(/\s+/g, " ").slice(0, 80));
      check("E8b input disabled while previewing", await page.locator("#input").isDisabled());
      await page.getByRole("button", { name: /^Drive/ }).first().click();
      await page.waitForFunction(() => /Driving/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 15000 });
      check("E8c driving enables the composer", !(await page.locator("#input").isDisabled()));
      await page.click("#model-btn");
      await page.waitForFunction(() => document.querySelectorAll("#model-menu .item").length > 0, null, { timeout: 20000 });
      check("E8d relay drive round-trip (model list via TUI)", true);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /Detach/ }).first().click();
      await page.waitForFunction(() => /Preview/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 15000 });
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

    // ── E12d up is disabled at the project root, and only there ─────────
    // It used to consult the server's jail roots (fetched after the first
    // listing), so the same folder could go enabled -> disabled on its own,
    // and any root without nested roots (e.g. the session cwd itself) read as
    // "no way up" even though the server allows it.
    const probeDir = `up-probe-${Date.now().toString(36)}`;
    fs.mkdirSync(`/tmp/pihub-fixtures/${probeDir}`, { recursive: true });
    await page.click("#file-close");
    await page.click("#files-btn");
    await page.waitForSelector("#file-panel:not(.hidden)", { timeout: 10000 });
    const probeRow = page.locator("#file-list .file-row.dir", { hasText: probeDir }).first();
    await probeRow.waitFor({ timeout: 10000 });
    await probeRow.click();
    await page.waitForFunction((d) => (document.querySelector("#file-path")?.textContent || "").endsWith(d), probeDir, { timeout: 10000 });
    const deepState = await page.evaluate(() => ({
      disabled: document.querySelector("#file-up").disabled,
      title: document.querySelector("#file-up").title,
    }));
    check("E12d up is enabled inside the project tree", deepState.disabled === false && /parent/i.test(deepState.title), JSON.stringify(deepState));
    await page.click("#file-up");
    await page.waitForFunction(() => (document.querySelector("#file-path")?.textContent || "") === "/tmp/pihub-fixtures", null, { timeout: 10000 });
    const backState = await page.evaluate(() => ({
      disabled: document.querySelector("#file-up").disabled,
      title: document.querySelector("#file-up").title,
    }));
    await page.waitForTimeout(400); // no late flip once the listing has settled
    const settled = await page.locator("#file-up").isDisabled();
    check("E12e up disables again at the root and stays put",
      backState.disabled === true && settled === true && /project root/i.test(backState.title),
      JSON.stringify({ ...backState, settled }));
    fs.rmSync(`/tmp/pihub-fixtures/${probeDir}`, { recursive: true, force: true });
    await page.click("#file-close");
    await page.click("#settings-btn");
    await page.waitForSelector("#settings:not(.hidden)", { timeout: 10000 });
    const swatches = await page.locator("#theme-grid .theme-swatch").count();
    check("E12b settings exposes themes", swatches === 12, `swatches=${swatches}`);
    const themeGroups = await page.evaluate(() => [...document.querySelectorAll(".theme-group")].map((g) => [g.dataset.scheme, g.querySelectorAll(".theme-swatch").length]));
    check("E12b1 themes are grouped light and dark", JSON.stringify(themeGroups) === JSON.stringify([["light", 6], ["dark", 6]]), JSON.stringify(themeGroups));
    check("E12b2 every theme tile previews its palette",
      (await page.locator(".theme-swatch .theme-preview").count()) === swatches
      && (await page.locator(".theme-swatch .theme-scheme").count()) === swatches);
    // Every tile must map to a real palette: apply it and read the accent.
    const applied = [];
    for (const id of await page.locator(".theme-swatch").evaluateAll((ns) => ns.map((n) => n.dataset.theme))) {
      await page.locator(`.theme-swatch[data-theme="${id}"]`).click();
      applied.push(await page.evaluate(() => ({
        id: document.documentElement.dataset.theme,
        accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        scheme: getComputedStyle(document.documentElement).colorScheme,
      })));
    }
    check("E12b3 all 12 themes apply distinct palettes",
      applied.every((a, i) => a.id === applied[i].id && !!a.accent) && new Set(applied.map((a) => a.accent)).size === 12,
      JSON.stringify(applied.map((a) => `${a.id}:${a.accent}`)));
    check("E12b4 themes declare their color scheme",
      applied.filter((a) => a.scheme === "light").length === 6 && applied.filter((a) => a.scheme === "dark").length === 6,
      JSON.stringify(applied.map((a) => a.scheme)));
    // theme-boot (head script, runs before the app) decides the pre-CSS
    // color-scheme from its own list; it must match what tokens.css declares.
    const schemeAgreement = await page.evaluate(async () => {
      const ids = [...document.querySelectorAll(".theme-swatch")].map((n) => n.dataset.theme);
      const out = [];
      for (const id of ids) {
        document.documentElement.dataset.theme = id;
        out.push({
          id,
          css: getComputedStyle(document.documentElement).colorScheme,
          boot: window.__piHubIsDark?.(id) ? "dark" : "light",
        });
      }
      return out;
    });
    check("E12b6 theme-boot's dark list matches tokens.css",
      schemeAgreement.every((t) => t.css === t.boot),
      JSON.stringify(schemeAgreement.filter((t) => t.css !== t.boot)));
    const selectedCount = await page.locator('.theme-swatch[aria-selected="true"]').count();
    check("E12b5 exactly one theme reads as selected", selectedCount === 1, `selected=${selectedCount}`);
    await page.locator('.theme-swatch[data-theme="terracotta"]').click();
    // ── E12c settings rails + switches ────────────────────────────────
    const rail = await page.evaluate(() => {
      const nav = document.querySelector(".settings-tabs");
      const cs = getComputedStyle(nav);
      const card = document.querySelector(".settings-card").getBoundingClientRect();
      return { dir: cs.flexDirection, cardW: Math.round(card.width), navW: Math.round(nav.getBoundingClientRect().width) };
    });
    check("E12c1 settings uses a side rail on desktop", rail.dir === "column" && rail.navW < rail.cardW / 3, JSON.stringify(rail));
    await page.locator('.settings-tabs .tab-btn[data-tab="chat"]').click();
    await page.waitForTimeout(150);
    const switchState = await page.evaluate(() => {
      const sw = document.querySelector("#toggle-thinking");
      const cs = getComputedStyle(sw);
      return { checked: sw.checked, appearance: cs.appearance, radius: parseFloat(cs.borderRadius), tag: sw.tagName };
    });
    check("E12c2 prefs are restyled native switches",
      switchState.tag === "INPUT" && switchState.appearance === "none" && switchState.radius > 8,
      JSON.stringify(switchState));
    await page.locator(".field-row", { hasText: "Wrap message code" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.wrapCode === "1", null, { timeout: 5000 });
    check("E12c3 clicking the row toggles its switch", await page.locator("#toggle-wrap").isChecked());
    await page.locator('.settings-tabs .tab-btn[data-tab="server"]').click();
    await page.waitForFunction(() => (document.querySelector("#server-info")?.textContent || "").includes("pi-hub"), null, { timeout: 10000 });
    check("E12c server info renders", true);
    await page.click("#settings-close");
    // ── E12h favouriting the only session keeps it in the list ──────────
    // The Favourites block used to render from inside the project loop: once
    // the sole session was filtered out of its project group the loop skipped
    // it and the star made the whole sidebar list disappear.
    const soleRow = page.locator("#session-list .sb-row").first();
    await soleRow.hover();
    await soleRow.locator(".fav-btn").click();
    await page.waitForTimeout(350);
    const sole = await page.evaluate(() => ({
      rows: document.querySelectorAll("#session-list .sb-row").length,
      labels: [...document.querySelectorAll("#session-list .section-label")].map((s) => s.textContent.trim()),
      pressed: document.querySelector("#session-list .fav-btn")?.getAttribute("aria-pressed"),
      filled: document.querySelector("#session-list .fav-btn svg path")?.getAttribute("fill"),
    }));
    check("E12h a starred sole session stays visible under Favourites",
      sole.rows === 1 && sole.labels[0] === "Favourites" && sole.pressed === "true" && sole.filled === "currentColor",
      JSON.stringify(sole));
    await page.locator("#session-list .fav-btn").click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(hub.dir, "e2e-desktop.png") });

    // ── E13 phone viewport ──────────────────────────────────────────────
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    phone.on("pageerror", (e) => pageErrors.push(`phone: ${e.message}`));
    await phone.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(phone);
    await phone.waitForTimeout(200);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("E13 phone has no horizontal overflow", overflow === 0, `${overflow}px`);
    // ── E13a the scroll area itself has no sideways overflow ────────────
    // `#view` scrolls the transcript; the home screen's recent rows used to
    // paint 29px past its right edge (a detail line reclaiming action space
    // on rows that have no actions), which showed up as a mystery scrollbar.
    const viewX = await phone.evaluate(() => {
      const v = document.querySelector("#view");
      return { over: v.scrollWidth - v.clientWidth, top: v.scrollTop, msgs: document.querySelectorAll("#messages .msg").length };
    });
    check("E13a home has no sideways scroll inside #view", viewX.over === 0, JSON.stringify(viewX));
    await phone.click("#sidebar-toggle");
    await phone.waitForFunction(() => document.body.classList.contains("sidebar-open"), null, { timeout: 5000 });
    await phone.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await phone.waitForFunction(() => !document.body.classList.contains("sidebar-open") && document.body.dataset.view === "session", null, { timeout: 45000 });
    check("E13b drawer closes on session pick", true);
    await phone.screenshot({ path: path.join(hub.dir, "e2e-phone.png") });
    // ── E13b2 a short viewport keeps the welcome at its top ─────────────
    // The transcript's "empty, stick to bottom" render used to scroll the
    // shared pane, so the logo and title were scrolled away on small screens.
    const short = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
    short.on("pageerror", (e) => pageErrors.push(`short: ${e.message}`));
    await short.goto(`${hub.url}/hub/`, { waitUntil: "domcontentloaded" });
    await ready(short);
    await short.waitForTimeout(400);
    const shortView = await short.evaluate(() => {
      const v = document.querySelector("#view");
      const de = document.documentElement;
      const logo = document.querySelector("#welcome-logo")?.getBoundingClientRect();
      return {
        over: v.scrollWidth - v.clientWidth,
        docOver: de.scrollWidth - de.clientWidth,
        top: v.scrollTop,
        logoTop: logo ? Math.round(logo.top) : -1,
        msgs: document.querySelectorAll("#messages .msg").length,
      };
    });
    check("E13b2 short screens keep the welcome at the top, with no overflow",
      shortView.over === 0 && shortView.docOver === 0 && shortView.top === 0 && shortView.logoTop > 46 && shortView.msgs === 0,
      JSON.stringify(shortView));
    await short.close();
    // ── E13c settings on a phone: a sheet with a horizontal tab strip ────
    await phone.click("#settings-btn");
    await phone.waitForSelector("#settings:not(.hidden)", { timeout: 10000 });
    const phoneSettings = await phone.evaluate(() => {
      const nav = document.querySelector(".settings-tabs");
      const card = document.querySelector(".settings-card").getBoundingClientRect();
      return {
        dir: getComputedStyle(nav).flexDirection,
        cardH: Math.round(card.height),
        vh: window.innerHeight,
        cardW: Math.round(card.width),
        vw: window.innerWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    check("E13c settings is a full-height sheet on a phone",
      phoneSettings.dir === "row" && phoneSettings.cardH === phoneSettings.vh
      && phoneSettings.cardW === phoneSettings.vw && phoneSettings.overflow === 0,
      JSON.stringify(phoneSettings));
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
    // 600px is a squeezed tablet (the strip hides only on phones ≤520px).
    await page.setViewportSize({ width: 540, height: 800 });
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
    // Phones (≤520px) drop the strip entirely — the sidebar + titlebar own
    // session identity there, and a clipped strip is unreachable anyway.
    await page.setViewportSize({ width: 480, height: 800 });
    await page.waitForTimeout(250);
    check("E15e2 tab strip hides on phones",
      await page.evaluate(() => getComputedStyle(document.querySelector("#tab-strip")).display === "none"));
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
    // The filter box is the last thing in the menu: it opens upward from the
    // composer, so that is the spot a phone thumb can reach once the keyboard
    // is up (and it must stay last after re-filtering — see E21c).
    const footer19 = await page.evaluate(() => {
      const menu = document.querySelector("#model-menu");
      const foot = menu.querySelector(".menu-foot");
      const search = menu.querySelector(".menu-search");
      const items = [...menu.querySelectorAll(".item")];
      return {
        isLast: menu.lastElementChild === foot && !!search,
        sticky: getComputedStyle(foot).position,
        afterItems: items.length ? Math.round(search.getBoundingClientRect().top - items[items.length - 1].getBoundingClientRect().bottom) : null,
        menuBottom: Math.round(menu.getBoundingClientRect().bottom - search.getBoundingClientRect().bottom),
      };
    });
    check("E19c model filter sits at the bottom of the list",
      footer19.isLast && footer19.sticky === "sticky" && footer19.afterItems >= 0 && footer19.menuBottom <= 12,
      JSON.stringify(footer19));

    // ── E19d a long list must not bury the filter box ───────────────────
    // It is sticky, so it stays on screen while the models scroll underneath
    // (the plain last-child version scrolled out of sight with 40 models).
    await page.evaluate(() => {
      const menu = document.querySelector("#model-menu");
      const foot = menu.querySelector(".menu-foot");
      for (let i = 0; i < 40; i++) {
        const b = document.createElement("button");
        b.className = "item";
        b.type = "button";
        b.textContent = `Padding model ${i}`;
        menu.insertBefore(b, foot);
      }
    });
    const longList = await page.evaluate(async () => {
      const menu = document.querySelector("#model-menu");
      const search = menu.querySelector(".menu-search");
      const inBox = () => {
        const m = menu.getBoundingClientRect();
        const s = search.getBoundingClientRect();
        return s.top >= m.top - 1 && s.bottom <= m.bottom + 1;
      };
      const overflow = menu.scrollHeight > menu.clientHeight;
      const atTop = inBox();
      menu.scrollTop = menu.scrollHeight;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const atBottom = inBox();
      return { overflow, atTop, atBottom, footLast: menu.lastElementChild === menu.querySelector(".menu-foot") };
    });
    check("E19d filter box stays visible over a long model list",
      longList.overflow && longList.atTop && longList.atBottom && longList.footLast, JSON.stringify(longList));
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
    const stillLast21 = await page.evaluate(() => {
      const menu = document.querySelector("#model-menu");
      const foot = menu.lastElementChild;
      return !!foot && foot.classList.contains("menu-foot") && !!foot.querySelector(".menu-search");
    });
    check("E21c re-filtering keeps the box at the bottom", stillLast21);
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
        btnW: Math.round(btn.getBoundingClientRect().width),
        glyph: Math.round(btn.querySelector("svg").getBoundingClientRect().width),
        // the session card's close button is the reference for the language
        closeW: Math.round(parseFloat(getComputedStyle(document.querySelector("#cs-close")).width)),
        closeGlyph: 13,
        gap: Math.round(actions.getBoundingClientRect().left - title.getBoundingClientRect().right),
        // The detail line is not under the actions, so it must keep the width
        // the row reserves for them (it used to clip at "pid 175").
        subWider: row.querySelector(".row-sub").clientWidth > title.clientWidth,
      };
    });
    // Sidebar icons share one treatment: 22px quiet targets, 13px glyph, no
    // painted background, same as #cs-close on the session card.
    check("E25b row actions are quiet, border-free 22px controls",
      acts25.bgImage === "none" && acts25.bg === "rgba(0, 0, 0, 0)" && acts25.padRight >= 66 &&
        acts25.border === "0px none" && acts25.shadow === "none" && acts25.radius >= 4 && acts25.gap >= 0 &&
        acts25.subWider && acts25.btnW === acts25.closeW && acts25.glyph === acts25.closeGlyph,
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
    // ── E26d a starred row shows a filled star ─────────────────────────
    // Both states used the same stroke-only glyph, so a favourited row still
    // looked un-starred and the "Unfavourite" action read as "add to favs".
    const starState = await page.evaluate(() => {
      const read = (file) => {
        const row = document.querySelector(`#session-list .sb-row[data-session-file$="${file}"]`);
        if (!row) return null;
        const btn = row.querySelector(".fav-btn");
        const path = btn?.querySelector("svg path");
        return {
          pressed: btn?.getAttribute("aria-pressed"),
          fill: path?.getAttribute("fill") || "",
          accent: /^rgb\(176, 106, 72\)$|^rgb\(/.test(getComputedStyle(btn).color),
          // no duplicate star in the title line
          titleStar: !!row.querySelector(".row-fav"),
        };
      };
      return { fav: read("fixture.jsonl"), other: read(document.querySelector('#session-list .sb-row[data-fav="0"]')?.dataset.sessionFile || "__none__") };
    });
    const otherStar = await otherRow.first().evaluate((row) => {
      const path = row.querySelector(".fav-btn svg path");
      return { pressed: row.querySelector(".fav-btn").getAttribute("aria-pressed"), fill: path?.getAttribute("fill") || "" };
    });
    check("E26d a starred row shows one filled accent star",
      starState.fav?.pressed === "true" && starState.fav.fill === "currentColor" && !starState.fav.titleStar
      && otherStar.pressed === "false" && otherStar.fill === "none",
      JSON.stringify({ fav: starState.fav, other: otherStar }));
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
    // ── E29a "↓ Latest" stays opaque on hover ─────────────────────────
    // It floats over the transcript; the shared .btn hover is a translucent
    // wash, so hovering turned the pill see-through with text behind it.
    // Force the pseudo-class via CDP: no actionability, no scroll dependency.
    await page.evaluate(() => document.querySelector("#jump-latest").classList.remove("hidden"));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const doc = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#jump-latest" });
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
    const jumpBg = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector("#jump-latest"));
      const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
      const parts = m ? m[1].split(",").map((v) => parseFloat(v)) : [];
      return {
        alpha: parts.length > 3 ? parts[3] : 1,
        tinted: /gradient/.test(cs.backgroundImage),
        shadow: cs.boxShadow !== "none",
      };
    });
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    check("E29a jump-latest stays opaque on hover",
      jumpBg.alpha === 1 && jumpBg.tinted && jumpBg.shadow, JSON.stringify(jumpBg));
    await page.evaluate(() => document.querySelector("#jump-latest").classList.add("hidden"));

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

    // ── E30 context chip opens a small usage card ─────────────────────
    // It used to be a dead readout (enabled only past 90%). Now every state
    // answers "how much of the window is left?" in one click, and the
    // over-budget compact action lives inside the card.
    const ctxChip = page.locator("#context-chip");
    await ctxChip.waitFor({ timeout: 20000 });
    await ctxChip.click();
    await page.waitForSelector("#ctx-pop", { timeout: 5000 });
    const ctx = await page.evaluate(() => {
      const pop = document.querySelector("#ctx-pop");
      const chip = document.querySelector("#context-chip");
      const fill = pop.querySelector(".ctx-fill");
      const pr = pop.getBoundingClientRect();
      const cr = chip.getBoundingClientRect();
      return {
        pct: (pop.querySelector(".ctx-pct")?.textContent || "").trim(),
        chipPct: (chip.textContent || "").trim(),
        rows: [...pop.querySelectorAll(".ctx-row")].map((r) => [r.firstElementChild.textContent, r.lastElementChild.textContent]),
        fillW: Math.round(fill.getBoundingClientRect().width),
        barW: Math.round(fill.parentElement.getBoundingClientRect().width),
        above: pr.bottom <= cr.top,
        expanded: chip.getAttribute("aria-expanded"),
        compact: !!pop.querySelector(".ctx-compact"),
        dialog: document.querySelectorAll("#dialog-container .dialog-card").length,
      };
    });
    check("E30 context chip opens a usage card",
      /ctx/.test(ctx.chipPct) && /%/.test(ctx.pct) && ctx.above && ctx.expanded === "true", JSON.stringify(ctx));
    check("E30b the card shows used, limit and left",
      ctx.rows.length === 3 && ctx.rows[0][0] === "Used" && ctx.rows[1][0] === "Limit" && ctx.rows[2][0] === "Left"
      && /[0-9]/.test(ctx.rows[1][1]) && ctx.rows.every(([, v]) => v !== "?"),
      JSON.stringify(ctx.rows));
    check("E30c the bar reflects the percentage",
      ctx.fillW >= 1 && ctx.fillW <= ctx.barW && ctx.fillW / ctx.barW <= 1, `fill=${ctx.fillW}/${ctx.barW}`);
    check("E30d healthy usage hides the compact action and pops no dialog",
      !ctx.compact && ctx.dialog === 0, JSON.stringify({ compact: ctx.compact, dialog: ctx.dialog }));
    await page.keyboard.press("Escape");
    check("E30e Escape closes the card", (await page.locator("#ctx-pop").count()) === 0
      && (await page.evaluate(() => document.querySelector("#context-chip").getAttribute("aria-expanded"))) === "false");

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
      await page.waitForFunction(() => /Preview/.test(document.querySelector("#banner")?.textContent || ""), null, { timeout: 30000 });
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
    await ui37.locator('#session-list .sb-row[data-session-file$="fixture.jsonl"]').first().click();
    await ui37.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await ui37.waitForSelector("#tab-strip .tab .tab-close", { timeout: 15000 });
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
    // The titlebar must sit on the bar's centre line (asymmetric padding used
    // to push it low) — measured on a real open session, and it has to be
    // visible, otherwise every rect is 0 and the check proves nothing.
    const tb37 = await ui37.evaluate(() => {
      const t = document.querySelector("#titlebar");
      const title = document.querySelector("#tb-title");
      const cs = getComputedStyle(t);
      const tr = t.getBoundingClientRect();
      const rr = title.getBoundingClientRect();
      return {
        shown: cs.display !== "none" && tr.height > 0 && (title.textContent || "").trim().length > 0,
        padTop: parseFloat(cs.paddingTop),
        padBottom: parseFloat(cs.paddingBottom),
        off: Math.abs(rr.top - tr.top + rr.height / 2 - tr.height / 2),
        // One lean line: the bar must stay under the tab bar's 46px.
        height: Math.round(tr.height),
        borderBottom: cs.borderBottomWidth,
        borderColor: cs.borderBottomColor,
        // The bar belongs to the session column, not the whole app: as a
        // full-width sibling it pushed the sidebar down and hid its title.
        x: Math.round(tr.left),
        mainX: Math.round(document.querySelector(".main").getBoundingClientRect().left),
        sidebarW: Math.round(document.querySelector("#sidebar").getBoundingClientRect().width),
        controls: Math.round(document.querySelector("#tb-close").getBoundingClientRect().height),
      };
    });
    check("E37h titlebar is a lean, centred band",
      tb37.shown && tb37.padTop === tb37.padBottom && tb37.off <= 1 && tb37.height <= 34 && tb37.controls <= 26,
      JSON.stringify(tb37));
    check("E37h2 titlebar has a bottom hairline", tb37.borderBottom === "1px" && tb37.borderColor !== "", JSON.stringify({ w: tb37.borderBottom, c: tb37.borderColor }));
    check("E37h3 titlebar lives inside the session column",
      tb37.x === tb37.mainX && tb37.x >= tb37.sidebarW - 1, JSON.stringify({ x: tb37.x, mainX: tb37.mainX, sidebarW: tb37.sidebarW }));
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
      // The title bar is about the open session, not about the sidebar: it
      // must still be there once the sidebar is back.
      titlebar: getComputedStyle(document.querySelector("#titlebar")).display,
      titlebarText: (document.querySelector("#tb-title").textContent || "").trim(),
      tabTitle: (document.querySelector("#tab-strip .tab.active .tab-title")?.textContent || "").trim(),
    }));
    check("E37g the toggle brings the sidebar back", back37.display !== "none" && back37.expanded === "true" && /hide/i.test(back37.title),
      JSON.stringify(back37));
    check("E37j title bar stays visible with the sidebar open",
      back37.titlebar === "flex" && back37.titlebarText.length > 0 && back37.titlebarText === back37.tabTitle,
      `bar="${back37.titlebarText.slice(0, 40)}" tab="${back37.tabTitle.slice(0, 40)}"`);

    // ── E37k scrollbars are themed pills, not the OS bar ────────────────
    // The thumb must take its colour from the theme tokens (so night themes
    // follow) and the 10px gutter must actually be in effect; the standard
    // scrollbar-width/color stay scoped to Firefox, otherwise Chromium drops
    // the rounded pseudo-element styling entirely.
    const sb37 = await ui37.evaluate(() => {
      const found = [];
      const visit = (rules, path) => {
        for (const r of rules) {
          if (r.selectorText && /^::(-webkit|moz)-scrollbar/.test(r.selectorText) || r.selectorText === "*") {
            if (/scrollbar/.test(r.selectorText) || r.style.scrollbarWidth) {
              found.push({ sel: r.selectorText, path, bg: r.style.backgroundColor || "", width: r.style.width || "", std: r.style.scrollbarWidth || "" });
            }
          }
          if (r.cssRules && r.cssRules.length) visit(r.cssRules, path + "/" + r.constructor.name.replace(/^CSS|Rule$/g, ""));
        }
      };
      for (const sheet of document.styleSheets) { try { visit(sheet.cssRules, ""); } catch {} }
      const view = document.querySelector("#view");
      const thumb = found.find((r) => r.sel === "::-webkit-scrollbar-thumb");
      const hover = found.find((r) => r.sel === "::-webkit-scrollbar-thumb:hover");
      const base = found.find((r) => r.sel === "::-webkit-scrollbar");
      const std = found.filter((r) => r.std);
      return {
        thumb: thumb?.bg || "",
        hover: hover?.bg || "",
        width: base?.width || "",
        stdOnlyInSupports: std.length > 0 && std.every((r) => /Supports/.test(r.path)),
        stdCount: std.length,
        gutter: view.offsetWidth - view.clientWidth,
      };
    });
    check("E37k scrollbars are themed and thin",
      /var\(--/.test(sb37.thumb) && /var\(--/.test(sb37.hover) && sb37.width === "10px" &&
        sb37.stdOnlyInSupports && sb37.gutter === 10,
      JSON.stringify(sb37));

    const closeBox = await ui37.evaluate(() => {
      const r = document.querySelector("#tab-strip .tab .tab-close").getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check("E37b tab close has a usable hit area", closeBox.w >= 20 && closeBox.h >= 20, JSON.stringify(closeBox));
    await ui37.waitForSelector(".load-earlier-wrap button", { timeout: 20000 });
    const align = await ui37.evaluate(() => {
      const wrap = document.querySelector(".load-earlier-wrap");
      const list = document.querySelector("#messages").getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      const padL = parseFloat(getComputedStyle(wrap).paddingLeft);
      const padR = parseFloat(getComputedStyle(wrap).paddingRight);
      const kids = [...wrap.children].map((n) => n.getBoundingClientRect());
      return {
        wrapLeft: Math.round(w.left), listLeft: Math.round(list.left),
        leftGap: Math.round(Math.min(...kids.map((k) => k.left)) - (w.left + padL)),
        rightGap: Math.round(w.right - padR - Math.max(...kids.map((k) => k.right))),
        stacked: getComputedStyle(wrap).flexDirection === "column",
        paneLeft: Math.round(document.querySelector("#view").getBoundingClientRect().left),
      };
    });
    // The recall control sits centred under the transcript column.
    check("E37c load-earlier is a centred stack in the transcript column",
      Math.abs(align.wrapLeft - align.listLeft) <= 2 && Math.abs(align.leftGap - align.rightGap) <= 2 && align.stacked,
      JSON.stringify(align));
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
      check("E38b steering pill appears right on send", ((await page.textContent(".queue .q-pill.steer")) || "").includes("STEER-E38"));
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
    // ── E39c the shell never paints behind the sign-in card ─────────────
    // `#app` used to be visible from first paint, so an authenticated hub
    // flashed the whole (themed) shell for a beat before the card appeared.
    const behindCard = await page.evaluate(() => ({
      app: getComputedStyle(document.querySelector("#app")).display,
      login: getComputedStyle(document.querySelector("#login")).display,
    }));
    check("E39c the app shell stays hidden while the sign-in card is up",
      behindCard.app === "none" && behindCard.login !== "none", JSON.stringify(behindCard));
    // ── E39d the theme is applied by the head script, not by app.js ─────
    // Delay app.js and set a dark pref first: the document must already be
    // theme "night" with color-scheme dark before any module has run.
    const fastPage = await authBrowser.newPage({ viewport: { width: 900, height: 700 } });
    await fastPage.route("**/js/app.js*", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await fastPage.goto(`${secure.url}/hub/`, { waitUntil: "commit" });
    await fastPage.evaluate(() => localStorage.setItem("pi-hub-prefs", JSON.stringify({ theme: "night" })));
    await fastPage.reload({ waitUntil: "commit" });
    await fastPage.waitForSelector("body", { timeout: 15000 });
    await fastPage.waitForTimeout(400);
    const early = await fastPage.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      scheme: document.querySelector('meta[name="color-scheme"]').content,
      app: getComputedStyle(document.querySelector("#app")).display,
      appLoaded: !!document.querySelector("#session-list .sb-row, #login:not(.hidden)"),
    }));
    check("E39d a reload paints the saved theme before the app module runs",
      early.theme === "night" && early.scheme === "dark" && early.app === "none",
      JSON.stringify(early));
    await fastPage.close();
    // ── E14e the card is a real sign-in form ────────────────────────────
    const card = await page.evaluate(() => {
      const c = document.querySelector(".login-card");
      const mark = document.querySelector("#login-mark svg");
      const cr = c.getBoundingClientRect();
      const sub = document.querySelector("#login-sub");
      return {
        title: (document.querySelector("#login-title")?.textContent || "").trim(),
        logo: !!mark && mark.getBoundingClientRect().width >= 40,
        fields: document.querySelectorAll(".login-field").length,
        labelled: [...document.querySelectorAll(".login-label")].map((n) => n.textContent.trim()),
        sub: (sub?.textContent || "").trim(),
        centered: Math.abs(cr.left + cr.width / 2 - window.innerWidth / 2) <= 2,
        footGone: !document.querySelector("#login-foot"),
        reveal: !!document.querySelector("#login-reveal svg"),
        errorEmpty: !document.querySelector("#login-error")?.textContent,
      };
    });
    check("E14e the sign-in card carries the logo and labelled fields",
      card.title === "Pi Hub" && card.logo && card.fields === 2 && card.labelled.join() === "User,Password"
      && card.centered && card.footGone && card.reveal && card.errorEmpty, JSON.stringify(card));
    // reveal toggles the field type in both directions
    await page.locator("#login-reveal").click();
    const revealed = await page.evaluate(() => ({
      type: document.querySelector("#login-pass").type,
      pressed: document.querySelector("#login-reveal").getAttribute("aria-pressed"),
    }));
    await page.locator("#login-reveal").click();
    const hidden = await page.evaluate(() => document.querySelector("#login-pass").type);
    check("E14f the password reveal toggles the field",
      revealed.type === "text" && revealed.pressed === "true" && hidden === "password", JSON.stringify({ revealed, hidden }));
    // a rejected sign-in reports it inline, above the button
    await page.fill("#login-user", "tau");
    await page.fill("#login-pass", "wrong-pass");
    await page.click("#login-form button[type=submit]");
    await page.waitForFunction(() => (document.querySelector("#login-error")?.textContent || "").length > 0, null, { timeout: 15000 });
    const rejection = await page.evaluate(() => ({
      err: document.querySelector("#login-error").textContent,
      stillOpen: !document.querySelector("#login").classList.contains("hidden"),
      submit: document.querySelector("#login-submit").textContent,
      disabled: document.querySelector("#login-submit").disabled,
    }));
    check("E14g a wrong password stays on the card with an inline error",
      rejection.stillOpen && /auth/i.test(rejection.err) && rejection.submit === "Sign in" && !rejection.disabled,
      JSON.stringify(rejection));
    await page.fill("#login-user", "tau");
    await page.fill("#login-pass", "tpass");
    await page.click("#login-form button[type=submit]");
    await ready(page);
    const rows = await page.locator("#session-list .sb-row").count();
    const appShown = await page.evaluate(() => getComputedStyle(document.querySelector("#app")).display);
    check("E14b login reaches the app with sessions", rows >= 1 && appShown === "flex", `rows=${rows} app=${appShown}`);
    await authBrowser.close();
  } finally {
    await secure.close();
  }

}

/**
 * Images (X1/R9 + the WS attachment budget): history blocks are normalized
 * (missing mimeType and `data:` URLs are legacy-valid, SVG is not), and the
 * composer downscales big photos so a send can never exceed the 2 MB frame
 * cap that closes socket 1009.
 */
async function imagesGroup({ check, log }) {
  const { hub, page, sessions, pageErrors, close } = await bootCore({ log });
  try {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const project = "--tmp-pihub-fixtures--";
    const file = "images-normalize.jsonl";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "img-1", timestamp: new Date().toISOString(), cwd: "/tmp/pihub-fixtures" }),
      JSON.stringify({
        type: "message",
        id: "im1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [
            { type: "text", text: "four image blocks, three valid" },
            { type: "image", mimeType: "image/png", data: PNG }, // explicit mime
            { type: "image", data: PNG }, // legacy: no mimeType -> png
            { type: "image", mimeType: "image/png", data: `data:image/png;base64,${PNG}` }, // data URL
            { type: "image", mimeType: "image/svg+xml", data: PNG }, // rejected
          ],
        },
      }),
      "",
    ].join("\n");
    fs.mkdirSync(path.join(sessions, project), { recursive: true });
    fs.writeFileSync(path.join(sessions, project, file), lines);

    await page.goto(`${hub.url}/hub/#s=${project}/${file}`, { waitUntil: "domcontentloaded" });
    await ready(page);
    await page.waitForFunction(() => document.body.dataset.view === "session", null, { timeout: 45000 });
    await page.waitForFunction(() => (document.querySelectorAll("#messages img").length || 0) >= 3, null, { timeout: 30000 });
    const rendered = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll("#messages img")];
      return { count: imgs.length, srcs: imgs.map((i) => (i.getAttribute("src") || "").slice(0, 22)) };
    });
    check("E41 history images render (explicit mime, missing mime, data URL)", rendered.count === 3, JSON.stringify(rendered.srcs));
    check("E41b SVG history block is dropped", rendered.srcs.every((s) => !s.includes("svg")), JSON.stringify(rendered.srcs));

    // Attachment budget: a noisy 2200×1600 image is far bigger than the
    // per-image cap, so it must arrive downscaled (and webp/jpeg, not png).
    const picked = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 2200;
      canvas.height = 1600;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255;
        img.data[i + 1] = Math.random() * 255;
        img.data[i + 2] = Math.random() * 255;
        img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const f = new File([blob], "noisy.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(f);
      const input = document.getElementById("image-input");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { bytes: f.size };
    });
    await page.waitForFunction(() => [...document.querySelectorAll("img[src^='data:image/']")].some((i) => (i.getAttribute("src") || "").length > 1000), null, { timeout: 20000 });
    const chip = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll("img[src^='data:image/']")].filter((i) => (i.getAttribute("src") || "").length > 1000);
      const src = imgs[imgs.length - 1]?.getAttribute("src") || "";
      return { len: src.length, mime: (/^data:([^;]+)/.exec(src) || [])[1] || "" };
    });
    check("E42 a 2200px photo is downscaled to fit the frame budget", picked.bytes > 640 * 1024 && chip.len <= 660 * 1024, `file=${picked.bytes} b64=${chip.len}`);
    check("E42b downscaled attachments use a supported re-encoded mime", ["image/webp", "image/jpeg"].includes(chip.mime), chip.mime);

    // Unsupported type is refused at pick time with a clear message.
    const before = await page.locator("img[src^='data:image/']").count();
    await page.evaluate(() => {
      const f = new File([new Uint8Array([1, 2, 3])], "vector.svg", { type: "image/svg+xml" });
      const dt = new DataTransfer();
      dt.items.add(f);
      const input = document.getElementById("image-input");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction(() => /unsupported type/i.test(document.querySelector("#toast")?.textContent || ""), null, { timeout: 10000 });
    const after = await page.locator("img[src^='data:image/']").count();
    check("E43 unsupported image type refused at pick time", after === before, `${before} -> ${after}`);

    check("E44 images group kept the client error-free", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
  } finally {
    await close();
  }
}
