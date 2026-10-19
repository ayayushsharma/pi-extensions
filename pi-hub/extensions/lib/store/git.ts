/**
 * git — the branch a session's cwd is on, read from `.git/HEAD` directly.
 *
 * Why not shell out to `git`: the hub must stay cheap (one request per
 * session open), must work with git missing, and must never block on a
 * lock. HEAD is a one-line file; walking up a few parents covers the common
 * case of a session started in a subdirectory of a repo.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitInfo {
  /** current branch, or the short sha on a detached HEAD */
  branch: string | null;
  /** repository root (the directory holding .git) */
  root: string | null;
  detached: boolean;
}

const EMPTY: GitInfo = { branch: null, root: null, detached: false };

/** `<dir>/.git` is a directory (normal repo) or a file ("gitdir: …"):
 *  worktrees and submodules point elsewhere. */
function gitDirOf(dir: string): string | null {
  const dotGit = path.join(dir, ".git");
  let st: fs.Stats;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  try {
    const line = fs.readFileSync(dotGit, "utf8").trim();
    const m = /^gitdir:\s*(.+)$/.exec(line);
    if (!m) return null;
    return path.resolve(dir, m[1].trim());
  } catch {
    return null;
  }
}

function parseHead(gitDir: string): { branch: string | null; detached: boolean } {
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return { branch: null, detached: false };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return { branch: ref[1].trim(), detached: false };
  if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: head.slice(0, 7), detached: true };
  return { branch: null, detached: false };
}

const cache = new Map<string, { at: number; info: GitInfo }>();
const TTL_MS = 5000;

/** Resolve the branch for `cwd` (or the nearest ancestor that is a repo). */
export function gitInfo(cwd: string): GitInfo {
  if (!cwd || typeof cwd !== "string") return EMPTY;
  let start: string;
  try {
    start = fs.realpathSync(cwd);
  } catch {
    return EMPTY;
  }
  const hit = cache.get(start);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  let info: GitInfo = EMPTY;
  let dir = start;
  for (let depth = 0; depth < 12; depth++) {
    const gitDir = gitDirOf(dir);
    if (gitDir) {
      const { branch, detached } = parseHead(gitDir);
      info = { branch, root: dir, detached };
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(start, { at: Date.now(), info });
  return info;
}
