// settings — themes, display toggles, server info, live process kill (ADR-013).
import { killProcess, processes, serverInfo } from "../core/api.js";
import { clear, el, show, toast } from "../core/dom.js";
import { savePrefs, set, state } from "../core/store.js";

const THEMES = ["dusk", "midnight", "clean", "terracotta", "sage", "dawn"];

export function createSettings(refs, actions) {
  function applyPrefs() {
    document.documentElement.dataset.theme = state.prefs.theme;
    document.body.classList.toggle("hide-thinking", !state.prefs.showThinking);
    document.body.classList.toggle("hide-costs", state.prefs.hideCosts);
    refs.thinkingToggle.checked = state.prefs.showThinking;
    refs.costsToggle.checked = state.prefs.hideCosts;
    for (const btn of refs.themePicker.querySelectorAll("button")) {
      btn.setAttribute("aria-selected", String(btn.dataset.theme === state.prefs.theme));
    }
  }

  refs.themePicker.replaceChildren();
  for (const theme of THEMES) {
    refs.themePicker.append(
      el("button", {
        type: "button",
        role: "option",
        dataset: { theme },
        text: theme,
        onclick: () => {
          state.prefs.theme = theme;
          savePrefs();
          applyPrefs();
        },
      }),
    );
  }
  refs.thinkingToggle.addEventListener("change", () => {
    state.prefs.showThinking = refs.thinkingToggle.checked;
    savePrefs();
    applyPrefs();
  });
  refs.costsToggle.addEventListener("change", () => {
    state.prefs.hideCosts = refs.costsToggle.checked;
    savePrefs();
    applyPrefs();
  });
  refs.close.addEventListener("click", () => show(refs.root, false));
  refs.root.addEventListener("click", (e) => {
    if (e.target === refs.root) show(refs.root, false);
  });
  refs.refresh.addEventListener("click", () => loadProcesses());
  refs.logout.addEventListener("click", () => actions.logout());

  async function loadInfo() {
    try {
      const info = await serverInfo();
      refs.info.textContent = `v${info.version} · pid ${info.pid} · up ${info.uptime}s · ${info.platform} · auth ${info.auth ? "on" : "off"}`;
    } catch (e) {
      refs.info.textContent = e.message;
    }
  }

  async function loadProcesses() {
    clear(refs.procList);
    try {
      const out = await processes();
      if (out.unsupported) return refs.procList.append(el("div", { class: "meta", text: "process listing not supported on this platform" }));
      if (!out.processes?.length) return refs.procList.append(el("div", { class: "meta", text: "no pi processes" }));
      for (const p of out.processes) {
        refs.procList.append(
          el("div", { class: "row-item" },
            el("span", { class: "title", text: `${p.owner === "hub" ? "hub" : "live"} · pid ${p.pid} · ${Math.round((p.rssKb || 0) / 1024)} MB` }),
            el("span", { class: "sub" }, el("span", { class: "meta", text: (p.argv || "").slice(0, 120) })),
            el("button", {
              type: "button",
              text: "Kill",
              onclick: async () => {
                if (!(await actions.confirm("Kill process", `Send TERM to ${p.pid}? Session files stay on disk.`))) return;
                try {
                  await killProcess(p.pid);
                  toast(`killed ${p.pid}`);
                  loadProcesses();
                } catch (e) {
                  toast(e.message);
                }
              },
            }),
          ),
        );
      }
    } catch (e) {
      refs.procList.append(el("div", { class: "meta", text: e.message }));
    }
  }

  return {
    async open() {
      show(refs.root, true);
      applyPrefs();
      await loadInfo();
      await loadProcesses();
    },
    applyPrefs,
  };
}
