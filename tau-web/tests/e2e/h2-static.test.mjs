// H2 — Layer A static-only: shell renders with zero pageerrors,
// status pill present, desktop + mobile viewports (testing.md §7 P0).
import { startStaticServer } from "../static-server.mjs";
import { launchBrowser, VIEWPORTS } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const id = "H2";
export const title = "static-only renders with zero pageerrors (desktop + mobile)";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const srv = await startStaticServer({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    for (const [name, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage(viewport);
      try {
        await page.goto(`${srv.url}/hub/`);
        await page.waitForFunction(`!!document.querySelector("#status-text")`, { timeout: 8000 });
        const pill = await page.evaluate(`(() => !!document.querySelector("#status-indicator") && !!document.querySelector("#status-text"))()`);
        assert(pill === true, `${name}: status pill missing`);
        page.assertNoPageErrors();
      } catch (e) {
        await page.screenshot(`h2-${name}-fail`);
        throw e;
      } finally {
        page.close();
      }
    }
  } finally {
    await browser.close();
    await srv.close();
  }
}
