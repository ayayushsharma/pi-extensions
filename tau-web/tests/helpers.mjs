// Shared helpers: ports, polling, asserts, process hygiene (testing.md §2).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { WebSocket } from "ws";

export const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
export const PUBLIC_DIR = path.join(REPO_ROOT, "public");
export const TMP_DIR = path.join(REPO_ROOT, "tests", ".tmp");

export function ensureTmp() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export async function basePort() {
  if (process.env.TAU_E2E_PORT) return Number(process.env.TAU_E2E_PORT);
  // Random free port ≥ 18000 — never the canonical 8192.
  for (let i = 0; i < 20; i++) {
    const p = await getFreePort();
    if (p >= 18000 && p !== 8192) return p;
  }
  return await getFreePort();
}

/** Pre-flight: fail fast if the test port is already bound (stale-code bump trap). */
export function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", (e) => reject(new Error(`pre-flight: port ${port} is busy (${e.message}) — kill the stale server, don't bump`)));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

export async function waitFor(fn, { timeout = 10000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function waitForPort(port, { timeout = 15000 } = {}) {
  return waitFor(async () => (await portBusy(port)) || null, { timeout, label: `port ${port}` });
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { redirect: "manual", ...opts });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain text */ }
  return { res, json, text };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assert: ${msg}`);
}

/** POST a JSON body and return the parsed response without following redirects. */
export async function postJson(url, body, opts = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** Connect a WS client, optionally with extra handshake headers (e.g. Cookie). */
export async function connectWs(url, { headers, timeout = 10000 } = {}) {
  const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), timeout);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  return ws;
}

/**
 * Send one command over the hub socket and resolve its response event
 * ({ type: "rpc_event", event: { type: "response", ... } }). Matches both the
 * control-command id and the injected inner id, mirroring H6.
 */
export function wsRpc(ws, msg, { timeout = 15000 } = {}) {
  const id = `e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`rpc timeout: ${msg.type}`));
    }, timeout);
    function onMsg(raw) {
      try {
        const m = JSON.parse(String(raw));
        const inner = m.event;
        if (m.type === "rpc_event" && inner?.type === "response" && (m.id === id || inner.id === id)) {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(m);
        }
      } catch { /* not for us */ }
    }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ ...msg, id }));
  });
}

/**
 * Thrown when a case cannot run on this host (no Chrome, no pi, disabled by
 * env). The runner reports it as SKIP, not FAIL, and keeps the exit code 0,
 * so the suite is usable on Termux/low-end hosts that lack optional runtimes.
 */
export class CaseSkip extends Error {
  constructor(reason) {
    super(reason);
    this.name = "CaseSkip";
    this.skip = true;
  }
}

export function skipCase(reason) {
  throw new CaseSkip(reason);
}


/** Direct child PIDs of `pid`; [] on non-Linux hosts without /proc. */
export function childPids(pid) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync("/proc"); } catch { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, "utf8");
      // "pid (comm with spaces) state ppid ..." — split after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[1]) === pid) out.push(Number(e));
    } catch { /* process vanished */ }
  }
  return out;
}

/** Every descendant of `pid` (depth-capped), via /proc only. */
function descendantsOf(pid, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (const child of childPids(pid)) {
    out.push(child, ...descendantsOf(child, depth + 1));
  }
  return out;
}

function pkillParent(pid) {
  return new Promise((resolve) => {
    // Kill by PARENT pid only — never `pkill -f <pattern>` (suicide trap, §2).
    // pkill is absent on some hosts (Termux without procps): unresolved
    // children are covered by the /proc scan below.
    execFile("pkill", ["-P", String(pid)], () => resolve(true));
  });
}

/** Kill a spawned process and its descendants, with a /proc fallback for pkill. */
export async function killTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  const kids = descendantsOf(pid);
  try { await pkillParent(pid); } catch {}
  // pid could have been recycled after a failed pkill; only signal children
  // we observed while the parent was alive.
  for (const kid of kids) { try { process.kill(kid, "SIGKILL"); } catch {} }
  await new Promise((r) => setTimeout(r, 300));
  try { proc.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { proc.kill("SIGKILL"); } catch {}
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
