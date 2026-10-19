/**
 * picker — Start / Resume overlay: browse directories, list the sessions
 * that live in each one, favourite them, fork or resume, and start a new
 * session anywhere. The "starter prompt" is passed through to the app, which
 * sends it after the fresh bind (fixed from tau-web, where it was dropped).
 */
import { listDir, listSessions, mkdir } from "../core/api.js";
import { el, show, shortCwd, timeAgo, basename, toast } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { isFavourite, favKey } from "../core/store.js";

export function createPicker(refs, actions) {
  let dir = "";
  let projects = [];
  let choice = null; // { session } while the resume/fork choice is showing

  refs.close.append(icon("x", 15));
  refs.up.append(el("span", { text: "↑ Up" }));

  // New-folder affordance (single level, jailed server-side like all mkdir).
  const newFolderRow = el("div", { class: "picker-choice hidden" });
  const newFolderName = el("input", { class: "picker-path", placeholder: "folder name", maxlength: "64", "aria-label": "New folder name" });
  const newFolderGo = el("button", { class: "btn small primary", type: "button", text: "Create" });
  newFolderRow.append(newFolderName, newFolderGo);
  refs.path.parentElement.after(newFolderRow);
  const newFolderBtn = el("button", { class: "btn small", type: "button", text: "+ New folder" });
  refs.path.parentElement.append(newFolderBtn);
  newFolderBtn.addEventListener("click", () => {
    show(newFolderRow, newFolderRow.classList.contains("hidden"));
    if (!newFolderRow.classList.contains("hidden")) newFolderName.focus();
  });
  newFolderGo.addEventListener("click", async () => {
    const name = newFolderName.value.trim();
    if (!name || !dir) return;
    try {
      const out = await mkdir(`${dir}/${name}`);
      show(newFolderRow, false);
      newFolderName.value = "";
      await browse(out.path || `${dir}/${name}`);
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  });
  newFolderName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") newFolderGo.click();
    if (e.key === "Escape") show(newFolderRow, false);
  });

  async function loadProjects() {
    try {
      projects = (await listSessions()).projects || [];
    } catch {
      projects = [];
    }
  }

  function projectFor(path) {
    return projects.find((p) => p.cwd === path);
  }

  function sessionRow(session, project) {
    const fav = isFavourite(favKey(session, project));
    return el(
      "button",
      {
        type: "button",
        class: "sb-row",
        dataset: { sessionFile: session.file },
        onclick: () => {
          choice = { session, project };
          renderChoice();
        },
      },
      el("span", { class: "row-title" }, fav ? icon("star", 12) : null, el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: session.title || session.file })),
      el("span", { class: "row-sub" }, el("span", { text: session.messageCount ? `${session.messageCount} msgs` : "" }), el("span", { text: timeAgo(session.mtime) })),
    );
  }

  function renderChoice() {
    refs.choice.replaceChildren();
    if (!choice) return show(refs.choice, false);
    refs.choice.append(
      el("div", { class: "section-label", text: choice.session.title || choice.session.file }),
      el(
        "div",
        { class: "picker-choice" },
        el("button", { class: "btn primary small", type: "button", text: "Resume", onclick: () => { const c = choice; close(); actions.onResume(c.session, c.project); } }),
        el("button", { class: "btn small", type: "button", text: "Fork as new", onclick: () => { const c = choice; close(); actions.onFork(c.session, c.project); } }),
        el("button", { class: "btn small", type: "button", text: "Favourite", onclick: (e) => { actions.toggleFavourite(favKey(choice.session, choice.project)); e.currentTarget.textContent = isFavourite(favKey(choice.session, choice.project)) ? "Unfavourite" : "Favourite"; } }),
        el("button", { class: "btn small", type: "button", text: "Cancel", onclick: () => { choice = null; renderChoice(); } }),
      ),
    );
    show(refs.choice, true);
  }

  async function browse(path) {
    try {
      const out = await listDir(path || dir || "~");
      dir = out.path;
      refs.path.value = dir;
      refs.dirs.replaceChildren();
      const dirs = out.entries.filter((e) => e.type === "dir");
      if (!dirs.length) refs.dirs.append(el("div", { class: "sb-empty", text: "No subdirectories" }));
      for (const entry of dirs) {
        refs.dirs.append(
          el("button", { type: "button", class: "sb-row", onclick: () => browse(`${out.path}/${entry.name}`) },
            el("span", { class: "row-title" }, icon("folder", 13), el("span", { class: "grow", text: entry.name })),
          ),
        );
      }
      refs.start.textContent = dir ? `Start new session in ${shortCwd(dir)}` : "Start new session here";
      const project = projectFor(dir);
      refs.sessionsLabel.textContent = project ? `Sessions in ${basename(dir) || dir}` : "Sessions here";
      refs.sessions.replaceChildren();
      if (project?.sessions?.length) {
        for (const s of [...project.sessions].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))) refs.sessions.append(sessionRow(s, project));
      } else {
        refs.sessions.append(el("div", { class: "sb-empty", text: "No sessions in this directory" }));
      }
    } catch (e) {
      // Still allow starting in a directory the file API cannot list (jail):
      // the user asked for it explicitly.
      dir = path || dir;
      refs.path.value = dir || "";
      refs.start.textContent = dir ? `Start new session in ${shortCwd(dir)}` : "Start new session here";
      refs.dirs.replaceChildren(el("div", { class: "sb-empty", text: `Cannot list this directory: ${e.message}` }));
      refs.sessions.replaceChildren();
      refs.sessionsLabel.textContent = "Sessions here";
    }
  }

  async function renderFavourites() {
    refs.favs.replaceChildren();
    const favs = [];
    for (const p of projects) for (const s of p.sessions || []) if (isFavourite(favKey(s, p))) favs.push({ s, p });
    if (!favs.length) return show(refs.favs, false);
    refs.favs.append(el("div", { class: "section-label" }, "★ Favourites"));
    for (const { s, p } of favs) {
      const row = sessionRow(s, p);
      row.prepend(el("span", { class: "icon-btn", title: "Remove favourite", onclick: (e) => { e.stopPropagation(); actions.toggleFavourite(favKey(s, p)); renderFavourites(); } }, icon("starFill", 13)));
      refs.favs.append(row);
    }
    show(refs.favs, true);
  }

  function close() {
    show(refs.root, false);
    choice = null;
    renderChoice();
  }

  refs.close.addEventListener("click", close);
  refs.root.addEventListener("click", (e) => {
    if (e.target === refs.root) close();
  });
  refs.up.addEventListener("click", () => browse(dir.split(/[\\/]/).slice(0, -1).join("/") || "/"));
  refs.path.addEventListener("keydown", (e) => {
    if (e.key === "Enter") browse(refs.path.value.trim());
  });
  refs.start.addEventListener("click", () => {
    const starter = refs.starter.value.trim();
    close();
    actions.onStart(dir, starter);
  });
  document.addEventListener("keydown", (e) => {
    if (refs.root.classList.contains("hidden")) return;
    if (e.key === "Escape") (choice ? ((choice = null), renderChoice()) : close());
  });

  return {
    async open(path) {
      show(refs.root, true);
      await loadProjects();
      await renderFavourites();
      await browse(path || dir || "~");
      refs.starter.value = "";
      setTimeout(() => refs.path.focus(), 50);
    },
    browse,
    close,
  };
}
