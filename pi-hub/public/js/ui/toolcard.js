// toolcard — collapsible tool call with a lightweight edit diff.
import { el } from "../core/dom.js";

function summarize(name, args = {}) {
  switch (name) {
    case "bash":
      return args.command || "";
    case "read":
    case "write":
    case "edit":
      return args.path || args.file_path || "";
    case "grep":
    case "search":
      return args.pattern || args.query || "";
    default:
      return "";
  }
}

function diffBlock(oldText, newText) {
  const oldLines = String(oldText ?? "").split("\n");
  const newLines = String(newText ?? "").split("\n");
  const wrap = el("div", { class: "diff" });
  for (const l of oldLines) if (l) wrap.append(el("div", { class: "del", text: `- ${l}` }));
  for (const l of newLines) if (l) wrap.append(el("div", { class: "add", text: `+ ${l}` }));
  return wrap;
}

export function createToolCard(toolCallId, name, args) {
  const body = el("div", { class: "tool-body" });
  const card = el(
    "details",
    { class: "tool", dataset: { toolId: toolCallId || "" }, open: "" },
    el("summary", {}, el("strong", { text: name || "tool" }), summarize(name, args) ? el("span", { text: ` · ${summarize(name, args).slice(0, 120)}` }) : null),
    body,
  );
  if ((name === "edit" || name === "write") && args) {
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) body.append(diffBlock(e.oldText, e.newText));
    } else if (args.oldText !== undefined || args.newText !== undefined) {
      body.append(diffBlock(args.oldText, args.newText));
    } else if (args.content) {
      body.append(el("pre", { text: String(args.content).slice(0, 20000) }));
    }
  } else if (args && Object.keys(args).length) {
    try {
      body.append(el("pre", { text: JSON.stringify(args, null, 2).slice(0, 20000) }));
    } catch {}
  } else {
    body.append(el("div", { class: "meta", text: "running…" }));
  }
  return card;
}

export function finishToolCard(card, result, isError) {
  if (!card) return;
  card.dataset.error = isError ? "true" : "false";
  const body = card.querySelector(".tool-body");
  if (!body) return;
  body.replaceChildren();
  if (isError) body.append(el("div", { class: "del", text: "error" }));
  const text = typeof result === "string" ? result : result?.content ?? result;
  if (typeof text === "string") {
    body.append(el("pre", { text: text.slice(0, 40000) }));
    if (text.length > 40000) body.append(el("div", { class: "meta", text: `… truncated (${text.length} chars)` }));
  } else if (text !== undefined) {
    try {
      body.append(el("pre", { text: JSON.stringify(text, null, 2).slice(0, 40000) }));
    } catch {}
  } else {
    body.append(el("div", { class: "meta", text: "done" }));
  }
}
