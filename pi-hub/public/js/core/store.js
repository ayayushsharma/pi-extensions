/**
 * store — one state object and one subscribe path. Views read state and
 * render; they never mutate it directly. Persistence lives here too, so the
 * rest of the client stays stateless.
 */
const PREFS_KEY = "pi-hub-prefs";
const TABS_KEY = "pi-hub-tabs";

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const savedTabs = readJSON(TABS_KEY, { tabs: [], activeKey: null });

export const state = {
  /* connection */
  booted: false,
  connected: false,
  connState: "connecting", // connecting | on | off | working
  mode: null,
  version: null,
  authRequired: false,

  /* runners */
  runners: new Map(), // runnerId -> info
  boundId: null,
  bound: null, // RunnerInfo of the active tab's runner
  binding: false,
  driving: null, // runnerId while driving a live runner
  driverBusy: null, // { runnerId, heldBy } while an attach was refused

  /* store listings */
  projects: [], // [{ dirName, cwd, sessions: [...] }]
  sessionsDir: null,
  search: "",
  favourites: readJSON(PREFS_KEY, {}).favourites || [],

  /* tabs / view */
  tabs: savedTabs.tabs || [], // [{ key, dirName, file, runnerId, title, kind }]
  activeKey: savedTabs.activeKey || null,
  view: "welcome", // welcome | session

  /* transcript */
  entries: [],
  meta: null, // { model, thinkingLevel, sessionName, total, cost, tokens, cwd }
  historyDir: null,
  historyFile: null,
  streaming: false,
  compacting: false,

  /* ui chrome */
  ui: { sidebarOpen: false, sidebarCollapsed: false },
  contextUsage: null,

  /* composer */
  cwdFallback: null, // {from,to} when a session's folder was gone (R-10)
  serverCwd: null, // the hub's own working directory (R-10 fallback target)
  queue: [],
  pendingFiles: [],

  prefs: Object.assign(
    { theme: null, showThinking: true, showCosts: true, expandTools: false, wrapCode: false, wrapTools: false, streamRender: "live", toolOutput: "text" },
    readJSON(PREFS_KEY, {}),
  ),
};

const subs = new Set();

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function set(patch) {
  Object.assign(state, patch);
  for (const fn of [...subs]) {
    try {
      fn(state);
    } catch (e) {
      (window.__errs = window.__errs || []).push(String((e && e.message) || e));
    }
  }
}

export function savePrefs() {
  writeJSON(PREFS_KEY, { ...state.prefs, favourites: state.favourites });
}

export function saveTabs() {
  writeJSON(TABS_KEY, { tabs: state.tabs, activeKey: state.activeKey });
}

/* ── tab helpers ─────────────────────────────────────────────────────── */

export function sessionKey(dirName, file) {
  return `s:${dirName || ""}/${file || ""}`;
}

export function runnerKey(runnerId) {
  return `r:${runnerId}`;
}

export function liveKey(pid) {
  return `live:${pid}`;
}

export function activeTab() {
  return state.tabs.find((t) => t.key === state.activeKey) || null;
}

export function findTabByFile(file, dirName) {
  // Match the project too when known: two projects can hold the same
  // basename, and closing/renaming must hit the right tab (R7).
  return (
    state.tabs.find((t) => t.file === file && (dirName == null || t.dirName === dirName)) || null
  );
}

export function findTabByRunner(runnerId) {
  return state.tabs.find((t) => t.runnerId === runnerId) || null;
}

export function upsertTab(tab) {
  const tabs = [...state.tabs];
  const idx = tabs.findIndex((t) => t.key === tab.key);
  if (idx >= 0) tabs[idx] = { ...tabs[idx], ...tab };
  else tabs.push(tab);
  set({ tabs, activeKey: tab.key });
  saveTabs();
}

export function updateTab(key, patch) {
  const tabs = state.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t));
  set({ tabs });
  saveTabs();
}

export function removeTab(key) {
  const tabs = state.tabs.filter((t) => t.key !== key);
  const activeKey = state.activeKey === key ? (tabs[tabs.length - 1]?.key ?? null) : state.activeKey;
  set({ tabs, activeKey });
  saveTabs();
  return activeKey;
}

export function allSessions() {
  const out = [];
  for (const project of state.projects) {
    for (const s of project.sessions || []) out.push({ ...s, dirName: s.dirName || project.dirName, cwd: s.cwd || project.cwd });
  }
  return out;
}

export function isFavourite(file) {
  return state.favourites.includes(file);
}

/** Stable favourites identity: the server never sends absolute session
 *  paths in listings, so favourites key on `dirName/file` (search hits
 *  carry the same pair). Pre-fix entries keyed on `filePath`/`undefined`
 *  simply stop matching and can be re-starred. */
export function favKey(session, project) {
  const dir = session.dirName || project?.dirName || "";
  return `${dir}/${session.file}`;
}

export function toggleFavourite(file) {
  const favourites = state.favourites.includes(file)
    ? state.favourites.filter((f) => f !== file)
    : [...state.favourites, file];
  set({ favourites });
  savePrefs();
}
