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

  /* Many tabs must scroll horizontally instead of being clipped away. The
     scrollbar itself is hidden (a 3px bar inside a 46px bar shifts the tab
     row), so provide the desktop affordance explicitly: vertical wheel/trackpad
     over the strip scrolls it sideways. Touch drag and Tab focus are native. */
  strip.addEventListener(
    "wheel",
    (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      const before = strip.scrollLeft;
      strip.scrollLeft = before + d;
      if (strip.scrollLeft !== before) e.preventDefault();
    },
    { passive: false },
  );

  function revealActive() {
    const active = strip.querySelector(".tab.active");
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }

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
          el("span", { class: "tab-title", text: tab.title || "new session" }),
          el("span", {
            class: "tab-close",
            role: "button",
            "aria-label": "Close tab",
            onclick: (e) => {
              e.stopPropagation();
              actions.closeTab(tab.key);
            },
          }, icon("x", 11)),
        );
        strip.append(node);
      }
      revealActive();
    },
  };
}
