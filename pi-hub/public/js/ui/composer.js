/**
 * composer — textarea, slash palette, queue/steer, images, model + thinking
 * menus. All side effects go through `actions`; this module owns no state.
 */
import { el, show, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function createComposer(refs, actions) {
  let commands = [];
  let sel = 0;
  let modelsLoaded = false;
  let models = [];
  let currentModel = null;

  refs.sendBtn.append(icon("arrow-up", 16));
  refs.abortBtn.append(icon("square", 14));
  refs.micBtn.append(icon("mic", 15));
  refs.commandBtn.append(icon("plug", 15));
  refs.attachBtn.append(icon("image", 15));

  /* ── textarea ─────────────────────────────────────────────────────── */
  function autoGrow() {
    refs.input.style.height = "auto";
    refs.input.style.height = `${Math.min(refs.input.scrollHeight, window.innerHeight * 0.38)}px`;
  }
  refs.input.addEventListener("input", () => {
    autoGrow();
    updateSlash();
  });
  refs.input.addEventListener("keydown", (e) => {
    if (slashOpen()) {
      if (e.key === "ArrowDown") return move(1), e.preventDefault();
      if (e.key === "ArrowUp") return move(-1), e.preventDefault();
      if (e.key === "Enter" || e.key === "Tab") return apply(), e.preventDefault();
      if (e.key === "Escape") return hideSlash();
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Alt+Enter queues a follow-up for after the run (native pi's binding).
      send({ followUp: e.altKey });
    }
  });
  refs.form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  refs.abortBtn.addEventListener("click", () => actions.abort());

  /* ── slash palette ────────────────────────────────────────────────── */
  const slashOpen = () => !refs.slashEl.classList.contains("hidden");
  const slashItems = () => {
    const q = refs.input.value.slice(1).split(/\s/)[0].toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 14);
  };
  function updateSlash() {
    if (!refs.input.value.startsWith("/") || refs.input.value.includes("\n")) return hideSlash();
    if (!commands.length) {
      actions.listCommands().then((list) => {
        commands = list || [];
        if (refs.input.value.startsWith("/")) updateSlash();
      }).catch(() => {});
    }
    const list = slashItems();
    sel = Math.min(sel, Math.max(0, list.length - 1));
    refs.slashEl.replaceChildren();
    list.forEach((c, i) => {
      refs.slashEl.append(
        el(
          "button",
          {
            type: "button",
            class: `item${i === sel ? " sel" : ""}`,
            role: "option",
            "aria-selected": String(i === sel),
            onmouseenter: () => { sel = i; updateSlash(); },
            onclick: () => apply(),
          },
          el("span", { text: `/${c.name}` }),
          c.description ? el("span", { class: "sub", text: c.description }) : null,
        ),
      );
    });
    show(refs.slashEl, list.length > 0);
  }
  function move(d) {
    const list = slashItems();
    if (!list.length) return;
    sel = (sel + d + list.length) % list.length;
    updateSlash();
  }
  function apply() {
    const list = slashItems();
    if (!list.length) return;
    refs.input.value = `/${list[sel].name} `;
    refs.input.focus();
    hideSlash();
    autoGrow();
  }
  function hideSlash() {
    show(refs.slashEl, false);
  }

  /* ── images ───────────────────────────────────────────────────────── */
  let images = [];
  refs.attachBtn.addEventListener("click", () => refs.imageInput.click());
  refs.imageInput.addEventListener("change", async () => {
    for (const file of refs.imageInput.files || []) {
      if (!file.type.startsWith("image/")) {
        toast(`${file.name}: only images are supported`, { kind: "error" });
        continue;
      }
      if (file.size > 8 * 1024 * 1024) {
        toast(`${file.name}: too large (max 8 MB)`, { kind: "error" });
        continue;
      }
      const data = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
        fr.onerror = () => resolve("");
        fr.readAsDataURL(file);
      });
      if (data) images.push({ type: "image", data, mimeType: file.type, name: file.name });
    }
    refs.imageInput.value = "";
    renderImageChips();
  });
  const imageChips = el("div", { class: "queue hidden", style: "margin-bottom:6px" });
  refs.form.parentElement.insertBefore(imageChips, refs.queueEl);
  function renderImageChips() {
    imageChips.replaceChildren();
    for (const [i, img] of images.entries()) {
      imageChips.append(
        el(
          "span",
          { class: "q-pill" },
          el("img", { src: `data:${img.mimeType};base64,${img.data}`, alt: img.name || "image", style: "width:22px;height:22px;border-radius:5px;object-fit:cover" }),
          el("span", { class: "txt", text: img.name || "image" }),
          el("button", { class: "icon-btn", type: "button", style: "width:20px;height:20px", "aria-label": "Remove image", html: icon("x", 11).innerHTML, onclick: () => { images.splice(i, 1); renderImageChips(); } }),
        ),
      );
    }
    show(imageChips, images.length > 0);
  }

  /* ── queue ────────────────────────────────────────────────────────── */
  // Pills mirror pi's own queues (`queue_update` events), never a local echo:
  // steering lands after the current turn, follow-ups after the whole run.
  function renderQueue(queue) {
    refs.queueEl.replaceChildren();
    for (const q of queue) {
      const kind = q.kind === "followUp" ? "follow-up" : "steering";
      refs.queueEl.append(
        el("span", { class: `q-pill ${q.kind === "followUp" ? "later" : "steer"}`, title: kind === "steering" ? "Steering — delivered after the current turn" : "Follow-up — delivered when the run ends" },
          el("span", { class: "txt", text: q.text }),
        ),
      );
    }
    if (queue.length) {
      refs.queueEl.append(
        el("button", { class: "icon-btn", type: "button", title: "Restore queued messages to the editor", "aria-label": "Restore queued messages to the editor", html: icon("back", 12).innerHTML, onclick: () => actions.restoreQueue() }),
      );
    }
    show(refs.queueEl, queue.length > 0);
  }

  /* ── send ─────────────────────────────────────────────────────────── */
  async function send({ followUp = false } = {}) {
    const text = refs.input.value.trim();
    if (!text && !images.length) return;
    if (state_.binding) return;
    const payloadImages = images.slice();
    images = [];
    renderImageChips();
    refs.input.value = "";
    autoGrow();
    hideSlash();
    try {
      if (state_.streaming) {
        // Match native pi: Enter mid-run is a steering message; Alt+Enter is a
        // follow-up. pi queues both itself and reports them back via
        // `queue_update` — replaying them here would deliver the text twice.
        await (followUp ? actions.followUp(text, payloadImages) : actions.steer(text, payloadImages));
      } else {
        const files = actions.takePendingFiles();
        const message = text + (files.length ? `\n\n${files.map((f) => `@${f}`).join("\n")}` : "");
        await actions.prompt(message, payloadImages);
      }
    } catch (e) {
      actions.toast(e.message, { kind: "error" });
      refs.input.value = text;
      autoGrow();
    }
  }

  /* ── model / thinking menus ───────────────────────────────────────── */
  function closeMenus() {
    show(refs.modelMenu, false);
    show(refs.thinkingMenu, false);
    refs.modelBtn.setAttribute("aria-expanded", "false");
    refs.thinkingBtn.setAttribute("aria-expanded", "false");
  }
  document.addEventListener("click", closeMenus);
  refs.modelBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const wasOpen = !refs.modelMenu.classList.contains("hidden");
    closeMenus();
    if (wasOpen) return;
    if (!modelsLoaded) {
      try {
        models = (await actions.listModels()) || [];
        modelsLoaded = true;
      } catch {}
    }
    try {
      const st = await actions.getState();
      currentModel = st?.model || currentModel;
    } catch {}
    refs.modelMenu.replaceChildren();
    const search = el("input", {
      class: "menu-search", type: "text", placeholder: "Filter models…",
      "aria-label": "Filter models", autocomplete: "off",
      onclick: (ev) => ev.stopPropagation(),
    });
    search.addEventListener("input", () => renderModelItems(search.value));
    search.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") refs.modelMenu.querySelector(".item")?.click();
      if (ev.key === "Escape") closeMenus();
    });
    refs.modelMenu.append(search);
    renderModelItems("");
    show(refs.modelMenu, true);
    refs.modelBtn.setAttribute("aria-expanded", "true");
  });

  function renderModelItems(filter) {
    refs.modelMenu.querySelectorAll(".item,.meta").forEach((n) => n.remove());
    const q = String(filter || "").trim().toLowerCase();
    const list = models.filter((m) => !q || `${m.name || ""} ${m.id || ""} ${m.provider || ""}`.toLowerCase().includes(q));
    for (const m of list) {
      const selected = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
      refs.modelMenu.append(
        el(
          "button",
          {
            type: "button",
            class: "item",
            role: "option",
            "aria-selected": String(!!selected),
            onclick: () => {
              closeMenus();
              actions.setModel(m).catch((err) => actions.toast(err.message, { kind: "error" }));
            },
          },
          el("span", { text: m.name || m.id }),
          el("span", { class: "sub", text: m.provider || "" }),
        ),
      );
    }
    if (!list.length) {
      refs.modelMenu.append(el("div", {
        class: "meta", style: "padding:8px 10px",
        text: models.length ? `No models match “${String(filter || "").trim()}”` : "No models available",
      }));
    }
  }

  refs.thinkingBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const wasOpen = !refs.thinkingMenu.classList.contains("hidden");
    closeMenus();
    if (wasOpen) return;
    // Drop the previous model's items while the fresh query is in flight, so
    // the menu can never flash (or be read as) a stale level list.
    refs.thinkingMenu.replaceChildren();
    // Per-model levels from the backend (R-2); the static list is only the
    // fallback for unbound sessions, relays that cannot answer, and errors.
    let levels = THINKING_LEVELS;
    try {
      const offered = (await actions.listThinkingLevels()) || [];
      if (offered.length) levels = offered;
    } catch {}
    const current = state_.meta?.thinkingLevel || state_.bound?.thinkingLevel || "off";
    refs.thinkingMenu.replaceChildren();
    for (const level of levels) {
      refs.thinkingMenu.append(
        el("button", {
          type: "button",
          class: "item",
          role: "option",
          "aria-selected": String(level === current),
          onclick: () => {
            closeMenus();
            actions.setThinking(level).catch((err) => actions.toast(err.message, { kind: "error" }));
          },
        }, el("span", { text: level })),
      );
    }
    show(refs.thinkingMenu, true);
    refs.thinkingBtn.setAttribute("aria-expanded", "true");
  });

  refs.commandBtn.addEventListener("click", () => actions.openPicker());

  /* ── voice (optional) ─────────────────────────────────────────────── */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    refs.micBtn.classList.add("hidden");
  } else {
    let recog = null;
    let listening = false;
    refs.micBtn.addEventListener("click", () => {
      if (listening) {
        recog?.stop();
        return;
      }
      recog = new SR();
      recog.continuous = false;
      recog.interimResults = true;
      recog.lang = navigator.language || "en-US";
      const base = refs.input.value;
      recog.onresult = (ev) => {
        let text = "";
        for (const r of ev.results) text += r[0].transcript;
        refs.input.value = base ? `${base} ${text}` : text;
        autoGrow();
      };
      recog.onend = () => {
        listening = false;
        refs.micBtn.classList.remove("on");
      };
      recog.onerror = (ev) => {
        listening = false;
        refs.micBtn.classList.remove("on");
        if (ev.error !== "aborted") toast(`Mic: ${ev.error}`, { kind: "error" });
      };
      listening = true;
      refs.micBtn.classList.add("on");
      try {
        recog.start();
      } catch {
        listening = false;
        refs.micBtn.classList.remove("on");
      }
    });
  }

  /* ── render ───────────────────────────────────────────────────────── */
  let state_ = {};
  return {
    render(state) {
      state_ = state;
      const bound = state.bound;
      const previewing = bound?.kind === "live" && state.driving !== bound.id;
      const offline = state.connected === false;
      const disabled = !bound || state.binding || previewing || bound.state === "dead" || offline;
      refs.input.disabled = !!disabled;
      refs.sendBtn.disabled = !!disabled;
      refs.attachBtn.disabled = !!disabled;
      refs.input.placeholder = offline
        ? "Reconnecting to the hub…"
        : state.binding
          ? "Loading session…"
          : !bound
            ? "Pick or start a session…"
            : previewing
              ? "Preview only — press Drive to take over"
              : bound.state === "dead"
                ? "Session ended — resume to continue"
                : state.streaming
                  ? "Enter steers this turn · Alt+Enter queues a follow-up"
                  : "Ask anything, / for commands…";

      show(refs.abortBtn, !!state.streaming && !previewing);
      renderQueue(state.queue || []);
      renderImageChips();

      const rawModel = state.meta?.model || bound?.model || "model";
      const modelId = rawModel.includes("/") ? rawModel.split("/").pop() : rawModel;
      refs.modelLabel.textContent = modelId.length > 26 ? `${modelId.slice(0, 25)}…` : modelId;
      refs.modelBtn.title = rawModel;
      refs.thinkingLabel.textContent = state.meta?.thinkingLevel || bound?.thinkingLevel || "off";

      if (disabled) closeMenus();
    },
    focus: () => refs.input.focus(),
    setCommands(list) {
      commands = list || [];
    },
  };
}
