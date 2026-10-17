// app — wiring: auth, WS, bindings, history, events, views.
import { $, clear, el, show, toast } from "./core/dom.js";
import { loadBinding, runnerList, saveBinding, set, state, subscribe } from "./core/store.js";
import { history as fetchHistory, listSessions, login, logout, onUnauthorized } from "./core/api.js";
import { HubSocket } from "./core/ws.js";
import { createTranscript } from "./ui/transcript.js";
import { createDialogs } from "./ui/dialogs.js";
import { createSidebar } from "./ui/sidebar.js";
import { createPicker } from "./ui/picker.js";
import { createHeader } from "./ui/header.js";
import { createComposer } from "./ui/composer.js";
import { createFiles } from "./ui/files.js";
import { createSettings } from "./ui/settings.js";
import { updateBanner } from "./ui/banner.js";

const refs = {
  login: $("login"),
  loginForm: $("login-form"),
  loginUser: $("login-user"),
  loginPass: $("login-pass"),
  loginError: $("login-error"),
  messages: $("messages"),
  banner: $("banner"),
  sidebar: $("sidebar"),
  backdrop: $("overlay"),
  runnerList: $("runner-list"),
  sessionList: $("session-list"),
  search: $("session-search"),
  newSessionBtn: $("new-session-btn"),
  sidebarToggle: $("sidebar-toggle"),
  title: $("session-title"),
  meta: $("session-meta"),
  modelBtn: $("model-btn"),
  modelMenu: $("model-menu"),
  thinkingBtn: $("thinking-btn"),
  thinkingMenu: $("thinking-menu"),
  cost: $("cost-pill"),
  dot: $("status-dot"),
  settingsBtn: $("settings-btn"),
  filesBtn: null,
  composer: $("composer"),
  input: $("input"),
  sendBtn: $("send-btn"),
  abortBtn: $("abort-btn"),
  queue: $("queue"),
  slash: $("slash"),
  picker: $("picker"),
  pickerProjects: $("picker-projects"),
  pickerDirs: $("picker-dirs"),
  pickerPath: $("picker-path"),
  pickerStart: $("picker-start"),
  pickerClose: $("picker-close"),
  settings: $("settings"),
  settingsClose: $("settings-close"),
  themePicker: $("theme-picker"),
  thinkingToggle: $("toggle-thinking"),
  costsToggle: $("toggle-costs"),
  serverInfo: $("server-info"),
  logoutBtn: $("logout-btn"),
  procRefresh: $("proc-refresh"),
  procList: $("proc-list"),
  filesPanel: $("file-panel"),
  filePath: $("file-path"),
  fileList: $("file-list"),
  fileUp: $("file-up"),
  fileClose: $("file-close"),
  viewer: $("viewer"),
  viewerTitle: $("viewer-title"),
  viewerBody: $("viewer-body"),
  viewerAdd: $("viewer-add"),
  viewerClose: $("viewer-close"),
  dialogs: $("dialog-container"),
};

const transcript = createTranscript(refs.messages);
let socket = null;
let pendingCommands = new Map();
let pendingFiles = [];

const dialogs = createDialogs(refs.dialogs, (msg) => socket?.send(msg));

function currentSessionRef() {
  if (!state.historyDir) return null;
  return { dirName: state.historyDir, file: state.historyFile };
}

const files = createFiles(
  {
    panel: refs.filesPanel,
    path: refs.filePath,
    list: refs.fileList,
    up: refs.fileUp,
    panelClose: refs.fileClose,
    viewer: refs.viewer,
    title: refs.viewerTitle,
    body: refs.viewerBody,
    add: refs.viewerAdd,
    close: refs.viewerClose,
  },
  {
    addToPrompt: (path) => {
      pendingFiles.push(path);
      refs.input.value = `${refs.input.value}${refs.input.value ? "\n" : ""}@${path}`;
      refs.input.focus();
      toast("added to prompt");
    },
  },
);

const header = createHeader(
  {
    titleEl: refs.title,
    metaEl: refs.meta,
    modelBtn: refs.modelBtn,
    modelMenu: refs.modelMenu,
    thinkingBtn: refs.thinkingBtn,
    thinkingMenu: refs.thinkingMenu,
    costEl: refs.cost,
    dotEl: refs.dot,
  },
  {
    listModels: () => commandRequest({ type: "get_available_models" }, 20000).then((r) => r.data?.models || []),
    getState: () => commandRequest({ type: "get_state" }, 10000),
    setModel: (m) => commandRequest({ type: "set_model", provider: m.provider, modelId: m.id }, 20000),
    setThinking: (level) => commandRequest({ type: "set_thinking_level", level }),
    toast,
  },
);

const composer = createComposer(
  {
    form: refs.composer,
    input: refs.input,
    sendBtn: refs.sendBtn,
    abortBtn: refs.abortBtn,
    queueEl: refs.queue,
    slashEl: refs.slash,
  },
  {
    isWorking: () => state.streaming || state.bound?.state === "working",
    prompt: (message) => commandRequest({ type: "prompt", message }, 30000),
    steer: (message) => commandRequest({ type: "steer", message }, 30000).catch((e) => toast(e.message)),
    abort: () => sendCommand({ type: "abort" }),
    listCommands: () => commandRequest({ type: "get_commands" }, 20000).then((r) => r.data?.commands || []),
    queue: (message) => set({ queue: [...state.queue, message] }),
    dropQueue: (i) => set({ queue: state.queue.filter((_, idx) => idx !== i) }),
    takePendingFiles: () => pendingFiles.splice(0),
    toast,
  },
);

const picker = createPicker({
  root: refs.picker,
  projectsEl: refs.pickerProjects,
  dirsEl: refs.pickerDirs,
  pathInput: refs.pickerPath,
  startBtn: refs.pickerStart,
  closeBtn: refs.pickerClose,
  onStart: (cwd) => {
    show(refs.picker, false);
    newSession(cwd);
  },
  onFork: () => {},
});

const settings = createSettings(
  {
    root: refs.settings,
    close: refs.settingsClose,
    themePicker: refs.themePicker,
    thinkingToggle: refs.thinkingToggle,
    costsToggle: refs.costsToggle,
    info: refs.serverInfo,
    logout: refs.logoutBtn,
    refresh: refs.procRefresh,
    procList: refs.procList,
  },
  {
    logout: async () => {
      await logout().catch(() => {});
      location.reload();
    },
    confirm: (title, message) => dialogs.confirm(title, message),
  },
);

const sidebar = createSidebar({
  runnerListEl: refs.runnerList,
  sessionListEl: refs.sessionList,
  searchEl: refs.search,
  onBindRunner: (id) => bindRunner(id).catch((e) => toast(e.message)),
  onBindSession: (session) => bindSession(session).catch((e) => toast(e.message)),
  onNewSession: () => picker.open().catch((e) => toast(e.message)),
});

const bannerActions = {
  onAttach: (runner, take) => attach(runner, take),
  onDetach: () => detach(),
  onCancelPreview: () => {
    set({ banner: null, bound: null, boundId: null, driving: null });
    socket?.request({ type: "unbind" }).catch(() => {});
  },
  onResumeDead: (runner) => {
    const stored = loadBinding();
    if (stored?.dirName && stored?.file) bindSession(stored).catch((e) => toast(e.message));
    else toast("no session file to resume");
    void runner;
  },
};

function render() {
  sidebar.render({ runners: runnerList(), projects: state.projects || [], boundId: state.boundId });
  header.render(state);
  composer.render(state);
  updateBanner(refs.banner, state, bannerActions);
  document.body.classList.toggle("sidebar-open", !!state.ui?.sidebarOpen);
  show(refs.backdrop, !!state.ui?.sidebarOpen);
  renderLoadEarlier();
}

subscribe(render);

function renderLoadEarlier() {
  const existing = refs.messages.querySelector(".load-earlier");
  const total = state.meta?.total || 0;
  if (!state.entries.length || state.entries.length >= total) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = `Load earlier messages (${total - state.entries.length} more)`;
    return;
  }
  const btn = el("button", { type: "button", class: "load-earlier pill", text: `Load earlier messages (${total - state.entries.length} more)`, onclick: () => loadEarlier() });
  refs.messages.prepend(btn);
}

refs.sidebarToggle.addEventListener("click", () => set({ ui: { ...(state.ui || {}), sidebarOpen: !state.ui?.sidebarOpen } }));
refs.backdrop.addEventListener("click", () => set({ ui: { ...(state.ui || {}), sidebarOpen: false } }));
refs.newSessionBtn.addEventListener("click", () => picker.open().catch((e) => toast(e.message)));
refs.settingsBtn.addEventListener("click", () => settings.open().catch((e) => toast(e.message)));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    picker.open().catch(() => {});
  }
});

// ─── commands over WS ───
function sendCommand(command) {
  return socket?.request({ type: "command", command }).catch((e) => {
    toast(e.message);
    throw e;
  });
}

function commandRequest(command, timeoutMs = 20000) {
  const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`${command.type} timed out`));
    }, timeoutMs);
    pendingCommands.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    sendCommand({ ...command, id }).catch((e) => {
      pendingCommands.delete(id);
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ─── bindings ───
async function applyBound(msg, session) {
  const runner = msg.runner || {};
  set({ boundId: runner.id, bound: runner, driverBusy: null, driving: null, queue: [] });
  saveBinding(
    session ? { dirName: session.dirName, file: session.file } : runner.absFile ? { runnerId: runner.id, file: runner.sessionFile } : { runnerId: runner.id, cwd: runner.cwd },
  );
  if (runner.kind === "live") {
    set({ meta: null });
    await loadHistoryFor(runner.absFile);
  } else if (session) {
    await loadHistoryFor(session);
    commandRequest({ type: "get_state" }, 15000)
      .then((r) => {
        // N3: file meta wins — a resumed child may report its own default model.
        if (state.meta?.model || state.meta?.thinkingLevel) return;
        set({
          bound: {
            ...state.bound,
            model: r.data?.model?.id || state.bound?.model,
            thinkingLevel: r.data?.thinkingLevel || state.bound?.thinkingLevel,
          },
        });
      })
      .catch(() => {});
  } else {
    transcript.renderHistory([], null);
  }
  hashSession();
  document.body.dataset.ready = "1";
}

function dirOfFile(abs) {
  if (!abs) return null;
  const parts = abs.split("/");
  return { dirName: parts[parts.length - 2], file: parts[parts.length - 1] };
}

async function loadHistoryFor(absOrSession) {
  let ref = typeof absOrSession === "string" ? dirOfFile(absOrSession) : absOrSession;
  if (!ref?.dirName) {
    transcript.renderHistory([], state.meta);
    set({ entries: [] });
    return;
  }
  set({ historyDir: ref.dirName, historyFile: ref.file });
  try {
    const win = await fetchHistory(ref.dirName, ref.file, { limit: 50 });
    transcript.renderHistory(win.entries, win.meta);
    set({ entries: win.entries, meta: win.meta });
  } catch (e) {
    toast(`history: ${e.message}`);
  }
}

async function loadEarlier() {
  const { historyDir, historyFile, entries } = state;
  const before = entries[0]?.id;
  if (!historyDir || !before) return;
  const win = await fetchHistory(historyDir, historyFile, { limit: 50, before });
  set({ entries: [...win.entries, ...entries] });
  transcript.prependHistory(win.entries);
}

async function bindRunner(id) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", runnerId: id ?? undefined, cwd: state.bound?.cwd });
    await applyBound(msg);
  } finally {
    set({ binding: false });
  }
}

async function bindSession(session) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", dirName: session.dirName, file: session.file, cwd: session.cwd });
    await applyBound(msg, session);
  } finally {
    set({ binding: false });
  }
}

async function newSession(cwd) {
  set({ binding: true });
  try {
    const msg = await socket.request({ type: "bind", cwd });
    await applyBound(msg);
  } finally {
    set({ binding: false });
  }
}

async function attach(runner, take) {
  try {
    const msg = await socket.request({ type: "attach", runnerId: runner.id, take: !!take });
    if (msg.type === "driver_busy") {
      set({ driverBusy: { runnerId: msg.runnerId, heldBy: msg.heldBy } });
      return;
    }
    set({ driving: runner.id, driverBusy: null });
  } catch (e) {
    toast(e.message);
  }
}

async function detach() {
  try {
    await socket.request({ type: "detach" });
  } catch {}
  set({ driving: null });
}

function hashSession() {
  if (!state.historyDir || !state.historyFile) return;
  const next = `#s=${state.historyDir}/${state.historyFile}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

function parseHash() {
  const m = /^#s=([^/]+)\/(.+)$/.exec(location.hash);
  return m ? { dirName: decodeURIComponent(m[1]), file: m[2] } : null;
}

// ─── ws ───
function connect() {
  socket = new HubSocket({
    onOpen: async () => {
      set({ connected: true });
      const target = parseHash() || loadBinding();
      try {
        if (target?.dirName && target?.file) await bindSession(target);
        else if (target?.runnerId) await bindRunner(target.runnerId);
      } catch {
        set({ bound: null, boundId: null });
      }
      document.body.dataset.ready = "1";
    },
    onClose: () => set({ connected: false }),
    onMessage: (msg) => handleFrame(msg),
    onError: (msg) => toast(msg.message || "error"),
  });
  socket.connect();
}

function handleFrame(msg) {
  switch (msg.type) {
    case "hello":
      set({ mode: msg.mode, version: msg.version, authRequired: !!msg.auth });
      break;
    case "runners":
      set({ runners: new Map((msg.runners || []).map((r) => [r.id, r])) });
      break;
    case "runner_added":
    case "runner_status": {
      const runners = new Map(state.runners);
      runners.set(msg.runner.id, msg.runner);
      set({ runners, bound: state.boundId === msg.runner.id ? msg.runner : state.bound });
      break;
    }
    case "runner_removed": {
      const runners = new Map(state.runners);
      runners.delete(msg.runner.id);
      set({ runners, driving: state.driving === msg.runner.id ? null : state.driving });
      if (state.boundId === msg.runner.id) set({ bound: { ...state.bound, state: "dead" } });
      break;
    }
    case "bound":
      applyBound(msg).catch((e) => toast(e.message));
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
    case "dialog":
      dialogs.handleEvent(msg.request);
      break;
    case "dialog_cancelled":
      break;
    case "error":
      toast(msg.message || "error");
      break;
    case "event":
      handleRunnerEvent(msg.event);
      break;
    default:
      break;
  }
}

function handleRunnerEvent(event) {
  if (!event) return;
  if (pendingCommands.has(event.id)) {
    const p = pendingCommands.get(event.id);
    pendingCommands.delete(event.id);
    if (event.success === false) p.reject(new Error(event.error || "command failed"));
    else p.resolve(event);
    return;
  }
  if (event.type === "response") return;
  if (event.type === "extension_ui_request") {
    dialogs.handleEvent(event);
    return;
  }
  transcript.handleEvent(event);
  if (event.type === "agent_start") set({ streaming: true });
  if (event.type === "agent_end") {
    set({ streaming: false });
    if (state.queue.length) {
      const [next, ...rest] = state.queue;
      set({ queue: rest });
      commandRequest({ type: "prompt", message: next }, 30000).catch((e) => toast(e.message));
    }
  }
  if (event.type === "compaction_start") set({ compacting: true });
  if (event.type === "compaction_end") set({ compacting: false });
  if (event.type === "session_file") {
    set({ meta: { ...(state.meta || {}), sessionName: null } });
    const ref = dirOfFile(state.bound?.absFile || null);
    if (ref) {
      set({ historyDir: ref.dirName, historyFile: ref.file });
      hashSession();
      saveBinding({ dirName: ref.dirName, file: ref.file });
    }
  }
}

// ─── login ───
onUnauthorized(() => {
  show(refs.login, true);
  refs.loginError.textContent = "Sign in to continue";
});

refs.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  refs.loginError.textContent = "";
  try {
    await login(refs.loginUser.value, refs.loginPass.value);
    show(refs.login, false);
    await boot();
  } catch (err) {
    refs.loginError.textContent = err.message;
  }
});

// ─── boot ───
async function boot() {
  try {
    await listSessions();
  } catch (e) {
    if (e.status === 401) return;
  }
  set({ projects: [] });
  listSessions()
    .then((out) => set({ projects: out.projects || [] }))
    .catch(() => {});
  connect();
}

settings.applyPrefs();
boot();
