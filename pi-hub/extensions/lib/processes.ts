/**
 * processes — live `pi` OS processes (ADR-013): read-only visibility plus an
 * on-demand kill. The fingerprint is fail-closed and re-checked at kill time.
 *
 * Works on Linux *and* Android/Termux: Node reports `process.platform ===
 * "android"` there (not "linux"), and pi is never a `/proc/<pid>/exe` named
 * `pi` — it runs as `node …/pi-coding-agent/…/cli.js`, or behind the
 * `pi-node.sh` wrapper. Fingerprinting argv (not just argv[0]) is what makes
 * the panel useful on the phone.
 */
import * as fs from "node:fs";

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

/** `/proc` parsing is available on Linux and Android (Termux); not elsewhere. */
export function supportsProcessScan(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "android";
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
 * Fail-closed fingerprint. True when this pid is a pi process:
 *   - argv[0] is `pi` (compiled binary or installed shim), or
 *   - an argument points into a pi install (`pi-coding-agent/`, `bundle/cli.js`,
 *     `bin/pi`) — node, bun, deno or a shell wrapping the shim, or
 *   - a `pi-node.sh` wrapper is on the command line (before it execs node).
 * A bare `node foo.js` never matches.
 */
export function isPiProcess(pid: number, procRoot: string = DEFAULT_PROC): boolean {
  if (!supportsProcessScan()) return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const argv = argvOf(pid, procRoot);
  if (argv.length) {
    const argv0 = basenameOf(argv[0]);
    if (argv0 === "pi") return true;
    // Node/bun/deno running a pi entry point, or a shell running a pi shim:
    // the path itself is the fingerprint, the runtime is not.
    if (argv.slice(1).some((a) => PI_PATH.some((re) => re.test(a)))) return true;
    if (argv.slice(1).some((a) => basenameOf(a) === "pi-node.sh")) return true;
  }
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
): { processes: PiProcess[]; unsupported?: boolean } {
  if (!supportsProcessScan()) return { processes: [], unsupported: true };
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
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) throw new ProcessKillError("invalid pid", 400);
  if (pid === selfPid) throw new ProcessKillError("refusing to kill the hub itself", 400);
  if (childPids.has(pid)) throw new ProcessKillError("hub-owned pid: use close_session", 409);
  if (!isPiProcess(pid, procRoot)) throw new ProcessKillError("not a pi process (stale pid?)", 404);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    throw new ProcessKillError("process already gone", 404);
  }
  await sleep(1500);
  if (isPiProcess(pid, procRoot)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

