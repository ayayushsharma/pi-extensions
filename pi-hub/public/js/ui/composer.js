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
  refs.commandBtn.append(icon("commands", 15));
  refs.commandBtn.title = "Commands and skills (/)";
  refs.attachBtn.append(icon("image", 15));

  /* ── textarea ─────────────────────────────────────────────────────── */
  function autoGrow() {
    refs.input.style.height = "auto";
    // Never shrink below the resting height the stylesheet asks for (two
    // lines); below that the field reads like a one-line search box.
    const min = parseFloat(getComputedStyle(refs.input).minHeight) || 0;
    const max = window.innerHeight * 0.38;
    refs.input.style.height = `${Math.min(Math.max(refs.input.scrollHeight, min), max)}px`;
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

  /* ── commands + skills ────────────────────────────────────────────── */
  /* pi reports three sources: `extension` (its own slash commands),
     `prompt` templates and `skill:<name>` entries. The palette lists all of
     them with a source chip, fuzzy-filtered, so skills are reachable without
     knowing the `/skill:` prefix. */
  const SOURCE_LABEL = { skill: "skill", prompt: "prompt", extension: "command" };
  const SOURCE_RANK = { skill: 0, prompt: 1, extension: 2 };

  let commandsLoading = null;
  /** `force` refetches: pi's list changes when a skill/prompt/extension is
   *  added, and the first answer can predate a freshly installed one. */
  async function loadCommands(force = false) {
    if (commands.length && !force) return commands;
    if (commandsLoading) return commandsLoading;
    commandsLoading = (async () => {
      try {
        commands = (await actions.listCommands()) || [];
      } catch {
        if (!commands.length) commands = [];
      }
      commands.sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9) || a.name.localeCompare(b.name));
      return commands;
    })().finally(() => { commandsLoading = null; });
    return commandsLoading;
  }

  /** Fuzzy match: query chars in order, prefix/word-boundary wins. -1 = no match. */
  function fuzzyScore(query, text) {
    const q = String(query || "").toLowerCase();
    const t = String(text || "").toLowerCase();
    if (!q) return 0;
    let qi = 0;
    let score = 0;
    let last = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-" || t[ti - 1] === ":") score += 3;
        else if (last === ti - 1) score += 2;
        else score += 1;
        last = ti;
        qi++;
      } else if (last !== -1) score -= 0.05;
    }
    return qi === q.length ? score : -1;
  }

  function matchCommands(query) {
    const q = String(query || "").trim().replace(/^\//, "");
    const scored = [];
    for (const c of commands) {
      const s = fuzzyScore(q, `${c.name} ${c.description || ""}`);
      if (s >= 0) scored.push({ c, s });
    }
    scored.sort((a, b) => b.s - a.s || (SOURCE_RANK[a.c.source] ?? 9) - (SOURCE_RANK[b.c.source] ?? 9) || a.c.name.localeCompare(b.c.name));
    return scored.map((x) => x.c);
  }

  function commandNode(c, { selected = false, onpick }) {
    return el(
      "button",
      {
        type: "button",
        class: `item cmd-item${selected ? " sel" : ""}`,
        role: "option",
        "aria-selected": String(!!selected),
        title: c.description || c.name,
        onclick: onpick,
      },
      el(
        "span",
        { class: "cmd-head" },
        el("span", { class: "cmd-name", text: `/${c.name}` }),
        el("span", { class: `chip-mini cmd-source ${c.source || ""}`, text: SOURCE_LABEL[c.source] || c.source || "" }),
      ),
      c.description ? el("span", { class: "sub", text: c.description }) : null,
    );
  }

  /* Deliberate "run something" palette, opened from the composer button.
     Reuses the model menu's shell (.menu + sticky .menu-foot filter) so the
     filter stays reachable on phones with a long skill list. */
  const commandOpen = () => !refs.commandMenu.classList.contains("hidden");
  let cmdSel = 0;
  let cmdQuery = "";

  function renderCommandMenu() {
    const list = matchCommands(cmdQuery);
    cmdSel = Math.min(cmdSel, Math.max(0, list.length - 1));
    refs.commandMenu.querySelectorAll(".item,.meta,.cmd-empty").forEach((n) => n.remove());
    const foot = refs.commandMenu.querySelector(".menu-foot");
    const add = (node) => (foot ? refs.commandMenu.insertBefore(node, foot) : refs.commandMenu.append(node));
    list.forEach((c, i) => {
      add(commandNode(c, {
        selected: i === cmdSel,
        onpick: () => applyCommand(c),
      }));
    });
    if (!list.length) {
      add(el("div", {
        class: "meta cmd-empty", style: "padding:8px 10px",
        text: commands.length ? `No command matches “${cmdQuery.trim()}”` : commandsLoading ? "Loading commands…" : "No commands or skills available",
      }));
    }
  }

  function applyCommand(c) {
    closeMenus();
    refs.input.value = `/${c.name} `;
    refs.input.focus();
    autoGrow();
  }

  function openCommandMenu() {
    // Paint at once (older list, or a "loading" line) and refresh from pi in
    // the background: the list is one cheap RPC and it changes when a skill or
    // command is installed mid-session.
    refs.commandMenu.replaceChildren();
    const search = el("input", {
      class: "menu-search", type: "search", placeholder: "Filter commands and skills…",
      "aria-label": "Filter commands and skills", autocomplete: "off",
      onclick: (ev) => ev.stopPropagation(),
    });
    search.addEventListener("input", () => { cmdQuery = search.value; cmdSel = 0; renderCommandMenu(); });
    search.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "ArrowDown") { ev.preventDefault(); cmdSel = Math.min(cmdSel + 1, Math.max(0, matchCommands(cmdQuery).length - 1)); renderCommandMenu(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); cmdSel = Math.max(0, cmdSel - 1); renderCommandMenu(); }
      else if (ev.key === "Enter") { ev.preventDefault(); const c = matchCommands(cmdQuery)[cmdSel]; if (c) applyCommand(c); }
      else if (ev.key === "Escape") closeMenus();
    });
    refs.commandMenu.append(el("div", { class: "menu-foot" }, search));
    cmdQuery = "";
    cmdSel = 0;
    renderCommandMenu();
    show(refs.commandMenu, true);
    search.focus();
    loadCommands(true).then(() => {
      if (commandOpen()) renderCommandMenu();
    });
  }

  /* ── slash palette ────────────────────────────────────────────────── */
  const slashOpen = () => !refs.slashEl.classList.contains("hidden");
  const slashItems = () => {
    const q = refs.input.value.slice(1).split(/\s/)[0].toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 14);
  };
  function updateSlash() {
    if (!refs.input.value.startsWith("/") || refs.input.value.includes("\n")) return hideSlash();
    if (!commands.length) {
      loadCommands().then(() => {
        if (refs.input.value.startsWith("/")) updateSlash();
      }).catch(() => {});
    }
    const list = slashItems();
    sel = Math.min(sel, Math.max(0, list.length - 1));
    refs.slashEl.replaceChildren();
    list.forEach((c, i) => {
      refs.slashEl.append(
        commandNode(c, { selected: i === sel, onpick: () => { sel = i; apply(); } }),
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
          el("button", { class: "icon-btn", type: "button", style: "width:20px;height:20px", "aria-label": "Remove image", onclick: () => { images.splice(i, 1); renderImageChips(); } }, icon("x", 11)),
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
        el("button", { class: "icon-btn", type: "button", title: "Restore queued messages to the editor", "aria-label": "Restore queued messages to the editor", onclick: () => actions.restoreQueue() }, icon("back", 12)),
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
    show(refs.commandMenu, false);
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
    renderModelItems("");
    // The filter box lives in a sticky footer: the menu opens upward from the
    // composer, so the bottom of the list is the spot a phone thumb (and the
    // on-screen keyboard) can reach — and it must stay there while a long
    // model list scrolls underneath.
    refs.modelMenu.append(el("div", { class: "menu-foot" }, search));
    show(refs.modelMenu, true);
    refs.modelBtn.setAttribute("aria-expanded", "true");
  });

  function renderModelItems(filter) {
    refs.modelMenu.querySelectorAll(".item,.meta").forEach((n) => n.remove());
    // Items go above the sticky filter footer, which stays the last child.
    const foot = refs.modelMenu.querySelector(".menu-foot");
    const add = (node) => (foot ? refs.modelMenu.insertBefore(node, foot) : refs.modelMenu.append(node));
    const q = String(filter || "").trim().toLowerCase();
    const list = models.filter((m) => !q || `${m.name || ""} ${m.id || ""} ${m.provider || ""}`.toLowerCase().includes(q));
    for (const m of list) {
      const selected = currentModel && m.provider === currentModel.provider && m.id === currentModel.id;
      add(
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
      add(el("div", {
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

  refs.commandBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = commandOpen();
    closeMenus();
    if (!wasOpen) openCommandMenu();
  });

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
