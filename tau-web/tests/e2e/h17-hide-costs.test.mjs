// H17 — the "Hide costs" switch suppresses every cost readout and survives a
// reload. It is off by default (nobody's view changes until they ask for it);
// when on it hides both the header session-cost pill and the per-message
// usage spans, and the `on` class / aria-checked / stored pref never drift.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, basePort, assertPortFree, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H17";
export const title = "hide-costs toggle suppresses cost readouts and persists";

// The stub transcript has no assistant usage and a $0 session, so a visible
// pill is forced before reading and one usage span is planted: both readouts
// must exist for the toggle's effect to be observable at all.
const PROBE = `(() => {
  const btn = document.getElementById("toggle-hide-costs");
  const pill = document.getElementById("session-cost");
  pill.classList.add("visible"); // what updateCostDisplay() does once cost > 0
  let usage = document.querySelector(".message-usage");
  if (!usage) {
    usage = document.createElement("span");
    usage.className = "message-usage";
    document.getElementById("messages").appendChild(usage);
  }
  const labelledBy = btn.getAttribute("aria-labelledby");
  return {
    label: (document.getElementById(labelledBy) || {}).textContent?.trim() || "",
    on: btn.classList.contains("on"),
    checked: btn.getAttribute("aria-checked"),
    bodyClass: document.body.classList.contains("hide-costs"),
    pillDisplay: getComputedStyle(pill).display,
    usageDisplay: getComputedStyle(usage).display,
    stored: localStorage.getItem("tau-hide-costs"),
  };
})()`;

async function openSettings(page) {
  await page.click("#settings-btn");
  await page.waitForFunction(
    `!document.getElementById("settings-panel").classList.contains("hidden") ? true : null`,
    { timeout: 5000 },
  );
}

function assertShown(s, when) {
  assert(s.pillDisplay !== "none", `${when}: session-cost pill hidden (display ${s.pillDisplay})`);
  assert(s.usageDisplay !== "none", `${when}: per-message usage hidden (display ${s.usageDisplay})`);
}

function assertHidden(s, when) {
  assert(s.pillDisplay === "none", `${when}: session-cost pill still visible (display ${s.pillDisplay})`);
  assert(s.usageDisplay === "none", `${when}: per-message usage still visible (display ${s.usageDisplay})`);
}

function assertToggle(s, on, when) {
  assert(s.on === on, `${when}: on class is ${s.on}, expected ${on}`);
  assert(s.checked === String(on), `${when}: aria-checked=${s.checked} disagrees with the on class (${s.on})`);
  assert(s.bodyClass === on, `${when}: body.hide-costs is ${s.bodyClass}, expected ${on}`);
}

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ width: 1280, height: 800 });
    try {
      // ── default: off, everything visible ──────────────────────────────
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(`!!document.getElementById("model-dropdown-btn") ? true : null`, { timeout: 10000 });
      const boot = await page.evaluate(PROBE);
      assert(boot.label === "Hide costs", `toggle is labelled "${boot.label}", expected "Hide costs"`);
      assertToggle(boot, false, "boot");
      assertShown(boot, "boot");
      assert(boot.stored !== "true", `boot: tau-hide-costs stored as ${boot.stored}`);
      page.assertNoPageErrors();

      // ── switch it on: both readouts go ────────────────────────────────
      await openSettings(page);
      await page.click("#toggle-hide-costs");
      const on = await page.evaluate(PROBE);
      assertToggle(on, true, "after enabling");
      assertHidden(on, "after enabling");
      assert(on.stored === "true", `after enabling: tau-hide-costs stored as ${on.stored}`);
      page.assertNoPageErrors();

      // ── reload: the preference is applied before the user opens settings ──
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(`!!document.getElementById("model-dropdown-btn") ? true : null`, { timeout: 10000 });
      const reload = await page.evaluate(PROBE);
      assertToggle(reload, true, "after reload");
      assertHidden(reload, "after reload");
      page.assertNoPageErrors();

      // ── switch it back off: everything returns ────────────────────────
      await openSettings(page);
      await page.click("#toggle-hide-costs");
      const off = await page.evaluate(PROBE);
      assertToggle(off, false, "after disabling");
      assertShown(off, "after disabling");
      assert(off.stored === "false", `after disabling: tau-hide-costs stored as ${off.stored}`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h17-hide-costs-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
