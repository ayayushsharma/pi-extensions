// H19 — "Start new session" in the Start/Resume picker really starts one.
// The click handler read `S.opts` *after* closeSessionPicker() had nulled S,
// so every press threw `Cannot read properties of null (reading 'opts')` and
// did nothing — silently, because the picker had already closed. On phones
// the sidebar drawer also stayed open with its tap-swallowing overlay, so the
// composer looked dead ("new session + prompt does nothing").
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, basePort, assertPortFree, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H19";
export const title = "picker Start binds a fresh session and closes the phone drawer";

const STATE = `(() => ({
  pickerHidden: document.getElementById("session-picker").classList.contains("hidden"),
  sidebarCollapsed: document.getElementById("sidebar").classList.contains("collapsed"),
  overlayVisible: document.getElementById("sidebar-overlay").classList.contains("visible"),
  binding: localStorage.getItem("tau-web-binding"),
  status: document.getElementById("status-text").textContent,
  tabs: document.getElementById("tab-strip").innerText.replace(/\\n/g, " / "),
}))()`;

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    // Phone width: the picker is reached from the slide-over drawer, and the
    // drawer's overlay is what made the composer unresponsive after the throw.
    const page = await browser.newPage({ width: 390, height: 844 });
    try {
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(`!!document.getElementById("model-dropdown-btn") ? true : null`, { timeout: 10000 });
      await page.click("#sidebar-toggle");
      await page.waitForFunction(
        `!document.getElementById("sidebar").classList.contains("collapsed") ? true : null`,
        { timeout: 5000 },
      );
      await page.click("#new-session-btn");
      await page.waitForFunction(
        `!document.getElementById("session-picker").classList.contains("hidden") ? true : null`,
        { timeout: 10000 },
      );

      const before = await page.evaluate(`localStorage.getItem("tau-web-binding")`);
      await page.click("#sp-start");
      // The ack rebinds and persists; a throwing handler never touches it, so
      // this wait is the detection point for the null-S regression.
      await page.waitForFunction(
        `localStorage.getItem("tau-web-binding") !== null && localStorage.getItem("tau-web-binding") !== ${JSON.stringify(before)} ? true : null`,
        { timeout: 10000 },
      );

      const after = await page.evaluate(STATE);
      assert(after.pickerHidden, "picker stayed open after Start");
      assert(String(after.binding).includes('"sessionKey":"stub-'),
        `binding was not refreshed with the new stub session: ${after.binding}`);
      assert(after.sidebarCollapsed, "phone drawer stayed open over the fresh session");
      assert(!after.overlayVisible, "phone drawer overlay is still visible — taps land on it, not the composer");
      assert(!/Creating session/.test(after.status), `status stuck on "${after.status}"`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h19-picker-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
