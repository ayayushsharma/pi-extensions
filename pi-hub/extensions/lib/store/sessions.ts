/**
 * sessions — the on-disk session store. Listing is cached by
 * (path, mtimeMs, size); history reads are windowed; mutations are limited
 * to rename (append-only session_info) and fork (byte copy, ADR-016).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SESSIONS_DIR } from "../env.js";

export interface SessionSummary {
  file: string;
  dirName: string;
  cwd: string | null;
  title: string;
  mtime: number;
  size: number;
  model: string | null;
  thinkingLevel: string | null;
  messageCount: number;
  entryCount: number;
  sessionName: string | null;
  cost: number;
  tokens: number;
}

export interface WindowMeta {
  cwd: string | null;
  model: string | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  total: number;
  firstId: string | null;
  cost: number;
  tokens: number;
}

interface CacheEntry {
  at: number;
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

const CACHE_TTL_MS = 15000;
const CACHE_MAX = 400;
const cache = new Map<string, CacheEntry>();

export function sessionsDir(): string {
  return SESSIONS_DIR;
}

/** Reject anything that is not exactly under the sessions dir. */
export function resolveSessionPath(dirName: string, file: string): string {
  if (/[/\\]|\.\./.test(file)) {
    throw new Error("invalid session path");
  }
  // A custom PI_CODING_AGENT_SESSION_DIR makes pi write sessions directly in
  // the root; real stores nest them in per-cwd `--…--` dirs. Accept both.
  const rootName = path.basename(SESSIONS_DIR);
  const flat = dirName === rootName || dirName === "." || dirName === "";
  if (!flat && /[/\\]|\.\./.test(dirName)) throw new Error("invalid session path");
  const abs = flat ? path.join(SESSIONS_DIR, file) : path.join(SESSIONS_DIR, dirName, file);
  return realUnder(abs, SESSIONS_DIR);
}

export function realUnder(target: string, root: string): string {
  const real = fs.realpathSync(target);
  const base = fs.realpathSync(root);
  if (real !== base && !real.startsWith(base + path.sep)) throw new Error("path escapes root");
  return real;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
      .filter(Boolean);
    return parts.join(" ").trim();
  }
  return "";
}

function sessionFilePath(dirName: string, file: string): string {
  const rootName = path.basename(SESSIONS_DIR);
  const flat = dirName === rootName || dirName === "." || dirName === "";
  return flat ? path.join(SESSIONS_DIR, file) : path.join(SESSIONS_DIR, dirName, file);
}

function parseSummary(file: string, dirName: string, st: fs.Stats): SessionSummary {
  const summary: SessionSummary = {
    file,
    dirName,
    cwd: null,
    title: file.replace(/\.jsonl$/, ""),
    mtime: st.mtimeMs,
    size: st.size,
    model: null,
    thinkingLevel: null,
    messageCount: 0,
    entryCount: 0,
    sessionName: null,
    cost: 0,
    tokens: 0,
  };
  let raw = "";
  try {
    raw = fs.readFileSync(sessionFilePath(dirName, file), "utf8");
  } catch {
    return summary;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    summary.entryCount++;
    if (e.type === "session" && typeof e.cwd === "string") summary.cwd = e.cwd;
    if (e.type === "message") {
      summary.messageCount++;
      const role = e.message?.role;
      if (role === "user" && summary.title === file.replace(/\.jsonl$/, "")) {
        const t = textOf(e.message.content);
        if (t) summary.title = t.split("\n")[0].slice(0, 120);
      }
      const usage = e.message?.usage;
      if (usage && typeof usage === "object") {
        summary.tokens += Number(usage.totalTokens || 0);
        summary.cost += Number(usage.cost?.total || 0);
      }
    }
    if (e.type === "model_change") summary.model = `${e.provider}/${e.modelId}`;
    if (e.type === "thinking_level_change") summary.thinkingLevel = e.thinkingLevel;
    if (e.type === "session_info" && e.name) {
      summary.title = e.name;
      summary.sessionName = e.name;
    }
    if (e.type === "usage" && e.usage) {
      summary.tokens += Number(e.usage.totalTokens || 0);
      summary.cost += Number(e.usage.cost?.total || 0);
    }
  }
  return summary;
}

function cachedSummary(dirName: string, file: string): SessionSummary | null {
  const abs = sessionFilePath(dirName, file);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  const hit = cache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.summary;
  }
  const summary = parseSummary(file, dirName, st);
  cache.set(abs, { at: Date.now(), mtimeMs: st.mtimeMs, size: st.size, summary });
  if (cache.size > CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
    for (const [k] of oldest) cache.delete(k);
  }
  return summary;
}

export function invalidateSession(abs: string): void {
  cache.delete(abs);
}

export function listSessionDirs(): Array<{ dirName: string; sessions: SessionSummary[] }> {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("--")).map((e) => e.name);
  const rootName = path.basename(SESSIONS_DIR);
  const hasRootFiles = entries.some((e) => e.isFile() && e.name.endsWith(".jsonl"));
  const out: Array<{ dirName: string; sessions: SessionSummary[] }> = [];
  if (hasRootFiles) {
    const sessions = listSessions(rootName);
    if (sessions.length) out.push({ dirName: rootName, sessions });
  }
  for (const dirName of dirs) {
    const sessions = listSessions(dirName);
    if (sessions.length) out.push({ dirName, sessions });
  }
  out.sort((a, b) => {
    const at = Math.max(...a.sessions.map((s) => s.mtime));
    const bt = Math.max(...b.sessions.map((s) => s.mtime));
    return bt - at;
  });
  return out;
}

export function listSessions(dirName: string): SessionSummary[] {
  let files: string[] = [];
  const rootName = path.basename(SESSIONS_DIR);
  const flat = dirName === rootName || dirName === "." || dirName === "";
  try {
    files = fs.readdirSync(flat ? SESSIONS_DIR : path.join(SESSIONS_DIR, dirName)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const file of files) {
    const s = cachedSummary(dirName, file);
    if (s) out.push(s);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export interface HistoryWindow {
  entries: any[];
  meta: WindowMeta;
}

/** Strip the giant system prompt/tool blocks; the UI never renders them. */
function trimEntry(e: any): any {
  if (e?.type === "message" && e.message?.role === "system") {
    return { type: "message", id: e.id, parentId: e.parentId, timestamp: e.timestamp, message: { role: "system", content: "" } };
  }
  return e;
}

export function readWindow(absPath: string, limit = 50, before?: string | null): HistoryWindow {
  let raw = "";
  try {
    raw = fs.readFileSync(absPath, "utf8");
  } catch {
    throw new Error("session file not found");
  }
  const all: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      all.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  const meta: WindowMeta = {
    cwd: null,
    model: null,
    thinkingLevel: null,
    sessionName: null,
    total: all.length,
    firstId: null,
    cost: 0,
    tokens: 0,
  };
  for (const e of all) {
    if (e.type === "session" && typeof e.cwd === "string") meta.cwd = e.cwd;
    if (e.type === "model_change") meta.model = `${e.provider}/${e.modelId}`;
    if (e.type === "thinking_level_change") meta.thinkingLevel = e.thinkingLevel;
    if (e.type === "session_info" && e.name) meta.sessionName = e.name;
    if (e.type === "message" && e.message?.usage) {
      meta.tokens += Number(e.message.usage.totalTokens || 0);
      meta.cost += Number(e.message.usage.cost?.total || 0);
    }
    if (e.type === "usage" && e.usage) {
      meta.tokens += Number(e.usage.totalTokens || 0);
      meta.cost += Number(e.usage.cost?.total || 0);
    }
  }
  let end = all.length;
  if (before) {
    const i = all.findIndex((e) => e.id === before);
    if (i >= 0) end = i;
  }
  const start = Math.max(0, end - limit);
  const entries = all.slice(start, end).map(trimEntry);
  meta.firstId = entries.length ? entries[0].id || null : null;
  return { entries, meta };
}

/** Pagination cursor for "load earlier": the id of the oldest loaded entry. */
export function windowInfo(absPath: string): { total: number } {
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    return { total: raw.split("\n").filter(Boolean).length };
  } catch {
    return { total: 0 };
  }
}

/** Resolve a session basename to its project dir (most recent wins). */
export function findSessionByBasename(file: string): { dirName: string; file: string; abs: string } | null {
  if (!file || /[/\\]|\.\./.test(file) || !file.endsWith(".jsonl")) return null;
  let best: { dirName: string; file: string; abs: string; mtime: number } | null = null;
  let dirs: string[] = [];
  const rootName = path.basename(SESSIONS_DIR);
  try {
    dirs = [rootName, ...fs.readdirSync(SESSIONS_DIR).filter((d) => d.startsWith("--"))];
  } catch {
    return null;
  }
  for (const dirName of dirs) {
    const abs = sessionFilePath(dirName, file);
    try {
      const st = fs.statSync(abs);
      if (!best || st.mtimeMs > best.mtime) best = { dirName, file, abs, mtime: st.mtimeMs };
    } catch {}
  }
  return best ? { dirName: best.dirName, file: best.file, abs: best.abs } : null;
}

export function deleteSession(dirName: string, file: string): void {
  const abs = resolveSessionPath(dirName, file);
  fs.unlinkSync(abs);
  invalidateSession(abs);
}

export interface SearchHit {
  dirName: string;
  file: string;
  filePath: string;
  cwd: string | null;
  title: string;
  snippet: string;
  timestamp: number;
}

/** Full-text scan across the session store, bounded by `limit` hits. */
export function searchSessions(query: string, limit = 30): SearchHit[] {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  let dirs: string[] = [];
  const rootName = path.basename(SESSIONS_DIR);
  try {
    dirs = [rootName, ...fs.readdirSync(SESSIONS_DIR).filter((d) => d.startsWith("--"))];
  } catch {
    return [];
  }
  outer: for (const dirName of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(sessionFilePath(dirName, "")).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const abs = sessionFilePath(dirName, file);
      let raw = "";
      try {
        raw = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      let cwd: string | null = null;
      let title = "";
      let snippet = "";
      let hit = false;
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type === "session" && typeof e.cwd === "string") cwd = e.cwd;
        const text = e.type === "message" ? textOf(e.message?.content) : "";
        if (!text) continue;
        if (!title && e.message?.role === "user") title = text.split("\n")[0].slice(0, 120);
        if (!hit && text.toLowerCase().includes(q)) {
          const idx = text.toLowerCase().indexOf(q);
          snippet = text.slice(Math.max(0, idx - 60), idx + 140);
          hit = true;
        }
      }
      if (!hit) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(abs).mtimeMs;
      } catch {}
      hits.push({ dirName, file, filePath: abs, cwd, title: title || file, snippet, timestamp: mtime });
      if (hits.length >= limit) break outer;
    }
  }
  return hits;
}

/** Every entry in the file (no window) — used by the compat history shape. */
export function readAll(absPath: string): HistoryWindow {
  return readWindow(absPath, Number.MAX_SAFE_INTEGER, null);
}

export function forkSession(dirName: string, file: string): { file: string } {
  const src = resolveSessionPath(dirName, file);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}_${crypto.randomUUID()}.jsonl`;
  const dest = path.join(SESSIONS_DIR, dirName, name);
  fs.copyFileSync(src, dest);
  invalidateSession(src);
  return { file: name };
}

export function renameSession(dirName: string, file: string, name: string): void {
  const abs = resolveSessionPath(dirName, file);
  const clean = String(name || "").replace(/[\r\n]/g, " ").trim().slice(0, 120);
  if (!clean) throw new Error("name required");
  const raw = fs.readFileSync(abs, "utf8");
  let lastId: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.id) lastId = e.id;
    } catch {}
  }
  const entry = {
    type: "session_info",
    id: crypto.randomBytes(4).toString("hex"),
    parentId: lastId,
    timestamp: new Date().toISOString(),
    name: clean,
  };
  fs.appendFileSync(abs, `${JSON.stringify(entry)}\n`);
  invalidateSession(abs);
}

export function sessionCwd(absPath: string): string | null {
  try {
    const fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const first = buf.toString("utf8", 0, n).split("\n")[0];
    const header = JSON.parse(first);
    return typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null;
  }
}

