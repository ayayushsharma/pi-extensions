/**
 * processes — live `pi` OS processes (ADR-013): read-only visibility plus an
 * on-demand kill. Fingerprint is fail-closed and re-checked at kill time.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface PiProcess {
  pid: number;
  argv: string;
  cwd: string | null;
  rssKb: number;
  startedAt: number | null;
  sessionHint: string | null;
  owner: "hub" | "live";
}

const LINUX = process.platform === "linux";

function readTrim(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function basenameOf(p: string): string {
  return p.split("/").pop() || p;
}

/** argv[0] basename `pi`, or /proc/<pid>/exe basename `pi`. No substring. */
export function isPiProcess(pid: number): boolean {
  if (!LINUX) return false;
  const cmdline = readTrim(`/proc/${pid}/cmdline`);
  if (cmdline) {
    const argv0 = cmdline.split("\0")[0];
    if (argv0 && basenameOf(argv0) === "pi") return true;
  }
  try {
    if (basenameOf(fs.readlinkSync(`/proc/${pid}/exe`)) === "pi") return true;
  } catch {}
  return false;
}

function processInfo(pid: number, childPids: Set<number>): PiProcess | null {
  if (!isPiProcess(pid)) return null;
  const cmdline = readTrim(`/proc/${pid}/cmdline`) || "";
  const argv = cmdline.split("\0").filter(Boolean).join(" ").slice(0, 500);
  let cwd: string | null = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {}
  let rssKb = 0;
  const statm = readTrim(`/proc/${pid}/statm`);
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

export function scanPiProcesses(childPids: Set<number>, selfPid = process.pid): { processes: PiProcess[]; unsupported?: boolean } {
  if (!LINUX) return { processes: [], unsupported: true };
  let pids: string[] = [];
  try {
    pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return { processes: [], unsupported: true };
  }
  const processes: PiProcess[] = [];
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (pid <= 1 || pid === selfPid) continue;
    const info = processInfo(pid, childPids);
    if (info) processes.push(info);
  }
  processes.sort((a, b) => a.pid - b.pid);
  return { processes };
}

export class ProcessKillError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TERM then KILL a verified live pi process. Never self, never pid <= 1. */
export async function killLivePiProcess(
  pid: number,
  childPids: Set<number>,
  selfPid = process.pid,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) throw new ProcessKillError("invalid pid", 400);
  if (pid === selfPid) throw new ProcessKillError("refusing to kill the hub itself", 400);
  if (childPids.has(pid)) throw new ProcessKillError("hub-owned pid: use close_session", 409);
  if (!isPiProcess(pid)) throw new ProcessKillError("not a pi process (stale pid?)", 404);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    throw new ProcessKillError("process already gone", 404);
  }
  await sleep(1500);
  if (isPiProcess(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
