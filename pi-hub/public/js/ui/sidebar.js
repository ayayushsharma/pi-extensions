/**
 * sidebar — current session card, open tabs, running terminals, project
 * session list, search, favourites and row actions. Purely a view: every
 * mutation goes back through app actions.
 */
import { el, show, timeAgo, shortCwd, basename } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { isFavourite, sessionKey } from "../core/store.js";

export function createSidebar(refs, actions) {
  let collapsed = new Set(); // collapsed project dirNames
  let hits = null; // full-text hits when local filtering comes up empty
  let searchTimer = null;

  refs.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = refs.search.value.trim();
    actions.setSearch(q);
    searchTimer = setTimeout(async () => {
      if (q.length < 2) {
        hits = null;
        actions.rerender();
        return;
      }
      try {
        const out = await actions.search(q);
        hits = out.hits || [];
      } catch {
        hits = null;
      }
      actions.rerender();
    }, 220);
  });

  refs.newBtn.append(icon("plus", 15));
  refs.collapseBtn.append(icon("back", 15));
  refs.csClose.append(icon("x", 13));

  /* ── current session card ─────────────────────────────────────────── */
  function renderCurrent(state) {
    const bound = state.bound;
    const tab = state.tabs.find((t) => t.key === state.activeKey) || null;
    const driving = bound && state.driving === bound.id;
    const dot = refs.dot;
    dot.className = "cs-dot";
    let label = "No session";
    if (bound) {
      if (bound.kind === "live") {
        dot.classList.add(driving ? "live" : "on");
        label = driving ? "Driving" : "Previewing";
      } else if (bound.state === "working") {
        dot.classList.add("working");
        label = "Working";
      } else if (bound.state === "dead") {
        dot.classList.add("dead");
        label = "Ended";
      } else {
        dot.classList.add("on");
        label = "Headless runner";
      }
    }
    refs.state.textContent = label;
    refs.name.textContent = state.meta?.sessionName || bound?.sessionFile || tab?.title || "New session";
    refs.dir.textContent = shortCwd(bound?.cwd || state.meta?.cwd || "");
    refs.csClose.classList.toggle("hidden", !bound || bound.kind === "live");
  }

  /* ── rows ─────────────────────────────────────────────────────────── */
  function runnerRow(state, info, { inTab }) {
    const live = info.kind === "live";
    const working = info.state === "working";
    const row = el(
      "button",
      {
        type: "button",
        class: `sb-row${state.boundId === info.id && state.view === "session" ? " active" : ""}`,
        dataset: { runnerId: info.id, runnerKind: info.kind },
        onclick: () => (live ? actions.previewRunner(info) : actions.openRunner(info)),
      },
      el(
        "span",
        { class: "row-title" },
        live ? icon("terminal", 13) : icon("chip", 13),
        el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: info.title || info.sessionFile || `${info.kind} session` }),
      ),
      el(
        "span",
        { class: "row-sub" },
        el("span", { class: `dot${working ? " working" : live ? " on" : ""}` }),
        el("span", { text: live ? `pid ${info.pid}` : `${shortCwd(info.cwd)}${info.sessionFile ? ` · ${info.sessionFile.slice(-12)}` : ""}` }),
      ),
      el(
        "span",
        { class: "row-actions" },
        inTab ? null : el("span", { class: "icon-btn", title: "Close runner", html: icon("x", 12).innerHTML, onclick: (e) => { e.stopPropagation(); actions.closeRunner(info); } }),
      ),
    );
    return row;
  }

  function sessionRow(state, session, project) {
    const active = state.view === "session" && state.historyFile === session.file;
    const fav = isFavourite(session.filePath);
    const row = el(
      "button",
      {
        type: "button",
        class: `sb-row${active ? " active" : ""}`,
        dataset: { sessionFile: session.file, sessionDir: session.dirName || project.dirName },
        title: session.filePath || session.file,
        onclick: () => actions.openSession(session, project),
        oncontextmenu: (e) => openMenu(e, session, project),
      },
      el("span", { class: "row-title" }, fav ? icon("star", 12) : null, el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: session.title || session.file })),
      el(
        "span",
        { class: "row-sub" },
        el("span", { text: session.messageCount ? `${session.messageCount} msgs` : "" }),
        el("span", { text: timeAgo(session.mtime) }),
      ),
      el(
        "span",
        { class: "row-actions" },
        el("span", { class: "icon-btn", title: "Actions", html: icon("dots", 14).innerHTML, onclick: (e) => { e.stopPropagation(); openMenu(e, session, project); } }),
      ),
    );
    return row;
  }

  /* ── context menu ─────────────────────────────────────────────────── */
  let menuNode = null;
  function closeMenu() {
    menuNode?.remove();
    menuNode = null;
  }
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
  window.addEventListener("resize", closeMenu);

  function openMenu(e, session, project) {
    e.preventDefault?.();
    e.stopPropagation?.();
    closeMenu();
    const fav = isFavourite(session.filePath);
    menuNode = el(
      "div",
      { class: "ctx-menu", onclick: (ev) => ev.stopPropagation() },
      el("button", { type: "button", onclick: () => { closeMenu(); actions.toggleFavourite(session.filePath); } }, icon(fav ? "star-outline" : "star", 14), fav ? "Unfavourite" : "Favourite"),
      el("button", { type: "button", onclick: () => { closeMenu(); startRename(session, project); } }, icon("pencil", 14), "Rename"),
      el("button", { type: "button", onclick: () => { closeMenu(); actions.forkSession(session, project); } }, icon("branch", 14), "Fork as new"),
      el("button", { type: "button", onclick: () => { closeMenu(); actions.exportSession(session, project); } }, icon("download", 14), "Export HTML"),
      el("button", { type: "button", onclick: () => { closeMenu(); actions.copyPath(session); } }, icon("copy", 14), "Copy path"),
      el("div", { class: "sep" }),
      el("button", { class: "danger", type: "button", onclick: () => { closeMenu(); actions.deleteSession(session, project); } }, icon("trash", 14), "Delete"),
    );
    document.body.append(menuNode);
    const r = e.currentTarget.getBoundingClientRect?.() || { left: e.clientX, top: e.clientY, bottom: e.clientY };
    const pad = 6;
    const mw = menuNode.offsetWidth;
    const mh = menuNode.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - pad);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - pad) top = Math.max(pad, r.top - mh - 4);
    menuNode.style.left = `${Math.max(pad, left)}px`;
    menuNode.style.top = `${top}px`;
  }

  function startRename(session, project) {
    const row = refs.list.querySelector(`[data-session-file="${CSS.escape(session.file)}"]`);
    if (!row) return actions.renameSession(session, project);
    const input = el("input", {
      class: "sb-search",
      value: session.title || basename(session.file),
      style: "width:100%",
      onclick: (e) => e.stopPropagation(),
    });
    row.style.display = "none";
    row.after(input);
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      input.remove();
      row.style.display = "";
      const name = input.value.trim();
      if (save && name && name !== (session.title || "")) await actions.renameSession(session, project, name);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  /* ── render ───────────────────────────────────────────────────────── */
  function matches(session, q) {
    if (!q) return true;
    return `${session.title || ""} ${session.file} ${session.cwd || ""}`.toLowerCase().includes(q);
  }

  return {
    render(state) {
      if (menuNode) closeMenu();
      renderCurrent(state);

      /* open tabs ("Currently running tabs") */
      refs.vtabs.replaceChildren();
      const openTabs = state.tabs.filter((t) => t.runnerId || t.file);
      if (openTabs.length) {
        refs.vtabs.append(el("div", { class: "section-label" }, "Currently running tabs"));
        for (const tab of openTabs) {
          const runner = tab.runnerId ? state.runners.get(tab.runnerId) : null;
          const active = tab.key === state.activeKey && state.view === "session";
          refs.vtabs.append(
            el(
              "button",
              {
                type: "button",
                class: `sb-row${active ? " active" : ""}`,
                dataset: { tabKey: tab.key },
                onclick: () => actions.activateTab(tab.key),
              },
              el(
                "span",
                { class: "row-title" },
                runner?.kind === "live" ? icon("terminal", 13) : el("span", { class: `dot${runner?.state === "working" ? " working" : " on"}` }),
                el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: tab.title || tab.file || "session" }),
              ),
              el(
                "span",
                { class: "row-sub" },
                el("span", { text: runner ? (runner.kind === "live" ? `live · pid ${runner.pid}` : runner.state === "working" ? "working" : "headless") : "headless" }),
              ),
              el(
                "span",
                { class: "row-actions" },
                el("span", { class: "icon-btn", title: "Close tab", html: icon("x", 12).innerHTML, onclick: (e) => { e.stopPropagation(); actions.closeTab(tab.key); } }),
              ),
            ),
          );
        }
      } else {
        show(refs.vtabs, false);
      }
      show(refs.vtabs, openTabs.length > 0);

      /* running terminals not already open in a tab */
      refs.live.replaceChildren();
      const tabRunnerIds = new Set(state.tabs.map((t) => t.runnerId).filter(Boolean));
      const live = [...state.runners.values()].filter((r) => r.kind === "live" && !tabRunnerIds.has(r.id));
      const headless = [...state.runners.values()].filter((r) => r.kind === "headless" && !tabRunnerIds.has(r.id) && r.state !== "dead");
      if (live.length) {
        refs.live.append(el("div", { class: "section-label" }, "Running terminals", el("span", { class: "grow" }), el("span", { class: "count", text: String(live.length) })));
        for (const info of live) refs.live.append(runnerRow(state, info, { inTab: false }));
      }
      if (headless.length) {
        refs.live.append(el("div", { class: "section-label" }, "Headless backends"));
        for (const info of headless) refs.live.append(runnerRow(state, info, { inTab: false }));
      }

      /* favourites */
      const q = (state.search || "").toLowerCase();
      refs.list.replaceChildren();
      const favs = [];
      for (const project of state.projects) {
        for (const s of project.sessions || []) {
          if (state.favourites.includes(s.filePath)) favs.push({ session: s, project });
        }
      }

      const renderProject = (project, sessions) => {
        const isCollapsed = collapsed.has(project.dirName);
        const label = el(
          "button",
          {
            class: `section-label${isCollapsed ? " collapsed" : ""}`,
            type: "button",
            style: "width:100%",
            onclick: () => {
              if (isCollapsed) collapsed.delete(project.dirName);
              else collapsed.add(project.dirName);
              actions.rerender();
            },
          },
          el("span", { class: "caret", html: icon("chevron-down", 11).innerHTML }),
          el("span", { class: "grow", text: basename(project.cwd || project.dirName) || project.dirName }),
          el("span", { class: "count", text: String(sessions.length) }),
        );
        refs.list.append(label);
        if (!isCollapsed) for (const s of sessions) refs.list.append(sessionRow(state, s, project));
      };

      let shown = 0;
      let anyProject = false;
      for (const project of state.projects) {
        const sessions = (project.sessions || [])
          .filter((s) => matches(s, q))
          .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        if (!sessions.length) continue;
        anyProject = true;
        if (!q && favs.length && !shown) {
          refs.list.append(el("div", { class: "section-label" }, "Favourites"));
          for (const f of favs.filter((f) => matches(f.session, ""))) refs.list.append(sessionRow(state, f.session, f.project));
        }
        renderProject(project, sessions);
        shown += sessions.length;
        if (shown > 300) break;
      }

      /* full-text fallback when the local filter has nothing */
      if (q.length >= 2 && !anyProject && hits?.length) {
        refs.list.append(el("div", { class: "section-label" }, `Matches for “${state.search}”`));
        for (const hit of hits) {
          const project = state.projects.find((p) => p.dirName === hit.dirName) || { dirName: hit.dirName, cwd: hit.cwd };
          refs.list.append(
            sessionRow(
              state,
              { file: hit.file, filePath: hit.filePath, title: hit.title || hit.file, cwd: hit.cwd, mtime: hit.timestamp },
              project,
            ),
          );
        }
      } else if (!anyProject && !hits?.length) {
        refs.list.append(el("div", { class: "sb-empty", text: q ? "No matching sessions" : "No sessions on disk yet" }));
      }
    },
    openMenu,
    startRename,
    setCollapsed: (set_) => { collapsed = set_; },
  };
}
