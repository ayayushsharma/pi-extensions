// header — session identity, model/thinking menus, cost, connection dot.
import { el, show, shortCwd, usageLabel } from "../core/dom.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function createHeader(refs, actions) {
  let models = [];
  let current = null;

  function closeMenus() {
    show(refs.modelMenu, false);
    show(refs.thinkingMenu, false);
    refs.modelBtn.setAttribute("aria-expanded", "false");
    refs.thinkingBtn.setAttribute("aria-expanded", "false");
  }

  refs.modelBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const open = refs.modelMenu.classList.contains("hidden");
    closeMenus();
    if (!open) return;
    try {
      models = await actions.listModels();
      const state = await actions.getState();
      current = state?.model || null;
    } catch {}
    refs.modelMenu.replaceChildren();
    for (const m of models) {
      const selected = current && m.provider === current.provider && m.id === current.id;
      refs.modelMenu.append(
        el("button", {
          type: "button",
          class: "item",
          role: "option",
          "aria-selected": String(!!selected),
          text: `${m.name || m.id} · ${m.provider}`,
          onclick: () => {
            closeMenus();
            actions.setModel(m).catch((err) => actions.toast(err.message));
          },
        }),
      );
    }
    if (!models.length) refs.modelMenu.append(el("div", { class: "meta", text: "No models" }));
    show(refs.modelMenu, true);
    refs.modelBtn.setAttribute("aria-expanded", "true");
  });

  refs.thinkingBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = refs.thinkingMenu.classList.contains("hidden");
    closeMenus();
    if (!open) return;
    refs.thinkingMenu.replaceChildren();
    for (const level of THINKING_LEVELS) {
      refs.thinkingMenu.append(
        el("button", {
          type: "button",
          class: "item",
          role: "option",
          "aria-selected": String(level === current?.thinkingLevel),
          text: level,
          onclick: () => {
            closeMenus();
            actions.setThinking(level).catch((err) => actions.toast(err.message));
          },
        }),
      );
    }
    show(refs.thinkingMenu, true);
    refs.thinkingBtn.setAttribute("aria-expanded", "true");
  });

  document.addEventListener("click", closeMenus);

  return {
    render(state) {
      const bound = state.bound;
      refs.titleEl.textContent = state.meta?.sessionName || bound?.sessionFile || (bound ? "headless session" : "Pi Hub");
      const bits = [];
      if (bound) bits.push(shortCwd(bound.cwd));
      if (bound?.model) bits.push(bound.model);
      if (bound?.thinkingLevel) bits.push(`thinking ${bound.thinkingLevel}`);
      if (state.meta?.total) bits.push(`${state.meta.total} entries`);
      refs.metaEl.textContent = bits.join(" · ");
      refs.modelBtn.textContent = bound?.model || "model";
      refs.thinkingBtn.textContent = bound?.thinkingLevel || "thinking";
      current = current || {};
      if (bound?.model) current.model = { id: bound.model, provider: (bound.model.includes("/") ? bound.model.split("/")[0] : "") };
      if (bound?.thinkingLevel) current.thinkingLevel = bound.thinkingLevel;
      refs.costEl.textContent = state.meta && (state.meta.cost || state.meta.tokens) ? `${(state.meta.tokens / 1000).toFixed(1)}k · $${(state.meta.cost || 0).toFixed(3)}` : "";
      show(refs.costEl, !!(state.meta && (state.meta.cost || state.meta.tokens)));
      const dotState = !state.connected ? "off" : state.streaming || state.compacting ? "working" : "on";
      refs.dotEl.dataset.state = dotState;
      refs.dotEl.title = dotState === "off" ? "disconnected" : dotState === "working" ? "working" : "connected";
    },
  };
}
