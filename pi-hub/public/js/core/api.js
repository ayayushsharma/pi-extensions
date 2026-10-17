// api — fetch wrapper. 401 raises the login overlay instead of failing twice.
let unauthorized = null;

export function onUnauthorized(fn) {
  unauthorized = fn;
}

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body !== undefined && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
  if (res.status === 401) {
    if (unauthorized) unauthorized();
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

export async function login(user, pass) {
  return api("/api/login", { method: "POST", body: { user, pass } });
}

export async function logout() {
  return api("/api/logout", { method: "POST" });
}

export function listSessions() {
  return api("/api/sessions");
}

export function listProjects() {
  return api("/api/projects");
}

export function history(dirName, file, { limit = 50, before } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", before);
  return api(`/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}?${q}`);
}

export function listDir(path) {
  return api(`/api/files/list?path=${encodeURIComponent(path)}`);
}

export function fileContent(path, session) {
  const q = new URLSearchParams({ path });
  if (session) q.set("session", session);
  return api(`/api/files/content?${q}`);
}

export function previewUrl(path, session) {
  const q = new URLSearchParams({ path });
  if (session) q.set("session", session);
  return `/api/files/preview?${q}`;
}

export function mkdir(path) {
  return api("/api/files/mkdir", { method: "POST", body: { path } });
}

export function fork(dirName, file) {
  return api("/api/sessions/fork", { method: "POST", body: { dirName, file } });
}

export function rename(dirName, file, name) {
  return api("/api/sessions/rename", { method: "POST", body: { dirName, file, name } });
}

export function processes() {
  return api("/api/processes");
}

export function killProcess(pid) {
  return api("/api/processes/kill", { method: "POST", body: { pid } });
}

export function serverInfo() {
  return api("/api/server");
}

export function clientError(message) {
  return api("/api/client-error", { method: "POST", body: { message } }).catch(() => {});
}
