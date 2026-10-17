// H18 — component modifier classes must not collide with global rules. The
// context visualiser named its "Input" variant `.messages`, the same class as
// the transcript scroller: the scroller's `flex: 1` + 68px/100px padding
// stretched that bar segment and legend dot to 271px tall and blew the
// popover up from ~186px to 443px. This guards the variant set the app
// actually applies (parsed out of app.js) against a repeat.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, PUBLIC_DIR } from "../helpers.mjs";

export const requires = [];
export const id = "H18";
export const title = "context-viz variant classes stay out of the global namespace";

const BASES = ["context-bar-segment", "context-legend-dot"];

/** Selectors that are exactly one class = rules any element with it inherits. */
export function bareClasses(css) {
  const cleaned = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@[^{]+\{/g, "{"); // drop at-rule preludes, keep their bodies
  const bare = new Set();
  const rule = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(cleaned))) {
    for (const part of m[1].split(",")) {
      const single = part.trim().match(/^\.([\w-]+)$/);
      if (single) bare.add(single[1]);
    }
  }
  return bare;
}

/** Classes the app attaches to a component via `class="${base} ${color}"`. */
export function appliedColors(appJs) {
  const block = appJs.match(/const segments = \[([\s\S]*?)\];/);
  assert(block, "app.js: no `const segments = [...]` — did the context viz move?");
  const colors = [...block[1].matchAll(/color:\s*['"]([\w-]+)['"]/g)].map((m) => m[1]);
  return colors;
}

export async function run() {
  const css = readFileSync(join(PUBLIC_DIR, "style.css"), "utf8");
  const app = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const bare = bareClasses(css);
  const colors = appliedColors(app);

  assert(colors.length >= 3, `parsed ${colors.length} segment colors from app.js`);
  // Detector sanity: the scroller is still a bare class, so a collision with
  // it is detectable at all. Without this the check below could be vacuous.
  assert(bare.has("messages"), "style.css: `.messages` scroller rule not found by the parser");

  for (const color of colors) {
    for (const base of BASES) {
      assert(
        new RegExp(`\\.${base}\\.${color}\\b`).test(css),
        `style.css: no .${base}.${color} rule for the "${color}" segment`,
      );
    }
    assert(
      !bare.has(color),
      `"${color}" is both a context-viz variant and a global .${color} class — it will inherit that rule`,
    );
  }

  // Every variant the stylesheet defines, not just the live ones, stays namespaced.
  for (const base of BASES) {
    const mods = new Set([...css.matchAll(new RegExp(`\\.${base}\\.([\\w-]+)`, "g"))].map((m) => m[1]));
    assert(mods.size > 0, `style.css: .${base} has no variant classes`);
    for (const mod of mods) {
      assert(!bare.has(mod), `style.css: .${base}.${mod} collides with the global .${mod} rule`);
    }
  }
}
