// H22 — headless ctx-window polling: the header pill shows the bound
// backend's LIVE (possibly ctx-limit-capped) window, not the static model
// catalog. The stub backend answers get_session_stats with a capped window
// smaller than the catalog entry; selecting the session must settle the pill
// on the live number, and later static refreshes must not overwrite it.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, basePort, assertPortFree, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H22";
export const title = "header ctx pill follows the headless backend's live window";

const DIR_NAME = "--tmp-e2e-history--";
const FILE = "e2e-session.jsonl";
const FILE_PATH = `/tmp/e2e-history/${FILE}`;
// stub-model-05-long-name exists in the stub catalog with contextWindow 105000.
const SESSION_MODEL = "stub-model-05-long-name";
const SESSION_THINKING = "low";
const SERVER_MODEL = "stub-server-own-model";
const SERVER_THINKING = "xhigh";
// Simulated ctx-limit cap: below the catalog's 105k, so any static overwrite
// is visible as the wrong pill.
const CAPPED_WINDOW = 64000;
const LIVE_TOKENS = 32000;

// 60 filler entries so the `?limit=50` windup cannot reach change entries
// (which the stub, like the real hub, keeps out of `entries` — only in meta).
const FILLER = Array.from({ length: 60 }, (_, i) => ({ type: "message", id: `f${i}`, message: { role: "user", content: `filler ${i}` } }));

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({
    port,
    staticDir: PUBLIC_DIR,
    sessions: [{
      path: "/tmp/e2e-history",
      dirName: DIR_NAME,
      sessions: [{
        file: FILE,
        filePath: FILE_PATH,
        name: "History model session",
        timestamp: new Date().toISOString(),
        firstMessage: "history",
      }],
    }],
    sessionFile: { dirName: DIR_NAME, file: FILE, entries: FILLER, model: { id: SESSION_MODEL }, thinkingLevel: SESSION_THINKING },
    serverState: { model: { id: SERVER_MODEL, contextWindow: 200000 }, thinkingLevel: SERVER_THINKING, sessionFile: "/tmp/e2e-other/own.jsonl" },
    headlessContext: { tokens: LIVE_TOKENS, contextWindow: CAPPED_WINDOW },
  });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ width: 1280, height: 800 });
    try {
      await page.goto(`${hub.url}/hub/`);
      await page.click("#sidebar-toggle");
      await page.waitForFunction(
        `!document.getElementById("sidebar").classList.contains("collapsed") ? true : null`,
        { timeout: 5000 },
      );
      await page.click(".session-item");
      // The bind ack triggers the headless ctx probe; the pill must settle
      // on the backend's live (capped) window, not the catalog's 105k.
      await page.waitForFunction(
        `document.getElementById("context-size").textContent === "32.0k / 64k" ? true : null`,
        { timeout: 15000 },
      );
      // Let the boot get_state round-trip land — the static catalog must
      // not overwrite the probed window (headlessOwnsWindow guard).
      await page.evaluate("new Promise(r => setTimeout(r, 2500))");
      const settled = await page.evaluate(`document.getElementById("context-size").textContent`);
      assert(settled === "32.0k / 64k", `after settle: ctx pill is "${settled}", expected the live headless window "32.0k / 64k"`);
      page.assertNoPageErrors();
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
