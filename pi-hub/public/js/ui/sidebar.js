/**
 * sidebar — current session card, open tabs, running terminals, project
 * session list, search, favourites and row actions. Purely a view: every
 * mutation goes back through app actions.
 */
import { el, show, timeAgo, shortCwd, basename } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { isFavourite, favKey, sessionKey } from "../core/store.js";

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

  refs.newBtn.append(icon("plus", 16));
  refs.collapseBtn.append(icon("back", 16));
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
    // Title first, file name never (a session's identity is its name; the
    // `.jsonl` name only appears for a session with no prompt yet, which the
    // UI calls "New session").
    refs.name.textContent = state.meta?.sessionName || tab?.title || "New session";
    refs.dir.textContent = shortCwd(bound?.cwd || state.meta?.cwd || "");
    refs.csClose.classList.toggle("hidden", !bound || bound.kind === "live");
  }

  /* ── rows ─────────────────────────────────────────────────────────── */
  // Rows show the session title (same string as the tab titles), resolved from
  // the on-disk store. Live runners carry an absolute path, so match on the
  // basename too. Fallbacks stay human: never a `.jsonl` name.
  function sessionTitleFor(state, info) {
    if (info.title) return info.title;
    const base = basename(info.sessionFile || info.absFile || "");
    let byFile = null;
    for (const project of state.projects || []) {
      for (const s of project.sessions || []) {
        if (info.absFile && s.filePath === info.absFile && s.title) return s.title;
        if (!base || s.file !== base) continue;
        const stem = String(s.file).replace(/\.jsonl$/, "");
        if (s.title && s.title !== stem) return s.title;
        if (!byFile) byFile = s;
      }
    }
    if (info.kind === "live") return "Live TUI";
    if (byFile?.title) return byFile.title;
    return base ? basename(base).replace(/\.jsonl$/, "") : "New session";
  }

  function runnerRow(state, info, { inTab }) {
    const live = info.kind === "live";
    const working = info.state === "working";
    const row = el(
      "button",
      {
        type: "button",
        class: `sb-row${state.boundId === info.id && state.view === "session" ? " active" : ""}${live ? " live-row" : ""}`,
        dataset: { runnerId: info.id, runnerKind: info.kind },
        onclick: () => (live ? actions.previewRunner(info) : actions.openRunner(info)),
      },
      el(
        "span",
        { class: "row-title" },
        live ? icon("terminal", 13) : icon("chip", 13),
        el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: sessionTitleFor(state, info) }),
        live ? el("span", { class: "chip live", text: "live" }) : null,
      ),
      el(
        "span",
        { class: "row-sub" },
        el("span", { class: `dot${working ? " working" : live ? " on" : ""}` }),
        el("span", { text: live ? `pid ${info.pid}` : `${shortCwd(info.cwd)}${info.pid ? ` · pid ${info.pid}` : ""}` }),
      ),
      el(
        "span",
        { class: "row-actions" },
        inTab ? null : el("span", { class: "icon-btn", title: "Close runner", onclick: (e) => { e.stopPropagation(); actions.closeRunner(info); } }, icon("x", 13)),
      ),
    );
    return row;
  }

  function sessionRow(state, session, project) {
    const active = state.view === "session" && state.historyFile === session.file;
    const key = favKey(session, project);
    const fav = isFavourite(key);
    const dirName = session.dirName || project?.dirName || "";
    const liveOwned = [...state.runners?.values?.() || []].some((r) => r.kind === "live" && !!r.absFile && !!session.file && r.absFile.endsWith(`/${dirName}/${session.file}`));
    const row = el(
      "button",
      {
        type: "button",
        class: `sb-row${active ? " active" : ""}`,
        dataset: { sessionFile: session.file, sessionDir: dirName },
        title: `${dirName}/${session.file}`,
        onclick: () => actions.openSession(session, project),
        oncontextmenu: (e) => openMenu(e, session, project),
      },
      // No separate star in the title: the (now filled, always-visible) action
      // star already marks favourites, and two stars per row was just noise.
      el("span", { class: "row-title" }, el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: session.title || session.file }), liveOwned ? el("span", { class: "chip live", text: "live" }) : null),
      el(
        "span",
        { class: "row-sub" },
        el("span", { text: session.messageCount ? `${session.messageCount} msgs` : "" }),
        el("span", { text: timeAgo(session.mtime) }),
      ),
      el(
        "span",
        { class: "row-actions" },
        el("span", {
          class: "icon-btn fav-btn", title: fav ? "Unfavourite" : "Favourite",
          "aria-label": fav ? "Unfavourite" : "Favourite", "aria-pressed": String(fav),
          dataset: { fav: fav ? "1" : "0" },
          onclick: (e) => { e.stopPropagation(); actions.toggleFavourite(key); },
        }, icon(fav ? "starFill" : "star-outline", 13)),
        el("span", { class: "icon-btn", title: "Actions", onclick: (e) => { e.stopPropagation(); openMenu(e, session, project); } }, icon("dots", 13)),
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
    const fav = isFavourite(favKey(session, project));
    menuNode = el(
      "div",
      { class: "ctx-menu", onclick: (ev) => ev.stopPropagation() },
      el("button", { type: "button", onclick: () => { closeMenu(); actions.toggleFavourite(favKey(session, project)); } }, icon(fav ? "starFill" : "star-outline", 14), fav ? "Unfavourite" : "Favourite"),
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
        refs.vtabs.append(
          el("div", { class: "section-label tabs-label" }, icon("tabs", 12), "Currently running tabs",
            el("span", { class: "grow" }), el("span", { class: "count", text: String(openTabs.length) })),
        );
        for (const tab of openTabs) {
          const runner = tab.runnerId ? state.runners.get(tab.runnerId) : null;
          const active = tab.key === state.activeKey && state.view === "session";
          refs.vtabs.append(
            el(
              "button",
              {
                type: "button",
                class: `sb-row${active ? " active" : ""}${runner?.kind === "live" ? " live-row" : ""}`,
                dataset: { tabKey: tab.key },
                onclick: () => actions.activateTab(tab.key),
              },
              el(
                "span",
                { class: "row-title" },
                runner?.kind === "live" ? icon("terminal", 13) : el("span", { class: `dot${runner?.state === "working" ? " working" : " on"}` }),
                el("span", { class: "grow", style: "overflow:hidden;text-overflow:ellipsis", text: tab.title || "new session" }),
              ),
              el(
                "span",
                { class: "row-sub" },
                el("span", { text: runner ? (runner.kind === "live" ? `live · pid ${runner.pid}` : runner.state === "working" ? "working" : "headless") : "headless" }),
              ),
              el(
                "span",
                { class: "row-actions" },
                el("span", { class: "icon-btn", title: "Close tab", onclick: (e) => { e.stopPropagation(); actions.closeTab(tab.key); } }, icon("x", 13)),
              ),
            ),
          );
        }
      }
      show(refs.vtabs, openTabs.length > 0);

      /* live terminals: their own block, first, always visible — including
         ones already open in a tab (a live TUI is a thing on the box, not
         just a tab) */
      refs.live.replaceChildren();
      const tabRunnerIds = new Set(state.tabs.map((t) => t.runnerId).filter(Boolean));
      const live = [...state.runners.values()].filter((r) => r.kind === "live");
      const headless = [...state.runners.values()].filter((r) => r.kind === "headless" && !tabRunnerIds.has(r.id) && r.state !== "dead");
      if (live.length) {
        refs.live.append(el("div", { class: "section-label live-label" }, icon("terminal", 12), "Live terminals", el("span", { class: "grow" }), el("span", { class: "count", text: String(live.length) })));
        for (const info of live) refs.live.append(runnerRow(state, info, { inTab: false }));
      }
      if (headless.length) {
        refs.live.append(
          el(
            "div",
            { class: "section-label" },
            "Headless backends",
            el("span", { class: "grow" }),
            el("span", { class: "count", text: String(headless.length) }),
            headless.length > 1
              ? el("button", {
                  class: "label-action",
                  type: "button",
                  title: "Close every headless backend",
                  onclick: (e) => {
                    e.stopPropagation();
                    actions.killAllHeadless();
                  },
                             }, "Kill all")
              : null,
          ),
        );
        for (const info of headless) refs.live.append(runnerRow(state, info, { inTab: false }));
      }

      /* favourites */
      const q = (state.search || "").toLowerCase();
      refs.list.replaceChildren();
      const favs = [];
      for (const project of state.projects) {
        for (const s of project.sessions || []) {
          if (state.favourites.includes(favKey(s, project))) favs.push({ session: s, project });
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
          el("span", { class: "caret" }, icon("chevron-down", 12)),
          el("span", { class: "grow", text: basename(project.cwd || project.dirName) || project.dirName }),
          el("span", { class: "count", text: String(sessions.length) }),
        );
        refs.list.append(label);
        if (!isCollapsed) for (const s of sessions) refs.list.append(sessionRow(state, s, project));
      };

      let shown = 0;
      let anyProject = false;
      // Favourited sessions render once, in the Favourites block — not again
      // inside their project group (R-6). Searching still shows everything.
      const favPaths = new Set(favs.map((f) => favKey(f.session, f.project)));
      // The block must render even when favourites are the *only* sessions:
      // it used to be emitted from inside the project loop, so favouriting the
      // last visible session reduced the filter to zero rows and the whole
      // list (favourites included) vanished.
      if (!q && favs.length) {
        refs.list.append(el("div", { class: "section-label" }, "Favourites"));
        for (const f of favs.filter((f) => matches(f.session, ""))) refs.list.append(sessionRow(state, f.session, f.project));
        anyProject = true;
      }
      for (const project of state.projects) {
        const sessions = (project.sessions || [])
          .filter((s) => matches(s, q))
          .filter((s) => q || !favPaths.has(favKey(s, project)))
          .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        if (!sessions.length) continue;
        anyProject = true;
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
