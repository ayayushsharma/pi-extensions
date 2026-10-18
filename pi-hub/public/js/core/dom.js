/**
 * dom — element helpers, formatting, toasts. No innerHTML anywhere model or
 * server content is involved; icons are static trusted markup (core/icons.js).
 */
export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v); // trusted static markup only
    else if (k === "value") node.value = String(v);
    else if (k === "checked") node.checked = !!v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function show(node, visible) {
  node.classList.toggle("hidden", !visible);
  return node;
}

export function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - Number(ts);
  if (diff < 30_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  try {
    return new Date(Number(ts)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function shortCwd(cwd) {
  if (!cwd) return "";
  const home = cwd
    .replace(/^\/data\/data\/com\.termux\/files\/home/, "~")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
  const parts = home.split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? home || "/" : `…/${parts.slice(-2).join("/")}`;
}

export function basename(p) {
  if (!p) return "";
  return String(p).split(/[\\/]/).filter(Boolean).pop() || "";
}

/** Shorten a tool path for display: cwd-relative when inside the session
 *  cwd, `~`-collapsed otherwise. The full path stays in the card's title. */
export function shortenPath(p, cwd) {
  const s = String(p || "");
  if (!s) return "";
  const root = String(cwd || "").replace(/\/$/, "");
  if (root && (s === root || s.startsWith(`${root}/`))) {
    return s.slice(root.length + 1) || s;
  }
  return s
    .replace(/^\/data\/data\/com\.termux\/files\/home/, "~")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
}

export function usageText(meta) {
  const bits = [];
  const tokens = meta?.tokens || meta?.usage?.totalTokens;
  if (tokens) bits.push(`${(tokens / 1000).toFixed(1)}k tok`);
  const cost = meta?.cost ?? meta?.usage?.cost?.total;
  if (typeof cost === "number" && cost > 0) bits.push(`$${cost.toFixed(4)}`);
  return bits.join(" · ");
}

let toastTimer = null;
export function toast(message, opts = {}) {
  const t = $("toast");
  if (!t) return;
  t.textContent = String(message);
  t.dataset.kind = opts.kind || "info";
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), opts.ms || (opts.kind === "error" ? 5200 : 2600));
}

export function debounce(fn, ms = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => toast("Copied")).catch(() => {});
      return;
    }
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand("copy");
    toast("Copied");
  } catch {}
  ta.remove();
}

// Error collector for tests and diagnostics (window.__errs).
window.addEventListener("error", (e) => {
  (window.__errs = window.__errs || []).push(String(e.message || e));
});
window.addEventListener("unhandledrejection", (e) => {
  (window.__errs = window.__errs || []).push(String((e.reason && e.reason.message) || e.reason || "unhandled rejection"));
});
