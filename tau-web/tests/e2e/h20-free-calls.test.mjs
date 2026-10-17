// H20 — every bare call in public/app.js resolves to something defined.
// `scrollToBottom` existed only as a method on the renderer classes, but
// app.js called it as a free function from the auto-compaction handler and
// the headless-continue path: both threw `ReferenceError: scrollToBottom is
// not defined` (the phone hit the first one mid-compaction, and the handler
// died after it had already flipped the header to "Compacting…"). Static
// syntax checks cannot see this, so parse the module's call sites and match
// them against declarations, imports, params and browser globals.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, PUBLIC_DIR } from "../helpers.mjs";

export const requires = [];
export const id = "H20";
export const title = "app.js free-function calls all resolve";

// Globals the browser (and the hub shell) provide.
const KNOWN_GLOBALS = new Set(`
  setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame
  queueMicrotask structuredClone fetch alert confirm prompt console JSON Math Object Array String
  Number Boolean Promise Date RegExp Error TypeError RangeError Map Set WeakMap WeakSet URL
  URLSearchParams WebSocket Blob File FileReader FormData Headers Request Response AbortController
  AbortSignal EventSource localStorage sessionStorage document window navigator location history
  performance crypto TextEncoder TextDecoder getComputedStyle matchMedia btoa atob parseInt
  parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI Symbol Intl
  ResizeObserver IntersectionObserver MutationObserver Image Audio AudioContext SpeechSynthesisUtterance
  speechSynthesis Notification CSS escape unescape globalThis customElements Element HTMLElement Node
  NodeList MediaQueryList Event CustomEvent KeyboardEvent MouseEvent TouchEvent WheelEvent DragEvent
  ImageBitmap createImageBitmap ClipboardEvent DOMRect DOMParser XMLSerializer Uint8Array Int8Array
  Float32Array Buffer ArrayBuffer SharedArrayBuffer DataView BigInt Proxy Reflect WeakRef FinalizationRegistry
  String Math Number Boolean Date RegExp Error Promise Map Set JSON parseInt parseFloat isNaN isFinite
  encodeURI encodeURIComponent decodeURI decodeURIComponent escape unescape btoa atob alert confirm
  open close print scroll scrollTo scrollBy focus blur stop
`.trim().split(/\s+/));

/**
 * Strip comments, strings, template literals (keeping `${}` expressions) and
 * regex literals, so only code remains. Templates may nest (a `${}` holding
 * another template), which a naive "scan to the next backtick" mangles.
 */
export function stripLiterals(src) {
  const out = [];
  const stack = []; // "template" frames and { expr: braceDepth } frames
  let mode = "code";
  let brace = 0;
  let i = 0;
  const n = src.length;
  let prev = ""; // last significant char, to tell regex from division
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); mode = "code"; prev = '"'; i++; out.push('""'); continue; }
      if (c === "$" && next === "{") { stack.push({ expr: brace }); mode = "code"; i += 2; out.push("{"); continue; }
      i++;
      continue;
    }
    if (c === "/" && next === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) { if (src[i] === "\\") i++; i++; }
      i++;
      out.push('""');
      prev = '"';
      continue;
    }
    if (c === "`") { stack.push("template"); mode = "template"; i++; continue; }
    if (c === "{") { brace++; prev = c; out.push(c); i++; continue; }
    if (c === "}") {
      const top = stack[stack.length - 1];
      if (top && typeof top === "object" && top.expr === brace) { stack.pop(); mode = "template"; i++; continue; }
      brace--;
      prev = c;
      out.push(c);
      i++;
      continue;
    }
    // A `/` after a value-less char opens a regex; quotes inside it must not
    // be mistaken for strings (that swallowed whole declarations).
    if (c === "/" && /[(,=:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === "\\") { i += 2; continue; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { i++; break; }
        else if (d === "\n") break;
        i++;
      }
      out.push("/r/");
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    out.push(c);
    i++;
  }
  return out.join("");
}

/** Names declared anywhere in the module (functions, vars, imports, destructuring, params). */
export function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{\s*([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const t = part.split(":").pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const t = part.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  // params of arrow functions and of `function name(...)` / `method(...)` forms
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(names, m[1]);
  for (const m of src.matchAll(/\(([^()]*)\)\s*\{/g)) addParams(names, m[1]);
  return names;
}

function addParams(names, list) {
  for (const part of list.split(",")) {
    const t = part.trim().split(/[=:]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
  }
}

/** Bare (not `obj.`) call sites: `foo(` where the preceding char is not a dot. */
export function bareCalls(src) {
  const names = new Set();
  for (const m of src.matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[2]);
  const keywords = /^(if|for|while|switch|catch|return|typeof|new|function|await|async|in|of|do|else|delete|void|yield|this|super|case|throw|instanceof|with)$/;
  return [...names].filter((n) => !keywords.test(n));
}

export async function run() {
  const raw = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const src = stripLiterals(raw);
  const declared = declaredNames(src);
  // Parser sanity: a bad parse would silently pass everything.
  assert(declared.size > 100, `parser found only ${declared.size} declared names in app.js`);
  const unresolved = bareCalls(src).filter((n) => !declared.has(n) && !KNOWN_GLOBALS.has(n));
  assert(unresolved.length === 0,
    `app.js calls ${unresolved.length} name(s) that are not declared anywhere in the module:\n  - ${unresolved.join("\n  - ")}`);
}
