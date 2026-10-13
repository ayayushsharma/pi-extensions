// Shared helpers: ports, polling, asserts, process hygiene (testing.md §2).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

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


function pkillParent(pid) {
  return new Promise((resolve) => {
    // Kill by PARENT pid only — never `pkill -f <pattern>` (suicide trap, §2).
    execFile("pkill", ["-P", String(pid)], () => resolve(true));
  });
}

export async function killTree(proc) {
  if (!proc || proc.killed) return;
  const pid = proc.pid;
  try { await pkillParent(pid); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { proc.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { proc.kill("SIGKILL"); } catch {}
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
