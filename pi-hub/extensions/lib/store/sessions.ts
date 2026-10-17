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
  if (/[/\\]|\.\./.test(dirName) || /[/\\]|\.\./.test(file)) {
    throw new Error("invalid session path");
  }
  const abs = path.join(SESSIONS_DIR, dirName, file);
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
    cost: 0,
    tokens: 0,
  };
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(SESSIONS_DIR, dirName, file), "utf8");
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
    if (e.type === "session_info" && e.name) summary.title = e.name;
    if (e.type === "usage" && e.usage) {
      summary.tokens += Number(e.usage.totalTokens || 0);
      summary.cost += Number(e.usage.cost?.total || 0);
    }
  }
  return summary;
}

function cachedSummary(dirName: string, file: string): SessionSummary | null {
  const abs = path.join(SESSIONS_DIR, dirName, file);
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
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(SESSIONS_DIR).filter((d) => d.startsWith("--"));
  } catch {
    return [];
  }
  const out: Array<{ dirName: string; sessions: SessionSummary[] }> = [];
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
  try {
    files = fs.readdirSync(path.join(SESSIONS_DIR, dirName)).filter((f) => f.endsWith(".jsonl"));
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

