// H15 — composer popovers fit the phone viewport. The model picker and the
// thinking menu open upward from controls that sit right of centre; anchored
// left they ran past the right edge, so the whole page became horizontally
// scrollable and the UI appeared to extend beyond the screen. The model search
// field also has to stay visible with the on-screen keyboard up: it lives at
// the bottom of the menu and the list scrolls above it while the menu's height
// follows the (keyboard-shrunk) viewport.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H15";
export const title = "composer popovers stay inside the viewport (no sideways scroll)";

const PHONE = { width: 390, height: 844 };
// Roughly what `interactive-widget=resizes-content` leaves the 844px phone
// with once the on-screen keyboard is up.
const PHONE_KEYBOARD = { width: 390, height: 430 };

const GEOMETRY = `(() => {
  const de = document.documentElement;
  const VW = de.clientWidth, VH = window.innerHeight;
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const menu = document.getElementById("model-dropdown-menu");
  const open = !!menu && !menu.classList.contains("hidden");
  const items = menu ? menu.querySelector(".model-dropdown-items") : null;
  const search = menu ? menu.querySelector(".model-dropdown-search") : null;
  return {
    VW, VH,
    overflowX: Math.max(0, de.scrollWidth - VW),
    model: open ? {
      menu: rect(menu),
      items: rect(items),
      search: rect(search),
      searchIsLast: menu.lastElementChild === search,
      searchOutsideScroller: !!search && !!items && !items.contains(search) && search.parentElement === menu,
      itemsScroll: !!items && items.scrollHeight > items.clientHeight + 1,
    } : null,
    thinking: (() => {
      const t = document.getElementById("thinking-menu");
      return t && !t.classList.contains("hidden") ? rect(t) : null;
    })(),
  };
})()`;

function assertInside(rect, VW, VH, label) {
  assert(rect, `${label}: not rendered`);
  assert(rect.left >= -0.5 && rect.right <= VW + 0.5,
    `${label}: horizontal overflow (left ${rect.left.toFixed(1)}, right ${rect.right.toFixed(1)}, viewport ${VW})`);
  assert(rect.top >= -0.5 && rect.bottom <= VH + 0.5,
    `${label}: vertical overflow (top ${rect.top.toFixed(1)}, bottom ${rect.bottom.toFixed(1)}, viewport ${VH})`);
}

async function checkViewport(browser, url, viewport, name) {
  const page = await browser.newPage(viewport);
  try {
    await page.goto(`${url}/hub/`);
    await page.waitForFunction(`!!document.querySelector("#model-dropdown-btn") ? true : null`, { timeout: 10000 });

    // ── model picker ────────────────────────────────────────────────────
    await page.click("#model-dropdown-btn");
    await page.waitForFunction(
      `document.querySelectorAll("#model-dropdown-menu .model-dropdown-item").length > 1 ? true : null`,
      { timeout: 10000 },
    );
    const g = await page.evaluate(GEOMETRY);
    assert(g.overflowX === 0, `${name}: page scrolls sideways with the picker open (overflow ${g.overflowX}px, scrollWidth ${g.VW + g.overflowX})`);
    assert(g.model, `${name}: model picker did not open`);
    assertInside(g.model.menu, g.VW, g.VH, `${name}: model menu`);
    assertInside(g.model.search, g.VW, g.VH, `${name}: model search field`);
    assert(g.model.searchIsLast, `${name}: search field is not the last child of the menu`);
    assert(g.model.searchOutsideScroller, `${name}: search field must sit outside the scrolling list`);
    assert(g.model.itemsScroll, `${name}: model list must scroll inside the capped menu height`);
    assert(g.model.search.top >= g.model.items.bottom - 0.5,
      `${name}: search field must be below the list (list bottom ${g.model.items.bottom.toFixed(1)}, search top ${g.model.search.top.toFixed(1)})`);
    // The capped height is what keeps the picker above the keyboard.
    assert(g.model.menu.height <= 0.45 * g.VH + 1,
      `${name}: model menu taller than 45% of the viewport (${g.model.menu.height.toFixed(1)} of ${g.VH})`);
    page.assertNoPageErrors();

    // Close, then check the thinking menu (same trigger-row problem).
    await page.click("#model-dropdown-btn");
    await page.click("#thinking-btn");
    await page.waitForFunction(
      `!document.getElementById("thinking-menu").classList.contains("hidden") ? true : null`,
      { timeout: 5000 },
    );
    const t = await page.evaluate(GEOMETRY);
    assert(t.overflowX === 0, `${name}: page scrolls sideways with the thinking menu open (overflow ${t.overflowX}px)`);
    assertInside(t.thinking, t.VW, t.VH, `${name}: thinking menu`);
    page.assertNoPageErrors();
  } catch (e) {
    await page.screenshot(`h15-${name}-fail`);
    throw e;
  } finally {
    page.close();
  }
}

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    await checkViewport(browser, hub.url, PHONE, "phone");
    await checkViewport(browser, hub.url, PHONE_KEYBOARD, "phone-keyboard");
  } finally {
    await browser.close();
    await hub.close();
  }
}
