// H21 — the header's model/thinking pill must describe the SESSION being
// viewed, not the hub's own pi process. Two ways that used to break:
//   * renderSessionHistory() ends with fetchContextWindow() → fetchModelInfo(),
//     whose get_state answer (the server's OWN session) overwrote whatever the
//     history had just applied — one click and every session showed the hub's
//     model/thinking;
//   * the first paint is a `?limit=50` tail, and a session's model_change /
//     thinking_level_change entries sit at the TOP of the file — so a long
//     session had nothing to derive from. The history payload now carries the
//     whole-file model/thinking (`serveSessionFile`) and the client applies it.
// The stub's own state is deliberately a different model/level: any leak is
// visible as the wrong pill.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, basePort, assertPortFree, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H21";
export const title = "header model/thinking follow the viewed session, not the hub";

const DIR_NAME = "--tmp-e2e-history--";
const FILE = "e2e-session.jsonl";
const FILE_PATH = `/tmp/e2e-history/${FILE}`;
const SESSION_MODEL = "stub-session-model";
const SESSION_THINKING = "low";
const SERVER_MODEL = "stub-server-own-model";
const SERVER_THINKING = "xhigh";

// 60 filler entries so the `?limit=50` windup cannot reach the change entries
// (which the stub, like the real hub, keeps out of `entries` — only in meta).
const FILLER = Array.from({ length: 60 }, (_, i) => ({ type: "message", id: `f${i}`, message: { role: "user", content: `filler ${i}` } }));

const PROBE = `({
  model: document.getElementById("model-dropdown-label").textContent,
  thinking: document.getElementById("thinking-btn").textContent,
  hash: decodeURIComponent(location.hash),
})`;

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
  });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ width: 1280, height: 800 });
    try {
      await page.goto(`${hub.url}/hub/`);
      // ── baseline: nothing selected, the hub's own state owns the header ──
      await page.waitForFunction(
        `document.getElementById("model-dropdown-label").textContent === ${JSON.stringify(SERVER_MODEL)} ? true : null`,
        { timeout: 10000 },
      );
      const boot = await page.evaluate(PROBE);
      assert(boot.thinking === SERVER_THINKING, `boot: thinking is "${boot.thinking}", expected the server's "${SERVER_THINKING}"`);
      page.assertNoPageErrors();

      // ── select the history session: its own model/thinking must win ─────
      await page.click("#sidebar-toggle");
      await page.waitForFunction(
        `!document.getElementById("sidebar").classList.contains("collapsed") ? true : null`,
        { timeout: 5000 },
      );
      await page.click(".session-item");
      await page.waitForFunction(
        `document.getElementById("model-dropdown-label").textContent === ${JSON.stringify(SESSION_MODEL)} ? true : null`,
        { timeout: 10000 },
      );
      const picked = await page.evaluate(PROBE);
      assert(picked.thinking === SESSION_THINKING, `after select: thinking is "${picked.thinking}", expected "${SESSION_THINKING}"`);
      assert(picked.hash.includes(FILE), `after select: hash is "${picked.hash}", expected it to pin ${FILE}`);

      // The select's own get_state round-trip lands after the render — give it
      // room, then re-assert (this is the guard: server state must not win).
      await page.evaluate("new Promise(r => setTimeout(r, 2500))");
      const settled = await page.evaluate(PROBE);
      assert(settled.model === SESSION_MODEL, `after settle: model leaked to "${settled.model}" (server state overwrote the session's)`);
      assert(settled.thinking === SESSION_THINKING, `after settle: thinking leaked to "${settled.thinking}"`);

      // ── reload on the pinned hash: the restore path must agree ──────────
      await page.goto(`${hub.url}/hub/#session=${FILE}`);
      await page.waitForFunction(
        `document.getElementById("model-dropdown-label").textContent === ${JSON.stringify(SESSION_MODEL)} ? true : null`,
        { timeout: 10000 },
      );
      await page.evaluate("new Promise(r => setTimeout(r, 2000))"); // let the boot get_state land too
      const restored = await page.evaluate(PROBE);
      assert(restored.model === SESSION_MODEL, `after reload: model is "${restored.model}", expected "${SESSION_MODEL}"`);
      assert(restored.thinking === SESSION_THINKING, `after reload: thinking is "${restored.thinking}", expected "${SESSION_THINKING}"`);
      page.assertNoPageErrors();
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
