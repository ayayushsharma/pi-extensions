// H3 — Layer B --late-file: + pins #session=<base>.jsonl + New session tab.
import { startFakeBackend } from "../fake-backend.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H3";
export const title = "late session_file pins #session + tab";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const srv = await startFakeBackend({ port, staticDir: PUBLIC_DIR, mode: "late-file" });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`${srv.url}/hub/`);
      await page.waitForFunction(`window.location !== undefined`, { timeout: 5000 });
      await page.click("#tab-new");
      const hash = await page.waitForFunction(
        `location.hash.includes("#session=") && location.hash.endsWith(".jsonl") ? location.hash : null`,
        { timeout: 10000 },
      );
      assert(String(hash).endsWith(".jsonl"), `hash not pinned to jsonl: ${hash}`);
      const tab = await page.evaluate(`(() => document.querySelector("#tab-strip")?.textContent || "")()`);
      assert(/New session/i.test(tab), `tab strip missing "New session": ${tab.slice(0, 200)}`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h3-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await srv.close();
  }
}
