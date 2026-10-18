/**
 * files — read-only exploration plus one mutation (mkdir, ADR-018).
 * Every path is realpath-checked under an allowlisted root; the viewer is
 * jailed to the viewed session's cwd (ADR-017).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { HOME, type HubConfig } from "../env.js";
import { listSessionDirs, sessionCwd } from "./sessions.js";

export interface DirEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
}

let sessionRootsCache: { at: number; roots: string[] } | null = null;

/** Session cwds are user project directories; browsing them is expected. */
function sessionCwdRoots(): string[] {
  const now = Date.now();
  if (sessionRootsCache && now - sessionRootsCache.at < 5000) return sessionRootsCache.roots;
  const roots: string[] = [];
  try {
    for (const dir of listSessionDirs()) {
      const cwd = dir.sessions.find((s) => s.cwd)?.cwd;
      if (cwd && path.isAbsolute(cwd)) roots.push(path.resolve(cwd));
    }
  } catch {}
  sessionRootsCache = { at: now, roots };
  return roots;
}

export function browseRoots(cfg: HubConfig): string[] {
  const roots = [HOME, ...cfg.fsRoots, ...sessionCwdRoots()];
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolve + realpath. Throws when the path escapes every allowed root. */
export function jailPath(rawPath: string, roots: string[]): string {
  if (!rawPath || typeof rawPath !== "string" || rawPath.includes("\0")) {
    throw Object.assign(new Error("invalid path"), { status: 400 });
  }
  const expanded = rawPath.startsWith("~") ? path.join(HOME, rawPath.slice(1)) : rawPath;
  const abs = path.resolve(HOME, expanded);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw Object.assign(new Error("not found"), { status: 404 });
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (within(real, realRoot)) return real;
  }
  throw Object.assign(new Error("path outside allowed roots"), { status: 403 });
}

export function listDir(rawPath: string, cfg: HubConfig): { path: string; entries: DirEntry[] } {
  const roots = browseRoots(cfg);
  let target = rawPath;
  if (!target || target === "~") target = HOME;
  const real = jailPath(target, roots);
  const st = fs.statSync(real);
  if (!st.isDirectory()) throw new Error("not a directory");
  const entries: DirEntry[] = [];
  for (const name of fs.readdirSync(real)) {
    if (name === "." || name === "..") continue;
    try {
      const s = fs.statSync(path.join(real, name));
      entries.push({
        name,
        type: s.isDirectory() ? "dir" : "file",
        size: s.size,
        mtime: s.mtimeMs,
      });
    } catch {}
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: real, entries: entries.slice(0, 500) };
}

const TEXT_EXT: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".xml": "application/xml",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".toml": "text/plain",
  ".sh": "text/x-shellscript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".java": "text/x-java",
  ".sql": "text/x-sql",
  ".log": "text/plain",
  ".svg": "image/svg+xml",
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export function contentTypeFor(file: string): string {
  return TEXT_EXT[path.extname(file).toLowerCase()] || "text/plain";
}

export interface FileContent {
  path: string;
  mime: string;
  text: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
}

const TEXT_CAP = 256 * 1024;

export function readContent(rawPath: string, cfg: HubConfig, sessionAbs?: string | null): FileContent {
  const roots = sessionAbs
    ? [sessionCwd(sessionAbs) || HOME]
    : browseRoots(cfg);
  const real = jailPath(rawPath, roots);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error("not a file");
  const mime = contentTypeFor(real);
  const fd = fs.openSync(real, "r");
  try {
    const size = st.size;
    const take = Math.min(size, TEXT_CAP);
    const buf = Buffer.alloc(take);
    const n = fs.readSync(fd, buf, 0, take, 0);
    const slice = buf.subarray(0, n);
    const binary = slice.includes(0);
    return {
      path: real,
      mime,
      text: binary ? null : slice.toString("utf8"),
      binary,
      truncated: size > TEXT_CAP,
      size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readPreview(
  rawPath: string,
  cfg: HubConfig,
  sessionAbs?: string | null,
): { path: string; mime: string; buffer: Buffer } {
  const roots = sessionAbs ? [sessionCwd(sessionAbs) || HOME] : browseRoots(cfg);
  const real = jailPath(rawPath, roots);
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error("not a file");
  const ext = path.extname(real).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new Error("unsupported preview type");
  if (st.size > 8 * 1024 * 1024) throw new Error("image too large");
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/png";
  return { path: real, mime, buffer: fs.readFileSync(real) };
}

/** The only mutation in the file API (ADR-018): one level, jail under HOME. */
export function makeDir(rawPath: string, cfg: HubConfig): string {
  const realHome = fs.realpathSync(HOME);
  const target = path.resolve(HOME, rawPath.startsWith("~") ? rawPath.slice(1) : rawPath);
  const parent = path.dirname(target);
  if (!parent || parent === target) throw new Error("invalid path");
  const realParent = fs.realpathSync(parent);
  if (!within(realParent, realHome)) throw new Error("mkdir is jailed to $HOME");
  if (fs.existsSync(target)) {
    const err: any = new Error("already exists");
    err.code = "EEXIST";
    throw err;
  }
  fs.mkdirSync(target, { recursive: false });
  return target;
}
