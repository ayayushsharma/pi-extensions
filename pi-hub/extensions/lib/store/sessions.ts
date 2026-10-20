/**
 * sessions — the on-disk session store. Each file has an append-aware
 * incremental index (consumed bytes + line offsets + aggregates); listing
 * and history windows read only new/tail bytes, never the whole JSONL.
 * Mutations are limited to rename (append-only session_info) and fork
 * (byte copy, ADR-016), plus relocate (header-rewritten copy, R-10).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SESSIONS_DIR } from "../env.js";

export interface SessionSummary {
  file: string;
  dirName: string;
  cwd: string | null;
  /** false when the recorded cwd no longer exists (R-10) */
  cwdExists?: boolean;
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

/* ── incremental file index ──────────────────────────────────────────
 * Listing and history both need per-file aggregates (tokens, cost, model,
 * title) plus the last N entries. Parsing the whole JSONL for that was the
 * biggest RAM spike in the hub: a 39 MB session cost ~+120 MB peak, and
 * every listing after a token re-parsed the growing file.
 *
 * The index is append-aware: it remembers how many bytes it has consumed
 * and only reads what was appended. Entries come from a ring of line
 * offsets, so serving a window reads ~limit lines instead of the file.
 *
 * Peaks are bounded by READ_CHUNK (not file size), and a rewrite/truncate
 * is detected via inode/size plus head+tail fingerprints and rebuilt once.
 */
const READ_CHUNK = 256 * 1024;
const OFFSET_RING = 4096;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const INDEX_MAX = 200;
const FP_BYTES = 4096;

interface FileIndex {
  ino: number;
  /** bytes consumed through the last complete line */
  size: number;
  mtimeMs: number;
  /** parsed entries (invalid JSON lines are skipped, as before) */
  lines: number;
  messageCount: number;
  tokens: number;
  cost: number;
  cwd: string | null;
  model: string | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  /** prompt-derived or session_info title; null = still the file stem */
  title: string | null;
  /** byte offset of the last OFFSET_RING complete line starts */
  offsets: number[];
  headHash: string;
  tailHash: string;
  lastAt: number;
}

const indexCache = new Map<string, FileIndex>();

/** Diagnostics for tests and /api/server: proves reads are incremental. */
export const sessionStoreStats = {
  fullScans: 0,
  incrementalBytes: 0,
  windowBytes: 0,
};

function hashBuf(b: Buffer): string {
  return crypto.createHash("sha1").update(b).digest("hex");
}

function readAt(fd: number, pos: number, len: number): Buffer {
  if (len <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

function fingerprintHead(fd: number, size: number): string {
  return hashBuf(readAt(fd, 0, Math.min(FP_BYTES, size)));
}

function fingerprintTail(fd: number, size: number): string {
  if (size <= 0) return hashBuf(Buffer.alloc(0));
  const len = Math.min(FP_BYTES, size);
  return hashBuf(readAt(fd, size - len, len));
}

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

function applyLine(idx: FileIndex, line: Buffer): void {
  if (line.length === 0) return;
  let e: any;
  try {
    e = JSON.parse(line.toString("utf8"));
  } catch {
    return;
  }
  idx.lines++;
  if (e.type === "session" && typeof e.cwd === "string") idx.cwd = e.cwd;
  if (e.type === "message") {
    idx.messageCount++;
    if (e.message?.role === "user" && idx.title === null) {
      const t = textOf(e.message.content);
      if (t) idx.title = t.split("\n")[0].slice(0, 120);
    }
    const usage = e.message?.usage;
    if (usage && typeof usage === "object") {
      idx.tokens += Number(usage.totalTokens || 0);
      idx.cost += Number(usage.cost?.total || 0);
    }
  }
  if (e.type === "model_change") idx.model = `${e.provider}/${e.modelId}`;
  if (e.type === "thinking_level_change") idx.thinkingLevel = e.thinkingLevel;
  if (e.type === "session_info" && e.name) {
    idx.title = e.name;
    idx.sessionName = e.name;
  }
  if (e.type === "usage" && e.usage) {
    idx.tokens += Number(e.usage.totalTokens || 0);
    idx.cost += Number(e.usage.cost?.total || 0);
  }
}

function pushOffset(idx: FileIndex, offset: number): void {
  idx.offsets.push(offset);
  if (idx.offsets.length > OFFSET_RING) idx.offsets.shift();
}

function blankIndex(st: fs.Stats): FileIndex {
  return {
    ino: st.ino,
    size: 0,
    mtimeMs: st.mtimeMs,
    lines: 0,
    messageCount: 0,
    tokens: 0,
    cost: 0,
    cwd: null,
    model: null,
    thinkingLevel: null,
    sessionName: null,
    title: null,
    offsets: [],
    headHash: "",
    tailHash: "",
    lastAt: Date.now(),
  };
}

/** Consume complete lines starting at `from`. Memory stays ~READ_CHUNK. */
function consume(fd: number, idx: FileIndex, size: number, from: number): void {
  let pos = from;
  let lineStart = from;
  let carry: Buffer[] = [];
  let carryLen = 0;
  let skipping = false;
  while (pos < size) {
    const want = Math.min(READ_CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(want);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    let pieceStart = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] !== 0x0a) continue;
      const piece = buf.subarray(pieceStart, i);
      if (skipping) {
        // Oversized line (> MAX_LINE_BYTES): drop it whole, never a suffix.
        skipping = false;
        carry = [];
        carryLen = 0;
      } else {
        const line = carryLen ? Buffer.concat([...carry, piece], carryLen + piece.length) : piece;
        applyLine(idx, line);
        pushOffset(idx, lineStart);
        carry = [];
        carryLen = 0;
      }
      lineStart = pos + i + 1;
      pieceStart = i + 1;
    }
    if (pieceStart < n) {
      const rest = Buffer.from(buf.subarray(pieceStart, n));
      carry.push(rest);
      carryLen += rest.length;
      if (carryLen > MAX_LINE_BYTES) {
        skipping = true;
        carry = [];
        carryLen = 0;
      }
    }
    pos += n;
    sessionStoreStats.incrementalBytes += n;
  }
  // Only complete lines are consumed; a partial trailing line is re-read next
  // time, so a mid-write file never yields half an entry.
  idx.size = lineStart;
  idx.mtimeMs = fs.fstatSync(fd).mtimeMs;
  idx.headHash = fingerprintHead(fd, idx.size);
  idx.tailHash = fingerprintTail(fd, idx.size);
  idx.lastAt = Date.now();
}

function buildIndex(abs: string, st: fs.Stats): FileIndex {
  const idx = blankIndex(st);
  const fd = fs.openSync(abs, "r");
  try {
    consume(fd, idx, st.size, 0);
  } finally {
    fs.closeSync(fd);
  }
  sessionStoreStats.fullScans++;
  return idx;
}

/** True when the bytes the index already consumed are still the same file. */
function intact(fd: number, idx: FileIndex, size: number): boolean {
  if (size < idx.size) return false;
  if (hashBuf(readAt(fd, 0, Math.min(FP_BYTES, idx.size))) !== idx.headHash) return false;
  if (idx.size > 0) {
    const len = Math.min(FP_BYTES, idx.size);
    if (hashBuf(readAt(fd, idx.size - len, len)) !== idx.tailHash) return false;
  }
  return true;
}

function getIndex(abs: string, st: fs.Stats): FileIndex {
  const hit = indexCache.get(abs);
  if (hit && hit.ino === st.ino) {
    if (st.size === hit.size && st.mtimeMs === hit.mtimeMs) {
      hit.lastAt = Date.now();
      return hit;
    }
    if (st.size > hit.size) {
      let fd = -1;
      try {
        fd = fs.openSync(abs, "r");
        if (intact(fd, hit, st.size)) {
          consume(fd, hit, st.size, hit.size);
          return hit;
        }
      } catch {
        // fall through to a rebuild
      } finally {
        if (fd >= 0) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
      }
    }
  }
  const idx = buildIndex(abs, st);
  indexCache.set(abs, idx);
  if (indexCache.size > INDEX_MAX) {
    const oldest = [...indexCache.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt).slice(0, 50);
    for (const [k] of oldest) indexCache.delete(k);
  }
  return idx;
}

function summaryFor(dirName: string, file: string, st: fs.Stats, idx: FileIndex): SessionSummary {
  const summary: SessionSummary = {
    file,
    dirName,
    cwd: idx.cwd,
    title: idx.title ?? file.replace(/\.jsonl$/, ""),
    mtime: st.mtimeMs,
    size: st.size,
    model: idx.model,
    thinkingLevel: idx.thinkingLevel,
    messageCount: idx.messageCount,
    entryCount: idx.lines,
    sessionName: idx.sessionName,
    cost: idx.cost,
    tokens: idx.tokens,
  };
  // R-10: pi refuses to resume a session whose stored cwd is gone, so the UI
  // must know before it tries (and offer to continue somewhere real).
  summary.cwdExists = !summary.cwd || fs.existsSync(summary.cwd);
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
  try {
    return summaryFor(dirName, file, st, getIndex(abs, st));
  } catch {
    return null;
  }
}

export function invalidateSession(abs: string): void {
  indexCache.delete(abs);
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

/** Parse the complete lines in [from, to). */
function parseRange(fd: number, from: number, to: number): any[] {
  const bytes = readAt(fd, from, Math.max(0, to - from));
  sessionStoreStats.windowBytes += bytes.length;
  const out: any[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Entry id without parsing the whole line (cheap paging cursor lookup). */
function quickId(fd: number, start: number, end: number): string | null {
  const head = readAt(fd, start, Math.min(4096, Math.max(0, end - start))).toString("utf8");
  const m = /"id"\s*:\s*"([^"]{1,200})"/.exec(head);
  return m ? m[1] : null;
}

/** Stream a file line by line; `onLine` returning false stops the walk. */
function forEachLineSync(abs: string, onLine: (line: string) => boolean): void {
  let fd = -1;
  try {
    fd = fs.openSync(abs, "r");
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = 0;
    let carry: Buffer[] = [];
    let carryLen = 0;
    while (pos < size) {
      const want = Math.min(READ_CHUNK, size - pos);
      const buf = Buffer.allocUnsafe(want);
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      let pieceStart = 0;
      let stop = false;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 0x0a) continue;
        const piece = buf.subarray(pieceStart, i);
        const line = carryLen ? Buffer.concat([...carry, piece], carryLen + piece.length) : piece;
        carry = [];
        carryLen = 0;
        pieceStart = i + 1;
        if (onLine(line.toString("utf8")) === false) {
          stop = true;
          break;
        }
      }
      if (stop) return;
      if (pieceStart < n) {
        const rest = Buffer.from(buf.subarray(pieceStart, n));
        carry.push(rest);
        carryLen += rest.length;
        if (carryLen > MAX_LINE_BYTES) {
          carry = [];
          carryLen = 0;
        }
      }
      pos += n;
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

/** Deep paging beyond the offset ring: stream, keep the last `limit` entries. */
function deepWindow(abs: string, limit: number, before: string): any[] {
  sessionStoreStats.fullScans++;
  const ring: any[] = [];
  let hit = false;
  forEachLineSync(abs, (line) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return true;
    }
    if (e.id === before) {
      hit = true;
      return false;
    }
    ring.push(e);
    if (ring.length > limit) ring.shift();
    return true;
  });
  return hit ? ring : [];
}

function readEntries(abs: string, idx: FileIndex, limit: number, before?: string | null): any[] {
  const offsets = idx.offsets;
  if (!offsets.length) return [];
  let fd = -1;
  try {
    fd = fs.openSync(abs, "r");
    let endIdx = offsets.length;
    if (before) {
      let found = -1;
      for (let i = offsets.length - 1; i >= 0; i--) {
        const end = i + 1 < offsets.length ? offsets[i + 1] : idx.size;
        if (quickId(fd, offsets[i], end) === before) {
          found = i;
          break;
        }
      }
      if (found < 0) return deepWindow(abs, limit, before);
      endIdx = found;
    }
    const startIdx = Math.max(0, endIdx - limit);
    if (startIdx >= endIdx) return [];
    const from = offsets[startIdx];
    const to = endIdx < offsets.length ? offsets[endIdx] : idx.size;
    return parseRange(fd, from, to).slice(-limit);
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function readWindow(absPath: string, limit = 50, before?: string | null): HistoryWindow {
  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch {
    throw new Error("session file not found");
  }
  let idx: FileIndex;
  try {
    idx = getIndex(absPath, st);
  } catch {
    throw new Error("session file not found");
  }
  const entries = readEntries(absPath, idx, limit, before).map(trimEntry);
  return {
    entries,
    meta: {
      cwd: idx.cwd,
      model: idx.model,
      thinkingLevel: idx.thinkingLevel,
      sessionName: idx.sessionName,
      total: idx.lines,
      firstId: entries.length ? entries[0].id || null : null,
      cost: idx.cost,
      tokens: idx.tokens,
    },
  };
}

/** Pagination cursor for "load earlier": the id of the oldest loaded entry. */
export function windowInfo(absPath: string): { total: number } {
  try {
    return { total: getIndex(absPath, fs.statSync(absPath)).lines };
  } catch {
    return { total: 0 };
  }
}

/** Resolve a session basename to its project dir (most recent wins). */
/** The human title of a session file, given any absolute path to it.
 *  Sessions that never saw a prompt carry their file stem as the placeholder
 *  title — that counts as "no title" so callers can say "new process" instead
 *  of leaking a `.jsonl` name (same rule the web UI applies to the sidebar). */
export function titleForSessionFile(absFile: string): string | null {
  if (!absFile || typeof absFile !== "string") return null;
  const found = findSessionByBasename(path.basename(absFile));
  if (!found) return null;
  if (path.resolve(found.abs) !== path.resolve(absFile)) return null;
  const stem = found.file.replace(/\.jsonl$/, "");
  const summary = listSessions(found.dirName).find((s) => s.file === found.file);
  const title = summary?.title;
  return title && title !== stem ? title : null;
}

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

/**
 * Full-text scan across the session store, bounded by `limit` hits.
 * DoS-shaped inputs stay cheap: files over SEARCH_FILE_CAP are skipped
 * (a 100 MB session must not be re-read per keystroke), and the whole
 * query stops after SEARCH_BUDGET_BYTES no matter how many files remain.
 * Per-IP throttling lives at the route (one scan is fast; a flood is not).
 */
export const SEARCH_FILE_CAP = 8 * 1024 * 1024;
export const SEARCH_BUDGET_BYTES = 64 * 1024 * 1024;

export function searchSessions(query: string, limit = 30): SearchHit[] {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  let scanned = 0;
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
      if (scanned >= SEARCH_BUDGET_BYTES) break outer;
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > SEARCH_FILE_CAP) continue;
      scanned += st.size;
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
      hits.push({ dirName, file, filePath: abs, cwd, title: title || file, snippet, timestamp: st?.mtimeMs || 0 });
      if (hits.length >= limit) break outer;
    }
  }
  return hits;
}

/**
 * S3: export_html outputPath is client-controlled. Constrain it to the
 * session store: a string-prefix jail plus a realpath check of an existing
 * parent (a symlinked dir inside the store must not redirect the write
 * outside). Returns the absolute path; throws with status 400/403.
 */
export function validateExportPath(raw: string): string {
  const abs = path.resolve(String(raw || ""));
  const root = path.resolve(SESSIONS_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw Object.assign(new Error("export path must be inside the session store"), { status: 403 });
  }
  try {
    const parentReal = fs.realpathSync(path.dirname(abs));
    if (parentReal !== root && !parentReal.startsWith(root + path.sep)) {
      throw Object.assign(new Error("export path must be inside the session store"), { status: 403 });
    }
  } catch (e: any) {
    if (e?.status === 403) throw e;
    // Parent missing: the child fails cleanly; the prefix jail above stands.
  }
  return abs;
}

/** Every entry in the file (no window) — used by the compat history shape.
 *  Unused by the hub; kept for callers that genuinely need the whole file, so
 *  it streams (constant memory) instead of `readFileSync`. */
export function readAll(absPath: string): HistoryWindow {
  const all: any[] = [];
  forEachLineSync(absPath, (line) => {
    try {
      all.push(JSON.parse(line));
    } catch {}
    return true;
  });
  const tail = readWindow(absPath, 1, null);
  return {
    entries: all.map(trimEntry),
    meta: { ...tail.meta, total: all.length, firstId: all.length ? all[0].id || null : null },
  };
}

export function forkSession(dirName: string, file: string): { file: string } {
  const src = resolveSessionPath(dirName, file);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}_${crypto.randomUUID()}.jsonl`;
  const dest = path.join(SESSIONS_DIR, dirName, name);
  fs.copyFileSync(src, dest);
  // src is untouched; the new copy gets indexed on first read.
  return { file: name };
}

/**
 * R-10: resume a session whose stored cwd is gone. pi refuses to switch to a
 * session whose cwd is missing and RPC `switch_session` has no cwd override,
 * so the only honest fix is a copy with a rewritten `cwd` header — the same
 * history, continued in a folder that exists.
 */
export function relocateSession(dirName: string, file: string, cwd: string): { file: string; dirName: string; cwd: string } {
  const src = resolveSessionPath(dirName, file);
  const target = path.resolve(String(cwd || ""));
  const st = fs.statSync(target); // throws when the target is gone too
  if (!st.isDirectory()) throw new Error("target cwd is not a directory");
  const raw = fs.readFileSync(src, "utf8");
  const lines = raw.split("\n");
  let rewritten = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const e = JSON.parse(lines[i]);
      if (e && e.type === "session") {
        e.cwd = target;
        lines[i] = JSON.stringify(e);
        rewritten = true;
      }
    } catch {}
    if (rewritten) break;
  }
  if (!rewritten) throw new Error("no session header found");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}_${crypto.randomUUID()}.jsonl`;
  const dest = path.join(SESSIONS_DIR, dirName, name);
  fs.writeFileSync(dest, lines.join("\n"));
  invalidateSession(src);
  invalidateSession(dest);
  return { file: name, dirName, cwd: target };
}

export function renameSession(dirName: string, file: string, name: string): void {
  const abs = resolveSessionPath(dirName, file);
  const clean = String(name || "").replace(/[\r\n]/g, " ").trim().slice(0, 120);
  if (!clean) throw new Error("name required");
  // lastId comes from the tail, not a full parse: rename on a 40 MB file
  // must not cost a 40 MB read.
  let lastId: string | null = null;
  try {
    const tail = readWindow(abs, 1, null);
    const last = tail.entries.at(-1);
    if (last?.id) lastId = last.id;
  } catch {
    lastId = null;
  }
  const entry = {
    type: "session_info",
    id: crypto.randomBytes(4).toString("hex"),
    parentId: lastId,
    timestamp: new Date().toISOString(),
    name: clean,
  };
  fs.appendFileSync(abs, `${JSON.stringify(entry)}\n`);
  // Append-only: the index consumes just this line on the next read.
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

