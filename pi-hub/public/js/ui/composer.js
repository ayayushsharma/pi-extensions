// composer — prompt vs steer, queue pills, slash palette.
import { $, el, show } from "../core/dom.js";

export function createComposer({ form, input, sendBtn, abortBtn, queueEl, slashEl, actions }) {
  let commands = [];
  let sel = 0;

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
    updateSlash();
  });
  input.addEventListener("keydown", (e) => {
    if (slashOpen()) {
      if (e.key === "ArrowDown") return move(1), e.preventDefault();
      if (e.key === "ArrowUp") return move(-1), e.preventDefault();
      if (e.key === "Enter" || e.key === "Tab") return apply(), e.preventDefault();
      if (e.key === "Escape") return hideSlash();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });
  abortBtn.addEventListener("click", () => actions.abort());

  function slashOpen() {
    return !slashEl.classList.contains("hidden");
  }
  function items() {
    const q = input.value.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
  }
  function updateSlash() {
    if (!input.value.startsWith("/") || input.value.includes("\n")) return hideSlash();
    if (!commands.length) actions.listCommands().then((list) => {
      commands = list;
      updateSlash();
    }).catch(() => {});
    const list = items();
    sel = Math.min(sel, Math.max(0, list.length - 1));
    slashEl.replaceChildren();
    list.forEach((c, i) => {
      slashEl.append(
        el("button", {
          type: "button",
          class: "item",
          role: "option",
          "aria-selected": String(i === sel),
          onclick: () => apply(),
          onmouseenter: () => {
            sel = i;
            updateSlash();
          },
        }, el("span", { text: `/${c.name}` }), el("span", { class: "meta", text: c.description || c.source || "" })),
      );
    });
    show(slashEl, list.length > 0);
  }
  function move(d) {
    const list = items();
    if (!list.length) return;
    sel = (sel + d + list.length) % list.length;
    updateSlash();
  }
  function apply() {
    const list = items();
    if (!list.length) return;
    input.value = `/${list[sel].name} `;
    hideSlash();
    input.focus();
  }
  function hideSlash() {
    show(slashEl, false);
  }

  async function send() {
    const text = input.value.trim();
    const files = actions.takePendingFiles ? actions.takePendingFiles() : [];
    if (!text && !files.length) return;
    const message = text + (files.length ? `\n\n${files.map((f) => `@${f}`).join("\n")}` : "");
    input.value = "";
    input.style.height = "auto";
    hideSlash();
    try {
      if (actions.isWorking()) {
        actions.steer(message);
        actions.queue(message);
      } else {
        await actions.prompt(message);
      }
    } catch (e) {
      actions.toast(e.message);
    }
  }

  function renderQueue(queue) {
    queueEl.replaceChildren();
    for (const [i, q] of queue.entries()) {
      queueEl.append(
        el("span", { class: "pill" }, el("span", { text: q.length > 40 ? `${q.slice(0, 40)}…` : q }), el("button", { type: "button", class: "icon-btn", style: "width:22px;height:22px", text: "✕", "aria-label": "Remove queued message", onclick: () => actions.dropQueue(i) })),
      );
    }
    show(queueEl, queue.length > 0);
  }

  return {
    render(state) {
      const working = state.streaming;
      show(abortBtn, working);
      show(sendBtn, !working || true);
      renderQueue(state.queue);
      const disabled = state.bound?.kind === "live" && state.driving !== state.bound.id;
      input.disabled = !!disabled;
      input.placeholder = disabled ? "Previewing live session — attach to drive" : state.bound ? "Message…" : "Bind a session first";
    },
  };
}
