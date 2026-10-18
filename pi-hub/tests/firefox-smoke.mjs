// firefox-smoke — the zero-dependency cross-platform backend (ADR-020).
// System Firefox headless: --dump-dom to wait for data-ready, --screenshot to
// capture. Works on Termux where Playwright's bundled Chromium cannot run.
// Replicates `auto-mate`'s tools/shot.sh pattern.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fixtureSessionDir, freePort, startHub } from "./helpers.mjs";

const run = promisify(execFile);

function firefoxBin() {
  return process.env.FIREFOX_BIN || "firefox";
}

async function firefoxAvailable() {
  // Fast negative: missing binary or a wrapper that cannot answer --version.
  // (A 15s timeout here used to cost every run 10s just to skip.)
  try {
    await run(firefoxBin(), ["--version"], { timeout: 3000 });
  } catch {
    return false;
  }
  // Probe headless DOM rendering with a data URL: some desktop builds hang
  // without a display (Termux builds are the ones ADR-020 targets).
  try {
    const { stdout } = await run(
      firefoxBin(),
      ["--headless", "--no-remote", "--dump-dom", "data:text/html,<h1>pi-hub-probe</h1>"],
      { timeout: 8000, env: { ...process.env, MOZ_HEADLESS: "1" }, maxBuffer: 1024 * 1024 },
    );
    return stdout.includes("pi-hub-probe");
  } catch {
    return false;
  }
}

async function dumpDom(url, timeoutMs = 60000) {
  const { stdout } = await run(firefoxBin(), ["--headless", "--no-remote", "--dump-dom", url], {
    timeout: timeoutMs,
    env: { ...process.env, MOZ_HEADLESS: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function runFirefoxSmoke({ log }) {
  const results = [];
  const check = (name, cond, detail = "") => {
    results.push({ name, ok: !!cond, detail });
    log(`${cond ? "PASS" : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  };

  if (process.env.PI_HUB_NO_FIREFOX === "1" || !(await firefoxAvailable())) {
    results.push({ name: "FC0 firefox available", ok: false, skip: true, detail: "no firefox binary" });
    log("SKIP FC0 system Firefox not available (PI_HUB_NO_FIREFOX=1 to silence)");
    return results;
  }

  const port = await freePort();
  const hub = await startHub({ port, sessionDir: fixtureSessionDir() });
  try {
    // Wait for the SPA to mark itself ready (auto-mate's data-ready loop).
    let dom = "";
    let ready = false;
    for (let i = 0; i < 12; i++) {
      dom = await dumpDom(hub.url);
      if (dom.includes('data-ready="1"')) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    check("FC1 firefox renders the shell to ready", ready, `dom ${dom.length} bytes`);
    check("FC2 session rows rendered", dom.includes("2026-01-01T00-00-00Z_fixture.jsonl") || dom.includes("Fixture session"));
    check("FC3 no server error page", !dom.includes("pi-hub server error"));

    const shot = path.join(hub.dir, "firefox-phone.png");
    await run(firefoxBin(), ["--headless", "--no-remote", `--screenshot=${shot}`, "--window-size=390,844", hub.url], {
      timeout: 120000,
      env: { ...process.env, MOZ_HEADLESS: "1" },
    });
    const size = fs.existsSync(shot) ? fs.statSync(shot).size : 0;
    check("FC4 screenshot captured (phone size)", size > 5000, `${size} bytes`);
  } finally {
    await hub.close();
  }
  return results;
}
