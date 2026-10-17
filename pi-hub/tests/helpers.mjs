// helpers — hub/mirror boot, process hygiene, ws client, tmp dirs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const WS = require("ws");

export const PKG_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
export const FIXTURE_SESSIONS = path.join(PKG_ROOT, "tests", "fixtures", "sessions");

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
        cachedPi = c;
        return c;
      }
    } catch {}
  }
  cachedPi = null;
  return null;
}

export function tmpDir(prefix = "pihub-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy the committed fixture store into a throwaway dir (tests stay idempotent). */
export function fixtureSessionDir() {
  const dir = tmpDir("pihub-sessions-");
  fs.cpSync(FIXTURE_SESSIONS, dir, { recursive: true });
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
  const pids = [];
  const walk = (pid) => {
    try {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      for (const child of children.split(/\s+/).filter(Boolean)) {
        const cpid = Number(child);
        walk(cpid);
        pids.push(cpid);
      }
    } catch {}
  };
  walk(proc.pid);
  for (const pid of pids.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TAU_") || key.startsWith("PI_HUB_") || key === "PI_WEB_PI_BIN") delete env[key];
  }
  env.TAU_DISABLED = "1"; // an installed tau-web must stay inert
  return env;
}

export async function startHub({ port, env = {}, sessionDir } = {}) {
  fs.mkdirSync("/tmp/pihub-fixtures", { recursive: true }); // fixture session cwd
  const piBin = findPi();
  if (!piBin) throw Object.assign(new Error("pi binary not found (set PI_BIN or TAU_NO_PI=1)"), { skip: true });
  const dir = tmpDir();
  const fullEnv = cleanEnv();
  Object.assign(fullEnv, {
    PI_HUB_PORT: String(port),
    PI_HUB_HOST: "127.0.0.1",
    PI_HUB_DIR: dir,
    PI_HUB_LOG_FILE: path.join(dir, "hub.log"),
    PI_HUB_STATIC_DIR: path.join(PKG_ROOT, "public"),
    PI_HUB_PI_BIN: piBin,
  });
  if (sessionDir) fullEnv.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  Object.assign(fullEnv, env);
  const proc = spawn(piBin, ["-e", PKG_ROOT, "--mode", "rpc"], {
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
    proc,
    log: () => fs.readFileSync(path.join(dir, "hub.log"), "utf8"),
    stdout: () => stdout,
    close: () => new Promise((resolve) => {
      killTree(proc);
      setTimeout(resolve, 200);
    }),
  };
}

export async function startMirror({ sock, cwd, sessionDir } = {}) {
  const piBin = findPi();
  if (!piBin) throw Object.assign(new Error("pi binary not found"), { skip: true });
  const env = cleanEnv();
  env.PI_HUB_FORCE_ROLE = "mirror";
  env.PI_HUB_SOCK = sock;
  env.PI_HUB_DIR = path.dirname(sock);
  env.PI_HUB_LOG_FILE = path.join(path.dirname(sock), "mirror.log");
  if (sessionDir) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
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
