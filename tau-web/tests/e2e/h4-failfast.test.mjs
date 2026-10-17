// H4 — Layer A: + with no backend shows the exact fail-fast message,
// never a silent 15s wait.
import { startStaticServer } from "../static-server.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H4";
export const title = "disconnected + shows exact fail-fast (no 15s wait)";
export const FAILFAST =
  "Not connected to the backend — start (or wait for) the server before opening a new session.";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const srv = await startStaticServer({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`${srv.url}/hub/`);
      const t0 = Date.now();
      await page.click("#tab-new");
      const msg = await page.waitForFunction(
        `[...document.querySelectorAll("#messages .system-message")].map(e=>e.textContent).find(t=>t.includes("Not connected to the backend")) || null`,
        { timeout: 8000 },
      );
      const dt = Date.now() - t0;
      assert(msg === FAILFAST, `fail-fast mismatch: ${JSON.stringify(msg)}`);
      assert(dt < 10000, `fail-fast took ${dt}ms — must not wait out the 15s RPC timeout`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h4-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
}
