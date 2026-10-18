/**
 * settings — appearance (theme), chat display prefs, server info and the
 * live process list with kill. Preferences persist through the store.
 */
import { killProcess, processes, serverInfo } from "../core/api.js";
import { el, show, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { savePrefs, set, state } from "../core/store.js";

const THEMES = [
  { id: "terracotta", name: "Terracotta", swatches: ["#f4f1ec", "#b06a48", "#6b3570"] },
  { id: "clean", name: "Clean", swatches: ["#ffffff", "#0580c4", "#007aff"] },
  { id: "sage", name: "Sage", swatches: ["#f0f2ec", "#6a7d5a", "#4a3860"] },
  { id: "night", name: "Dusk", swatches: ["#212121", "#a0a0a0", "#666666"] },
  { id: "dawn", name: "Dawn", swatches: ["#1a1d26", "#7a8ab0", "#6a5a80"] },
  { id: "midnight", name: "Midnight", swatches: ["#000000", "#5a7a9a", "#4a5567"] },
];

export function createSettings(refs, actions) {
  refs.close.append(icon("x", 15));

  /* tabs */
  const tabs = [...refs.tabs.querySelectorAll(".tab-btn")];
  const panes = [...refs.root.querySelectorAll(".settings-pane")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const t of tabs) t.classList.toggle("active", t === tab);
      for (const p of panes) show(p, p.dataset.pane === tab.dataset.tab);
    });
  }

  /* themes */
  function renderThemes() {
    refs.themeGrid.replaceChildren();
    for (const theme of THEMES) {
      const selected = state.prefs.theme === theme.id;
      refs.themeGrid.append(
        el(
          "button",
          {
            type: "button",
            class: "theme-swatch",
            role: "option",
            "aria-selected": String(selected),
            dataset: { theme: theme.id },
            onclick: () => {
              state.prefs.theme = theme.id;
              savePrefs();
              applyPrefs();
            },
          },
          el("span", { class: "swatches" }, ...theme.swatches.map((c) => el("span", { class: "sw", style: `background:${c}` }))),
          el("span", { text: theme.name }),
        ),
      );
    }
  }

  function applyPrefs() {
    if (state.prefs.theme) document.documentElement.dataset.theme = state.prefs.theme;
    document.documentElement.dataset.wrapCode = state.prefs.wrapCode ? "1" : "";
    refs.thinkingToggle.checked = state.prefs.showThinking;
    refs.costsToggle.checked = state.prefs.showCosts;
    refs.toolsToggle.checked = state.prefs.expandTools;
    refs.wrapToggle.checked = state.prefs.wrapCode;
    renderThemes();
    actions.applyPrefs?.();
  }

  refs.thinkingToggle.addEventListener("change", () => {
    state.prefs.showThinking = refs.thinkingToggle.checked;
    savePrefs();
    applyPrefs();
  });
  refs.costsToggle.addEventListener("change", () => {
    state.prefs.showCosts = refs.costsToggle.checked;
    savePrefs();
    applyPrefs();
  });
  refs.toolsToggle.addEventListener("change", () => {
    state.prefs.expandTools = refs.toolsToggle.checked;
    savePrefs();
    applyPrefs();
  });
  refs.wrapToggle.addEventListener("change", () => {
    state.prefs.wrapCode = refs.wrapToggle.checked;
    savePrefs();
    applyPrefs();
  });

  refs.close.addEventListener("click", () => show(refs.root, false));
  refs.root.addEventListener("click", (e) => {
    if (e.target === refs.root) show(refs.root, false);
  });
  refs.procRefresh.addEventListener("click", () => loadProcesses());
  refs.logout.addEventListener("click", () => actions.logout());

  async function loadInfo() {
    try {
      const info = await serverInfo();
      const bits = [`pi-hub v${info.version}`, `pid ${info.pid}`, `up ${Math.round((info.uptime || 0) / 60)}m`, info.platform, `auth ${info.auth ? "on" : "off"}`];
      refs.info.textContent = bits.join(" · ");
    } catch (e) {
      refs.info.textContent = e.message;
    }
  }

  async function loadProcesses() {
    refs.procList.replaceChildren(el("div", { class: "meta", text: "Loading…" }));
    try {
      const out = await processes();
      refs.procList.replaceChildren();
      if (out.unsupported) {
        refs.procList.append(el("div", { class: "meta", text: "Process listing is not supported on this platform." }));
        return;
      }
      if (!out.processes?.length) {
        refs.procList.append(el("div", { class: "meta", text: "No pi processes." }));
        return;
      }
      for (const p of out.processes) {
        refs.procList.append(
          el(
            "div",
            { class: "proc-row" },
            el(
              "div",
              { class: "grow" },
              el("div", { class: "proc-title", text: p.title || "new process" }),
              el("div", { text: `${p.owner === "hub" ? "child" : "live"} · pid ${p.pid} · ${Math.round((p.rssKb || 0) / 1024)} MB` }),
              el("div", { class: "argv", text: p.argv || "" }),
            ),
            el("button", {
              class: "btn small danger",
              type: "button",
              text: "Kill",
              onclick: async () => {
                if (!(await actions.confirm("Kill process", `Send TERM to pid ${p.pid}? Session files stay on disk.`))) return;
                try {
                  await killProcess(p.pid);
                  toast(`killed ${p.pid}`);
                  loadProcesses();
                } catch (e) {
                  toast(e.message, { kind: "error" });
                }
              },
            }),
          ),
        );
      }
    } catch (e) {
      refs.procList.replaceChildren(el("div", { class: "meta", text: e.message }));
    }
  }

  return {
    async open() {
      show(refs.root, true);
      applyPrefs();
      loadInfo();
      loadProcesses();
    },
    applyPrefs,
    isOpen: () => !refs.root.classList.contains("hidden"),
  };
}
