/**
 * toolcard — collapsible tool call card: status, argument hint, inputs and
 * output, copy. Running cards stay open; finished cards collapse unless the
 * user pinned them open or "Expand tool calls" is enabled in settings.
 */
import { el, copyText, shortenPath } from "../core/dom.js";
import { icon } from "../core/icons.js";

const TOOL_ICON = {
  bash: "terminal",
  read: "file",
  write: "pencil",
  edit: "pencil",
  grep: "search",
  glob: "search",
  webfetch: "external",
  websearch: "search",
  task: "branch",
};

function hintOf(name, args = {}, cwd = "") {
  const short = (p) => shortenPath(p, cwd);
  switch (name) {
    case "bash":
      return args.command || "";
    case "read":
    case "write":
    case "edit":
      return short(args.path || args.file_path || "");
    case "grep":
    case "glob":
    case "search":
      return args.pattern || args.query || "";
    case "webfetch":
      return args.url || "";
    default:
      return short(args.path || args.file_path || "");
  }
}

function argText(args) {
  if (!args || typeof args !== "object") return "";
  try {
    const text = JSON.stringify(args, null, 2);
    return text && text !== "{}" ? text.slice(0, 20000) : "";
  } catch {
    return "";
  }
}

function diffBlock(oldText, newText) {
  const wrap = el("div", { class: "diff" });
  for (const l of String(oldText ?? "").split("\n")) if (l) wrap.append(el("div", { class: "del", text: `- ${l}` }));
  for (const l of String(newText ?? "").split("\n")) if (l) wrap.append(el("div", { class: "add", text: `+ ${l}` }));
  return wrap;
}

export function createToolCard(toolCallId, name, args, { expanded = false, cwd = "" } = {}) {
  const hint = hintOf(name, args || {}, cwd);
  const full = hintOf(name, args || {});
  const body = el("div", { class: "tool-body" });
  const status = el("span", { class: "tool-status", text: "running" });
  const card = el(
    "details",
    { class: "tool", dataset: { toolId: toolCallId || "", toolName: name || "tool", status: "running" }, open: expanded ? "" : undefined },
    el(
      "summary",
      full && full !== hint ? { title: full } : {},
      icon(TOOL_ICON[name] || "chip", 13),
      el("span", { class: "tool-name", text: name || "tool" }),
      hint ? el("span", { class: "tool-hint", text: hint.slice(0, 160) }) : null,
      status,
    ),
    body,
  );

  // User choice sticks: manual toggles disable auto-collapse on finish.
  let userToggled = false;
  card.addEventListener("toggle", () => {
    if (card.dataset.pinned === "1") userToggled = true;
  });
  card.dataset.pinned = userToggled ? "1" : "0";

  renderArgs(body, name, args);
  // Stashed for finish: the finished card shows inputs above the output.
  card.toolName = name;
  card.toolArgs = args;
  return card;
}

function inputNodes(name, args) {
  const nodes = [];
  if ((name === "edit" || name === "write") && args) {
    const edits = Array.isArray(args.edits) ? args.edits : args.oldText !== undefined || args.newText !== undefined ? [args] : [];
    if (edits.length) {
      for (const e of edits) nodes.push(diffBlock(e.oldText, e.newText));
      return nodes;
    }
    if (args.content !== undefined) {
      nodes.push(el("pre", { text: String(args.content).slice(0, 20000) }));
      return nodes;
    }
  }
  const text = argText(args);
  if (text) nodes.push(el("pre", { text }));
  return nodes;
}

function renderArgs(body, name, args) {
  body.replaceChildren();
  const nodes = inputNodes(name, args);
  if (nodes.length) body.append(...nodes);
  else body.append(el("div", { class: "meta", style: "padding:8px 12px", text: "running…" }));
}

/** Tool result content to display text. Content-block arrays (the usual
 *  `[{type:"text", text}, …]` shape) render as their joined text in readable
 *  mode so Output reads as output, not JSON; raw mode keeps the dump. */
function outputNodes(result, outputMode) {
  const nodes = [];
  const content = typeof result === "string" ? result : result?.content ?? result;
  let text = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && outputMode !== "raw") {
    const parts = content.filter((b) => b?.type === "text").map((b) => b.text || "");
    if (parts.length) text = parts.join("\n");
  }
  if (text === null) {
    if (content !== undefined && content !== null && content !== "" && typeof content === "object") {
      try {
        text = JSON.stringify(content, null, 2);
      } catch {
        return { nodes, copyable: "", empty: true, unserializable: true };
      }
    } else if (!content && content !== 0) {
      return { nodes, copyable: "", empty: true };
    } else text = String(content);
  }
  if (text) {
    nodes.push(el("pre", { text: text.slice(0, 60000) }));
    if (text.length > 60000) nodes.push(el("div", { class: "truncated", text: `… truncated (${text.length} chars)` }));
  }
  return { nodes, copyable: text || "", empty: !text };
}

export function finishToolCard(card, result, isError, { expand = false, outputMode = "text" } = {}) {
  if (!card) return;
  card.dataset.status = isError ? "error" : "done";
  const status = card.querySelector(".tool-status");
  if (status) status.textContent = isError ? "error" : "done";
  const body = card.querySelector(".tool-body");
  if (!body) return;
  const scrollTop = body.querySelector("pre")?.scrollTop || 0;
  body.replaceChildren();

  // Inputs stay visible above the output (edit diffs, bash commands, …).
  const inputs = inputNodes(card.toolName, card.toolArgs);
  if (inputs.length) body.append(el("div", { class: "tool-section-label", text: "Input" }), ...inputs);

  const outLabel = inputs.length ? el("div", { class: "tool-section-label", text: "Output" }) : null;

  const out = outputNodes(result, outputMode);
  if (outLabel) body.append(outLabel);
  if (out.nodes.length) body.append(...out.nodes);
  else if (out.unserializable) body.append(el("div", { class: "truncated", text: "unserializable result" }));
  else if (out.empty) body.append(el("div", { class: "truncated", text: isError ? "no output" : "done" }));

  const pre = body.querySelector("pre");
  if (pre) pre.scrollTop = scrollTop;

  const copy = el("button", {
    class: "btn small",
    type: "button",
    text: "Copy output",
    style: "margin:6px 12px 8px",
    onclick: () => copyText(out.copyable),
  });
  body.append(copy);

  if (!expand && card.dataset.pinned !== "1") card.open = false;
}
