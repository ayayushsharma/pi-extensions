// dom — tiny element helpers. No innerHTML anywhere model content is involved.
export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, String(v));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function show(node, visible) {
  node.classList.toggle("hidden", !visible);
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const t = $("toast");
  if (!t) return;
  t.textContent = message;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

export function fmtTime(ts) {
  if (!ts) return "";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function shortCwd(cwd) {
  if (!cwd) return "";
  const home = cwd.replace(/^\/data\/data\/com\.termux\/files\/home/, "~").replace(/^\/home\/[^/]+/, "~");
  const parts = home.split("/").filter(Boolean);
  return parts.length <= 3 ? home : `…/${parts.slice(-2).join("/")}`;
}

export function usageLabel(usage) {
  if (!usage) return "";
  const tok = usage.totalTokens || (usage.input || 0) + (usage.output || 0);
  const cost = usage.cost?.total;
  return `${tok ? `${(tok / 1000).toFixed(1)}k tok` : ""}${cost !== undefined ? ` · $${Number(cost).toFixed(3)}` : ""}`;
}

window.addEventListener("error", (e) => {
  (window.__errs = window.__errs || []).push(String(e.message || e));
});
window.addEventListener("unhandledrejection", (e) => {
  (window.__errs = window.__errs || []).push(String((e.reason && e.reason.message) || e.reason || "unhandled rejection"));
});
