// sidebar — live/headless runners plus session history. Rows are the switcher.
import { el, fmtTime, shortCwd } from "../core/dom.js";

export function createSidebar({ runnerListEl, sessionListEl, searchEl, onBindRunner, onBindSession, onNewSession }) {
  let query = "";

  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    rerender();
  });

  let current = { runners: [], projects: [], boundId: null };

  function runnerRow(info) {
    const isLive = info.kind === "live";
    const state = info.state === "working" ? "working" : info.state === "dead" ? "dead" : "idle";
    return el(
      "button",
      {
        type: "button",
        class: "row-item",
        dataset: { runnerId: info.id, runnerKind: info.kind, runnerState: state },
        "aria-current": info.id === current.boundId ? "true" : "false",
        onclick: () => onBindRunner(info.id),
      },
      el("span", { class: "title", text: info.sessionFile || info.title || `${info.kind} session` }),
      el(
        "span",
        { class: "sub" },
        el("span", { class: "chip", dataset: { state: isLive ? "live" : state }, text: isLive ? "live" : state === "working" ? "working" : "headless" }),
        info.pid ? el("span", { class: "meta", text: `pid ${info.pid}` }) : null,
        el("span", { class: "meta", text: shortCwd(info.cwd) }),
        info.viewers ? el("span", { class: "meta", text: `${info.viewers} viewing` }) : null,
        el("span", { class: "meta", text: fmtTime(info.lastActiveAt) }),
      ),
    );
  }

  function sessionRow(session) {
    const title = session.title || session.file;
    return el(
      "button",
      {
        type: "button",
        class: "row-item",
        dataset: { sessionFile: session.file, sessionDir: session.dirName },
        title: session.file,
        onclick: () => onBindSession(session),
      },
      el("span", { class: "title", text: title }),
      el(
        "span",
        { class: "sub" },
        el("span", { class: "meta", text: `${session.messageCount || 0} msgs` }),
        el("span", { class: "meta", text: fmtTime(session.mtime) }),
        session.model ? el("span", { class: "meta", text: session.model.split("/").pop() }) : null,
      ),
    );
  }

  function match(session) {
    if (!query) return true;
    return `${session.title} ${session.file} ${session.cwd || ""}`.toLowerCase().includes(query);
  }

  function rerender() {
    runnerListEl.replaceChildren();
    const live = current.runners.filter((r) => r.kind === "live");
    const headless = current.runners.filter((r) => r.kind === "headless");
    if (live.length) {
      runnerListEl.append(el("div", { class: "section-label", text: "Live terminal sessions" }));
      live.forEach((r) => runnerListEl.append(runnerRow(r)));
    }
    if (headless.length) {
      runnerListEl.append(el("div", { class: "section-label", text: "Running here" }));
      headless.forEach((r) => runnerListEl.append(runnerRow(r)));
    }
    runnerListEl.append(el("div", { class: "section-label" }, "History", el("button", { type: "button", class: "pill", text: "＋ New", onclick: onNewSession })));

    sessionListEl.replaceChildren();
    let shown = 0;
    for (const project of current.projects) {
      const sessions = (project.sessions || []).filter(match);
      if (!sessions.length) continue;
      sessionListEl.append(el("div", { class: "section-label", text: shortCwd(project.cwd || project.dirName) }));
      for (const session of sessions) {
        sessionListEl.append(sessionRow(session));
        shown++;
        if (shown > 200) break;
      }
      if (shown > 200) break;
    }
    if (!shown) sessionListEl.append(el("div", { class: "meta", style: "padding:10px", text: "No sessions" }));
  }

  return {
    render(patch) {
      Object.assign(current, patch);
      rerender();
    },
  };
}
