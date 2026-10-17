// H16 — the hub's markup is well-formed and its widgets expose their state
// through ARIA, not only through CSS classes. Two layers:
//   1. a static audit of the served HTML: every tag closes, no duplicate ids,
//      every button has an explicit type and an accessible name, dialogs /
//      switches / tabs / listboxes carry the attributes their role requires,
//      text inputs are labelled, images have alt;
//   2. a runtime audit of the live widgets: aria-expanded follows the model
//      picker and thinking menu, aria-selected follows the settings tabs,
//      aria-checked follows the settings toggles.
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, basePort, assertPortFree, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H16";
export const title = "markup is well-formed and ARIA state tracks the widgets";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ATTR_RE = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;

function attrsOf(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

/** Stack-based audit of the raw HTML (scripts/comments stripped first). */
export function auditHtml(html) {
  const src = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  const issues = [];
  const tags = [];
  const buttons = [];
  const ids = new Set();
  const dups = new Set();
  const stack = [];
  let pendingButton = null;
  let m;
  while ((m = TAG_RE.exec(src))) {
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const attrs = attrsOf(m[3] || "");
    if (closing) {
      if (name === "button" && pendingButton) {
        const text = src.slice(pendingButton.textStart, m.index).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        buttons.push({ ...pendingButton, text });
        pendingButton = null;
      }
      const top = stack.pop();
      if (!top || top.name !== name) {
        issues.push(`</${name}> at line ${lineAt(m.index)} closes ${top ? `<${top.name}> opened at line ${top.line}` : "nothing"}`);
      }
      continue;
    }
    const row = { name, attrs, line: lineAt(m.index), inTablist: stack.some((e) => e.attrs.role === "tablist") };
    tags.push(row);
    if (attrs.id) {
      if (ids.has(attrs.id)) dups.add(attrs.id);
      ids.add(attrs.id);
    }
    if (name === "button") pendingButton = { attrs, line: row.line, textStart: TAG_RE.lastIndex };
    const selfClosing = m[4] === "/" || /\/\s*$/.test(m[3] || "");
    if (!VOID.has(name) && !selfClosing) stack.push(row);
  }
  for (const leftover of stack) issues.push(`<${leftover.name}> opened at line ${leftover.line} is never closed`);
  if (pendingButton) issues.push(`<button> at line ${pendingButton.line} has no </button>`);

  const NAMEABLE = new Set(["text", "search", "password", "email", "url", "tel", "number"]);
  for (const t of tags) {
    const a = t.attrs;
    const where = a.id ? `#${a.id}` : `line ${t.line}`;
    if (t.name === "button" && !("type" in a)) issues.push(`<button ${where}> has no explicit type`);
    if (t.name === "img" && !("alt" in a)) issues.push(`<img> without alt (line ${t.line})`);
    if (a.role === "dialog") {
      if (!a["aria-label"] && !a["aria-labelledby"]) issues.push(`role=dialog without a name (${where})`);
      if (a["aria-modal"] !== "true") issues.push(`role=dialog without aria-modal (${where})`);
    }
    if (a.role === "switch") {
      if (!("aria-checked" in a)) issues.push(`role=switch without aria-checked (${where})`);
      if (!a["aria-label"] && !a["aria-labelledby"]) issues.push(`role=switch without a name (${where})`);
    }
    if (a.role === "tab" && !("aria-selected" in a)) issues.push(`role=tab without aria-selected (${where})`);
    if (a.role === "tab" && !t.inTablist) issues.push(`role=tab outside a tablist (${where})`);
    if (a.role === "tabpanel" && (!a["aria-labelledby"] || !ids.has(a["aria-labelledby"]))) {
      issues.push(`role=tabpanel without a live aria-labelledby (${where})`);
    }
    if (a.role === "tablist" && !a["aria-label"]) issues.push(`role=tablist without aria-label (${where})`);
    if (a["aria-controls"] && !ids.has(a["aria-controls"])) issues.push(`aria-controls="${a["aria-controls"]}" has no target (${where})`);
    for (const ref of (a["aria-labelledby"] || "").split(/\s+/).filter(Boolean)) {
      if (!ids.has(ref)) issues.push(`aria-labelledby="${ref}" has no target (${where})`);
    }
    const isTextInput = (t.name === "textarea") || (t.name === "input" && NAMEABLE.has(a.type || "text"));
    if (isTextInput && !a["aria-label"] && !a["aria-labelledby"]) issues.push(`text input without a label (${where})`);
  }
  for (const b of buttons) {
    if (b.text) continue;
    if (b.attrs["aria-label"] || b.attrs["aria-labelledby"] || b.attrs.title) continue;
    issues.push(`icon-only button without a name (line ${b.line}${b.attrs.id ? ` #${b.attrs.id}` : ""})`);
  }
  return { issues, dups: [...dups], buttons: buttons.length };
}

const SETTINGS_STATE = `(() => {
  const one = (sel, attr) => {
    const els = [...document.querySelectorAll(sel)];
    return els.filter((e) => e.classList.contains("hidden") ? attr === "hidden" : !e.classList.contains("hidden")).map((e) => e.id + (attr === "selected" ? ":" + e.getAttribute("aria-selected") : ""));
  };
  const toggle = document.getElementById("toggle-show-thinking");
  return {
    open: !document.getElementById("settings-panel").classList.contains("hidden"),
    visibleTabs: [...document.querySelectorAll("#settings-tabs .settings-tab")]
      .filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.id),
    visiblePanes: [...document.querySelectorAll("#settings-panel .settings-section")]
      .filter((p) => !p.classList.contains("hidden")).map((p) => p.id),
    toggle: { checked: toggle.getAttribute("aria-checked"), on: toggle.classList.contains("on") },
  };
})()`;

const POPOVER_STATE = `(() => {
  const btn = document.getElementById("model-dropdown-btn");
  const tbtn = document.getElementById("thinking-btn");
  const menu = document.getElementById("model-dropdown-menu");
  const list = menu.querySelector('[role="listbox"]');
  const options = list ? [...list.querySelectorAll('[role="option"]')] : [];
  const search = menu.querySelector(".model-dropdown-search");
  const tmenu = document.getElementById("thinking-menu");
  const topts = [...tmenu.querySelectorAll('[role="option"]')];
  const activeItem = menu.querySelector(".model-dropdown-item.active");
  const activeOpt = topts.find((o) => o.getAttribute("aria-selected") === "true");
  return {
    modelExpanded: btn.getAttribute("aria-expanded"),
    thinkingExpanded: tbtn.getAttribute("aria-expanded"),
    modelLabel: list ? list.getAttribute("aria-label") : null,
    optionCount: options.length,
    selectedCount: options.filter((o) => o.getAttribute("aria-selected") === "true").length,
    activeIsSelected: !!activeItem && activeItem.getAttribute("aria-selected") === "true",
    searchRole: search ? search.getAttribute("role") : null,
    searchControls: search ? search.getAttribute("aria-controls") : null,
    searchListboxId: list ? list.id : null,
    thinkingListbox: tmenu.getAttribute("role"),
    thinkingOptionCount: topts.length,
    thinkingSelectedCount: topts.filter((o) => o.getAttribute("aria-selected") === "true").length,
    thinkingActiveIsSelected: !!activeOpt && activeOpt.classList.contains("active"),
  };
})()`;

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  const browser = await launchBrowser();
  try {
    // ── 1. static markup audit of the served file ───────────────────────
    const res = await fetch(`${hub.url}/hub/`);
    assert(res.ok, `GET /hub/ -> ${res.status}`);
    const html = await res.text();
    const audit = auditHtml(html);
    assert(audit.dups.length === 0, `duplicate ids: ${audit.dups.join(", ")}`);
    assert(audit.issues.length === 0, `markup issues:\n  - ${audit.issues.join("\n  - ")}`);
    assert(audit.buttons > 20, `suspiciously few buttons audited (${audit.buttons})`);

    // ── 2. runtime ARIA state ──────────────────────────────────────────
    const page = await browser.newPage({ width: 1280, height: 800 });
    try {
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(`!!document.getElementById("model-dropdown-btn") ? true : null`, { timeout: 10000 });

      // settings: tabs + toggles
      await page.click("#settings-btn");
      await page.waitForFunction(`!document.getElementById("settings-panel").classList.contains("hidden") ? true : null`, { timeout: 5000 });
      const s1 = await page.evaluate(SETTINGS_STATE);
      assert(s1.visibleTabs.length === 1 && s1.visibleTabs[0] === "settings-tab-appearance", `settings tabs announce the wrong selection: ${JSON.stringify(s1.visibleTabs)}`);
      assert(s1.visiblePanes.length === 1 && s1.visiblePanes[0] === "settings-pane-appearance", `settings panes disagree with the tabs: ${JSON.stringify(s1.visiblePanes)}`);
      assert(s1.toggle.checked === String(s1.toggle.on), `show-thinking aria-checked (${s1.toggle.checked}) disagrees with its on class (${s1.toggle.on})`);

      await page.click("#settings-tab-voice");
      const s2 = await page.evaluate(SETTINGS_STATE);
      assert(s2.visibleTabs.length === 1 && s2.visibleTabs[0] === "settings-tab-voice", `voice tab not announced as selected: ${JSON.stringify(s2.visibleTabs)}`);
      assert(s2.visiblePanes.length === 1 && s2.visiblePanes[0] === "settings-pane-voice", `voice pane not the visible one: ${JSON.stringify(s2.visiblePanes)}`);
      await page.click("#settings-tab-appearance");

      await page.click("#toggle-show-thinking");
      const s3 = await page.evaluate(SETTINGS_STATE);
      assert(s3.toggle.checked !== s1.toggle.checked, `toggle click did not flip aria-checked (${s1.toggle.checked} -> ${s3.toggle.checked})`);
      assert(s3.toggle.checked === String(s3.toggle.on), `aria-checked (${s3.toggle.checked}) disagrees with the on class (${s3.toggle.on}) after the click`);
      await page.click("#toggle-show-thinking"); // restore the preference
      await page.click("#settings-close");

      // model picker + thinking menu
      await page.click("#model-dropdown-btn");
      await page.waitForFunction(`document.querySelectorAll("#model-dropdown-menu [role=option]").length > 1 ? true : null`, { timeout: 10000 });
      const p1 = await page.evaluate(POPOVER_STATE);
      assert(p1.modelExpanded === "true", `model button aria-expanded=${p1.modelExpanded} while open`);
      assert(p1.modelLabel === "Models", `model listbox aria-label=${p1.modelLabel}`);
      assert(p1.optionCount > 1, `model listbox has ${p1.optionCount} options`);
      assert(p1.selectedCount === (p1.activeIsSelected ? 1 : 0), `model listbox marks ${p1.selectedCount} rows selected, active row selected=${p1.activeIsSelected}`);
      assert(p1.searchRole === "combobox" && p1.searchControls === p1.searchListboxId, `model search must be a combobox controlling the listbox (role ${p1.searchRole}, controls ${p1.searchControls} vs ${p1.searchListboxId})`);

      // Pick the second model, then reopen: exactly that row is the announced
      // one, and it is also the row painted as active.
      const optionText = `document.querySelectorAll("#model-dropdown-list [role=option]")[1].textContent.trim()`;
      const picked = await page.evaluate(optionText);
      await page.click("#model-dropdown-list [role=option]:nth-child(2)");
      await page.waitForFunction(`document.getElementById("model-dropdown-btn").getAttribute("aria-expanded") === "false" ? true : null`, { timeout: 10000 });
      await page.click("#model-dropdown-btn");
      await page.waitForFunction(`document.querySelectorAll("#model-dropdown-list [role=option]").length > 1 ? true : null`, { timeout: 10000 });
      const p2 = await page.evaluate(`(() => {
        const opts = [...document.querySelectorAll("#model-dropdown-list [role=option]")];
        const chosen = opts.filter((o) => o.getAttribute("aria-selected") === "true");
        return { count: chosen.length, text: chosen.map((o) => o.textContent.trim()), active: chosen.every((o) => o.classList.contains("active")) };
      })()`);
      assert(p2.count === 1 && p2.text[0] === picked, `model listbox announces ${p2.count} selection(s) ${JSON.stringify(p2.text)}, expected ${JSON.stringify(picked)}`);
      assert(p2.active, `the announced model row is not the one painted active`);
      await page.click("#model-dropdown-btn");
      const p3 = await page.evaluate(POPOVER_STATE);
      assert(p3.modelExpanded === "false", `model button aria-expanded=${p3.modelExpanded} after closing`);

      await page.click("#thinking-btn");
      await page.waitForFunction(`!document.getElementById("thinking-menu").classList.contains("hidden") ? true : null`, { timeout: 5000 });
      const p4 = await page.evaluate(POPOVER_STATE);
      assert(p4.thinkingExpanded === "true", `thinking button aria-expanded=${p4.thinkingExpanded} while open`);
      assert(p4.thinkingListbox === "listbox", `thinking menu role=${p4.thinkingListbox}`);
      assert(p4.thinkingOptionCount === 7, `thinking menu has ${p4.thinkingOptionCount} options, expected 7`);
      assert(p4.thinkingSelectedCount === 1 && p4.thinkingActiveIsSelected, `thinking menu must mark exactly its current level selected (selected ${p4.thinkingSelectedCount}, active ${p4.thinkingActiveIsSelected})`);
      await page.click("#thinking-btn");
      const p5 = await page.evaluate(POPOVER_STATE);
      assert(p5.thinkingExpanded === "false", `thinking button aria-expanded=${p5.thinkingExpanded} after closing`);

      // A session tab (via the hash deep-link) exercises the hub tab strip
      // and its sidebar mirror: both announce the active tab, and every tab
      // sits inside a tablist.
      await page.goto(`${hub.url}/hub/#session=h16-sample.jsonl`);
      await page.waitForFunction(`document.querySelectorAll("#tab-strip [role=tab]").length === 1 ? true : null`, { timeout: 10000 });
      const tabs = await page.evaluate(`(() => {
        const rows = (root) => [...root.querySelectorAll("[role=tab]")];
        const isSel = (t) => t.getAttribute("aria-selected") === "true";
        const all = [...document.querySelectorAll("[role=tab]")];
        const strip = rows(document.getElementById("tab-strip"));
        const vtabs = rows(document.getElementById("vtabs"));
        return {
          strip: strip.length,
          vstrip: vtabs.length,
          stripSelected: strip.filter(isSel).length,
          vstripSelected: vtabs.filter(isSel).length,
          selectedIsActive: all.filter(isSel).every((t) => t.classList.contains("active")),
          orphans: all.filter((t) => !t.closest("[role=tablist]")).map((t) => t.id || t.className),
        };
      })()`);
      assert(tabs.strip === 1 && tabs.vstrip === 1, `expected the session tab in the strip and its sidebar mirror, found ${tabs.strip} + ${tabs.vstrip}`);
      assert(tabs.stripSelected === 1 && tabs.vstripSelected === 1 && tabs.selectedIsActive, `active session tab not announced (strip ${tabs.stripSelected}, sidebar ${tabs.vstripSelected}, active class ${tabs.selectedIsActive})`);
      assert(tabs.orphans.length === 0, `role=tab outside a tablist: ${tabs.orphans.join(", ")}`);

      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h16-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
