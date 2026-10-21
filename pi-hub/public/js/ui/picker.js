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
  let dirEntries = []; // { name, full } of the currently listed directory
  let hi = 0; // highlighted index within the filtered dirs
  let projects = [];
  let choice = null; // { session } while the resume/fork choice is showing

  // Type-to-filter over the current listing (no server roundtrip per
  // keystroke): match the typed last segment against child names, but only
  // while the typed path is still inside the listed dir. Typing upward (e.g.
  // trimming to the parent) leaves the listing stale — filtering it by the
  // parent's own name would fake an empty "No matching" state.
  function commonPrefix(strs) {
    let p = strs[0] || "";
    for (const s of strs.slice(1)) {
      let i = 0;
      while (i < p.length && s[i] === p[i]) i++;
      p = p.slice(0, i);
      if (!p) break;
    }
    return p;
  }
  function norm(p) {
    return (p || "").trim().replace(/[\\/]+$/, "") || "/";
  }
  function filteredDirs() {
    const typed = norm(refs.path.value);
    const here = norm(dir);
    if (typed === here) return dirEntries;
    if (!typed.startsWith(here === "/" ? "/" : here + "/")) return dirEntries;
    const f = (typed.split(/[\\/]/).pop() || "").toLowerCase();
    if (!f) return dirEntries;
    return dirEntries.filter((d) => d.name.toLowerCase().includes(f));
  }
  function renderDirs() {
    const list = filteredDirs();
    if (hi >= list.length) hi = Math.max(0, list.length - 1);
    refs.dirs.replaceChildren();
    if (!dirEntries.length) refs.dirs.append(el("div", { class: "sb-empty", text: "No subdirectories" }));
    else if (!list.length) refs.dirs.append(el("div", { class: "sb-empty", text: "No matching subdirectories" }));
    list.forEach((d, i) => {
      refs.dirs.append(
        el("button", { type: "button", class: `sb-row${i === hi ? " active" : ""}`, onclick: () => browse(d.full) },
          el("span", { class: "row-title" }, icon("folder", 13), el("span", { class: "grow", text: d.name })),
        ),
      );
    });
    return list;
  }

  refs.close.append(icon("x", 15));
  refs.up.append(el("span", { text: "↑ Up" }));

  // New-folder affordance (single level, jailed server-side like all mkdir).
  const newFolderRow = el("div", { class: "picker-choice hidden" });
  const newFolderName = el("input", { class: "picker-path", placeholder: "folder name", maxlength: "64", "aria-label": "New folder name", autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" });
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
      el("span", { class: "row-title" }, el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: session.title || session.file })),
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
      dirEntries = out.entries.filter((e) => e.type === "dir").map((entry) => ({ name: entry.name, full: `${out.path}/${entry.name}` }));
      hi = 0;
      renderDirs();
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
      // the user asked for it explicitly. Drop the previous listing so Tab
      // completion and filtering cannot act on a stale directory.
      dir = path || dir;
      dirEntries = [];
      hi = 0;
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
      row.append(el("span", { class: "row-actions" }, el("span", { class: "icon-btn fav-btn", title: "Remove favourite", dataset: { fav: "1" }, onclick: (e) => { e.stopPropagation(); actions.toggleFavourite(favKey(s, p)); renderFavourites(); } }, icon("starFill", 13))));
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
  refs.path.addEventListener("input", () => { hi = 0; renderDirs(); });
  refs.path.addEventListener("keydown", (e) => {
    if (e.key === "Enter") browse(refs.path.value.trim());
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = filteredDirs();
      if (!list.length) return;
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
      renderDirs();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const typed = norm(refs.path.value);
      const here = norm(dir);
      if (typed === here) return; // box already exact — nothing to complete
      const list = filteredDirs();
      if (list.length === 1) browse(list[0].full); // single match: complete + descend
      else if (list.length > 1) {
        const frag = (typed.split(/[\\/]/).pop() || "").toLowerCase();
        if (frag && list.every((d) => d.name.toLowerCase().startsWith(frag))) {
          const p = commonPrefix(list.map((d) => d.name.toLowerCase()));
          if (p.length > frag.length) {
            refs.path.value = `${here}/${list[0].name.slice(0, p.length)}`;
            hi = 0;
            renderDirs();
            return;
          }
        }
        hi = (hi + 1) % list.length; // nothing more to complete: cycle (zsh-style)
        renderDirs();
      }
      // else: partial name with no match, or typed outside this listing —
      // leave it alone (bash would beep; Enter is the way out).
      // else: partial name with no match — leave it alone (bash would beep)
    }
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
