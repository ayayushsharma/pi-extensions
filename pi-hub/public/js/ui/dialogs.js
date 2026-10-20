/**
 * dialogs — extension_ui_request broker on the client (ADR-007): select,
 * confirm, input, editor, notify. Model/extension-supplied text is inserted
 * with textContent only. Also exposes local confirm/prompt helpers for the
 * UI's own destructive actions.
 */
import { clear, el, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";

export function createDialogs(container, sendResponse, actions = {}) {
  const seen = new Set();

  const close = () => clear(container);

  function answer(id, response) {
    close();
    sendResponse({ type: "extension_ui_response", id, ...response });
  }

  function frame({ title, message, body, actions, danger }) {
    return el(
      "div",
      { class: "overlay", role: "dialog", "aria-modal": "true", "aria-label": title || "Dialog" },
      el(
        "div",
        { class: "card dialog-card" },
        el("h2", { text: title || "Select an option" }),
        message ? el("div", { class: "dialog-message", text: message }) : null,
        body || null,
        el("div", { class: "dialog-actions" }, ...actions),
      ),
    );
  }

  function showRequest(request) {
    if (!request?.id || seen.has(request.id)) return;
    seen.add(request.id);
    const { method, id } = request;

    if (method === "select") {
      const list = el("div", { class: "dialog-options" });
      for (const option of request.options || []) {
        list.append(el("button", { class: "opt", type: "button", text: String(option), onclick: () => answer(id, { value: String(option) }) }));
      }
      container.append(frame({ title: request.title || "Select", message: request.message, body: list, actions: [el("button", { class: "btn small", type: "button", text: "Cancel", onclick: () => answer(id, { cancelled: true }) })] }));
      return;
    }

    if (method === "confirm") {
      container.append(
        frame({
          title: request.title || "Confirm",
          message: request.message,
          actions: [
            el("button", { class: "btn small", type: "button", text: "Cancel", onclick: () => answer(id, { cancelled: true }) }),
            el("button", { class: "btn small primary", type: "button", text: "Confirm", onclick: () => answer(id, { confirmed: true }) }),
          ],
        }),
      );
      return;
    }

    if (method === "input" || method === "editor") {
      const isEditor = method === "editor";
      const input = isEditor
        ? el("textarea", { rows: "6", "aria-label": request.title || "Input", value: request.prefill || "" })
        : el("input", { type: "text", placeholder: request.placeholder || "", "aria-label": request.title || "Input", value: request.prefill || "" });
      const submit = () => answer(id, { value: input.value });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !isEditor) submit();
        if (e.key === "Escape") answer(id, { cancelled: true });
      });
      container.append(
        frame({
          title: request.title || "Input",
          message: request.message,
          body: input,
          actions: [
            el("button", { class: "btn small", type: "button", text: "Cancel", onclick: () => answer(id, { cancelled: true }) }),
            el("button", { class: "btn small primary", type: "button", text: "OK", onclick: submit }),
          ],
        }),
      );
      queueMicrotask(() => input.focus());
      return;
    }

    // Unknown method: cancel once so the extension never hangs.
    answer(id, { cancelled: true });
  }

  /** Two-button choice; offer/confirm differ only in labels and danger. */
  function choice(title, message, { confirmLabel, cancelLabel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
      container.append(
        frame({
          title,
          message,
          actions: [
            el("button", { class: "btn small", type: "button", text: cancelLabel, onclick: () => { close(); resolve(false); } }),
            el("button", { class: `btn small ${danger ? "danger" : "primary"}`, type: "button", text: confirmLabel, onclick: () => { close(); resolve(true); } }),
          ],
        }),
      );
    });
  }

  function handleEvent(event) {
    if (event?.type !== "extension_ui_request") return false;
    if (event.method === "notify") {
      const kind = event.notifyType === "error" ? "error" : event.notifyType === "warning" ? "warning" : "info";
      if (actions?.notify) actions.notify(event.message || "", kind);
      else toast(event.message || "", { kind });
      return true;
    }
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      showRequest(event);
      return true;
    }
    return true; // setStatus/setWidget — not rendered
  }

  return {
    handleEvent,
    /** Continue/Cancel decision with caller-supplied labels (R-10 flow). */
    offer(title, message, { confirmLabel = "Continue", cancelLabel = "Cancel" } = {}) {
      return choice(title, message, { confirmLabel, cancelLabel });
    },
    confirm(title, message) {
      return choice(title, message, { confirmLabel: "Confirm", danger: true });
    },
    close,
}
}
