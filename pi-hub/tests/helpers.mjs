// helpers — hub/mirror boot, process hygiene, ws client, tmp dirs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { sandbox, snapshotTree, diffRealStore, REAL_SESSIONS_DIR } from "./sandbox.mjs";

const require = createRequire(import.meta.url);
const WS = require("ws");

export const PKG_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
export const FIXTURE_SESSIONS = path.join(PKG_ROOT, "tests", "fixtures", "sessions");
/** Fixture sessions used to point their header cwd at /tmp. Termux has no
 *  /tmp, so use the platform temp dir and rewrite the copied header instead
 *  of forcing a fake root (T1). The project dirName stays the stable
 *  `--tmp-pihub-fixtures--` name; only the header cwd is rewritten. */
export const FIXTURE_CWD = path.join(os.tmpdir(), "pihub-fixtures");

let cachedPi;
export function findPi() {
  if (cachedPi !== undefined) return cachedPi;
  const candidates = [];
  if (process.env.PI_BIN) candidates.push(process.env.PI_BIN);
  if (os.homedir()) candidates.push(path.join(os.homedir(), ".pi", "agent", "bin", "pi"));
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, "pi"));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        cachedPi = piLauncher(c);
        return cachedPi;
      }
    } catch {}
  }
  cachedPi = null;
  return null;
}

/** On a normal Linux host the npm `pi` shim is directly executable. On
 *  Termux `/usr/bin/env` does not exist, so a `#!/usr/bin/env node` shim
 *  fails before Node starts; return a tiny temp launcher with an absolute
 *  shell + node path instead of requiring the termux-exec LD_PRELOAD (T1). */
function piLauncher(candidate) {
  if (process.platform !== "android" || fs.existsSync("/usr/bin/env")) return candidate;
  let head = "";
  try {
    const fd = fs.openSync(candidate, "r");
    const buf = Buffer.alloc(128);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString("utf8");
  } catch {
    return candidate;
  }
  if (!/^#!\/usr\/bin\/env\s+node/.test(head)) return candidate;
  const target = fs.realpathSync(candidate);
  const dir = tmpDir("pihub-pi-launcher-");
  const wrapper = path.join(dir, "pi");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(target)} "$@"\n`, { mode: 0o755 });
  return wrapper;
}

let cachedTestPi;
/**
 * The binary under test for the hub role.
 *
 * `PI_HUB_TEST_BIN` is the Rust host during the port. Children spawned by the
 * hub still use `findPi()` (the reference Node pi), because Phase 2 keeps the
 * existing pi children unchanged. When the variable is unset this falls back
 * to the reference pi so the suite still runs before the port lands.
 */
export function findTestPi() {
  if (cachedTestPi !== undefined) return cachedTestPi;
  const explicit = process.env.PI_HUB_TEST_BIN;
  if (explicit) {
    try {
      if (!fs.statSync(explicit).isFile()) throw new Error("not a file");
    } catch (e) {
      throw new Error(`PI_HUB_TEST_BIN is not an executable file: ${explicit} (${e.message})`);
    }
    cachedTestPi = explicit;
    return explicit;
  }
  cachedTestPi = findPi();
  return cachedTestPi;
}

export function tmpDir(prefix = "pihub-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy the committed fixture store into a throwaway dir (tests stay idempotent). */
export function fixtureSessionDir() {
  const dir = tmpDir("pihub-sessions-");
  fs.cpSync(FIXTURE_SESSIONS, dir, { recursive: true });
  fs.mkdirSync(FIXTURE_CWD, { recursive: true });
  const fixtureDir = path.join(dir, "--tmp-pihub-fixtures--");
  for (const name of fs.readdirSync(fixtureDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(fixtureDir, name);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    try {
      const header = JSON.parse(lines[0]);
      if (header?.type === "session") {
        header.cwd = FIXTURE_CWD;
        lines[0] = JSON.stringify(header);
        fs.writeFileSync(file, lines.join("\n"));
      }
    } catch {}
  }
  return dir;
}

export async function freePort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 150, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

export function killTree(proc) {
  if (!proc || !proc.pid) return;
  // Safety rail for a phone that is also running the developer's pi: never
  // signal this test process or any of its ancestors, even if a PID was
  // reused or a caller passes the wrong handle. Only descendants of `proc`
  // are collected, and the final kill is the exact child handle.
  const protectedPids = new Set([process.pid]);
  let parent = process.ppid;
  while (parent && parent > 1 && !protectedPids.has(parent)) {
    protectedPids.add(parent);
    try {
      const stat = fs.readFileSync(`/proc/${parent}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parent = Number(fields[1]) || null;
    } catch {
      break;
    }
  }
  if (protectedPids.has(proc.pid)) return;
  const pids = [];
  const walk = (pid) => {
    if (protectedPids.has(pid)) return;
    try {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      for (const child of children.split(/\s+/).filter(Boolean)) {
        const cpid = Number(child);
        if (!Number.isInteger(cpid) || cpid <= 1 || protectedPids.has(cpid)) continue;
        walk(cpid);
        pids.push(cpid);
      }
    } catch {}
  };
  walk(proc.pid);
  for (const pid of pids.reverse()) {
    if (protectedPids.has(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
}

/**
 * Env for every pi child a test spawns: no tau, no hub autoload, and — the
 * important part — a throwaway agent dir + session store, so nothing a test
 * does can appear in the developer's real `~/.pi/agent`.
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TAU_") || key.startsWith("PI_HUB_") || key === "PI_WEB_PI_BIN") delete env[key];
    if (key === "PI_CODING_AGENT_DIR" || key === "PI_CODING_AGENT_SESSION_DIR") delete env[key];
  }
  Object.assign(env, sandbox(extra).env);
  env.TAU_DISABLED = "1"; // an installed tau-web must stay inert
  return env;
}

/** Every request the sandbox's fake model has received this run. */
export async function llmRequests() {
  const url = process.env.PI_HUB_TEST_LLM_URL;
  if (!url) return [];
  const res = await fetch(`${url}/__requests`).catch(() => null);
  if (!res?.ok) return [];
  return (await res.json()).requests || [];
}

/**
 * How many *user* messages in the newest conversation contain `text`.
 * Requests carry the whole history, so a double-send shows up as two copies
 * in the final conversation. (Counting raw JSON would also match tool output
 * and the assistant's own echo.)
 */
export async function llmCopiesInLastRequest(text) {
  const all = await llmRequests();
  if (!all.length) return 0;
  const messages = all[all.length - 1].messages || [];
  return messages.filter((m) => m?.role === "user" && JSON.stringify(m.content ?? "").includes(text)).length;
}

/** Requests whose conversation contains `text` (double-send detector). */
export async function llmMentioning(text) {
  const all = await llmRequests();
  return all.filter((r) => JSON.stringify(r.messages).includes(text));
}

/** Hold the fake model mid-stream so a test can act while a run is in flight. */
export async function setLlmHold(ms) {
  const url = process.env.PI_HUB_TEST_LLM_URL;
  if (!url) return;
  await fetch(`${url}/__hold`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ms }) }).catch(() => {});
}

/** Leak guard: snapshot the real store so run.mjs can assert it stayed clean. */
export function realStoreSnapshot() {
  return snapshotTree(REAL_SESSIONS_DIR);
}
export function realStoreDiff(before) {
  return diffRealStore(before);
}

export async function startHub({ port, env = {}, sessionDir, llmUrl } = {}) {
  fs.mkdirSync(FIXTURE_CWD, { recursive: true }); // fixture session cwd
  const piBin = findPi();
  const testBin = findTestPi();
  if (!testBin) throw Object.assign(new Error("test pi binary not found (set PI_HUB_TEST_BIN or PI_BIN; TAU_NO_PI=1 skips)"), { skip: true });
  if (!piBin) throw Object.assign(new Error("child pi binary not found (set PI_BIN or TAU_NO_PI=1)"), { skip: true });
  const dir = tmpDir();
  const fullEnv = cleanEnv({ llmUrl: llmUrl ?? process.env.PI_HUB_TEST_LLM_URL });
  Object.assign(fullEnv, {
    PI_HUB_PORT: String(port),
    PI_HUB_HOST: "127.0.0.1",
    PI_HUB_DIR: dir,
    PI_HUB_ADVERT_FILE: path.join(dir, "hub.json"),
    PI_HUB_LOG_FILE: path.join(dir, "hub.log"),
    PI_HUB_STATIC_DIR: path.join(PKG_ROOT, "public"),
    PI_HUB_PI_BIN: piBin,
  });
  fullEnv.PI_CODING_AGENT_SESSION_DIR = sessionDir || fullEnv.PI_CODING_AGENT_SESSION_DIR;
  Object.assign(fullEnv, env);
  // The hub under test receives the same argv the extension host normally gets.
  // A Rust host accepts `-e <pkg> --mode rpc` and ignores `-e`; children still
  // come from PI_HUB_PI_BIN above.
  const proc = spawn(testBin, ["-e", PKG_ROOT, "--mode", "rpc"], {
    cwd: PKG_ROOT,
    env: fullEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  let stdout = "";
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stdout += d));
  proc.stdin.on("error", () => {});
  proc.stdin.write("\n");
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    }, { timeoutMs: 30000, what: "hub /api/health" });
  } catch (e) {
    killTree(proc);
    throw new Error(`${e.message}\nhub output:\n${stdout.slice(-2000)}`);
  }
  return {
    url,
    port,
    dir,
    agentDir: fullEnv.PI_CODING_AGENT_DIR,
    advertPath: path.join(dir, "hub.json"),
    proc,
    log: () => fs.readFileSync(path.join(dir, "hub.log"), "utf8"),
    stdout: () => stdout,
    close: () => new Promise((resolve) => {
      killTree(proc);
      setTimeout(resolve, 200);
    }),
  };
}

export async function startMirror({ sock, cwd, sessionDir, llmUrl, env: extraEnv } = {}) {
  const piBin = findPi();
  if (!piBin) throw Object.assign(new Error("pi binary not found"), { skip: true });
  const env = cleanEnv({ llmUrl: llmUrl ?? process.env.PI_HUB_TEST_LLM_URL });
  env.PI_HUB_FORCE_ROLE = "mirror";
  env.PI_HUB_SOCK = sock;
  env.PI_HUB_DIR = path.dirname(sock);
  env.PI_HUB_LOG_FILE = path.join(path.dirname(sock), "mirror.log");
  if (sessionDir) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  if (extraEnv) Object.assign(env, extraEnv);
  const proc = spawn(piBin, ["-e", PKG_ROOT, "--mode", "rpc"], { cwd: cwd || os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.on("error", () => {});
  proc.stdin.write("\n");
  return {
    proc,
    close: () => new Promise((resolve) => {
      killTree(proc);
      setTimeout(resolve, 200);
    }),
  };
}

export function jsonFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
  });
}

export function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    const frames = [];
    const waiters = [];
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      frames.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          waiters[i].resolve(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.on("error", reject);
    ws.on("open", () =>
      resolve({
        ws,
        frames,
        send: (msg) => ws.send(JSON.stringify(msg)),
        wait(pred, timeoutMs = 20000, what = "frame") {
          const hit = frames.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), timeoutMs);
            waiters.push({
              pred,
              resolve: (v) => {
                clearTimeout(t);
                res(v);
              },
            });
          });
        },
        close: () =>
          new Promise((res) => {
            ws.on("close", res);
            ws.close();
            setTimeout(res, 500);
          }),
      }),
    );
  });
}
