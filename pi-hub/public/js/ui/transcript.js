/**
 * transcript — renders history entries and live runner events into one list.
 * DOM-built only; auto-scrolls only when the user is already at the bottom so
 * reading history is never yanked away. Deltas are batched per animation frame.
 */
import { el, usageText } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { renderMarkdown } from "./markdown.js";
import { createToolCard, finishToolCard } from "./toolcard.js";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n");
  return "";
}

function imageNodes(content) {
  if (!Array.isArray(content)) return null;
  const images = content.filter((b) => b?.type === "image" && typeof b.data === "string");
  if (!images.length) return null;
  const grid = el("div", { class: "image-grid" });
  for (const b of images) grid.append(el("img", { src: `data:${b.mimeType || "image/png"};base64,${b.data}`, alt: "image", loading: "lazy" }));
  return grid;
}

export function createTranscript(container, opts = {}) {
  const settings = { showThinking: true, showCosts: true, expandTools: false, ...opts };
  const toolCards = new Map();
  let sessionCwd = ""; // refreshed on every history load; shortens tool paths
  const nodeForEntry = new Map();
  let pending = null; // streaming assistant
  let flushQueued = false;

  /* #messages is NOT the scroller: the shell scrolls an ancestor (#view) on
     both mobile and desktop, so all scroll math must resolve that element.
     Getting this wrong made every scrollToBottom() a silent no-op, which is
     why a resumed session opened at the top of its transcript. */
  function scrollerEl() {
    for (let n = container.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return document.scrollingElement || document.documentElement;
  }

  const bottomGap = () => {
    const s = scrollerEl();
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  };
  const atBottom = () => bottomGap() < 140;

  function scrollToBottom() {
    const s = scrollerEl();
    s.scrollTop = s.scrollHeight;
    ownScroll = s.scrollTop; // ignore the scroll event this write will fire
  }

  // Stay pinned to the newest message while the transcript grows (markdown,
  // fonts, images, streaming) unless the reader scrolled away. A ResizeObserver
  // also covers the pane being hidden at render time and revealed later.
  let stick = true;
  let ownScroll = -1;
  document.addEventListener("scroll", (e) => {
    if (e.target !== scrollerEl()) return;
    if (Math.abs(e.target.scrollTop - ownScroll) < 2) {
      ownScroll = -1;
      return;
    }
    stick = atBottom();
  }, true);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (stick) scrollToBottom();
    }).observe(container);
  }

  /* ── nodes ───────────────────────────────────────────────────────── */
  function userNode(message) {
    const bubble = el("div", { class: "bubble" });
    const text = textOf(message.content);
    if (text) bubble.append(renderMarkdown(text));
    const imgs = imageNodes(message.content);
    if (imgs) bubble.append(imgs);
    return el("div", { class: "msg user" }, el("div", { class: "role", text: "You" }), bubble);
  }

  function assistantMessageNode(message) {
    const wrap = el("div", { class: "msg assistant" }, el("div", { class: "role", text: "Pi" }));
    renderAssistantBlocks(wrap, message);
    if (message?.usage && settings.showCosts) {
      const t = usageText({ usage: message.usage });
      if (t) wrap.append(el("div", { class: "usage", text: t }));
    }
    return wrap;
  }

  function thinkingNode(text, { streaming = false } = {}) {
    const body = el("div", { class: "think-body", text });
    const details = el(
      "details",
      { class: "thinking", open: streaming ? "" : undefined },
      el("summary", {}, icon("eye", 12), el("span", { text: "Thinking…" })),
      body,
    );
    if (!settings.showThinking) details.classList.add("hidden");
    return details;
  }

  function renderAssistantBlocks(wrap, message) {
    for (const block of message?.content || []) {
      if (block?.type === "text" && block.text) wrap.append(el("div", { class: "bubble" }, renderMarkdown(block.text)));
      else if ((block?.type === "thinking" || block?.type === "reasoning") && (block.thinking || block.text)) {
        wrap.append(thinkingNode(block.thinking || block.text));
      } else if (block?.type === "toolCall") {
        const card = createToolCard(block.id, block.name, block.arguments || {}, { expanded: settings.expandTools, cwd: sessionCwd });
        toolCards.set(block.id, card);
        wrap.append(card);
      }
    }
    if (message?.stopReason && !["stop", "toolUse", "length"].includes(message.stopReason)) {
      wrap.append(el("div", { class: "meta", text: `stopped: ${message.stopReason}` }));
    }
    const imgs = imageNodes(message?.content);
    if (imgs) wrap.append(imgs);
  }

  function toolResultNode(message) {
    const card = toolCards.get(message.toolCallId);
    if (card) finishToolCard(card, message.content, message.isError, { expand: settings.expandTools });
  }

  function systemNode(text, kind = "") {
    return el("div", { class: `msg system ${kind}` }, el("div", { class: "bubble", text }));
  }

  function entryNode(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg?.role === "user") return userNode(msg);
      if (msg?.role === "assistant") return assistantMessageNode(msg);
      if (msg?.role === "toolResult") return toolResultNode(msg);
      const text = textOf(msg?.content);
      return text ? systemNode(text) : null;
    }
    if (entry.type === "compaction") {
      return systemNode(`Compacted${entry.summary ? `: ${String(entry.summary).slice(0, 2000)}` : ""}`);
    }
    if (entry.type === "branch_summary") return systemNode(`Branch summary: ${entry.summary || ""}`);
    if (entry.type === "custom_message") {
      const text = textOf(entry.content);
      return text ? systemNode(text) : null;
    }
    return null;
  }

  /* ── history ─────────────────────────────────────────────────────── */
  function renderHistory(entries, meta) {
    toolCards.clear();
    nodeForEntry.clear();
    if (meta?.cwd) sessionCwd = meta.cwd;
    pending = null;
    container.replaceChildren();
    for (const entry of entries || []) {
      const node = entryNode(entry);
      if (node) {
        nodeForEntry.set(entry.id, node);
        container.append(node);
      }
    }
    if (!container.childElementCount) {
      const text = meta?.loading
        ? "Loading session…"
        : meta?.sessionName
          ? `${meta.sessionName} — no messages yet.`
          : "New session — send a message to start.";
      container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text })));
    }
    stick = true;
    scrollToBottom();
  }

  function prependHistory(entries) {
    const wasAtBottom = atBottom();
    const before = scrollerEl().scrollHeight;
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
    else scrollerEl().scrollTop += scrollerEl().scrollHeight - before;
  }

  /* ── live events ─────────────────────────────────────────────────── */
  function flushPending() {
    flushQueued = false;
    if (!pending) return;
    if (pending.textWrap) pending.textWrap.replaceChildren(renderMarkdown(pending.text));
    if (pending.thinkBody && pending.thinking) pending.thinkBody.textContent = pending.thinking;
    if (pending.thinkDetails) pending.thinkDetails.classList.toggle("hidden", !settings.showThinking);
  }

  function scheduleFlush() {
    if (flushQueued) return;
    flushQueued = true;
    requestAnimationFrame(flushPending);
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
          const node = el("div", { class: "msg assistant streaming" }, el("div", { class: "role", text: "Pi" }));
          const textWrap = el("div", { class: "bubble" });
          node.append(textWrap);
          container.append(node);
          pending = { node, textWrap, thinking: "", text: "", thinkDetails: null, thinkBody: null };
        }
        break;
      }
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (!pending || !inner) break;
        if (inner.type === "text_delta" && inner.delta) pending.text += inner.delta;
        else if ((inner.type === "thinking_delta" || inner.type === "reasoning_delta") && inner.delta) {
          pending.thinking += inner.delta;
          if (!pending.thinkDetails) {
            const details = thinkingNode("", { streaming: true });
            pending.thinkDetails = details;
            pending.thinkBody = details.querySelector(".think-body");
            pending.node.insertBefore(details, pending.textWrap);
          }
        }
        scheduleFlush();
        break;
      }
      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant") {
          if (pending) {
            const wrap = pending.node;
            wrap.classList.remove("streaming");
            wrap.replaceChildren(el("div", { class: "role", text: "Pi" }));
            renderAssistantBlocks(wrap, msg);
            if (msg.usage && settings.showCosts) {
              const t = usageText({ usage: msg.usage });
              if (t) wrap.append(el("div", { class: "usage", text: t }));
            }
            if (pending.thinkDetails) pending.thinkDetails.open = false;
            pending = null;
          } else {
            container.append(assistantMessageNode(msg));
          }
        } else if (msg?.role === "toolResult") {
          toolResultNode(msg);
        } else if (msg?.role === "user") {
          // rendered on message_start
        } else {
          const text = textOf(msg?.content);
          if (text) container.append(systemNode(text));
        }
        break;
      }
      case "tool_execution_start": {
        const card = createToolCard(event.toolCallId, event.toolName, event.args || {}, { expanded: settings.expandTools, cwd: sessionCwd });
        toolCards.set(event.toolCallId, card);
        const host = pending?.node || container;
        host.append(card);
        break;
      }
      case "tool_execution_end": {
        const card = toolCards.get(event.toolCallId);
        finishToolCard(card, event.result, event.isError, { expand: settings.expandTools });
        break;
      }
      case "compaction_start":
        container.append(systemNode(`Compacting context (${event.reason || "manual"})…`));
        break;
      case "compaction_end":
        container.append(
          event.errorMessage
            ? systemNode(`Compaction failed: ${event.errorMessage}`, "error")
            : systemNode(event.summary ? `Compacted: ${String(event.summary).slice(0, 2000)}` : "Compacted"),
        );
        break;
      case "runner_exit":
        container.append(systemNode(`Session ended${event.reason ? `: ${event.reason}` : event.code != null ? ` (code ${event.code})` : ""}`));
        break;
      default:
        break;
    }
    if (wasAtBottom) scrollToBottom();
  }

  container.addEventListener("click", (e) => {
    const fileEl = e.target.closest?.("[data-file]");
    if (fileEl) opts.onOpenFile?.(fileEl.dataset.file);
  });

  return {
    renderHistory,
    prependHistory,
    handleEvent,
    scrollToBottom,
    clear: () => container.replaceChildren(),
    setOptions(patch) {
      Object.assign(settings, patch);
      for (const node of container.querySelectorAll(".thinking")) node.classList.toggle("hidden", !settings.showThinking);
      for (const node of container.querySelectorAll(".usage")) node.classList.toggle("hidden", !settings.showCosts);
    },
  };
}
