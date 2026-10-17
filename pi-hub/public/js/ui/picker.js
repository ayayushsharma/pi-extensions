// picker — browse the server filesystem, start a new session anywhere, fork.
import { api, fork, listDir, listProjects } from "../core/api.js";
import { $, clear, el, show, shortCwd, toast } from "../core/dom.js";

export function createPicker({ root, projectsEl, dirsEl, pathInput, startBtn, closeBtn, onStart, onFork }) {
  let current = "";
  let projects = [];

  async function loadProjects() {
    projectsEl.replaceChildren();
    try {
      projects = (await listProjects()).projects || [];
    } catch {
      projects = [];
    }
    projectsEl.append(el("div", { class: "section-label", text: "Recent projects" }));
    for (const p of projects.slice(0, 20)) {
      projectsEl.append(
        el("button", {
          type: "button",
          class: "row-item",
          onclick: () => browse(p.cwd || "~"),
        },
          el("span", { class: "title", text: shortCwd(p.cwd || p.dirName) }),
          el("span", { class: "sub" }, el("span", { class: "meta", text: `${p.sessionCount || 0} sessions` })),
        ),
      );
    }
    if (!projects.length) projectsEl.append(el("div", { class: "meta", text: "No projects yet" }));
  }

  async function browse(path) {
    try {
      const out = await listDir(path);
      current = out.path;
      pathInput.value = out.path;
      dirsEl.replaceChildren();
      dirsEl.append(
        el("button", { type: "button", class: "row-item", text: "Start a new session here", onclick: () => start(current) }),
      );
      for (const entry of out.entries.filter((e) => e.type === "dir")) {
        dirsEl.append(
          el("button", { type: "button", class: "row-item", text: entry.name, onclick: () => browse(`${out.path}/${entry.name}`) }),
        );
      }
      for (const entry of out.entries.filter((e) => e.type === "file").slice(0, 50)) {
        dirsEl.append(el("div", { class: "row-item", style: "cursor:default" }, el("span", { class: "title", text: entry.name })));
      }
    } catch (e) {
      toast(e.message);
    }
  }

  function start(path) {
    if (!path) return;
    onStart(path);
  }

  closeBtn.addEventListener("click", () => show(root, false));
  startBtn.addEventListener("click", () => start(pathInput.value.trim()));
  root.addEventListener("click", (e) => {
    if (e.target === root) show(root, false);
  });

  return {
    async open() {
      show(root, true);
      await loadProjects();
      browse(current || "~");
    },
    browse,
  };
}
