/**
 * ui-parity — A/B screenshot harness: boots tau-web (baseline) and pi-hub
 * (candidate) against copies of the same fixture session store, captures the
 * welcome + resumed-session views in Chrome, and writes PNGs for visual
 * comparison. Used during the clean-room UI rebuild; keep it around for
 * visual-regression checks after CSS/layout changes.
 *
 *   node tests/ui-parity.mjs [outDir]     # default: <tmp>/pi-hub-ui-parity
 *
 * Requires ../tau-web (sibling package) and playwright-core. The output is not
 * diffed numerically: screenshots are meant to be looked at side by side.
 */
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPi, fixtureSessionDir, freePort, killTree, startHub, waitFor } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tauDir = path.resolve(here, "..", "..", "tau-web");
const outDir = process.argv[2] || path.join(os.tmpdir(), "pi-hub-ui-parity");

export async function runUiParity({ log = console.log } = {}) {
  if (!fs.existsSync(path.join(tauDir, "package.json"))) {
    throw new Error(`tau-web not found at ${tauDir} — the parity harness needs the sibling package`);
  }
  const shots = {};
  const browser = await chromium.launch({ channel: "chrome", headless: true }).catch(() => chromium.launch({ headless: true }));

  async function snap(url, prefix) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4500);
    shots[`${prefix}-welcome`] = await page.screenshot();
    // tau-web starts with the sidebar off-canvas; pi-hub shows it on desktop.
    if (await page.evaluate(() => document.getElementById("sidebar")?.classList.contains("collapsed"))) {
      await page.click("#sidebar-toggle");
      await page.waitForTimeout(800);
    }
    const row = page.locator('.session-item[data-file-path$="fixture.jsonl"], .sb-row[data-session-file$="fixture.jsonl"]').first();
    if (await row.count()) {
      await row.click();
      await page.waitForTimeout(7000);
    }
    shots[`${prefix}-resume`] = await page.screenshot();
    await page.close();
  }

  // tau-web baseline
  const tauPort = await freePort();
  const tau = spawn(findPi(), ["-e", tauDir, "--mode", "rpc"], {
    env: { ...process.env, TAU_MIRROR_PORT: String(tauPort), TAU_HOST: "127.0.0.1", PI_HUB_DISABLED: "1", PI_CODING_AGENT_SESSION_DIR: fixtureSessionDir() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  tau.stdout.setEncoding("utf8");
  tau.stderr.setEncoding("utf8");
  let tauOut = "";
  tau.stdout.on("data", (d) => (tauOut += d));
  tau.stderr.on("data", (d) => (tauOut += d));
  tau.stdin.on("error", () => {});
  tau.stdin.write("\n");
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${tauPort}/hub/`)).ok, { timeoutMs: 40000, what: "tau-web ui" });
    await snap(`http://127.0.0.1:${tauPort}/hub/`, "tau");
  } finally {
    killTree(tau);
  }

  // pi-hub candidate
  const hub = await startHub({ port: await freePort(), sessionDir: fixtureSessionDir() });
  try {
    await snap(`${hub.url}/hub/`, "pihub");
  } finally {
    await hub.close();
    await browser.close();
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, buf] of Object.entries(shots)) fs.writeFileSync(path.join(outDir, `${name}.png`), buf);
  log(`ui-parity: wrote ${Object.keys(shots).length} screenshots to ${outDir}`);
  log(`ui-parity: tau-web tail — ${tauOut.trim().split("\n").slice(-1)[0] || "(no output)"}`);
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUiParity().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
