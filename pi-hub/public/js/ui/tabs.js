/**
 * tabs — the session tab strip. One tab per open session/runner; close is
 * explicit (the runner keeps living until the current-session card's Kill).
 */
import { el } from "../core/dom.js";
import { icon } from "../core/icons.js";

function tabDot(state, tab) {
  const runner = tab.runnerId ? state.runners.get(tab.runnerId) : null;
  const cls = !runner ? "" : runner.kind === "live" ? "live" : runner.state === "working" ? "working" : "on";
  return el("span", { class: `dot ${cls}`, title: runner ? runner.state : "" });
}

export function createTabs({ strip, newBtn }, actions) {
  newBtn.append(icon("plus", 15));

  return {
    render(state) {
      strip.replaceChildren();
      for (const tab of state.tabs) {
        const active = tab.key === state.activeKey && state.view === "session";
        const node = el(
          "button",
          {
            type: "button",
            role: "tab",
            class: `tab${active ? " active" : ""}`,
            "aria-selected": String(active),
            "data-tab-key": tab.key,
            title: tab.title || tab.file || "",
            onclick: () => actions.activateTab(tab.key),
          },
          tab.kind === "live" ? icon("terminal", 13) : tabDot(state, tab),
          el("span", { class: "tab-title", text: tab.title || tab.file || "session" }),
          el("span", {
            class: "tab-close",
            role: "button",
            "aria-label": "Close tab",
            onclick: (e) => {
              e.stopPropagation();
              actions.closeTab(tab.key);
            },
            html: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
          }),
        );
        strip.append(node);
      }
    },
  };
}
