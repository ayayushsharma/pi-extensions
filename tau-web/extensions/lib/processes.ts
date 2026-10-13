/**
 * processes — live `pi` OS-process visibility + on-demand kill (ADR-013).
 *
 * This is process management, not session driving: no transcript proxy,
 * no snapshots, no prompt injection, no session-file writes. The hub
 * lists `pi` processes on its own box and SIGTERMs verified ones so the
 * user can free resources from the browser.
 *
 * Fingerprint (fail-closed, re-checked at kill time): argv[0] basename
 * OR /proc exe basename must equal "pi" exactly. Substring matching is
 * forbidden — `grep pi`, `happy`, `node spin.js` must never match.
 * Dependency-free: node builtins only, so tests can exercise the same
 * semantics without a pi process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type ProcessOwner = "hub" | "live";

export interface PiProcess {
  pid: number;
  /** Full argv (truncated to 8 entries) so rows are distinguishable. */
  argv: string[];
  cwd: string | null;
  rssKb: number | null;
  /** Seconds since the process started (null when unknowable). */
  ageSec: number | null;
  owner: ProcessOwner;
  /** Best-effort `--session X` hint from argv (headless children pass the
   *  session over stdin instead, so this is usually null for them). */
  sessionHint: string | null;
}

function baseOf(p: string): string {
  const b = path.basename(String(p || "").replace(/ \(deleted\)$/, ""));
  return b;
}

/** Exact-equality fingerprint: is this argv/exe really a `pi` process? */
export function isPiArgv(argv: string[], exeBase: string | null): boolean {
  if (argv.length > 0 && baseOf(argv[0]) === "pi") return true;
  if (exeBase && baseOf(exeBase) === "pi") return true;
  return false;
}

function sessionHintOf(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session" && i + 1 < argv.length) return argv[i + 1];
    if (a.startsWith("--session=")) return a.slice("--session=".length);
  }
  return null;
}

function readLinuxProc(pid: number): { argv: string[]; exe: string | null; cwd: string | null; rssKb: number | null; ageSec: number | null } | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`);
  } catch { return null; }
  const argv = raw.toString("utf8").split("\0").filter((s) => s.length > 0);
  if (argv.length === 0) return null; // kernel thread
  let exe: string | null = null;
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
  let cwd: string | null = null;
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
  let rssKb: number | null = null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (m) rssKb = Number(m[1]);
  } catch {}
  let ageSec: number | null = null;
  try {
    const st = fs.statSync(`/proc/${pid}`);
    ageSec = Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000));
  } catch {}
  return { argv: argv.slice(0, 8), exe, cwd, rssKb, ageSec };
}

function scanViaPs(selfPid: number): Array<{ pid: number; argv: string[] }> {
  // Fallback for non-/proc platforms (darwin). comm match is exact.
  try {
    const out = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8", timeout: 5000 });
    const rows: Array<{ pid: number; argv: string[] }> = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!pid || pid === selfPid) continue;
      if (m[2] !== "pi") continue;
      const args = m[3].trim().split(/\s+/).filter(Boolean);
      rows.push({ pid, argv: args.slice(0, 8) });
    }
    return rows;
  } catch { return []; }
}

/**
 * List live `pi` processes. `hubChildPids` marks the hub's own headless
 * children (owner "hub"); everything else fingerprinted is "live".
 * Self is never listed. Sorted oldest-first (highest value first:
 * long-running terminal sessions float up).
 */
export function scanPiProcesses(selfPid: number, hubChildPids: Set<number>): { processes: PiProcess[]; unsupported: boolean } {
  const out: PiProcess[] = [];
  const useProc = fs.existsSync("/proc");
  if (useProc) {
    let names: string[] = [];
    try { names = fs.readdirSync("/proc"); } catch { return { processes: [], unsupported: false }; }
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid <= 1 || pid === selfPid) continue;
      const info = readLinuxProc(pid);
      if (!info) continue;
      if (!isPiArgv(info.argv, info.exe ? baseOf(info.exe) : null)) continue;
      out.push({
        pid,
        argv: info.argv,
        cwd: info.cwd,
        rssKb: info.rssKb,
        ageSec: info.ageSec,
        owner: hubChildPids.has(pid) ? "hub" : "live",
        sessionHint: sessionHintOf(info.argv),
      });
    }
  } else if (process.platform !== "win32") {
    for (const row of scanViaPs(selfPid)) {
      out.push({
        pid: row.pid, argv: row.argv, cwd: null, rssKb: null, ageSec: null,
        owner: hubChildPids.has(row.pid) ? "hub" : "live",
        sessionHint: sessionHintOf(row.argv),
      });
    }
  } else {
    return { processes: [], unsupported: true };
  }
  out.sort((a, b) => (b.ageSec ?? -1) - (a.ageSec ?? -1));
  return { processes: out, unsupported: false };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface KillResult {
  ok: true;
  pid: number;
  owner: ProcessOwner;
  /** Signal that did it (SIGTERM preferred, SIGKILL fallback). */
  signal: "SIGTERM" | "SIGKILL";
  exited: boolean;
}

export class ProcessKillError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * TERM a verified live `pi` process (grace wait, then KILL). Hub-owned
 * pids must go through the headless registry instead — pass them in so
 * a stale registry entry still resolves to a safe raw kill rather than
 * a refusal. Fail-closed: anything that does not fingerprint as `pi`
 * at kill time is a 404, never a signal.
 */
export async function killLivePiProcess(pidRaw: unknown, selfPid: number, hubChildPids: Set<number>): Promise<KillResult> {
  const pid = typeof pidRaw === "string" && /^\d+$/.test(pidRaw) ? Number(pidRaw) : pidRaw;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    throw new ProcessKillError(400, "pid must be a positive integer");
  }
  if (pid === selfPid) {
    throw new ProcessKillError(400, "refusing to kill the hub itself");
  }
  // Re-fingerprint at kill time: the pid may have been recycled since listing.
  let argv: string[] = [];
  let exe: string | null = null;
  if (fs.existsSync("/proc")) {
    const info = readLinuxProc(pid);
    if (!info) throw new ProcessKillError(404, `no live pi process with pid ${pid}`);
    argv = info.argv;
    exe = info.exe ? baseOf(info.exe) : null;
  } else if (process.platform !== "win32") {
    const row = scanViaPs(selfPid).find((r) => r.pid === pid);
    if (!row) throw new ProcessKillError(404, `no live pi process with pid ${pid}`);
    argv = row.argv;
  } else {
    throw new ProcessKillError(400, "process kill is unsupported on this platform");
  }
  if (!isPiArgv(argv, exe)) {
    throw new ProcessKillError(404, `no live pi process with pid ${pid}`);
  }
  const owner: ProcessOwner = hubChildPids.has(pid) ? "hub" : "live";
  try { process.kill(pid, "SIGTERM"); }
  catch { throw new ProcessKillError(404, `no live pi process with pid ${pid}`); }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!alive(pid)) return { ok: true, pid, owner, signal: "SIGTERM", exited: true };
  }
  try { process.kill(pid, "SIGKILL"); }
  catch { throw new ProcessKillError(404, `no live pi process with pid ${pid}`); }
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (!alive(pid)) return { ok: true, pid, owner, signal: "SIGKILL", exited: true };
  }
  return { ok: true, pid, owner, signal: "SIGKILL", exited: false };
}
