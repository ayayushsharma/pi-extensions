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

/** History image allowlist — mirrors protocol.ts isValidMessageImage (the
 *  browser cannot import the .ts sources, so the check is duplicated here).
 *  <img> context is already scriptless, but invalid blocks still render as
 *  broken icons and hostile sizes bloat the DOM, so drop them silently.
 *
 *  Normalization matches tau-web's hardened renderer: legacy blocks may
 *  omit mimeType (default png, as pi's own fallback) or carry a full
 *  `data:` URL instead of raw base64. Rejecting those would hide images
 *  from perfectly valid old sessions. */
const VALID_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function normalizeImage(block) {
  if (!block || typeof block !== "object") return null;
  let data = typeof block.data === "string" ? block.data : "";
  let mimeType = String(block.mimeType || "").toLowerCase();
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    if (comma < 0) return null;
    const header = data.slice(0, comma);
    if (!/;base64$/i.test(header)) return null;
    const m = /^data:([^;,]+)/i.exec(header);
    if (!m) return null;
    mimeType = (m[1] || "").toLowerCase();
    data = data.slice(comma + 1);
  }
  if (!mimeType) mimeType = "image/png";
  if (!VALID_IMAGE_MIMES.has(mimeType)) return null;
  if (!data || data.length > 8 * 1024 * 1024) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  return { mimeType, data };
}

function imageNodes(content) {
  if (!Array.isArray(content)) return null;
  const images = content.map((b) => (b?.type === "image" ? normalizeImage(b) : null)).filter(Boolean);
  if (!images.length) return null;
  const grid = el("div", { class: "image-grid" });
  for (const b of images) grid.append(el("img", { src: `data:${b.mimeType};base64,${b.data}`, alt: "image", loading: "lazy" }));
  return grid;
}

export function createTranscript(container, opts = {}) {
  const settings = { showThinking: true, showCosts: true, expandTools: false, streamRender: "live", toolOutput: "text", ...opts };
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
    // Nothing to reveal: scrolling the shared #view here would push the
    // home screen's welcome block out of sight.
    if (!container.childElementCount) return;
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
    return el("div", { class: "msg user" }, bubble);
  }

  function assistantMessageNode(message) {
    const wrap = el("div", { class: "msg assistant" });
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
        // One card per tool call id: the start event may already have
        // rendered it (no streaming message alive at the time), so adopt
        // the live card instead of painting a running duplicate next to it.
        let card = toolCards.get(block.id);
        if (!card) {
          card = createToolCard(block.id, block.name, block.arguments || {}, { expanded: settings.expandTools, cwd: sessionCwd });
          toolCards.set(block.id, card);
        } else {
          // The end message is authoritative: refresh the stash so the
          // finish paints full args even if the start arrived partial.
          card.toolName = block.name;
          card.toolArgs = block.arguments;
        }
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
    if (card) finishToolCard(card, message.content, message.isError, { expand: settings.expandTools, outputMode: settings.toolOutput });
  }

  function systemNode(text, kind = "") {
    return el("div", { class: `msg system ${kind}` }, el("div", { class: "bubble", text }));
  }

  /** Inline note about something that happened *in this session* — an
   *  extension/skill notification or a command's own feedback. It is part of
   *  the transcript, so it does not vanish after a couple of seconds (like a
   *  toast) and it is gone the next time history renders (resume/reload),
   *  which is exactly the lifetime a session-scoped note should have. */
  function notice(text, { kind = "info" } = {}) {
    const message = String(text ?? "").trim();
    if (!message) return null;
    const node = el(
      "div",
      { class: `msg system notice ${kind}` },
      el(
        "div",
        { class: "bubble" },
        icon(kind === "error" || kind === "warning" ? "alert" : "info", 13),
        el("span", { class: "notice-text", text: message }),
      ),
    );
    container.append(node);
    if (stick) scrollToBottom();
    return node;
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
    trimCount = 0;
    trimWrap = null;
    trimBtn = null;
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
    // `meta === null` means "empty the pane" (home screen / closed tab): no
    // placeholder, no scroll, nothing for the ResizeObserver to pin.
    if (meta && !container.childElementCount) {
      const text = meta.loading
        ? "Loading session…"
        : meta.sessionName
          ? `${meta.sessionName} — no messages yet.`
          : "New session — send a message to start.";
      container.append(el("div", { class: "msg system" }, el("div", { class: "bubble", text })));
    }
    stick = !!meta;
    if (meta) scrollToBottom();
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
  /* R6: the transcript DOM is windowed. History arrives in pages of 50, but
     a long live session appends forever — past TRIM_CAP nodes the oldest
     are dropped from the DOM (never from the file) with a count + a way
     back. The pending streaming node always sits at the bottom, so
     top-trimming can never eat the reply in flight; a tool result landing
     after its card was trimmed has nowhere to paint (rare past 300). */
  const TRIM_CAP = 300;
  let trimCount = 0;
  let trimWrap = null;
  let trimBtn = null;

  function renderTrimNote() {
    if (trimCount <= 0) {
      trimWrap?.remove();
      trimWrap = null;
      trimBtn = null;
      return;
    }
    if (!trimWrap) {
      trimBtn = el("button", { class: "btn small", type: "button", onclick: () => opts.onLoadEarlier?.() });
      trimWrap = el("div", { class: "trim-note" }, trimBtn);
    }
    trimBtn.textContent = `Show earlier (${trimCount} hidden from view)`;
    if (container.firstChild !== trimWrap) container.prepend(trimWrap);
  }

  function maybeTrim() {
    let removedH = 0;
    let removed = 0;
    while (container.childElementCount > TRIM_CAP + (trimWrap ? 1 : 0)) {
      const first = trimWrap && container.firstChild === trimWrap ? trimWrap.nextSibling : container.firstChild;
      if (!first || first === pending?.node) break;
      removedH += first.offsetHeight || 0;
      first.remove();
      removed++;
    }
    if (!removed) return;
    trimCount += removed;
    renderTrimNote();
    // Dropping nodes above the viewport would yank the reader upward: pay
    // back the removed height unless we pin to the bottom below anyway.
    if (!stick) scrollerEl().scrollTop -= removedH;
  }
  /* Re-rendering the whole accumulated reply every frame is O(n) per frame
     over the stream — O(n²) for a long reply, and the jank lands on phones
     first. So full markdown paints are throttled once the reply grows, and
     "format on completion" mode skips parsing mid-stream entirely (one text
     node, formatted once at message_end). */
  let lastStreamPaint = 0;

  function flushPending() {
    flushQueued = false;
    if (!pending) return;
    if (pending.textWrap) {
      const settled = settings.streamRender === "settled";
      pending.textWrap.classList.toggle("stream-plain", settled);
      const now = performance.now();
      const long = pending.text.length > 6000;
      if (!long || now - lastStreamPaint >= 150) {
        lastStreamPaint = now;
        if (settled) pending.textWrap.textContent = pending.text;
        else pending.textWrap.replaceChildren(renderMarkdown(pending.text));
      } else if (!flushQueued) {
        // Throttled away: paint after the window so a paused stream never
        // leaves a stale tail (message_end paints the final state anyway).
        flushQueued = true;
        setTimeout(flushPending, 160);
      }
    }
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
          const node = el("div", { class: "msg assistant streaming" });
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
            wrap.replaceChildren();
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
        // The end-of-message render may already own this id (adopted above)
        // or the same start may redeliver: never paint a second card.
        if (toolCards.has(event.toolCallId)) break;
        const card = createToolCard(event.toolCallId, event.toolName, event.args || {}, { expanded: settings.expandTools, cwd: sessionCwd });
        toolCards.set(event.toolCallId, card);
        const host = pending?.node || container;
        host.append(card);
        break;
      }
      case "tool_execution_end": {
        const card = toolCards.get(event.toolCallId);
        finishToolCard(card, event.result, event.isError, { expand: settings.expandTools, outputMode: settings.toolOutput });
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
    maybeTrim();
    if (wasAtBottom) scrollToBottom();
  }

  container.addEventListener("click", (e) => {
    const fileEl = e.target.closest?.("[data-file]");
    if (fileEl) opts.onOpenFile?.(fileEl.dataset.file);
  });

  return {
    renderHistory,
    notice,
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
