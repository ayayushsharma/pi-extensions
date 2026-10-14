// Real-hub boot for cases that need a live pi process (H6 + opt-in rest).
// Contract (testing.md §2): stdin MUST stay open (tail -f /dev/null pipe),
// per-run port (never 8192), kill by parent PID.
import { spawn } from "node:child_process";
import path from "node:path";
import { REPO_ROOT, waitForPort, killTree } from "./helpers.mjs";

export async function bootRealHub({ port, extraEnv = {} }) {
  const piBin = process.env.PI_BIN || path.join(process.env.HOME || "", ".pi/agent/bin/pi");
  const env = {
    ...process.env,
    TAU_MIRROR_PORT: String(port),
    TAU_HOST: "127.0.0.1",
    TAU_STATIC_DIR: path.join(REPO_ROOT, "public"),
    TAU_ROLE: "hub",
    ...extraEnv,
  };
  // A dev shell running inside a tau-web agent session inherits
  // TAU_DISABLED=1 (nested servers off) — the test hub IS a server.
  delete env.TAU_DISABLED;
  // Same for auth: the suite asserts hub logic, not auth (D5 covers
  // that). Scrub inherited credentials so the test hub serves open.
  delete env.TAU_USER;
  delete env.TAU_PASS;
  // stdin held open via a tail pipe — bare `</dev/null` exits immediately.
  const tail = spawn("tail", ["-f", "/dev/null"], { stdio: ["ignore", "ignore", "ignore"] });
  const hub = spawn(piBin, ["-e", path.join(REPO_ROOT), "--mode", "rpc"], {
    env, stdio: ["pipe", "ignore", "ignore"],
  });
  tail.stdout?.on("data", () => {});
  // Pipe tail -> hub stdin so it never sees EOF.
  try { tail.stdout?.pipe?.(hub.stdin); } catch {}
  // Fallback: keep stdin open directly if the pipe dance fails.
  hub.stdin.on("error", () => {});
  try { hub.stdin.write("\n"); } catch {}

  await waitForPort(port, { timeout: 30000 });
  return {
    url: `http://127.0.0.1:${port}`,
    pid: hub.pid,
    close: async () => {
      await killTree(hub); // kills headless children (pkill -P) then the hub
      try { tail.kill("SIGKILL"); } catch {}
    },
  };
}
