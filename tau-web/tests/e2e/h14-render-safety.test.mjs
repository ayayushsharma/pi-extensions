// H14 — renderer safety units: hostile image blocks (B1/S1) and the markdown
// placeholder collision (B2). Pure Node: the browser modules are imported
// directly (module scope touches no DOM) so this runs anywhere — Termux,
// low-end boxes, CI — with no hub and no browser.
import { assert } from "../helpers.mjs";

export const id = "H14";
export const title = "renderer safety: hostile image blocks + markdown placeholder collision";

export async function run() {
  const { renderMarkdown } = await import("../../public/markdown.js");
  const { isValidMessageImage } = await import("../../public/message-renderer.js");

  // B2: user text that looks like an internal placeholder must render as
  // text and must not swallow the rest of the message (pre-fix: threw /
  // emitted "undefined").
  const collide = renderMarkdown("before %%CODEBLOCK_0%%\n\nafter");
  assert(typeof collide === "string", "renderMarkdown returned non-string");
  assert(collide.includes("before") && collide.includes("after"), `placeholder-like line swallowed content: ${collide}`);
  const dmath = renderMarkdown("x %%DMATH_7%% y");
  assert(dmath.includes("x") && dmath.includes("y"), `DMATH-like text swallowed content: ${dmath}`);
  const icode = renderMarkdown("a %%ICODE3%% b");
  assert(icode.includes("a") && icode.includes("b"), `ICODE-like text swallowed content: ${icode}`);
  const mathx = renderMarkdown("m %%MATHX9%% n");
  assert(mathx.includes("m") && mathx.includes("n"), `MATHX-like text swallowed content: ${mathx}`);
  // Real blocks still go through the placeholder machinery.
  const fenced = renderMarkdown("```js\nlet a = 1;\n```");
  assert(fenced.includes("code-block-wrapper") && fenced.includes("let a = 1;"), `fenced code block regressed: ${fenced}`);
  const display = renderMarkdown("$$\nE = mc^2\n$$");
  assert(display.includes("math-display"), `display math regressed: ${display}`);

  // B1/S1: history session files are attacker-influenced; only plain base64
  // payloads of allowlisted raster types may become <img> sources.
  const good = [
    { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", mimeType: "image/png" },
    { data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
    { data: "data:image/webp;base64,UklGRiIAAABXRUJQVlA4" },
    { data: "AA==", mimeType: "image/gif" },
    { data: "iVBORw0KGgo=" }, // mimeType omitted -> defaults to image/png
  ];
  for (const img of good) {
    assert(isValidMessageImage(img), `valid image rejected: ${JSON.stringify(img).slice(0, 70)}`);
  }

  const bad = [
    null,
    undefined,
    {},
    { data: "" },
    { data: "AAAA", mimeType: "text/html" },
    { data: "AAAA", mimeType: "image/svg+xml" },
    { data: '"><img src=x onerror=alert(1)>', mimeType: "image/png" },
    { data: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" },
    { data: "data:image/svg+xml;base64,PHN2Zy8+" },
    { data: "data:image/png;base64," },
    { data: "data:image/png" }, // no comma
    { data: "data:image/png;base64,%%%not-base64%%%", mimeType: "image/png" },
    { data: 123, mimeType: "image/png" },
  ];
  for (const img of bad) {
    assert(!isValidMessageImage(img), `hostile image accepted: ${JSON.stringify(img)?.slice(0, 70)}`);
  }
}
