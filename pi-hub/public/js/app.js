/**
 * app — wiring. Owns the socket, the tab/view FSM and the bind lifecycle;
 * views are dumb renderers of `store.state` plus action callbacks. The four
 * first-class capabilities map to: openSession (resume), newSession (create
 * anywhere), previewRunner/attach (drive a live TUI), commandRequest (add to
 * a running headless backend).
 */
import { $, el, show, toast, shortCwd, basename, timeAgo, copyText, usageText } from "./core/dom.js";
import { icon, logo } from "./core/icons.js";
import {
  activeTab,
  allSessions,
  findTabByFile,
  findTabByRunner,
  liveKey,
  removeTab,
  runnerKey,
  saveTabs,
  sessionKey,
  set,
  state,
  subscribe,
  toggleFavourite,
  updateTab,
  upsertTab,
} from "./core/store.js";
import {
  deleteSession as apiDelete,
  forkSession as apiFork,
  gitBranch,
  history as fetchHistory,
  listSessions,
  login,
  logout,
  onUnauthorized,
  renameSession as apiRename,
  relocateSession as apiRelocate,
  searchSessions,
  serverInfo,
} from "./core/api.js";
import { HubSocket } from "./core/ws.js";
import { createTranscript } from "./ui/transcript.js";
import { createDialogs } from "./ui/dialogs.js";
import { createSidebar } from "./ui/sidebar.js";
import { createPicker } from "./ui/picker.js";
import { createComposer } from "./ui/composer.js";
import { createFiles } from "./ui/files.js";
import { createSettings } from "./ui/settings.js";
import { createTabs } from "./ui/tabs.js";
import { renderBanner } from "./ui/banner.js";

/* ── refs ────────────────────────────────────────────────────────────── */
/** The context chip's popover: one small card, opened on demand. */
const ctxPop = { node: null, open: false };

const refs = {
  app: $("app"),
  login: $("login"),
  loginForm: $("login-form"),
  loginMark: $("login-mark"),
  loginSub: $("login-sub"),
  loginReveal: $("login-reveal"),
  loginSubmit: $("login-submit"),
  loginUser: $("login-user"),
  loginPass: $("login-pass"),
  loginError: $("login-error"),

  tabbar: $("tabbar"),
  tabsStrip: $("tab-strip"),
  homeBtn: $("home-btn"),
  tabNew: $("tab-new"),
  sidebarToggle: $("sidebar-toggle"),
  conn: $("conn"),
  statusDot: $("status-dot"),
  statusText: $("status-text"),
  filesBtn: $("files-btn"),
  settingsBtn: $("settings-btn"),
  reloadBtn: $("reload-btn"),

  titlebar: $("titlebar"),
  tbTitle: $("tb-title"),
  tbChip: $("tb-chip"),
  tbClose: $("tb-close"),

  sidebar: $("sidebar"),
  sidebarOverlay: $("sidebar-overlay"),
  search: $("session-search"),
  newSessionBtn: $("new-session-btn"),
  sidebarCollapse: $("sidebar-collapse"),
  csDot: $("cs-dot"),
  csState: $("cs-state"),
  csName: $("cs-name"),
  csDir: $("cs-dir"),
  csClose: $("cs-close"),
  vtabs: $("vtabs-section"),
  live: $("live-section"),
  sessionList: $("session-list"),

  view: $("view"),
  jumpLatest: $("jump-latest"),
  welcome: $("welcome"),
  welcomeLogo: $("welcome-logo"),
  welcomeHints: $("welcome-hints"),
  welcomeActions: $("welcome-actions"),
  welcomeRecents: $("welcome-recents"),
  welcomeLive: $("welcome-live"),
  banner: $("banner"),
  messages: $("messages"),

  queue: $("queue"),
  composerForm: $("composer"),
  input: $("input"),
  sendBtn: $("send-btn"),
  abortBtn: $("abort-btn"),
  micBtn: $("mic-btn"),
  commandBtn: $("command-btn"),
  attachBtn: $("attach-btn"),
  imageInput: $("image-input"),
  modelWrap: $("model-wrap"),
  modelBtn: $("model-btn"),
  modelMenu: $("model-menu"),
  modelLabel: $("model-label"),
  thinkingWrap: $("thinking-wrap"),
  thinkingBtn: $("thinking-btn"),
  thinkingMenu: $("thinking-menu"),
  thinkingLabel: $("thinking-label"),
  slash: $("slash"),
  commandMenu: $("command-menu"),
  cwdLabel: $("cwd-label"),
  costChip: $("cost-chip"),
  contextChip: $("context-chip"),

  filePanel: $("file-panel"),
  filePanelTitle: $("file-panel-title"),
  filePath: $("file-path"),
  fileList: $("file-list"),
  fileUp: $("file-up"),
  fileFinder: $("file-finder"),
  fileClose: $("file-close"),

  picker: $("picker"),
  pickerFavs: $("picker-favs"),
  pickerPath: $("picker-path"),
  pickerUp: $("picker-up"),
  pickerDirs: $("picker-dirs"),
  pickerSessions: $("picker-sessions"),
  pickerSessionsLabel: $("picker-sessions-label"),
  pickerChoice: $("picker-choice"),
  pickerStarter: $("picker-starter"),
  pickerStart: $("picker-start"),
  pickerClose: $("picker-close"),

  settings: $("settings"),
  settingsClose: $("settings-close"),
  settingsTabs: document.querySelector(".settings-tabs"),
  themeGrid: $("theme-grid"),
  toggleThinking: $("toggle-thinking"),
  toggleCosts: $("toggle-costs"),
  toggleTools: $("toggle-tools"),
  toggleWrap: $("toggle-wrap"),
  serverInfo: $("server-info"),
  procRefresh: $("proc-refresh"),
  procList: $("proc-list"),
  logoutBtn: $("logout-btn"),

  viewer: $("viewer"),
  viewerTitle: $("viewer-title"),
  viewerBody: $("viewer-body"),
  viewerAdd: $("viewer-add"),
  viewerDownload: $("viewer-download"),
  viewerClose: $("viewer-close"),

  dialogContainer: $("dialog-container"),
};

/* ── theme before first paint ────────────────────────────────────────── */
function initialTheme() {
  if (state.prefs.theme) return state.prefs.theme;
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "terracotta" : "night";
  } catch {
    return "night";
  }
}
document.documentElement.dataset.theme = initialTheme();

/* ── modules ─────────────────────────────────────────────────────────── */
let socket = null;
const pendingCommands = new Map();

const lastSeenSeq = new Map(); // runnerId -> last event seq observed

function rawSend(msg) {
  return socket?.send(msg) ?? false;
}
function sendExtensionResponse(msg) {
  rawSend(msg);
}

const dialogs = createDialogs(refs.dialogContainer, sendExtensionResponse, {
  /** Extension notifications (skills, command runs) belong to the session they
   *  happened in — show them in the transcript, not as a toast that vanishes.
   *  With no session on screen a toast is the only channel left. */
  notify: (message, kind) => {
    if (state.view === "session" && state.bound) transcript.notice(message, { kind });
    else toast(message, { kind });
  },
});

const transcript = createTranscript(refs.messages, {
  showThinking: state.prefs.showThinking,
  showCosts: state.prefs.showCosts,
  expandTools: state.prefs.expandTools,
  onOpenFile: (path) => files.view(path),
});

const files = createFiles(
  {
    panel: refs.filePanel,
    panelTitle: refs.filePanelTitle,
    path: refs.filePath,
    list: refs.fileList,
    up: refs.fileUp,
    finder: refs.fileFinder,
    close: refs.fileClose,
    viewer: refs.viewer,
    title: refs.viewerTitle,
    body: refs.viewerBody,
    add: refs.viewerAdd,
    viewerAdd: refs.viewerAdd,
    download: refs.viewerDownload,
    viewerClose: refs.viewerClose,
  },
  {
    addToPrompt: (path) => {
      state.pendingFiles.push(path);
      const prefix = refs.input.value && !refs.input.value.endsWith("\n") ? "\n" : "";
      refs.input.value = `${refs.input.value}${prefix}@${path} `;
      refs.input.focus();
      toast(`Added ${basename(path)} to the prompt`);
    },
  },
);

const picker = createPicker(
  {
    root: refs.picker,
    favs: refs.pickerFavs,
    path: refs.pickerPath,
    up: refs.pickerUp,
    dirs: refs.pickerDirs,
    sessions: refs.pickerSessions,
    sessionsLabel: refs.pickerSessionsLabel,
    choice: refs.pickerChoice,
    starter: refs.pickerStarter,
    start: refs.pickerStart,
    close: refs.pickerClose,
  },
  {
    onStart: (dir, starter) => newSession(dir, starter),
    onResume: (session, project) => openSession(session, project),
    onFork: (session, project) => forkSession(session, project),
    toggleFavourite: (file) => toggleFavourite(file),
  },
);

const settings = createSettings(
  {
    root: refs.settings,
    close: refs.settingsClose,
    tabs: refs.settingsTabs,
    themeGrid: refs.themeGrid,
    thinkingToggle: refs.toggleThinking,
    costsToggle: refs.toggleCosts,
    toolsToggle: refs.toggleTools,
    wrapToggle: refs.toggleWrap,
    info: refs.serverInfo,
    refresh: refs.procRefresh,
    procRefresh: refs.procRefresh,
    procList: refs.procList,
    logout: refs.logoutBtn,
  },
  {
    logout: async () => {
      await logout().catch(() => {});
      location.reload();
    },
    confirm: (title, message) => dialogs.confirm(title, message),
    applyPrefs: () => {
      transcript.setOptions({
        showThinking: state.prefs.showThinking,
        showCosts: state.prefs.showCosts,
        expandTools: state.prefs.expandTools,
      });
      render();
    },
  },
);

/** Drop pi's queued steering/follow-up messages and return their text. */
async function clearQueue() {
  const r = await commandRequest({ type: "clear_queue" }, 15000).catch(() => null);
  const texts = [...(r?.data?.steering || []), ...(r?.data?.followUp || [])].filter((t) => typeof t === "string");
  set({ queue: [] });
  return texts;
}

/** Put recovered text back into the composer, keeping anything already typed. */
function restoreToEditor(texts) {
  if (!texts.length) return;
  const current = refs.input.value.trim();
  refs.input.value = [current, ...texts].filter(Boolean).join("\n");
  refs.input.dispatchEvent(new Event("input"));
  refs.input.focus();
}

const composer = createComposer(
  {
    form: refs.composerForm,
    input: refs.input,
    sendBtn: refs.sendBtn,
    abortBtn: refs.abortBtn,
    micBtn: refs.micBtn,
    commandBtn: refs.commandBtn,
    attachBtn: refs.attachBtn,
    imageInput: refs.imageInput,
    queueEl: refs.queue,
    slashEl: refs.slash,
    commandMenu: refs.commandMenu,
    modelBtn: refs.modelBtn,
    modelMenu: refs.modelMenu,
    modelLabel: refs.modelLabel,
    thinkingBtn: refs.thinkingBtn,
    thinkingMenu: refs.thinkingMenu,
    thinkingLabel: refs.thinkingLabel,
  },
  {
    isWorking: () => state.streaming || state.bound?.state === "working",
    prompt: (message, images) => commandRequest({ type: "prompt", message, ...(images.length ? { images } : {}) }, 30000),
    steer: (message, images) => commandRequest({ type: "steer", message, ...(images.length ? { images } : {}) }, 30000),
    followUp: (message, images) => commandRequest({ type: "follow_up", message, ...(images.length ? { images } : {}) }, 30000),
    // Abort behaves like pi's Esc: queued text goes back to the editor instead
    // of being delivered after the run.
    abort: async () => {
      restoreToEditor(await clearQueue());
      rawSend({ type: "command", id: `abort-${Date.now().toString(36)}`, command: { type: "abort" } });
    },
    listCommands: () =>
      commandRequest({ type: "get_commands" }, 20000)
        .then((r) => r.data?.commands || [])
        .catch(() => []),
    listModels: () => commandRequest({ type: "get_available_models" }, 20000).then((r) => r.data?.models || []),
    listThinkingLevels: () =>
      commandRequest({ type: "get_available_thinking_levels" }, 15000)
        .then((r) => (Array.isArray(r.data?.levels) ? r.data.levels.filter((l) => typeof l === "string") : []))
        .catch(() => []),
    getState: () => commandRequest({ type: "get_state" }, 15000).then((r) => r.data),
    setModel: async (m) => {
      await commandRequest({ type: "set_model", provider: m.provider, modelId: m.id }, 20000);
      // RPC mode answers set_model with a response only — no model_select
      // event is forwarded by the child — so re-read state to refresh the
      // pills (and the server's runner info) immediately.
      await refreshSessionState();
    },
    setThinking: async (level) => {
      await commandRequest({ type: "set_thinking_level", level }, 20000);
      await refreshSessionState();
    },
    restoreQueue: async () => restoreToEditor(await clearQueue()),
    takePendingFiles: () => state.pendingFiles.splice(0),
    toast: (message, opts) => toast(message, opts),
  },
);

const sidebar = createSidebar(
  {
    search: refs.search,
    newBtn: refs.newSessionBtn,
    collapseBtn: refs.sidebarCollapse,
    csClose: refs.csClose,
    vtabs: refs.vtabs,
    live: refs.live,
    list: refs.sessionList,
    dot: refs.csDot,
    state: refs.csState,
    name: refs.csName,
    dir: refs.csDir,
  },
  {
    openSession: (session, project) => openSession(session, project),
    openRunner: (runner) => bindRunner(runner.id, runner),
    previewRunner: (runner) => bindRunner(runner.id, runner),
    closeRunner: (runner) => killRunner(runner, { confirm: true }),
    killAllHeadless: () => killAllHeadless(),
    activateTab: (key) => activateTab(key),
    closeTab: (key) => closeTab(key),
    setSearch: (q) => set({ search: q }),
    search: (q) => searchSessions(q),
    rerender: () => render(),
    forkSession: (session, project) => forkSession(session, project),
    deleteSession: (session, project) => deleteSession(session, project),
    renameSession: (session, project, name) => renameSession(session, project, name),
    copyPath: (session) => copyText(session.filePath || (session.dirName ? `${session.dirName}/${session.file}` : session.file)),
    exportSession: (session, project) => exportSession(session, project),
    toggleFavourite: (file) => toggleFavourite(file),
  },
);

const tabs = createTabs(
  { strip: refs.tabsStrip, newBtn: refs.tabNew },
  {
    activateTab: (key) => activateTab(key),
    closeTab: (key) => closeTab(key),
  },
);

/* ── titlebar ────────────────────────────────────────────────────────── */
refs.tbClose.append(icon("x", 14));
refs.tbClose.addEventListener("click", () => state.activeKey && closeTab(state.activeKey));
refs.welcomeLogo.append(logo(60));
refs.loginMark.append(logo(48));
refs.welcomeHints.append(
  el("span", { class: "chip-mini" }, "/", " focus input"),
  el("span", { class: "chip-mini" }, "Esc", " stop"),
  el("span", { class: "chip-mini" }, "Ctrl+T", " new session"),
);
refs.welcomeActions.append(
  el("button", { class: "btn primary", type: "button", onclick: () => newSession(state.bound?.cwd || state.meta?.cwd) }, icon("plus", 14), "New session"),
  el("button", { class: "btn", type: "button", onclick: () => picker.open(state.bound?.cwd || state.meta?.cwd) }, icon("folder", 14), "Browse sessions…"),
);

/** Live TUI block on the home screen: a running terminal is state on the
 *  box, so it gets a prominent card with one-click Drive — no need to open
 *  the drawer or hunt through the sidebar. */
function renderWelcomeLive() {
  const live = [...state.runners.values()].filter((r) => r.kind === "live");
  refs.welcomeLive.replaceChildren();
  show(refs.welcomeLive, live.length > 0);
  if (!live.length) return;
  refs.welcomeLive.append(
    el("div", { class: "section-label live-label" }, icon("terminal", 11), "Live terminals", el("span", { class: "grow" }), el("span", { class: "count", text: String(live.length) })),
  );
  for (const info of live) {
    const base = basename(info.sessionFile || info.absFile || "");
    const parts = String(info.absFile || "").split(/[\\/]/);
    const dirName = parts.length > 1 ? parts[parts.length - 2] : null;
    const title = titleForFile(dirName, base) || info.title || "Live TUI";
    refs.welcomeLive.append(
      el(
        "div",
        { class: "welcome-live-row live-row", dataset: { runnerId: info.id, runnerKind: "live" } },
        el(
          "button",
          { type: "button", class: "welcome-live-main", onclick: () => bindRunner(info.id, info) },
          el("span", { class: "row-title" }, icon("terminal", 13), el("span", { class: "grow", text: title }), el("span", { class: "chip live", text: "live" })),
          el("span", { class: "row-sub" }, el("span", { class: `dot${info.state === "working" ? " working" : " on"}` }), el("span", { text: `pid ${info.pid}` }), el("span", { text: shortCwd(info.cwd) })),
        ),
        el("button", {
          type: "button",
          class: "btn small primary",
          text: "Drive",
          onclick: async () => {
            await bindRunner(info.id, info);
            await attach(info, false);
          },
        }),
      ),
    );
  }
}

function renderWelcome() {
  if (state.view !== "welcome") return;
  renderWelcomeLive();
  refs.welcomeRecents.replaceChildren();
  const recents = allSessions()
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
    .slice(0, 6);
  if (!recents.length) return;
  refs.welcomeRecents.append(el("div", { class: "section-label", text: "Recent sessions" }));
  for (const s of recents) {
    refs.welcomeRecents.append(
      el(
        "button",
        { type: "button", class: "sb-row", dataset: { sessionFile: s.file }, onclick: () => openSession(s, { dirName: s.dirName, cwd: s.cwd }) },
        el("span", { class: "row-title" }, el("span", { class: "grow", text: s.title || s.file })),
        el("span", { class: "row-sub" }, el("span", { text: shortCwd(s.cwd || "") }), el("span", { text: timeAgo(s.mtime) })),
      ),
    );
  }
}
refs.homeBtn.append(logo(22));refs.filesBtn.append(icon("folder", 16));
refs.settingsBtn.append(icon("gear", 17));
refs.reloadBtn.append(icon("refresh", 15));
refs.sidebarToggle.append(icon("menu", 18));
refs.fileFinder.append(icon("external", 14));

/* ── render ──────────────────────────────────────────────────────────── */
function render() {
  // sidebar visibility (drawer on mobile, collapsed column on desktop)
  document.body.classList.toggle("sidebar-open", !!state.ui?.sidebarOpen);
  refs.sidebar.classList.toggle("collapsed", !!state.ui?.sidebarCollapsed && !state.ui?.sidebarOpen);
  document.querySelector(".shell")?.classList.toggle("sidebar-collapsed", !!state.ui?.sidebarCollapsed);
  syncSidebarToggle();
  show(refs.sidebarOverlay, !!state.ui?.sidebarOpen);

  tabs.render(state);
  renderWelcome();
  sidebar.render(state);
  composer.render(state);
  renderBanner(refs.banner, state, bannerActions);
  renderStatusline();
  renderTitlebar();

  if (state.binding && state.view === "session") {
    transcript.renderHistory([], { loading: true });
    clearLoadEarlier(); // previous session's counts must not linger
  }
  const sessionView = state.view === "session" && !!state.bound;
  show(refs.welcome, !sessionView);
  show(refs.messages, sessionView);
  // The messages pane is hidden on the homepage — drop its stale nodes too
  // so a closed transcript frees its DOM instead of lingering hidden, and
  // take the "load earlier" control with it (it is a sibling of #messages).
  if (!sessionView) {
    transcript.renderHistory([], null);
    clearLoadEarlier();
    show(refs.jumpLatest, false);
    // The pane is shared with the transcript; a scrolled session must not
    // leave the welcome block scrolled off its top.
    if (refs.view.scrollTop !== 0) refs.view.scrollTop = 0;
  }
  document.body.dataset.view = state.view;
  if (state.booted) document.body.dataset.ready = "1";
}

function renderTitlebar() {
  const tab = activeTab();
  // Shown for any open session — it used to require a collapsed sidebar,
  // which made the title (and its state chip + close) vanish for no reason
  // while the sidebar was open.
  const hidden = !tab || state.view !== "session";
  show(refs.titlebar, !hidden);
  if (hidden) return;
  refs.tbTitle.textContent = tab.title || tab.file || "session";
  const runner = tab.runnerId ? state.runners.get(tab.runnerId) : null;
  refs.tbChip.textContent = runner?.kind === "live" ? "live tui" : runner ? runner.state : "session";
  refs.tbChip.className = `chip ${runner?.kind === "live" ? "live" : runner?.state === "dead" ? "dead" : "headless"}`;
}

/* git branch for the open session's directory (fetched once per cwd) */
const gitCache = new Map();
let gitPending = null;

function refreshGit(cwd) {
  if (!cwd || state.view !== "session") return;
  if (gitCache.has(cwd) || gitPending === cwd) return;
  gitPending = cwd;
  gitBranch(cwd)
    .then((info) => gitCache.set(cwd, info))
    .catch(() => gitCache.set(cwd, { branch: null }))
    .finally(() => {
      if (gitPending === cwd) gitPending = null;
      render();
    });
}

function renderStatusline() {
  const cwd = state.bound?.cwd || state.meta?.cwd || "";
  const parts = [icon("folder", 13), el("span", { class: "cwd-text", text: shortCwd(cwd) || "no session" })];
  const branch = cwd ? gitCache.get(cwd)?.branch : null;
  if (branch) {
    parts.push(
      el("span", { class: "cwd-branch", title: `git branch: ${branch}` },
        icon("branch", 11),
        el("span", { class: "cwd-branch-name", text: branch }),
      ),
    );
  }
  refs.cwdLabel.replaceChildren(...parts);
  refreshGit(cwd);

  const cost = state.meta?.cost ?? 0;
  const tokens = state.meta?.tokens ?? 0;
  const showCost = state.prefs.showCosts && state.view === "session";
  show(refs.costChip, showCost && (cost > 0 || tokens > 0));
  if (cost > 0 || tokens > 0) {
    const bits = [];
    if (tokens) bits.push(`${(tokens / 1000).toFixed(1)}k tok`);
    if (cost > 0) bits.push(`$${cost.toFixed(4)}`);
    refs.costChip.textContent = bits.join(" · ");
  }
  const usage = state.contextUsage;
  show(refs.contextChip, state.view === "session" && usage?.percent != null);
  if (usage?.percent != null) {
    const pct = Number(usage.percent);
    refs.contextChip.textContent = pct < 1 ? "<1% ctx" : `${Math.round(pct)}% ctx`;
    refs.contextChip.classList.toggle("warn", pct >= 70 && pct < 90);
    refs.contextChip.classList.toggle("danger", pct >= 90);
    refs.contextChip.disabled = false;
    refs.contextChip.title = "Context usage — click for details";
    if (ctxPop.open) renderContextPopover();
  }

  // connection pill
  const connState = !state.connected ? "off" : state.streaming ? "working" : "on";
  refs.conn.dataset.state = connState;
  refs.conn.title = state.connected ? `Connected · ${state.mode || "hub"} · v${state.version || "?"}` : "Disconnected — click to retry";
  refs.statusText.textContent = !state.connected
    ? "Offline"
    : state.streaming
      ? "Working…"
      : state.compacting
        ? "Compacting…"
        : "Connected";
}

subscribe(render);

/* ── commands over WS ────────────────────────────────────────────────── */
function sendCommand(command, timeoutMs = 20000) {
  const id = command.id || `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`${command.type} timed out`));
    }, timeoutMs);
    pendingCommands.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    if (!rawSend({ type: "command", id, command: { ...command, id } })) {
      pendingCommands.delete(id);
      clearTimeout(timer);
      reject(new Error("not connected"));
    }
  });
}
const commandRequest = sendCommand;

/** Pull the child's current model/thinking into the client view. Needed after
 *  set_model / set_thinking_level: RPC mode forwards a bare response (no
 *  model_select event), so without this the pills keep the stale value. */
async function refreshSessionState() {
  try {
    const st = await commandRequest({ type: "get_state" }, 15000).then((r) => r.data);
    if (!st) return;
    const m = st.model;
    const id = typeof m === "string" ? m : m?.id || m?.name || "";
    const provider = typeof m === "object" && m ? m.provider || "" : "";
    set({
      bound: state.bound
        ? { ...state.bound, model: id || state.bound.model, thinkingLevel: st.thinkingLevel || state.bound.thinkingLevel }
        : state.bound,
      meta: {
        ...(state.meta || {}),
        ...(id ? { model: provider ? `${provider}/${id}` : id } : {}),
        ...(st.thinkingLevel ? { thinkingLevel: st.thinkingLevel } : {}),
      },
    });
  } catch {}
}

/* ── bind lifecycle ──────────────────────────────────────────────────── */
function applyBound(msg, tab) {
  const runner = msg.runner || {};  set({
    boundId: runner.id,
    bound: runner,
    binding: false,
    driverBusy: null,
    driving: null,
    cwdFallback: runner.cwdFallback || null,
    queue: [],
    contextUsage: null,
    entries: [],
    meta: null,
  });
  const key = tab?.key || (runner.sessionFile ? sessionKey(tab?.dirName, runner.sessionFile) : runnerKey(runner.id));
  // Titles only: a session's identity is its name (the store's prompt-derived
  // title). Never surface the `.jsonl` file name — a brand-new session is
  // "new session" until its first prompt names it, a live TUI without a
  // stored title is "Live TUI".
  let title = tab?.title;
  if (!title || title === "new session") {
    const base = basename(runner.sessionFile || runner.absFile || "");
    title =
      runner.kind === "live"
        ? titleForFile(null, base) || "Live TUI"
        : titleForFile(tab?.dirName ?? null, runner.sessionFile) || "new session";
  }
  const nextTab = {
    key,
    dirName: tab?.dirName || null,
    file: runner.sessionFile || tab?.file || null,
    runnerId: runner.id,
    title,
    kind: runner.kind,
  };
  upsertTab(nextTab);
  set({ view: "session" });
  if (window.innerWidth <= 860) set({ ui: { ...(state.ui || {}), sidebarOpen: false } });
  updateHash(nextTab);
  loadHistory(nextTab).catch((e) => toast(`history: ${e.message}`, { kind: "error" }));
  refreshSessions().catch(() => {});
  if (runner.kind !== "live") {
    commandRequest({ type: "get_session_stats" }, 15000)
      .then((r) => applyStats(r.data))
      .catch(() => {});
  }
  composer.focus();
}

async function bindSession(session, project, opts = {}) {
  set({ binding: true });
  try {
    const known = state.tabs.find((t) => t.file === session.file && t.runnerId);
    const msg = await socket.request({
      type: "bind",
      dirName: session.dirName,
      file: session.file,
      cwd: session.cwd || project?.cwd,
      sinceSeq: known ? lastSeenSeq.get(known.runnerId) || 0 : 0,
    });
    applyBound(msg, {
      key: sessionKey(session.dirName || project?.dirName, session.file),
      dirName: session.dirName || project?.dirName,
      file: session.file,
      title: session.title || "new session",
    });
    if (opts.starter) {
      await commandRequest({ type: "prompt", message: opts.starter }, 30000).catch((e) => toast(e.message, { kind: "error" }));
    }
  } catch (e) {
    set({ binding: false });
    toast(e.message, { kind: "error" });
    throw e;
  }
}

/** Tab identity for a runner opened without one: a runner that owns a session
 *  file maps onto that file's tab key, so the backend list, the session list
 *  and the tab strip all converge on a single tab (R-12). Runners without a
 *  file (live TUIs, brand-new children) keep their runner/live key. */
function runnerTabHint(info, runner) {
  const r = runner || info || {};
  if (r.kind === "live") return { key: liveKey(r.pid ?? info?.pid) };
  const base = basename(r.sessionFile || r.absFile || "");
  if (!base) return { key: runnerKey(r.id || info?.id) };
  for (const project of state.projects || []) {
    for (const s of project.sessions || []) {
      if (s.file !== base) continue;
      const dirName = s.dirName || project.dirName;
      return { key: sessionKey(dirName, base), dirName, file: base };
    }
  }
  const parts = String(r.absFile || "").split(/[\\/]/);
  const dirName = parts.length > 1 ? parts[parts.length - 2] : null;
  return { key: sessionKey(dirName, base), dirName, file: base };
}

async function bindRunner(runnerId, info, tab) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", runnerId, sinceSeq: lastSeenSeq.get(runnerId) || 0 });
    // Re-activating a tab must keep its identity (key/title/dirName): minting
    // a runner-keyed tab here duplicated the tab and lost the session title.
    // Opening a runner that already owns a file converges on that file's tab
    // key (R-12: one tab per session, whichever list you came from).
    applyBound(msg, tab || runnerTabHint(info, msg.runner));
  } catch (e) {
    set({ binding: false });
    toast(e.message, { kind: "error" });
  }
}

async function newSession(cwd, starter) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", cwd: cwd || state.bound?.cwd || undefined });
    applyBound(msg, { key: runnerKey(msg.runner.id), title: "new session" });
    if (starter) {
      await commandRequest({ type: "prompt", message: starter }, 60000).catch((e) => toast(e.message, { kind: "error" }));
    }
  } catch (e) {
    set({ binding: false });
    toast(e.message, { kind: "error" });
  }
}

function openSession(session, project) {
  // A live TUI owns its file: never put a second writer on it (ADR-003).
  const live = [...state.runners.values()].find((r) => r.kind === "live" && r.absFile && session.filePath && r.absFile === session.filePath);
  if (live) return bindRunner(live.id, live);
  // R-10: pi refuses to switch to a session whose stored cwd is gone. Ask the
  // same question its TUI asks, then continue in a folder that exists.
  if (session.cwdExists === false) return continueMissingCwd(session, project);
  const key = sessionKey(session.dirName || project?.dirName, session.file);
  const existing = state.tabs.find((t) => t.key === key);
  if (existing) return activateTab(key);
  return bindSession(session, project);
}

/** Native pi's "Session cwd not found" prompt, web edition: continue the
 *  session as a copy whose stored cwd is a folder that exists. The original
 *  file is never edited, so nothing is lost if the folder comes back. */
async function continueMissingCwd(session, project) {
  const target = state.serverCwd || "";
  if (!target) return toast("Hub working directory unknown — cannot relocate this session", { kind: "error" });
  const ok = await dialogs.offer(
    "Session cwd not found",
    `cwd from session file does not exist: ${session.cwd || "unknown"}.\nContinue in ${target}? The session is copied there so pi can run its tools — the original file stays untouched.`,
    { confirmLabel: "Continue" },
  );
  if (!ok) return;
  try {
    const out = await apiRelocate({ dirName: session.dirName || project?.dirName, file: session.file, cwd: target });
    await bindSession({ dirName: out.dirName, file: out.file, cwd: out.cwd, title: session.title }, null);
    toast(`Continued in ${target}`);
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

function activateTab(key) {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return;
  set({ activeKey: key });
  saveTabs();
  if (tab.runnerId) return bindRunner(tab.runnerId, state.runners.get(tab.runnerId), tab);
  if (tab.file) return bindSession({ dirName: tab.dirName, file: tab.file, title: tab.title, cwd: tab.cwd }, null);
  return undefined;
}

function closeTab(key) {
  const wasActive = state.activeKey === key;
  const nextKey = removeTab(key);
  if (wasActive) {
    set({ bound: null, boundId: null, driving: null, entries: [], meta: null, view: "welcome" });
    rawSend({ type: "unbind" });
    // Never leave a hash pointing at the closed tab: if the next tab cannot
    // bind (dead runner, missing file) a reload would otherwise resurrect the
    // session we just closed. activateTab re-stamps the hash when it succeeds.
    updateHash(null);
    if (nextKey) activateTab(nextKey);
  }
}

/** Headless backends the sidebar lists (i.e. not owned by an open tab). */
function headlessBackends() {
  const tabbable = new Set(state.tabs.map((t) => t.runnerId).filter(Boolean));
  return [...state.runners.values()].filter((r) => r.kind === "headless" && r.state !== "dead" && !tabbable.has(r.id));
}

/** One confirmation, then close every headless backend. */
async function killAllHeadless() {
  const backends = headlessBackends();
  if (!backends.length) return;
  const ok = await dialogs.confirm(
    "Kill all backends",
    `Close ${backends.length} headless ${backends.length === 1 ? "backend" : "backends"}? The transcripts stay on disk.`,
  );
  if (!ok) return;
  for (const runner of backends) {
    try {
      await killRunner(runner, { confirm: false });
    } catch (e) {
      toast(e.message, { kind: "error" });
    }
  }
}

async function killRunner(runner, { confirm: confirmFirst = true } = {}) {
  const bound = state.boundId === runner.id;
  if (confirmFirst) {
    const label = runner.title || runner.sessionFile || runner.id;
    const ok = await dialogs.confirm(
      bound ? "Close session" : "Close backend",
      bound
        ? "Close this session? The backend stops and its tab closes. The transcript stays on disk — reopen it from the sidebar any time."
        : `Close the backend for ${label}? The transcript stays on disk; the process ends.`,
    );
    if (!ok) return;
  }
  try {
    const msg = await socket.request({ type: "close", runnerId: runner.id });
    if (msg.type === "closed") {
      if (bound) {
        // Closing the current session is durable: drop its tab (and the
        // binding) so a reload cannot silently resurrect it. Reopening is an
        // explicit action from the sidebar, where the file still is.
        const tab = state.tabs.find((t) => t.runnerId === runner.id);
        if (tab) closeTab(tab.key);
        else set({ bound: { ...state.bound, state: "dead" }, boundId: null });
        toast("Session closed — reopen it from the sidebar");
      } else {
        toast("Backend closed");
      }
      refreshSessions().catch(() => {});
    }
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

/* ── live preview / drive ────────────────────────────────────────────── */
async function attach(runner, take) {
  try {
    const msg = await socket.request({ type: "attach", runnerId: runner.id, take: !!take });
    if (msg.type === "driver_busy") {
      set({ driverBusy: { runnerId: msg.runnerId, heldBy: msg.heldBy } });
      return;
    }
    if (msg.type === "attached") {
      set({ driving: runner.id, driverBusy: null });
      toast("Driving the live TUI — detach to return to preview");
    }
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

async function detach() {
  try {
    await socket.request({ type: "detach" });
  } catch {}
  set({ driving: null });
}

const bannerActions = {
  onAttach: (runner, take) => attach(runner, take),
  onDetach: () => detach(),
  onDismissFallback: () => set({ cwdFallback: null }),
  onDismiss: () => {
    set({ bound: null, boundId: null, driving: null, driverBusy: null, view: "welcome" });
    rawSend({ type: "unbind" });
  },
  onResume: (runner) => {
    const tab = activeTab();
    if (tab?.file) bindSession({ dirName: tab.dirName, file: tab.file, cwd: runner.cwd }, null);
    else toast("No session file to resume", { kind: "error" });
  },
};

/* ── history ─────────────────────────────────────────────────────────── */
let historyExhausted = true;

async function loadHistory(tab) {
  let { dirName, file } = tab || {};
  if (!dirName && (tab?.absFile || state.bound?.absFile)) {
    const abs = tab?.absFile || state.bound?.absFile;
    const parts = abs.split(/[\\/]/);
    dirName = parts[parts.length - 2];
    file = parts[parts.length - 1];
  }
  if (!dirName || !file) {
    set({ entries: [], meta: null, historyDir: null, historyFile: null });
    transcript.renderHistory([], null);
    historyExhausted = true;
    return;
  }
  set({ historyDir: dirName, historyFile: file });
  const win = await fetchHistory(dirName, file, { limit: 50 });
  historyExhausted = win.entries.length < 50 || win.entries.length >= (win.meta?.total ?? 0);
  set({ entries: win.entries, meta: win.meta });
  transcript.renderHistory(win.entries, win.meta);
  renderLoadEarlier();
}

async function loadEarlier() {
  const { historyDir, historyFile, entries } = state;
  const before = entries[0]?.id;
  if (!historyDir || !historyFile || !before) return;
  const win = await fetchHistory(historyDir, historyFile, { limit: 50, before });
  historyExhausted = win.entries.length < 50;
  set({ entries: [...win.entries, ...entries], meta: { ...state.meta, ...win.meta } });
  transcript.prependHistory(win.entries);
  renderLoadEarlier();
}

/** pi reports context usage as { tokens, contextWindow, percent }; older and
 *  live-runner paths only give a percent, so normalise both into one object. */
function normalizeUsage(value) {
  if (value == null) return null;
  if (typeof value === "number") return { percent: value };
  if (typeof value === "object") return { ...value };
  return null;
}

/** Map get_session_stats onto the statusline fields. */
function applyStats(data) {
  if (!data) return;
  const next = normalizeUsage(data.contextUsage);
  set({
    meta: {
      ...(state.meta || {}),
      cost: typeof data.cost === "number" ? data.cost : state.meta?.cost,
      tokens: data.tokens?.total ?? state.meta?.tokens,
    },
    contextUsage: next ? { ...(state.contextUsage || {}), ...next } : state.contextUsage,
  });
}

/** Drops the "load earlier" control. It lives beside #messages, so draining
 *  the transcript alone left it stranded (visible on the homepage after the
 *  last session was closed). */
function clearLoadEarlier() {
  refs.messages.parentElement?.querySelector(".load-earlier-wrap")?.remove();
}

function renderLoadEarlier() {
  const total = state.meta?.total || 0;
  const loaded = state.entries.length;
  const existing = refs.messages.parentElement.querySelector(".load-earlier-wrap");
  if (!loaded || (historyExhausted && loaded >= total)) {
    existing?.remove();
    return;
  }
  const remaining = historyExhausted ? 0 : Math.max(0, total - loaded);
  const label = remaining ? `Load earlier messages (${remaining} more)` : "Load earlier messages";
  if (existing) {
    existing.querySelector("button").textContent = label;
    return;
  }
  const wrap = el("div", { class: "load-earlier-wrap" });
  wrap.append(
    el("button", { class: "btn small", type: "button", text: label, onclick: () => loadEarlier().catch((e) => toast(e.message, { kind: "error" })) }),
    el("span", { class: "meta", text: total ? `showing ${loaded} of ${total} entries` : "" }),
  );
  refs.messages.parentElement.insertBefore(wrap, refs.messages);
}

/* ── store refresh ───────────────────────────────────────────────────── */
/** The store's title for a session file, when it has a real one. Sessions
 *  with no prompt yet carry their filename stem as a placeholder title —
 *  treated here as "no title" so the UI never shows a `.jsonl` name. */
function titleForFile(dirName, file) {
  if (!file) return null;
  const stem = String(file).replace(/\.jsonl$/, "");
  let loose = null;
  for (const project of state.projects || []) {
    for (const s of project.sessions || []) {
      if (s.file !== file) continue;
      if (!s.title || s.title === stem) continue;
      if (dirName && project.dirName === dirName) return s.title;
      loose = loose || s.title;
    }
  }
  return loose;
}

/** Adopt store titles into tabs/cards that are still showing a placeholder
 *  (`new session` or the file stem) — the first prompt names the session. */
function adoptSessionTitles() {
  for (const tab of state.tabs) {
    if (!tab.file || tab.kind === "live") continue;
    const stem = String(tab.file).replace(/\.jsonl$/, "");
    const placeholder = !tab.title || tab.title === "new session" || tab.title === tab.file || tab.title === stem;
    if (!placeholder) continue;
    const title = titleForFile(tab.dirName, tab.file);
    if (title && title !== tab.title) updateTab(tab.key, { title });
  }
}

async function refreshSessions() {
  try {
    const out = await listSessions();
    set({ projects: out.projects || [], sessionsDir: out.sessionsDir || state.sessionsDir });
    adoptSessionTitles();
    return true;
  } catch (e) {
    // 401 must reach the caller (boot/login/socket-open) so the login overlay
    // is raised instead of a half-booted app; everything else is a toast.
    if (e.status === 401) throw e;
    toast(`sessions: ${e.message}`, { kind: "error" });
    return false;
  }
}

/* ── session actions ─────────────────────────────────────────────────── */
async function forkSession(session, project) {
  try {
    const data = await apiFork(session.dirName || project?.dirName, session.file);
    await refreshSessions();
    toast("Forked — opening the copy");
    const found = allSessions().find((s) => s.file === data.file);
    if (found) openSession(found, { dirName: found.dirName, cwd: found.cwd });
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

async function deleteSession(session, project) {
  const tab = findTabByFile(session.file);
  const owned = tab?.runnerId ? state.runners.get(tab.runnerId) : null;
  const extra = owned ? " Its running backend will be closed first." : "";
  const ok = await dialogs.confirm("Delete session", `Delete ${session.title || session.file} from disk? This cannot be undone.${extra}`);
  if (!ok) return;
  try {
    // No writer may race the unlink: close the owning runner first.
    if (owned) {
      await socket.request({ type: "close", runnerId: owned.id }).catch(() => {});
      closeTab(tab.key);
    }
    await apiDelete(session.dirName || project?.dirName, session.file);
    if (state.historyFile === session.file) {
      const key = sessionKey(session.dirName || project?.dirName, session.file);
      if (findTabByFile(session.file)) closeTab(key);
    }
    await refreshSessions();
    toast("Session deleted");
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

async function exportSession(session, project) {
  const dirName = session.dirName || project?.dirName;
  try {
    const key = sessionKey(dirName, session.file);
    if (state.activeKey !== key || !state.bound) {
      await bindSession({ dirName, file: session.file, cwd: session.cwd || project?.cwd }, null);
    }
    if (state.bound?.kind === "live") {
      toast("Export is not available while a live TUI owns the session", { kind: "error" });
      return;
    }
    const outputPath = state.sessionsDir ? `${state.sessionsDir}/${session.file.replace(/\.jsonl$/, "")}.export.html` : undefined;
    const out = await commandRequest({ type: "export_html", ...(outputPath ? { outputPath } : {}) }, 45000);
    const p = out?.data?.path;
    if (!p) throw new Error("export did not return a path");
    window.open(`/api/sessions/export-file?path=${encodeURIComponent(p)}`, "_blank");
    toast("Exported session HTML");
  } catch (e) {
    toast(e.message || "export failed", { kind: "error" });
  }
}

async function renameSession(session, project, name) {
  if (!name) return;
  try {
    await apiRename(session.dirName || project?.dirName, session.file, name);
    const tab = findTabByFile(session.file);
    if (tab) updateTab(tab.key, { title: name });
    await refreshSessions();
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}

/* ── hash routing ────────────────────────────────────────────────────── */
function updateHash(tab) {
  if (!tab?.file) {
    if (location.hash) history.replaceState(null, "", location.pathname);
    return;
  }
  const next = `#s=${encodeURIComponent(tab.dirName || "")}/${encodeURIComponent(tab.file)}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

function parseHash() {
  const m = /^#s=([^/]*)\/(.+)$/.exec(location.hash);
  if (!m) return null;
  const dirName = decodeURIComponent(m[1]);
  const file = decodeURIComponent(m[2]);
  return file ? { dirName: dirName || null, file } : null;
}

/* ── websocket ───────────────────────────────────────────────────────── */
function handleFrame(msg) {
  switch (msg.type) {
    case "hello":
      set({ mode: msg.mode, version: msg.version, authRequired: !!msg.auth });
      break;
    case "runners": {
      const runners = new Map((msg.runners || []).map((r) => [r.id, r]));
      set({ runners });
      rebindIfRunnerChanged(runners);
      break;
    }
    case "runner_added":
    case "runner_status": {
      const runners = new Map(state.runners);
      runners.set(msg.runner.id, msg.runner);
      const isBound = state.boundId === msg.runner.id;
      set({ runners, bound: isBound ? msg.runner : state.bound });
      if (isBound) adoptRunnerFile(msg.runner);
      break;
    }
    case "runner_removed": {
      const runners = new Map(state.runners);
      runners.delete(msg.runner.id);
      const driving = state.driving === msg.runner.id ? null : state.driving;
      set({ runners, driving, bound: state.boundId === msg.runner.id ? { ...state.bound, state: "dead" } : state.bound });
      break;
    }
    case "bound":
      applyBound(msg);
      break;
    case "driver_busy":
      set({ driverBusy: { runnerId: msg.runnerId, heldBy: msg.heldBy } });
      break;
    case "attached":
      set({ driving: msg.runnerId, driverBusy: null });
      break;
    case "detached":
      set({ driving: null });
      break;
    case "closed":
      set({ bound: state.boundId === msg.runnerId ? { ...state.bound, state: "dead" } : state.bound });
      break;
    case "dialog":
      dialogs.handleEvent(msg.request);
      break;
    case "dialog_cancelled":
      dialogs.close();
      break;
    case "error":
      if (msg.id && pendingCommands.has(msg.id)) {
        const p = pendingCommands.get(msg.id);
        pendingCommands.delete(msg.id);
        p.reject(new Error(msg.message || "command failed"));
      } else {
        toast(msg.message || "error", { kind: "error" });
      }
      break;
    case "event":
      if (msg.runnerId && typeof msg.seq === "number") lastSeenSeq.set(msg.runnerId, msg.seq);
      handleRunnerEvent(msg.event, msg);
      break;
    default:
      break;
  }
}

/** Adopt a freshly discovered session file for the active tab (fresh binds). */
function adoptRunnerFile(runner) {
  const tab = activeTab();
  if (!runner?.sessionFile || !tab || tab.kind === "live" || tab.file) return;
  const parts = String(runner.absFile || "").split(/[\\/]/);
  const dirName = parts.length > 1 ? parts[parts.length - 2] : tab.dirName;
  // Own the discovered file, but keep the human title: a fresh session stays
  // "new session" until its first prompt names it (never the .jsonl name).
  const title = titleForFile(dirName, runner.sessionFile) || tab.title || "new session";
  updateTab(tab.key, { file: runner.sessionFile, dirName, title });
  set({ historyDir: dirName, historyFile: runner.sessionFile });
  loadHistory({ ...tab, file: runner.sessionFile, dirName }).catch(() => {});
  refreshSessions().catch(() => {});
}

function rebindIfRunnerChanged(runners) {
  const bound = state.boundId ? runners.get(state.boundId) : null;
  if (state.boundId && !bound) {
    set({ bound: { ...state.bound, state: "dead" } });
  } else if (bound) {
    set({ bound });
  }
}

function handleRunnerEvent(event) {
  if (!event) return;
  if (event.id && pendingCommands.has(event.id)) {
    const p = pendingCommands.get(event.id);
    pendingCommands.delete(event.id);
    if (event.success === false) p.reject(new Error(event.error || "command failed"));
    else p.resolve(event);
    return;
  }
  if (event.type === "response") return;
  if (event.type === "extension_ui_request") return void dialogs.handleEvent(event);
  if (event.type === "session_name") {
    if (event.name) {
      const tab = activeTab();
      if (tab) updateTab(tab.key, { title: event.name });
      set({ meta: { ...(state.meta || {}), sessionName: event.name } });
    }
    return;
  }
  // Model / thinking changes reach every viewer: pi emits these on set_model,
  // cycle_model and the thinking menu, so the composer pills (and the sidebar
  // card) follow the session instead of showing the value it was bound with.
  if (event.type === "model_select" && event.model) {
    const id = event.model.id || event.model.name || "";
    const provider = event.model.provider || "";
    set({
      bound: state.bound ? { ...state.bound, model: id } : state.bound,
      meta: { ...(state.meta || {}), model: provider ? `${provider}/${id}` : id },
    });
    return;
  }
  if (event.type === "thinking_level_select" && event.level) {
    set({
      bound: state.bound ? { ...state.bound, thinkingLevel: event.level } : state.bound,
      meta: { ...(state.meta || {}), thinkingLevel: event.level },
    });
    return;
  }
  if (event.type === "runner_status") {
    set({ bound: { ...state.bound, state: event.state || state.bound?.state } });
    if (event.contextUsage != null) {
      const next = normalizeUsage(event.contextUsage);
      set({ contextUsage: next ? { ...(state.contextUsage || {}), ...next } : state.contextUsage });
    }
    return;
  }
  if (event.type === "session_file") {
    const sf = event.sessionFile;
    if (sf) {
      const tab = activeTab();
      const tab2 = activeTab();
      if (tab2 && tab2.kind !== "live" && !tab2.file) {
        const parts = (state.bound?.absFile || "").split(/[\\/]/);
        const dirName = parts.length > 1 ? parts[parts.length - 2] : tab2.dirName;
        const title = titleForFile(dirName, sf) || tab2.title || "new session";
        updateTab(tab2.key, { file: sf, dirName, title });
        set({ historyDir: dirName, historyFile: sf });
        loadHistory({ ...tab2, file: sf, dirName }).catch(() => {});
      }
      refreshSessions().catch(() => {});
    }
    return;
  }

  transcript.handleEvent(event);
  if (event.type === "agent_start") set({ streaming: true, connState: "working" });
  if (event.type === "agent_end") {
    set({ streaming: false, connState: "on" });
    commandRequest({ type: "get_session_stats" }, 15000)
      .then((r) => applyStats(r.data))
      .catch(() => {});
  }
  if (event.type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering : [];
    const followUp = Array.isArray(event.followUp) ? event.followUp : [];
    set({
      queue: [
        ...steering.filter((t) => typeof t === "string").map((text) => ({ text, kind: "steer" })),
        ...followUp.filter((t) => typeof t === "string").map((text) => ({ text, kind: "followUp" })),
      ],
    });
  }
  if (event.type === "compaction_start") set({ compacting: true });
  if (event.type === "compaction_end") set({ compacting: false });
}

/* ── boot ────────────────────────────────────────────────────────────── */
function connect() {
  socket = new HubSocket({
    onOpen: async () => {
      set({ connected: true, connState: "on" });
      try {
        await refreshSessions();
        set({ booted: true });
      } catch (e) {
        if (e.status === 401) onUnauthorized?.();
      }
      const pinned = parseHash() || activeTab();
      try {
        if (pinned?.dirName && pinned?.file) {
          const all = allSessions();
          const found = all.find((s) => s.file === pinned.file);
          await bindSession({ dirName: pinned.dirName, file: pinned.file, title: found?.title, cwd: found?.cwd }, null);
        } else if (pinned?.runnerId) {
          await bindRunner(pinned.runnerId, state.runners.get(pinned.runnerId));
        } else if (state.tabs.length) {
          await activateTab(state.tabs[state.tabs.length - 1].key);
        }
      } catch {
        set({ bound: null, boundId: null, binding: false });
      }
      const info = await serverInfo().catch(() => null);
      if (info?.version) set({ version: info.version, serverCwd: info.cwd || null });
      document.body.dataset.ready = "1";
    },
    onClose: () => set({ connected: false, connState: "off" }),
    onMessage: (msg) => handleFrame(msg),
    onError: (msg) => toast(msg.message || "connection error", { kind: "error" }),
  });
  socket.connect();
}

onUnauthorized(() => {
  show(refs.login, true);
  refs.loginSub.textContent = "Sign in to this hub";
  setTimeout(() => refs.loginUser.focus(), 30);
});

/* Password reveal: the field types "password" until the eye is pressed. */
let pwVisible = false;
refs.loginReveal.append(icon("eye", 15));
refs.loginReveal.addEventListener("click", () => {
  pwVisible = !pwVisible;
  refs.loginPass.type = pwVisible ? "text" : "password";
  refs.loginReveal.setAttribute("aria-pressed", String(pwVisible));
  refs.loginReveal.setAttribute("aria-label", pwVisible ? "Hide password" : "Show password");
  refs.loginReveal.title = pwVisible ? "Hide password" : "Show password";
  refs.loginPass.focus();
});

refs.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (refs.loginSubmit.disabled) return;
  refs.loginError.textContent = "";
  const label = refs.loginSubmit.textContent;
  refs.loginSubmit.disabled = true;
  refs.loginSubmit.textContent = "Signing in…";
  try {
    await login(refs.loginUser.value.trim(), refs.loginPass.value);
    show(refs.login, false);
    show(refs.app, true);
    socket?.close?.();
    connect();
  } catch (err) {
    refs.loginError.textContent = err.message || "Sign-in failed";
    refs.loginPass.select?.();
  } finally {
    refs.loginSubmit.disabled = false;
    refs.loginSubmit.textContent = label;
  }
});

/* ── chrome wiring ───────────────────────────────────────────────────── */
/* Sidebar visibility is a two-mode thing: on phones it is an overlay drawer
   (`sidebarOpen`), on desktop a column that collapses away (`sidebarCollapsed`).
   Both the tabbar button and the sidebar's own chevron must honour the mode the
   window is actually in — the chevron used to only clear `sidebarOpen`, so on
   desktop it did nothing at all. */
const sidebarVisible = () => (window.innerWidth <= 860 ? !!state.ui?.sidebarOpen : !state.ui?.sidebarCollapsed);
function syncSidebarToggle() {
  const visible = sidebarVisible();
  refs.sidebarToggle.setAttribute("aria-expanded", String(visible));
  refs.sidebarToggle.title = visible ? "Hide sidebar" : "Show sidebar";
}
refs.sidebarToggle.addEventListener("click", () => {
  if (window.innerWidth <= 860) set({ ui: { ...(state.ui || {}), sidebarOpen: !state.ui?.sidebarOpen } });
  else set({ ui: { ...(state.ui || {}), sidebarCollapsed: !state.ui?.sidebarCollapsed } });
});
refs.sidebarCollapse.addEventListener("click", () => {
  const ui = { ...(state.ui || {}), sidebarOpen: false };
  if (window.innerWidth > 860) ui.sidebarCollapsed = true;
  set({ ui });
});
window.addEventListener("resize", syncSidebarToggle);
refs.sidebarOverlay.addEventListener("click", () => set({ ui: { ...(state.ui || {}), sidebarOpen: false } }));
refs.newSessionBtn.addEventListener("click", () => picker.open(state.bound?.cwd || state.meta?.cwd));
refs.tabNew.addEventListener("click", () => newSession(state.bound?.cwd || state.meta?.cwd));
refs.homeBtn.addEventListener("click", () => {
  set({ view: "welcome", activeKey: null });
  saveTabs();
});
refs.csClose.addEventListener("click", () => {
  const runner = state.bound;
  if (runner) killRunner(runner, { confirm: true });
});
refs.contextChip.addEventListener("click", (e) => {
  e.stopPropagation();
  if (ctxPop.open) return closeContextPopover();
  openContextPopover();
});
document.addEventListener("click", (e) => {
  if (ctxPop.open && !ctxPop.node?.contains(e.target) && e.target !== refs.contextChip) closeContextPopover();
});
document.addEventListener("keydown", (e) => {
  if (ctxPop.open && e.key === "Escape") closeContextPopover();
});
window.addEventListener("resize", () => ctxPop.open && closeContextPopover());

/* ── context usage popover ───────────────────────────────────────────── */
function fmtTokens(n) {
  if (n == null || !Number.isFinite(n)) return "?";
  const trim = (v) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1e6) return `${trim(n / 1e6)}m`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(Math.round(n));
}

async function openContextPopover() {
  ctxPop.open = true;
  refs.contextChip.setAttribute("aria-expanded", "true");
  renderContextPopover();
  // Refresh, so a stale chip cannot show stale numbers.
  commandRequest({ type: "get_session_stats" }, 15000)
    .then((r) => applyStats(r.data))
    .catch(() => {});
}

function closeContextPopover() {
  ctxPop.open = false;
  refs.contextChip?.setAttribute("aria-expanded", "false");
  ctxPop.node?.remove();
  ctxPop.node = null;
}

function renderContextPopover() {
  if (!ctxPop.open) return;
  const usage = state.contextUsage || {};
  const pct = Math.max(0, Math.min(100, Number(usage.percent ?? 0)));
  const known = usage.tokens != null && usage.contextWindow != null;
  const left = known ? Math.max(0, usage.contextWindow - usage.tokens) : null;
  const canCompact = pct >= 90 && state.view === "session" && !!state.bound
    && state.bound.state !== "dead" && !state.streaming && !state.compacting && !state.binding;

  if (!ctxPop.node) {
    ctxPop.node = el("div", { class: "ctx-pop", id: "ctx-pop", role: "dialog", "aria-label": "Context usage" });
    document.body.append(ctxPop.node);
  }
  ctxPop.node.replaceChildren(
    el("div", { class: "ctx-head" },
      el("span", { class: "ctx-title", text: "Context" }),
      el("span", { class: "ctx-pct", text: `${pct < 1 ? "<1" : Math.round(pct)}%` }),
    ),
    el("div", { class: "ctx-bar", role: "img", "aria-label": `Context ${Math.round(pct)}% used` },
      el("span", { class: `ctx-fill${pct >= 90 ? " danger" : pct >= 70 ? " warn" : ""}`, style: `width:${Math.max(pct, 1.5)}%` }),
    ),
    el("div", { class: "ctx-rows" },
      el("div", { class: "ctx-row" }, el("span", { text: "Used" }), el("b", { text: known ? fmtTokens(usage.tokens) : "unknown" })),
      el("div", { class: "ctx-row" }, el("span", { text: "Limit" }), el("b", { text: known ? fmtTokens(usage.contextWindow) : "?" })),
      el("div", { class: "ctx-row ctx-left" }, el("span", { text: "Left" }), el("b", { text: left != null ? fmtTokens(left) : "?" })),
    ),
    ...(canCompact
      ? [el("button", { class: "btn small primary ctx-compact", type: "button", text: "Compact now", onclick: compactFromPopover })]
      : []),
  );

  // Anchor above the chip, right-aligned with it.
  const r = refs.contextChip.getBoundingClientRect();
  ctxPop.node.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
  ctxPop.node.style.right = `${Math.round(window.innerWidth - r.right)}px`;
}

async function compactFromPopover() {
  closeContextPopover();
  const ok = await dialogs.confirm("Compact context", "Summarize the transcript to free context? The full history stays on disk.");
  if (!ok) return;
  try {
    await commandRequest({ type: "compact" }, 120000);
  } catch (e) {
    toast(e.message, { kind: "error" });
  }
}
refs.settingsBtn.addEventListener("click", () => settings.open());
refs.filesBtn.addEventListener("click", () => files.toggle(state.bound?.cwd || state.meta?.cwd, { dirName: state.historyDir, file: state.historyFile }));
refs.reloadBtn.addEventListener("click", () => location.reload());
refs.conn.addEventListener("click", () => {
  if (!state.connected) {
    socket?.close?.();
    connect();
  }
});
refs.input?.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.streaming) {
    e.preventDefault();
    rawSend({ type: "command", id: `abort-${Date.now().toString(36)}`, command: { type: "abort" } });
  }
});
/* jump-to-latest: visible whenever the transcript is scrolled away */
const nearBottom = () => {
  const v = refs.view;
  return v.scrollHeight - v.scrollTop - v.clientHeight < 140;
};
refs.view.addEventListener("scroll", () => {
  show(refs.jumpLatest, state.view === "session" && !nearBottom());
});
refs.jumpLatest.addEventListener("click", () => {
  transcript.scrollToBottom();
  show(refs.jumpLatest, false);
});

/* iOS keeps the keyboard over a fixed composer; nudge it into view. */
refs.input.addEventListener("focus", () => {
  if (window.innerWidth > 860) return;
  setTimeout(() => refs.input.scrollIntoView({ block: "nearest", behavior: "smooth" }), 250);
});

document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return;
  if (e.key.toLowerCase() === "t") {
    e.preventDefault();
    newSession(state.bound?.cwd || state.meta?.cwd);
  } else if (e.key.toLowerCase() === "k") {
    e.preventDefault();
    picker.open(state.bound?.cwd || state.meta?.cwd);
  } else if (e.shiftKey && e.key.toLowerCase() === "p") {
    e.preventDefault();
    set({ view: "welcome", activeKey: null });
  }
});

set({ ui: { sidebarOpen: false, sidebarCollapsed: false } });
render();

/** Probe the API before opening the socket so an auth wall shows the login
 *  overlay instead of a silent reconnect loop. */
async function boot() {
  try {
    settings.applyPrefs(); // theme + display prefs before first paint
    await refreshSessions();
    set({ booted: true });
  } catch (e) {
    if (e.status === 401) return; // sign-in card over a shell that never painted
    toast(`sessions: ${e.message}`, { kind: "error" });
  }
  show(refs.app, true);
  connect();
}
boot();
