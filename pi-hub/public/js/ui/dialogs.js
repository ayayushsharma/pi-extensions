// dialogs — full web dialogs for extension_ui_request (ADR-007), plus small
// local confirm/prompt helpers used by the UI itself.
import { $, clear, el, show, toast } from "../core/dom.js";

export function createDialogs(container, sendResponse) {
  const seen = new Set();

  function close() {
    clear(container);
  }

  function answer(id, response) {
    close();
    sendResponse({ type: "extension_ui_response", id, ...response });
  }

  function frame(title, body, actions) {
    return el(
      "div",
      { class: "overlay", role: "dialog", "aria-modal": "true", "aria-label": title },
      el("div", { class: "card dialog-card" }, el("h2", { text: title }), body, el("div", { class: "dialog-actions" }, actions)),
    );
  }

  function showRequest(request) {
    if (!request?.id || seen.has(request.id)) return;
    seen.add(request.id);
    const { method, id } = request;
    if (method === "select") {
      const list = el("div", { class: "list" });
      for (const option of request.options || []) {
        list.append(el("button", { type: "button", class: "row-item", text: String(option), onclick: () => answer(id, { value: String(option) }) }));
      }
      container.append(frame(request.title || "Select", list, [el("button", { type: "button", text: "Cancel", onclick: () => answer(id, { cancelled: true }) })]));
      return;
    }
    if (method === "confirm") {
      container.append(
        frame(request.title || "Confirm", el("p", { text: request.message || "" }), [
          el("button", { type: "button", onclick: () => answer(id, { cancelled: true }), text: "Cancel" }),
          el("button", { type: "button", onclick: () => answer(id, { confirmed: true }), text: "Confirm" }),
        ]),
      );
      return;
    }
    if (method === "input" || method === "editor") {
      const input = method === "editor" ? el("textarea", { text: request.prefill || "", "aria-label": request.title || "Input" }) : el("input", { value: request.prefill || "", placeholder: request.placeholder || "", "aria-label": request.title || "Input" });
      const submit = () => answer(id, { value: input.value });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && method === "input") submit();
        if (e.key === "Escape") answer(id, { cancelled: true });
      });
      container.append(
        frame(request.title || "Input", el("div", {}, input), [
          el("button", { type: "button", onclick: () => answer(id, { cancelled: true }), text: "Cancel" }),
          el("button", { type: "button", onclick: submit, text: "OK" }),
        ]),
      );
      queueMicrotask(() => input.focus());
      return;
    }
    answer(id, { cancelled: true });
  }

  function handleEvent(event) {
    if (event?.type !== "extension_ui_request") return false;
    if (event.method === "notify") {
      toast(event.message || "", event.notifyType === "error" ? 5000 : 3000);
      return true;
    }
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      showRequest(event);
      return true;
    }
    return true; // setStatus/setWidget etc. — ignore
  }

  return {
    handleEvent,
    confirm(title, message) {
      return new Promise((resolve) => {
        const id = `local-${Date.now()}`;
        container.append(
          frame(title, el("p", { text: message || "" }), [
            el("button", { type: "button", text: "Cancel", onclick: () => { close(); resolve(false); } }),
            el("button", { type: "button", text: "Confirm", onclick: () => { close(); resolve(true); } }),
          ]),
        );
        void id;
      });
    },
    prompt(title, prefill = "") {
      return new Promise((resolve) => {
        const input = el("input", { value: prefill, "aria-label": title });
        container.append(
          frame(title, input, [
            el("button", { type: "button", text: "Cancel", onclick: () => { close(); resolve(null); } }),
            el("button", { type: "button", text: "OK", onclick: () => { const v = input.value; close(); resolve(v); } }),
          ]),
        );
        queueMicrotask(() => input.focus());
      });
    },
  };
}
