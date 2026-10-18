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
  history as fetchHistory,
  listSessions,
  login,
  logout,
  onUnauthorized,
  renameSession as apiRename,
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
const refs = {
  login: $("login"),
  loginForm: $("login-form"),
  loginSub: $("login-sub"),
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
  welcome: $("welcome"),
  welcomeLogo: $("welcome-logo"),
  welcomeHints: $("welcome-hints"),
  welcomeActions: $("welcome-actions"),
  welcomeRecents: $("welcome-recents"),
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

function rawSend(msg) {
  return socket?.send(msg) ?? false;
}
function sendExtensionResponse(msg) {
  rawSend(msg);
}

const dialogs = createDialogs(refs.dialogContainer, sendExtensionResponse);

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
    abort: () => rawSend({ type: "command", id: `abort-${Date.now().toString(36)}`, command: { type: "abort" } }),
    listCommands: () =>
      commandRequest({ type: "get_commands" }, 20000)
        .then((r) => r.data?.commands || [])
        .catch(() => []),
    listModels: () => commandRequest({ type: "get_available_models" }, 20000).then((r) => r.data?.models || []),
    getState: () => commandRequest({ type: "get_state" }, 15000).then((r) => r.data),
    setModel: (m) => commandRequest({ type: "set_model", provider: m.provider, modelId: m.id }, 20000),
    setThinking: (level) => commandRequest({ type: "set_thinking_level", level }, 20000),
    addQueue: (message) => set({ queue: [...state.queue, message] }),
    removeQueue: (i) => set({ queue: state.queue.filter((_, idx) => idx !== i) }),
    takePendingFiles: () => state.pendingFiles.splice(0),
    openPicker: () => picker.open(state.bound?.cwd || state.meta?.cwd),
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
    closeRunner: (runner) => killRunner(runner, { confirm: false }),
    activateTab: (key) => activateTab(key),
    closeTab: (key) => closeTab(key),
    setSearch: (q) => set({ search: q }),
    search: (q) => searchSessions(q),
    rerender: () => render(),
    forkSession: (session, project) => forkSession(session, project),
    deleteSession: (session, project) => deleteSession(session, project),
    renameSession: (session, project, name) => renameSession(session, project, name),
    copyPath: (session) => copyText(session.filePath || session.file),
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
refs.welcomeLogo.append(logo(44));
refs.welcomeHints.append(
  el("span", { class: "chip-mini" }, "/", " focus input"),
  el("span", { class: "chip-mini" }, "Esc", " stop"),
  el("span", { class: "chip-mini" }, "Ctrl+T", " new session"),
);
refs.welcomeActions.append(
  el("button", { class: "btn primary", type: "button", onclick: () => newSession(state.bound?.cwd || state.meta?.cwd) }, icon("plus", 14), "New session"),
  el("button", { class: "btn", type: "button", onclick: () => picker.open(state.bound?.cwd || state.meta?.cwd) }, icon("folder", 14), "Browse sessions…"),
);

function renderWelcome() {
  if (state.view !== "welcome") return;
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
refs.homeBtn.append(logo(20));
refs.filesBtn.append(icon("folder", 16));
refs.settingsBtn.append(icon("gear", 17));
refs.reloadBtn.append(icon("refresh", 15));
refs.sidebarToggle.append(icon("menu", 18));
refs.sidebarCollapse.append(icon("chevron-left", 15));
refs.fileFinder.append(icon("external", 14));

/* ── render ──────────────────────────────────────────────────────────── */
function render() {
  // sidebar visibility (drawer on mobile, collapsed column on desktop)
  document.body.classList.toggle("sidebar-open", !!state.ui?.sidebarOpen);
  refs.sidebar.classList.toggle("collapsed", !!state.ui?.sidebarCollapsed && !state.ui?.sidebarOpen);
  document.querySelector(".shell")?.classList.toggle("sidebar-collapsed", !!state.ui?.sidebarCollapsed);
  show(refs.sidebarOverlay, !!state.ui?.sidebarOpen);

  tabs.render(state);
  renderWelcome();
  sidebar.render(state);
  composer.render(state);
  renderBanner(refs.banner, state, bannerActions);
  renderStatusline();
  renderTitlebar();

  const sessionView = state.view === "session" && !!state.bound;
  show(refs.welcome, !sessionView);
  show(refs.messages, sessionView);
  document.body.dataset.view = state.view;
  if (state.booted) document.body.dataset.ready = "1";
}

function renderTitlebar() {
  const tab = activeTab();
  const hidden = !tab || state.view !== "session" || !state.ui?.sidebarCollapsed;
  show(refs.titlebar, !hidden);
  if (hidden) return;
  refs.tbTitle.textContent = tab.title || tab.file || "session";
  const runner = tab.runnerId ? state.runners.get(tab.runnerId) : null;
  refs.tbChip.textContent = runner?.kind === "live" ? "live tui" : runner ? runner.state : "session";
  refs.tbChip.className = `chip ${runner?.kind === "live" ? "live" : runner?.state === "dead" ? "dead" : "headless"}`;
}

function renderStatusline() {
  const cwd = state.bound?.cwd || state.meta?.cwd || "";
  refs.cwdLabel.replaceChildren(icon("folder", 13), el("span", { class: "cwd-text", text: shortCwd(cwd) || "no session" }));

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
  show(refs.contextChip, state.view === "session" && usage != null);
  if (usage != null) {
    const pct = Number(usage);
    refs.contextChip.textContent = pct < 1 ? "<1% ctx" : `${Math.round(pct)}% ctx`;
    refs.contextChip.classList.toggle("warn", pct >= 70 && pct < 90);
    refs.contextChip.classList.toggle("danger", pct >= 90);
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

/* ── bind lifecycle ──────────────────────────────────────────────────── */
function applyBound(msg, tab) {
  const runner = msg.runner || {};
  set({
    boundId: runner.id,
    bound: runner,
    binding: false,
    driverBusy: null,
    driving: null,
    queue: [],
    contextUsage: null,
    entries: [],
    meta: null,
  });
  const key = tab?.key || (runner.sessionFile ? sessionKey(tab?.dirName, runner.sessionFile) : runnerKey(runner.id));
  const nextTab = {
    key,
    dirName: tab?.dirName || null,
    file: runner.sessionFile || tab?.file || null,
    runnerId: runner.id,
    title: tab?.title || runner.sessionFile || (runner.kind === "live" ? `TUI :${runner.pid}` : "new session"),
    kind: runner.kind,
  };
  upsertTab(nextTab);
  set({ view: "session" });
  if (window.innerWidth <= 860) set({ ui: { ...(state.ui || {}), sidebarOpen: false } });
  updateHash(nextTab);
  loadHistory(nextTab).catch((e) => toast(`history: ${e.message}`, { kind: "error" }));
  refreshSessions().catch(() => {});
  composer.focus();
}

async function bindSession(session, project, opts = {}) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", dirName: session.dirName, file: session.file, cwd: session.cwd || project?.cwd });
    applyBound(msg, {
      key: sessionKey(session.dirName || project?.dirName, session.file),
      dirName: session.dirName || project?.dirName,
      file: session.file,
      title: session.title || session.file,
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

async function bindRunner(runnerId, info) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", runnerId });
    applyBound(msg, {
      key: info?.kind === "live" ? liveKey(info.pid) : runnerKey(runnerId),
      title: info?.title || info?.sessionFile || info?.kind,
    });
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
  const key = sessionKey(session.dirName || project?.dirName, session.file);
  const existing = state.tabs.find((t) => t.key === key);
  if (existing) return activateTab(key);
  return bindSession(session, project);
}

function activateTab(key) {
  const tab = state.tabs.find((t) => t.key === key);
  if (!tab) return;
  set({ activeKey: key });
  saveTabs();
  if (tab.runnerId) return bindRunner(tab.runnerId, state.runners.get(tab.runnerId));
  if (tab.file) return bindSession({ dirName: tab.dirName, file: tab.file, title: tab.title, cwd: tab.cwd }, null);
  return undefined;
}

function closeTab(key) {
  const tab = state.tabs.find((t) => t.key === key);
  const nextKey = removeTab(key);
  if (state.activeKey === key) {
    set({ bound: null, boundId: null, bound: null, driving: null, entries: [], meta: null, view: "welcome" });
    rawSend({ type: "unbind" });
    if (nextKey) activateTab(nextKey);
    else updateHash(null);
  }
  void tab;
}

async function killRunner(runner, { confirm: confirmFirst = true } = {}) {
  if (confirmFirst) {
    const ok = await dialogs.confirm("Close backend", `Close the backend for ${runner.title || runner.sessionFile || runner.id}? The transcript stays on disk; the process ends.`);
    if (!ok) return;
  }
  try {
    const msg = await socket.request({ type: "close", runnerId: runner.id });
    if (msg.type === "closed") {
      set({ bound: state.boundId === runner.id ? { ...state.bound, state: "dead" } : state.bound });
      toast("Backend closed — resume from the banner to continue");
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
async function refreshSessions() {
  try {
    const out = await listSessions();
    set({ projects: out.projects || [] });
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
  updateTab(tab.key, { file: runner.sessionFile, dirName, title: runner.sessionFile });
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
  if (event.type === "runner_status") {
    set({ bound: { ...state.bound, state: event.state || state.bound?.state } });
    if (event.contextUsage != null) set({ contextUsage: event.contextUsage });
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
        updateTab(tab2.key, { file: sf, dirName, title: sf });
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
    if (state.queue.length) {
      const [next, ...rest] = state.queue;
      set({ queue: rest });
      commandRequest({ type: "prompt", message: next }, 30000).catch((e) => toast(e.message, { kind: "error" }));
    }
    commandRequest({ type: "get_session_stats" }, 15000)
      .then((r) => r.data && set({ meta: { ...state.meta, ...r.data } }))
      .catch(() => {});
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
      if (info?.version) set({ version: info.version });
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
  refs.loginSub.textContent = "This server requires authentication.";
});

refs.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  refs.loginError.textContent = "";
  try {
    await login(refs.loginUser.value, refs.loginPass.value);
    show(refs.login, false);
    socket?.close?.();
    connect();
  } catch (err) {
    refs.loginError.textContent = err.message;
  }
});

/* ── chrome wiring ───────────────────────────────────────────────────── */
refs.sidebarToggle.addEventListener("click", () => {
  if (window.innerWidth <= 860) set({ ui: { ...(state.ui || {}), sidebarOpen: !state.ui?.sidebarOpen } });
  else set({ ui: { ...(state.ui || {}), sidebarCollapsed: !state.ui?.sidebarCollapsed } });
});
refs.sidebarCollapse.addEventListener("click", () => set({ ui: { ...(state.ui || {}), sidebarOpen: false } }));
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
    await refreshSessions();
    set({ booted: true });
  } catch (e) {
    if (e.status === 401) return; // overlay was raised by onUnauthorized
    toast(`sessions: ${e.message}`, { kind: "error" });
  }
  connect();
}
boot();
