/**
 * api — fetch wrapper. A 401 raises the login overlay (never the browser's
 * native auth prompt: the server never sends WWW-Authenticate).
 */
let unauthorized = null;

export function onUnauthorized(fn) {
  unauthorized = fn;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body:
      options.body !== undefined && typeof options.body !== "string" && !(options.body instanceof FormData)
        ? JSON.stringify(options.body)
        : options.body,
  });
  if (res.status === 401) {
    unauthorized?.();
    throw Object.assign(new Error("authentication required"), { status: 401 });
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw Object.assign(new Error(message || `HTTP ${res.status}`), { status: res.status });
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json") ? res.json() : res.text();
}

/* ── auth ────────────────────────────────────────────────────────────── */
export const login = (user, pass) => api("/api/login", { method: "POST", body: { user, pass } });
export const logout = () => api("/api/logout", { method: "POST" });

/* ── sessions ────────────────────────────────────────────────────────── */
export const listSessions = () => api("/api/sessions");
export const listProjects = () => api("/api/projects");

export function history(dirName, file, { limit = 50, before } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", before);
  return api(`/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}?${q}`);
}

export const forkSession = (dirName, file) =>
  api("/api/sessions/fork", { method: "POST", body: { dirName, file } });
export const renameSession = (dirName, file, name) =>
  api("/api/sessions/rename", { method: "POST", body: { dirName, file, name } });
export const deleteSession = (dirName, file) =>
  api("/api/sessions/delete", { method: "POST", body: { dirName, file } });
export const sessionFileExists = (path) => api(`/api/session-file-exists?path=${encodeURIComponent(path)}`);
export const searchSessions = (q) => api(`/api/search?q=${encodeURIComponent(q)}`);

/* ── files ───────────────────────────────────────────────────────────── */
export const listDir = (path) => api(`/api/files/list?path=${encodeURIComponent(path)}`);
export const fileContent = (path, session) => {
  const q = new URLSearchParams({ path });
  if (session) q.set("session", session);
  return api(`/api/files/content?${q}`);
};
export const previewUrl = (path, session) => {
  const q = new URLSearchParams({ path });
  if (session) q.set("session", session);
  return `/api/files/preview?${q}`;
};
export const mkdir = (path) => api("/api/files/mkdir", { method: "POST", body: { path } });
export const downloadUrl = (path) => `/api/file/download?path=${encodeURIComponent(path)}`;

/* ── runners / processes ─────────────────────────────────────────────── */
export const listRunners = () => api("/api/runners");
export const closeRunner = (runnerId) => api("/api/runners/close", { method: "POST", body: { runnerId } });
export const listInstances = () => api("/api/instances");
export const headlessStatus = (file) => api(`/api/headless/status?file=${encodeURIComponent(file)}`);
export const processes = () => api("/api/processes");
export const killProcess = (pid) => api("/api/processes/kill", { method: "POST", body: { pid } });
export const serverInfo = () => api("/api/server");
export const clientError = (message) => api("/api/client-error", { method: "POST", body: { message } }).catch(() => {});
