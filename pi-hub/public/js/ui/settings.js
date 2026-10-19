/**
 * settings — appearance (theme), chat display prefs, server info and the
 * live process list with kill. Preferences persist through the store.
 */
import { killProcess, processes, serverInfo } from "../core/api.js";
import { el, show, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { savePrefs, set, state } from "../core/store.js";

/** Every theme the stylesheet defines; `preview` feeds the tile mock. */
const THEMES = [
  { id: "terracotta", name: "Terracotta", scheme: "light", preview: { bg: "#f4f1ec", bar: "#efe8df", line: "rgba(0,0,0,.2)", accent: "#b06a48" } },
  { id: "clean", name: "Clean", scheme: "light", preview: { bg: "#ffffff", bar: "#f1f3f7", line: "rgba(0,0,0,.18)", accent: "#0580c4" } },
  { id: "sage", name: "Sage", scheme: "light", preview: { bg: "#f0f2ec", bar: "#e6eadf", line: "rgba(0,0,0,.18)", accent: "#6a7d5a" } },
  { id: "linen", name: "Linen", scheme: "light", preview: { bg: "#f7f5ef", bar: "#efece2", line: "rgba(0,0,0,.18)", accent: "#2f6f6a" } },
  { id: "paper", name: "Paper", scheme: "light", preview: { bg: "#fbfbf9", bar: "#f2f2ef", line: "rgba(0,0,0,.16)", accent: "#1d4ed8" } },
  { id: "rose", name: "Rose", scheme: "light", preview: { bg: "#fbf4f2", bar: "#f3e8e5", line: "rgba(0,0,0,.16)", accent: "#b5546a" } },
  { id: "night", name: "Dusk", scheme: "dark", preview: { bg: "#212121", bar: "#191919", line: "rgba(255,255,255,.28)", accent: "#b5b5b5" } },
  { id: "dawn", name: "Dawn", scheme: "dark", preview: { bg: "#1a1d26", bar: "#141722", line: "rgba(255,255,255,.26)", accent: "#7a8ab0" } },
  { id: "midnight", name: "Midnight", scheme: "dark", preview: { bg: "#000000", bar: "#0a0a0b", line: "rgba(255,255,255,.24)", accent: "#8a9aa8" } },
  { id: "slate", name: "Slate", scheme: "dark", preview: { bg: "#15181d", bar: "#101317", line: "rgba(255,255,255,.24)", accent: "#6f8fb8" } },
  { id: "forest", name: "Forest", scheme: "dark", preview: { bg: "#101614", bar: "#0b100e", line: "rgba(255,255,255,.22)", accent: "#5f9e7f" } },
  { id: "plum", name: "Plum", scheme: "dark", preview: { bg: "#16121c", bar: "#100c15", line: "rgba(255,255,255,.22)", accent: "#a17ac2" } },
];

export function createSettings(refs, actions) {
  refs.close.append(icon("x", 15));

  /* tabs */
  const tabs = [...refs.tabs.querySelectorAll(".tab-btn")];
  const panes = [...refs.root.querySelectorAll(".settings-pane")];
  for (const tab of tabs) {
    const ico = tab.querySelector(".tab-ico");
    if (ico) ico.append(icon(ico.dataset.icon, 16));
    tab.addEventListener("click", () => {
      for (const t of tabs) {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      }
      for (const p of panes) show(p, p.dataset.pane === tab.dataset.tab);
    });
  }

  /* themes */
  /** The theme actually in effect — an unset pref still shows a selected tile. */
  function currentTheme() {
    return document.documentElement.dataset.theme || state.prefs.theme || "terracotta";
  }

  function themeTile(theme) {
    const selected = currentTheme() === theme.id;
    const p = theme.preview;
    const preview = el("span", { class: "theme-preview", style: `background:${p.bg}` },
      el("span", { class: "tp-bar", style: `background:${p.bar}` }),
      el("span", { class: "tp-line one", style: `background:${p.line}` }),
      el("span", { class: "tp-line two", style: `background:${p.line}` }),
      el("span", { class: "tp-bubble", style: `background:${p.accent}` }),
    );
    return el(
      "button",
      {
        type: "button",
        class: "theme-swatch",
        role: "option",
        "aria-selected": String(selected),
        title: `${theme.name} — ${theme.scheme} theme`,
        dataset: { theme: theme.id, scheme: theme.scheme },
        onclick: () => {
          state.prefs.theme = theme.id;
          savePrefs();
          applyPrefs();
        },
      },
      preview,
      el("span", { class: "theme-meta" },
        el("span", { class: "theme-name", text: theme.name }),
        el("span", { class: "theme-scheme", text: theme.scheme === "dark" ? "Dark" : "Light" }),
      ),
    );
  }

  function renderThemes() {
    refs.themeGrid.replaceChildren();
    for (const scheme of ["light", "dark"]) {
      const group = el("div", { class: "theme-group", dataset: { scheme } },
        el("div", { class: "theme-group-label", text: scheme === "dark" ? "Dark" : "Light" }),
      );
      const grid = el("div", { class: "theme-grid", role: "group", "aria-label": scheme === "dark" ? "Dark themes" : "Light themes" });
      for (const theme of THEMES.filter((t) => t.scheme === scheme)) grid.append(themeTile(theme));
      group.append(grid);
      refs.themeGrid.append(group);
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
      const rows = [
        ["Version", `pi-hub v${info.version}`],
        ["Process", `pid ${info.pid}`],
        ["Uptime", `${Math.round((info.uptime || 0) / 60)} min`],
        ["Platform", info.platform],
        ["Auth", info.auth ? "cookie required" : "off — open LAN"],
      ];
      refs.info.replaceChildren(
        ...rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: String(v) })]),
      );
    } catch (e) {
      refs.info.replaceChildren(el("dd", { text: e.message }));
    }
  }

  async function loadProcesses() {
    refs.procList.replaceChildren(el("div", { class: "proc-empty", text: "Loading…" }));
    try {
      const out = await processes();
      refs.procList.replaceChildren();
      if (out.unsupported) {
        refs.procList.append(el("div", { class: "proc-empty", text: "Process listing is not supported on this platform." }));
        return;
      }
      if (!out.processes?.length) {
        refs.procList.append(el("div", { class: "proc-empty", text: "No pi processes running." }));
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
              el("div", { class: "proc-meta", text: `${p.owner === "hub" ? "child" : "live"} · pid ${p.pid} · ${Math.round((p.rssKb || 0) / 1024)} MB` }),
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
      refs.procList.replaceChildren(el("div", { class: "proc-empty", text: e.message }));
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
