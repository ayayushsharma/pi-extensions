/**
 * banner — the preview/drive strip above the transcript. One placement for
 * every "this view is not a normal headless session" state.
 */
import { el, show, timeAgo } from "../core/dom.js";
import { icon } from "../core/icons.js";

export function renderBanner(node, state, actions) {
  const bound = state.bound;
  show(node, false);

  if (!bound) return;

  // R-10: the session's folder no longer exists — tools run in the fallback.
  if (state.cwdFallback) {
    node.dataset.kind = "warn";
    node.replaceChildren(
      icon("alert", 18),
      el("div", { class: "banner-copy" },
        el("div", { class: "banner-title", text: "This project folder is gone" }),
        el("div", { class: "banner-sub", text: `${state.cwdFallback.from} no longer exists — the session resumed in ${state.cwdFallback.to}, so tools run there.` }),
      ),
      el("button", { class: "btn small", type: "button", text: "Dismiss", onclick: () => actions.onDismissFallback() }),
    );
    return show(node, true);
  }

  if (bound.state === "dead") {
    node.dataset.kind = "error";
    node.replaceChildren(
      icon("alert", 18),
      el("div", { class: "banner-copy" },
        el("div", { class: "banner-title", text: "Session ended" }),
        el("div", { class: "banner-sub", text: `${bound.sessionFile || bound.id} — the backend is no longer running.` }),
      ),
      el("button", { class: "btn small primary", type: "button", text: "Resume from disk", onclick: () => actions.onResume(bound) }),
    );
    return show(node, true);
  }

  if (bound.kind !== "live") return;

  const driving = state.driving === bound.id;
  const busy = state.driverBusy && state.driverBusy.runnerId === bound.id;
  node.dataset.kind = busy ? "error" : driving ? "ok" : "preview";

  if (driving) {
    node.replaceChildren(
      icon("eye", 18),
      el("div", { class: "banner-copy" },
        el("div", { class: "banner-text" }, el("strong", { text: "Driving" }), " — terminal still attached, prompts here and there may race."),
      ),
      el("button", { class: "btn small", type: "button", text: "Detach", onclick: () => actions.onDetach() }),
    );
    return show(node, true);
  }

  if (busy) {
    node.replaceChildren(
      icon("alert", 18),
      el("div", { class: "banner-copy" },
        el("div", { class: "banner-title", text: "Another browser is driving this session" }),
        el("div", { class: "banner-sub", text: `Held by client ${state.driverBusy.heldBy}. Taking over releases it there.` }),
      ),
      el("button", { class: "btn small primary", type: "button", text: "Take over", onclick: () => actions.onAttach(bound, true) }),
      el("button", { class: "btn small", type: "button", text: "Cancel", onclick: () => actions.onDismiss() }),
    );
    return show(node, true);
  }

  node.replaceChildren(
    icon("eye", 18),
    el("div", { class: "banner-copy" },
      el("div", { class: "banner-text" }, el("strong", { text: "Preview" }), ` — read-only. Drive to take over. Last active ${timeAgo(bound.lastActiveAt)}.`),
    ),
    el("button", { class: "btn small primary", type: "button", text: "Drive", onclick: () => actions.onAttach(bound, false) }),
    el("button", { class: "btn small", type: "button", text: "Dismiss", onclick: () => actions.onDismiss() }),
  );
  show(node, true);
}
