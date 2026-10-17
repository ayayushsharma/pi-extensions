// banner — the preview → drive → detached FSM surface for live TUIs (ADR-009).
import { el, fmtTime, show } from "../core/dom.js";

export function updateBanner(banner, state, actions) {
  const bound = state.bound;
  banner.replaceChildren();
  if (!bound) return show(banner, false);
  if (bound.kind !== "live") {
    if (bound.state === "dead") {
      banner.dataset.kind = "error";
      banner.append(
        el("span", { class: "grow", text: `Session ended (${bound.sessionFile || bound.id})` }),
        el("button", { type: "button", text: "Resume from disk", onclick: () => actions.onResumeDead(bound) }),
      );
      return show(banner, true);
    }
    return show(banner, false);
  }
  const driving = state.driving === bound.id;
  const busy = state.driverBusy && state.driverBusy.runnerId === bound.id;
  banner.dataset.kind = busy ? "error" : driving ? "ok" : "preview";
  const info = `pid ${bound.pid} · last active ${fmtTime(bound.lastActiveAt)}`;
  if (driving) {
    banner.append(
      el("span", { class: "grow", text: `Driving live session on:${bound.pid} — it is also attached in the terminal, so typing happens in both.` }),
      el("button", { type: "button", text: "Detach", onclick: actions.onDetach }),
    );
  } else if (busy) {
    banner.append(
      el("span", { class: "grow", text: `Another browser is driving this session (client ${state.driverBusy.heldBy}).` }),
      el("button", { type: "button", text: "Take over", onclick: () => actions.onAttach(bound, true) }),
      el("button", { type: "button", text: "Cancel", onclick: actions.onCancelPreview }),
    );
  } else {
    banner.append(
      el("span", { class: "grow", text: `Previewing live session (${info}). Input is read-only until you drive.` }),
      el("button", { type: "button", text: "Attach & Drive", onclick: () => actions.onAttach(bound, false) }),
      el("button", { type: "button", text: "Cancel", onclick: actions.onCancelPreview }),
    );
  }
  show(banner, true);
}
