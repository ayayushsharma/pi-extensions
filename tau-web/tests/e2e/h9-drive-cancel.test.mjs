// H9 — preview-then-drive in the browser: Drive previews read-only with a
// confirm banner, Cancel backs out, "Drive this TUI" wires the uplink
// (Driving banner), Detach freezes with a Drive-again affordance.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const id = "H9";
export const title = "preview-then-drive flow: preview, cancel, drive, detach";

async function bannerAction(page, action) {
  return page.evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(`#session-banner .sb-btn[data-action="${action}"]`)});
    return b ? b.textContent : null;
  })()`);
}

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
      await page.waitForFunction(
        `!!document.querySelector('#live-section .live-btn[data-action="attach"]') ? true : null`,
        { timeout: 15000 },
      );

      // Phase 1: Drive previews — confirm banner offers Drive/Cancel.
      await page.evaluate(`(() => document.querySelector('#live-section .live-btn[data-action="attach"]').click())()`);
      await page.waitForFunction(
        `!!document.querySelector('#session-banner .sb-btn[data-action="attach"]') ? true : null`,
        { timeout: 10000 },
      );
      const confirmLabel = await bannerAction(page, "attach");
      assert(confirmLabel && /Drive this TUI/.test(confirmLabel), `confirm banner: ${JSON.stringify(confirmLabel)}`);
      assert(await bannerAction(page, "cancel"), "preview banner must offer Cancel");

      // Cancel backs out: banner clears.
      await page.evaluate(`(() => document.querySelector('#session-banner .sb-btn[data-action="cancel"]').click())()`);
      await page.waitForFunction(
        `(() => { const b = document.querySelector("#session-banner"); return !b || b.classList.contains("hidden") || !b.textContent.trim() ? true : null; })()`,
        { timeout: 10000 },
      );

      // Phase 2: Drive again, confirm — uplink wires, Driving banner shows.
      await page.evaluate(`(() => document.querySelector('#live-section .live-btn[data-action="attach"]').click())()`);
      await page.waitForFunction(
        `!!document.querySelector('#session-banner .sb-btn[data-action="attach"]') ? true : null`,
        { timeout: 10000 },
      );
      await page.evaluate(`(() => document.querySelector('#session-banner .sb-btn[data-action="attach"]').click())()`);
      await page.waitForFunction(
        `!!document.querySelector('#session-banner .sb-btn[data-action="detach"]') ? true : null`,
        { timeout: 10000 },
      );
      const sysMsg = await page.evaluate(`(() => {
        const all = Array.from(document.querySelectorAll(".system-message")).map((e) => e.textContent);
        return all.join("\\n").slice(-500);
      })()`);
      assert(/Now driving the live TUI/.test(sysMsg), `driving notice missing: ${JSON.stringify(sysMsg)}`);

      // Detach freezes with a Drive-again affordance.
      await page.evaluate(`(() => document.querySelector('#session-banner .sb-btn[data-action="detach"]').click())()`);
      await page.waitForFunction(
        `!!document.querySelector('#session-banner .sb-btn[data-action="retry"]') ? true : null`,
        { timeout: 10000 },
      );
      const retryLabel = await bannerAction(page, "retry");
      assert(retryLabel && /Drive again/.test(retryLabel), `drive-again banner: ${JSON.stringify(retryLabel)}`);

      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h9-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
