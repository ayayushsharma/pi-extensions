// files — browser panel + read-only viewer (ADR-017), "Add to prompt" only.
import { fileContent, listDir, previewUrl } from "../core/api.js";
import { el, show, toast } from "../core/dom.js";

export function createFiles(refs, actions) {
  let cwd = null;
  let session = null;
  let currentPath = "";

  async function open(path) {
    if (!path) return;
    try {
      const out = await listDir(path);
      currentPath = out.path;
      refs.path.textContent = out.path;
      refs.list.replaceChildren();
      for (const entry of out.entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        refs.list.append(
          el("button", {
            type: "button",
            class: "row-item",
            onclick: () => (entry.type === "dir" ? open(`${out.path}/${entry.name}`) : view(`${out.path}/${entry.name}`)),
          },
            el("span", { class: "title", text: `${entry.type === "dir" ? "▸" : "·"} ${entry.name}` }),
          ),
        );
      }
      show(refs.panel, true);
    } catch (e) {
      toast(e.message);
    }
  }

  async function view(path) {
    try {
      const out = await fileContent(path, session);
      if (out.binary) {
        refs.body.textContent = `(binary file, ${out.size} bytes)`;
      } else {
        refs.body.textContent = out.text + (out.truncated ? "\n… truncated" : "");
      }
      refs.body.dataset.path = out.path;
      refs.title.textContent = out.path.split("/").pop();
      show(refs.viewer, true);
    } catch (e) {
      toast(e.message);
    }
  }

  refs.close.addEventListener("click", () => show(refs.viewer, false));
  refs.panelClose.addEventListener("click", () => show(refs.panel, false));
  refs.up.addEventListener("click", () => open(currentPath.split("/").slice(0, -1).join("/") || "/"));
  refs.add.addEventListener("click", () => {
    const path = refs.body.dataset.path;
    if (path) actions.addToPrompt(path);
    show(refs.viewer, false);
  });

  return {
    async show(sessionCwd, sessionRef) {
      cwd = sessionCwd || null;
      session = sessionRef || null;
      if (!cwd) return toast("No session cwd");
      await open(cwd);
    },
    open,
    view,
    previewUrl: (path) => previewUrl(path, session),
  };
}
