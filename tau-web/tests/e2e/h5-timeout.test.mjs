// H5 — Layer B --no-ack: + waits out the 15s RPC timeout and shows
// the exact timeout message. Slow by design (~17s).
import { startFakeBackend } from "../fake-backend.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H5";
export const title = "no-ack backend shows exact 15s timeout message";
export const TIMEOUT_MSG =
  "New session timed out — the server did not answer. Check the backend connection and try again.";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const srv = await startFakeBackend({ port, staticDir: PUBLIC_DIR, mode: "no-ack" });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`${srv.url}/hub/`);
      await page.click("#tab-new");
      const msg = await page.waitForFunction(
        `[...document.querySelectorAll("#messages .system-message")].map(e=>e.textContent).find(t=>t.includes("timed out")) || null`,
        { timeout: 25000 },
      );
      assert(msg === TIMEOUT_MSG, `timeout mismatch: ${JSON.stringify(msg)}`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h5-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
}
