// store — one state object, one subscribe path. Views never mutate it directly.
const PREF_KEY = "pi-hub-prefs";
const BIND_KEY = "pi-hub-binding";

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
  } catch {
    return {};
  }
}

export const state = {
  connected: false,
  mode: null,
  version: null,
  authRequired: false,
  runners: new Map(), // id -> RunnerInfo
  boundId: null,
  bound: null, // RunnerInfo of the bound runner
  binding: false, // a bind request is in flight (switching sessions)
  driving: null, // runnerId while driving a live runner
  driverBusy: null, // { runnerId, heldBy } while attach was refused
  banner: null, // { kind, text, actions: [...] }
  entries: [], // loaded transcript entries (window)
  meta: null, // { model, thinkingLevel, sessionName, total, cost, tokens, cwd }
  historyDir: null, // dirName of the bound session (for paging/fork)
  historyFile: null, // file name of the bound session
  streaming: false,
  compacting: false,
  commands: [],
  queue: [],
  prefs: Object.assign({ theme: "dusk", showThinking: true, hideCosts: false }, loadPrefs()),
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
      (window.__errs = window.__errs || []).push(String(e && e.message ? e.message : e));
    }
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs));
  } catch {}
}

export function saveBinding(binding) {
  try {
    if (binding) localStorage.setItem(BIND_KEY, JSON.stringify(binding));
    else localStorage.removeItem(BIND_KEY);
  } catch {}
}

export function loadBinding() {
  try {
    return JSON.parse(localStorage.getItem(BIND_KEY) || "null");
  } catch {
    return null;
  }
}

export function runnerList() {
  return [...state.runners.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "live" ? -1 : 1;
    return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
  });
}
