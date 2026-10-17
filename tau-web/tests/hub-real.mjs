// Real-hub boot for cases that need a live pi process (H6 + opt-in rest).
// Contract (testing.md §2): stdin MUST stay open (tail -f /dev/null pipe),
// per-run port (never 8192), kill by parent PID.
//
// Portability: the `pi` binary is resolved from PI_BIN, ~/.pi/agent/bin/pi,
// or PATH (no `which` shell-out). When nothing is found the caller gets a
// CaseSkip and the runner reports SKIP instead of crashing — this keeps the
// suite usable on hosts that only run the static/stub layers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, waitForPort, killTree, skipCase } from "./helpers.mjs";

let cachedPi;

/** Resolve the pi binary without shelling out; null when unavailable. */
export function findPi() {
  if (cachedPi !== undefined) return cachedPi;
  const candidates = [];
  if (process.env.PI_BIN) candidates.push(process.env.PI_BIN);
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".pi", "agent", "bin", "pi"));
  const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) candidates.push(path.join(dir, name));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) { cachedPi = c; return c; }
    } catch { /* next */ }
  }
  cachedPi = null;
  return null;
}

/** True when real-hub cases can run on this host. */
export function piAvailable() {
  if (process.env.TAU_NO_PI === "1") return false;
  return !!findPi();
}

/**
 * Boot `pi -e <repo> --mode rpc` on 127.0.0.1:<port>. The hub's own machine
 * environment is scrubbed of every inherited TAU_* var so test runs are
 * deterministic (a dev shell inside a tau-web session exports TAU_ROLE,
 * TAU_DISABLED, TAU_LOG_FILE…), then the suite defaults are applied.
 */
export async function bootRealHub({ port, extraEnv = {} }) {
  const piBin = findPi();
  if (!piBin) skipCase("real-hub cases need a `pi` binary (set PI_BIN, or TAU_NO_PI=1 to silence)");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TAU_") || key === "PI_WEB_PI_BIN") delete env[key];
  }
  Object.assign(env, {
    TAU_MIRROR_PORT: String(port),
    TAU_HOST: "127.0.0.1",
    TAU_STATIC_DIR: path.join(REPO_ROOT, "public"),
    TAU_ROLE: "hub",
  }, extraEnv);

  // stdin held open via a tail pipe — bare `</dev/null` exits immediately.
  // tail missing (unusual) is non-fatal: the hub's stdin pipe stays open and
  // the write below prevents any early EOF.
  const tail = spawn("tail", ["-f", "/dev/null"], { stdio: ["ignore", "ignore", "ignore"] });
  tail.on("error", () => {});
  const hub = spawn(piBin, ["-e", path.join(REPO_ROOT), "--mode", "rpc"], {
    env, stdio: ["pipe", "ignore", "ignore"],
  });
  hub.on("error", () => {});
  let earlyExit = null;
  hub.once("exit", (code) => { earlyExit = code; });
  tail.stdout?.on("data", () => {});
  // Pipe tail -> hub stdin so it never sees EOF.
  try { tail.stdout?.pipe?.(hub.stdin); } catch {}
  hub.stdin.on("error", () => {});
  try { hub.stdin.write("\n"); } catch {}

  try {
    await waitForPort(port, { timeout: 30000 });
  } catch (e) {
    await killTree(hub).catch(() => {});
    try { tail.kill("SIGKILL"); } catch {}
    if (earlyExit !== null) {
      throw new Error(`hub exited before listening (code ${earlyExit}) — check that ${piBin} can run the extension (try PI_BIN=…)`);
    }
    throw e;
  }

  return {
    url: `http://127.0.0.1:${port}`,
    pid: hub.pid,
    close: async () => {
      await killTree(hub); // kills headless children (pkill//proc) then the hub
      try { tail.kill("SIGKILL"); } catch {}
    },
  };
}
