// H8 — Live section presence: the hub UI lists running TUIs with Drive
// controls, while the session banner stays hidden until a preview/attach.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const id = "H8";
export const title = "Live section lists the running TUI with Drive controls";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(`!!document.querySelector("#status-indicator") ? true : null`, { timeout: 15000 });
      // The stub's fake live TUI arrives via /api/instances on socket connect.
      await page.waitForFunction(
        `!!document.querySelector("#live-section .live-row") ? true : null`,
        { timeout: 15000 },
      );
      const header = await page.evaluate(`(() => document.querySelector("#live-section .live-header")?.textContent || "")()`);
      assert(/RUNNING TUIs/.test(header), `live header missing: ${JSON.stringify(header)}`);
      const driveBtn = await page.evaluate(`(() => {
        const b = document.querySelector('#live-section .live-btn[data-action="attach"]');
        return b ? b.textContent : null;
      })()`);
      assert(driveBtn && /Drive/.test(driveBtn), `Drive button missing: ${JSON.stringify(driveBtn)}`);
      // No preview/attach yet: the banner stays hidden.
      const bannerVisible = await page.evaluate(`(() => {
        const b = document.querySelector("#session-banner");
        return !!b && !b.classList.contains("hidden") && b.textContent.trim().length > 0;
      })()`);
      assert(!bannerVisible, "session banner must stay hidden before any preview/attach");
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h8-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
