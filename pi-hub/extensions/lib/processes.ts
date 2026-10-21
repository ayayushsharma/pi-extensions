/**
 * processes — live `pi` OS processes (ADR-013): read-only visibility plus an
 * on-demand kill. The fingerprint is fail-closed and re-checked at kill time.
 *
 * Works on Linux *and* Android/Termux: Node reports `process.platform ===
 * "android"` there (not "linux"), and pi is never a `/proc/<pid>/exe` named
 * `pi` — it runs as `node …/pi-coding-agent/…/cli.js`, or behind the
 * `pi-node.sh` wrapper. Fingerprinting argv (not just argv[0]) is what makes
 * the panel useful on the phone.
 *
 * macOS has no `/proc`, so darwin scans through `ps` instead: same argv
 * fingerprint, RSS straight from `ps`, no cwd (`lsof` per pid is too slow
 * for a scan) and start time derived from elapsed time. Kill re-verifies
 * through `ps` the same way and signals with process.kill.
 */
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

export interface PiProcess {
  pid: number;
  argv: string;
  cwd: string | null;
  rssKb: number;
  startedAt: number | null;
  sessionHint: string | null;
  owner: "hub" | "live";
  /** resolved session title, filled in by the route (null => "new process") */
  title?: string | null;
}

const DEFAULT_PROC = "/proc";

/** `/proc` parsing is available on Linux and Android (Termux); macOS scans
 *  through `ps` instead; anything else is unsupported. */
export function supportsProcessScan(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "android" || platform === "darwin";
}

/** Paths that only a pi install/wrapper produces (no bare "cli.js"). */
const PI_PATH = [
  /(^|[/\\])pi-coding-agent([/\\]|$)/,
  /(^|[/\\])bundle[/\\]cli\.js$/,
  /(^|[/\\])\.bin[/\\]pi$/,
  /(^|[/\\])bin[/\\]pi$/,
];

function readTrim(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function basenameOf(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function argvOf(pid: number, procRoot: string): string[] {
  const raw = readTrim(`${procRoot}/${pid}/cmdline`);
  if (!raw) return [];
  return raw.split("\0").filter(Boolean);
}

/**
 * Fail-closed fingerprint on an argv array. True when:
 *   - argv[0] is `pi` (compiled binary or installed shim), or
 *   - an argument points into a pi install (`pi-coding-agent/`, `bundle/cli.js`,
 *     `bin/pi`) — node, bun, deno or a shell wrapping the shim, or
 *   - a `pi-node.sh` wrapper is on the command line (before it execs node).
 * A bare `node foo.js` never matches.
 */
function matchesPiArgv(argv: string[]): boolean {
  if (!argv.length) return false;
  const argv0 = basenameOf(argv[0]);
  if (argv0 === "pi") return true;
  // Node/bun/deno running a pi entry point, or a shell running a pi shim:
  // the path itself is the fingerprint, the runtime is not.
  if (argv.slice(1).some((a) => PI_PATH.some((re) => re.test(a)))) return true;
  if (argv.slice(1).some((a) => basenameOf(a) === "pi-node.sh")) return true;
  return false;
}

/**
 * Fail-closed fingerprint for a /proc-style tree (Linux, Android, and the
 * unit-test fake tree — pure file reads, so platform-independent).
 */
export function isPiProcess(pid: number, procRoot: string = DEFAULT_PROC): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (matchesPiArgv(argvOf(pid, procRoot))) return true;
  try {
    if (basenameOf(fs.readlinkSync(`${procRoot}/${pid}/exe`)) === "pi") return true;
  } catch {}
  return false;
}

function processInfo(pid: number, childPids: Set<number>, procRoot: string): PiProcess | null {
  if (!isPiProcess(pid, procRoot)) return null;
  const argv = argvOf(pid, procRoot).join(" ").slice(0, 500);
  let cwd: string | null = null;
  try {
    cwd = fs.readlinkSync(`${procRoot}/${pid}/cwd`);
  } catch {}
  let rssKb = 0;
  const statm = readTrim(`${procRoot}/${pid}/statm`);
  if (statm) rssKb = Math.round((Number(statm.split(" ")[1]) || 0) * (4096 / 1024));
  const sessionHint = /(?:--session|--session-id)[ =](\S+)/.exec(argv)?.[1] || null;
  return {
    pid,
    argv,
    cwd,
    rssKb,
    startedAt: null,
    sessionHint,
    owner: childPids.has(pid) ? "hub" : "live",
  };
}

export function scanPiProcesses(
  childPids: Set<number>,
  selfPid = process.pid,
  procRoot = DEFAULT_PROC,
  platform: string = process.platform,
): { processes: PiProcess[]; unsupported?: boolean } {
  // On darwin an explicit proc tree (unit tests) still uses the file logic;
  // real scans go through ps.
  if (platform === "darwin" && procRoot === DEFAULT_PROC) return scanDarwin(childPids, selfPid);
  if (platform !== "linux" && platform !== "android") return { processes: [], unsupported: true };
  let pids: string[] = [];
  try {
    pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n));
  } catch {
    return { processes: [], unsupported: true };
  }
  const processes: PiProcess[] = [];
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (pid <= 1 || pid === selfPid) continue;
    const info = processInfo(pid, childPids, procRoot);
    if (info) processes.push(info);
  }
  processes.sort((a, b) => a.pid - b.pid);
  return { processes };
}

/** `ps` elapsed time ([[dd-]hh:]mm:ss) to a start timestamp. Best-effort:
 *  null when the format is unfamiliar. */
function etimeToStart(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const s = Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Date.now() - s * 1000;
}

export interface PsRow {
  pid: number;
  rssKb: number;
  startedAt: number | null;
  command: string;
}

/** Pure parse of `ps -ax -o pid= -o rss= -o etime= -o command=` (exported for tests). */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    rows.push({ pid, rssKb: Number(m[2]) || 0, startedAt: etimeToStart(m[3]), command: m[4] });
  }
  return rows;
}

function psRows(): PsRow[] {
  try {
    const out = execFileSync("ps", ["-ax", "-o", "pid=", "-o", "rss=", "-o", "etime=", "-o", "command="], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePs(out);
  } catch {
    return [];
  }
}

/** macOS scan: one `ps` call, same argv fingerprint as the /proc back end. */
function scanDarwin(childPids: Set<number>, selfPid: number): { processes: PiProcess[] } {
  const processes: PiProcess[] = [];
  for (const row of psRows()) {
    if (row.pid === selfPid) continue;
    const argv = row.command.split(/\s+/).filter(Boolean);
    if (!matchesPiArgv(argv)) continue;
    processes.push({
      pid: row.pid,
      argv: row.command.slice(0, 500),
      cwd: null, // macOS ps exposes no cwd; per-pid lsof is too slow for a scan
      rssKb: row.rssKb,
      startedAt: row.startedAt,
      sessionHint: /(?:--session|--session-id)[ =](\S+)/.exec(row.command)?.[1] || null,
      owner: childPids.has(row.pid) ? "hub" : "live",
    });
  }
  processes.sort((a, b) => a.pid - b.pid);
  return { processes };
}

/** macOS argv for one pid (kill-time re-verification). Null when gone. */
function darwinArgvOf(pid: number): string[] | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).trim();
    if (!out) return null;
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

function verifyPiProcess(pid: number, procRoot: string, platform: string): boolean {
  if (platform === "darwin" && procRoot === DEFAULT_PROC) {
    const argv = darwinArgvOf(pid);
    return !!argv && matchesPiArgv(argv);
  }
  return isPiProcess(pid, procRoot);
}

export class ProcessKillError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TERM then KILL a verified live pi process. Never self, never pid <= 1. */
export async function killLivePiProcess(
  pid: number,
  childPids: Set<number>,
  selfPid = process.pid,
  procRoot = DEFAULT_PROC,
  platform: string = process.platform,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) throw new ProcessKillError("invalid pid", 400);
  if (pid === selfPid) throw new ProcessKillError("refusing to kill the hub itself", 400);
  if (childPids.has(pid)) throw new ProcessKillError("hub-owned pid: use close_session", 409);
  if (!verifyPiProcess(pid, procRoot, platform)) throw new ProcessKillError("not a pi process (stale pid?)", 404);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    throw new ProcessKillError("process already gone", 404);
  }
  await sleep(1500);
  if (verifyPiProcess(pid, procRoot, platform)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

