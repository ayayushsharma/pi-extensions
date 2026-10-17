// transcript — renders history entries and live runner events into one list.
import { el, usageLabel } from "../core/dom.js";
import { renderMarkdown } from "./markdown.js";
import { createToolCard, finishToolCard } from "./toolcard.js";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function imageNodes(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === "image" && typeof b.data === "string")
    .map((b) =>
      el("img", {
        src: `data:${b.mimeType || "image/png"};base64,${b.data}`,
        alt: "image",
        loading: "lazy",
      }),
    );
}

function messageRoleLabel(role) {
  return role === "user" ? "you" : role === "assistant" ? "assistant" : role;
}

export function createTranscript(container, hooks = {}) {
  const toolCards = new Map();
  let pending = null; // streaming assistant { node, textWrap, thinkingWrap }
  const nodeForEntry = new Map();

  function atBottom() {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
  }

  function scrollToBottom() {
    container.scrollTop = container.scrollHeight;
  }

  function autoscroll(wasAtBottom) {
    if (wasAtBottom) scrollToBottom();
  }

  function userNode(message) {
    const bubble = el("div", { class: "bubble" });
    const text = textOf(message.content);
    if (text) bubble.append(renderMarkdown(text));
    for (const img of imageNodes(message.content)) bubble.append(img);
    return el("div", { class: "msg user" }, el("div", { class: "role", text: "you" }), bubble);
  }

  function assistantNode(message) {
    const wrap = el("div", { class: "msg assistant" }, el("div", { class: "role", text: "assistant" }));
    renderAssistantBlocks(wrap, message);
    if (message?.usage) wrap.append(el("div", { class: "usage", text: usageLabel(message.usage) }));
    return wrap;
  }

  function renderAssistantBlocks(wrap, message) {
    for (const block of message?.content || []) {
      if (block?.type === "text" && block.text) wrap.append(el("div", { class: "bubble" }, renderMarkdown(block.text)));
      else if (block?.type === "thinking" && block.thinking) wrap.append(el("div", { class: "thinking", text: block.thinking }));
      else if (block?.type === "toolCall") {
        const card = createToolCard(block.id, block.name, block.arguments || {});
        toolCards.set(block.id, card);
        wrap.append(card);
      }
    }
    if (message?.stopReason && message.stopReason !== "stop" && message.stopReason !== "toolUse") {
      wrap.append(el("div", { class: "meta", text: `stopped: ${message.stopReason}` }));
    }
  }

  function toolResultNode(message) {
    const card = toolCards.get(message.toolCallId);
    if (card) finishToolCard(card, message.content, message.isError);
    return null;
  }

  function compactionNode(entry) {
    return el(
      "div",
      { class: "msg system" },
      el("div", { class: "bubble" }, el("strong", { text: "Compacted" }), entry.summary ? el("div", { text: String(entry.summary).slice(0, 2000) }) : null),
    );
  }

  function entryNode(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg?.role === "user") return userNode(msg);
      if (msg?.role === "assistant") return assistantNode(msg);
      if (msg?.role === "toolResult") return toolResultNode(msg);
      if (msg?.role === "custom" || msg?.role === "system") {
        const text = textOf(msg.content);
        return text ? el("div", { class: "msg system" }, el("div", { class: "bubble", text })) : null;
      }
      return null;
    }
    if (entry.type === "compaction") return compactionNode(entry);
    if (entry.type === "branch_summary") {
      return el("div", { class: "msg system" }, el("div", { class: "bubble", text: `Branch summary: ${entry.summary || ""}` }));
    }
    if (entry.type === "custom_message") {
      const text = textOf(entry.content);
      return text ? el("div", { class: "msg system" }, el("div", { class: "bubble", text })) : null;
    }
    return null;
  }

  function renderHistory(entries, meta) {
    toolCards.clear();
    pending = null;
    nodeForEntry.clear();
    container.replaceChildren();
    for (const entry of entries || []) {
      const node = entryNode(entry);
      if (node) {
        nodeForEntry.set(entry.id, node);
        container.append(node);
      }
    }
    if (!container.childElementCount) {
      container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text: meta?.sessionName || "Empty session — say something." })));
    }
    scrollToBottom();
  }

  function prependHistory(entries) {
    const wasAtBottom = atBottom();
    const frag = document.createDocumentFragment();
    for (const entry of entries || []) {
      const node = entryNode(entry);
      if (node) {
        nodeForEntry.set(entry.id, node);
        frag.append(node);
      }
    }
    container.prepend(frag);
    if (wasAtBottom) scrollToBottom();
  }

  function handleEvent(event) {
    if (!event || typeof event !== "object") return;
    const wasAtBottom = atBottom();
    switch (event.type) {
      case "message_start": {
        const msg = event.message;
        if (msg?.role === "user") {
          container.append(userNode(msg));
        } else if (msg?.role === "assistant") {
          const node = el("div", { class: "msg assistant" }, el("div", { class: "role", text: "assistant" }));
          const textWrap = el("div", { class: "bubble" });
          const thinkingWrap = el("div", { class: "thinking hidden" });
          node.append(thinkingWrap, textWrap);
          container.append(node);
          pending = { node, textWrap, thinkingWrap, text: "", thinking: "" };
        }
        break;
      }
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (!pending || !inner) break;
        if (inner.type === "text_delta" && inner.delta) {
          pending.text += inner.delta;
          pending.textWrap.replaceChildren(renderMarkdown(pending.text));
        } else if (inner.type === "thinking_delta" && inner.delta) {
          pending.thinking += inner.delta;
          pending.thinkingWrap.classList.remove("hidden");
          pending.thinkingWrap.textContent = pending.thinking;
        }
        break;
      }
      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant") {
          if (pending) {
            const wrap = pending.node;
            const usage = msg.usage;
            wrap.replaceChildren(el("div", { class: "role", text: "assistant" }));
            renderAssistantBlocks(wrap, msg);
            if (usage) wrap.append(el("div", { class: "usage", text: usageLabel(usage) }));
            pending = null;
          } else {
            container.append(assistantNode(msg));
          }
        } else if (msg?.role === "user") {
          // already appended on message_start
        } else if (msg?.role === "toolResult") {
          toolResultNode(msg);
        } else if (msg?.role === "custom") {
          const text = textOf(msg.content);
          if (text) container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text })));
        }
        break;
      }
      case "tool_execution_start": {
        const card = createToolCard(event.toolCallId, event.toolName, event.args);
        toolCards.set(event.toolCallId, card);
        container.append(card);
        break;
      }
      case "tool_execution_end": {
        const card = toolCards.get(event.toolCallId);
        finishToolCard(card, event.result, event.isError);
        break;
      }
      case "compaction_start":
        container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text: `Compacting… (${event.reason || "manual"})` })));
        break;
      case "compaction_end":
        if (event.errorMessage) {
          container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text: `Compaction failed: ${event.errorMessage}` })));
        } else {
          container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text: event.summary ? `Compacted: ${String(event.summary).slice(0, 2000)}` : "Compacted" })));
        }
        break;
      case "runner_exit":
        container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text: `Session ended (${event.reason || `code ${event.code}`})` })));
        break;
      default:
        break;
    }
    autoscroll(wasAtBottom);
  }

  container.addEventListener("click", (e) => {
    const a = e.target.closest?.("[data-file]");
    if (a) hooks.onOpenFile?.(a.dataset.file);
  });

  return { renderHistory, prependHistory, handleEvent, scrollToBottom, clear: () => container.replaceChildren(), toolCards };
}
