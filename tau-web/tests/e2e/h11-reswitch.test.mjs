// H11 — rejoining a session must NOT re-issue switch_session.
// Regression: the start_session handler used to call switchToFile on every
// bind, even when rejoining the backend already on that file. pi cancels
// the in-flight turn on switch_session, so returning to (or reselecting) a
// running session killed its run and baked "Command aborted" into the
// transcript. The hub now tracks ManagedHeadless.switchedFile and skips the
// redundant switch.
//
// Needs the real hub (the stub has no registry): TEST_REAL_HUB=1.
// WS-only, no browser. The headless child is a stub binary (PI_WEB_PI_BIN)
// that logs every command the hub writes to its stdin; the test counts
// switch_session lines per session file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, TMP_DIR, ensureTmp, waitFor, sleep } from "../helpers.mjs";

export const id = "H11";
export const title = "session rejoin does not re-send switch_session";

const STUB_SRC = `#!/bin/bash
# H11 double: log every stdin line (commands from the hub), stay alive.
while IFS= read -r line; do printf '%s\\n' "$line" >> "$HEADLESS_STUB_LOG"; done
`;

function rpc(ws, msg, { timeout = 15000 } = {}) {
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
      } catch {}
    }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ ...msg, id }));
  });
}

function switchCount(logFile, sessionFile) {
  let text = "";
  try { text = fs.readFileSync(logFile, "utf8"); } catch { return 0; }
  return text.split("\n").filter((l) => {
    if (!l.includes("switch_session")) return false;
    try { return String(JSON.parse(l).sessionPath || "").endsWith(sessionFile); } catch { return false; }
  }).length;
}

export async function run() {
  if (process.env.TEST_REAL_HUB !== "1") {
    console.log("  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)");
    return;
  }
  ensureTmp();
  const tag = `h11-${process.pid}`;
  const fileA = `${tag}-a.jsonl`;
  const fileB = `${tag}-b.jsonl`;
  const projDir = os.tmpdir(); // must exist: headless children spawn with cwd here

  // Fixture session files where the real hub resolves them:
  // SESSIONS_DIR/<cwdToSessionDir(projDir)>/file.
  const sessionDirName = `--${path.resolve(projDir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const home = process.env.HOME || os.homedir();
  const sessionDir = path.join(home, ".pi", "agent", "sessions", sessionDirName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const header = (name) => JSON.stringify({ type: "session", version: 1, id: `e2e-${name}`, timestamp: new Date().toISOString(), cwd: projDir }) + "\n";
  fs.writeFileSync(path.join(sessionDir, fileA), header("a"));
  fs.writeFileSync(path.join(sessionDir, fileB), header("b"));

  const stub = path.join(TMP_DIR, `${tag}-stub.sh`);
  const logFile = path.join(TMP_DIR, `${tag}-stdin.log`);
  fs.writeFileSync(stub, STUB_SRC, { mode: 0o755 });
  fs.writeFileSync(logFile, "");

  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({
    port,
    extraEnv: { PI_WEB_PI_BIN: stub, HEADLESS_STUB_LOG: logFile },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
    setTimeout(() => rej(new Error("ws connect timeout")), 10000);
  });
  try {
    // 1. First bind: fresh backend, the child must be told to load the file.
    const ack1 = await rpc(ws, { type: "start_session", cwd: projDir, sessionFile: fileA });
    assert(ack1.event?.success, `start_session A ok: ${JSON.stringify(ack1.event).slice(0, 200)}`);
    const keyA = ack1.event?.data?.sessionKey;
    await waitFor(() => switchCount(logFile, fileA) === 1, { timeout: 10000, label: "first switch for A" });

    // 2. Rejoin the same file (user switches back to a running session):
    // must rebind to the SAME backend and must NOT send switch_session again.
    const ack2 = await rpc(ws, { type: "start_session", cwd: projDir, sessionFile: fileA });
    assert(ack2.event?.success, `rejoin A ok: ${JSON.stringify(ack2.event).slice(0, 200)}`);
    assert(ack2.event?.data?.sessionKey === keyA, `rejoin binds the same backend (got ${ack2.event?.data?.sessionKey}, want ${keyA})`);
    await sleep(800); // give a redundant switch time to land, then assert absence
    assert(switchCount(logFile, fileA) === 1, `no second switch_session for A on rejoin (log:\n${fs.readFileSync(logFile, "utf8").slice(0, 500)})`);

    // 3. A different file still binds a new backend and switches it.
    const ack3 = await rpc(ws, { type: "start_session", cwd: projDir, sessionFile: fileB });
    assert(ack3.event?.success, `start_session B ok: ${JSON.stringify(ack3.event).slice(0, 200)}`);
    assert(ack3.event?.data?.sessionKey !== keyA, `B binds a different backend`);
    await waitFor(() => switchCount(logFile, fileB) === 1, { timeout: 10000, label: "first switch for B" });
    assert(switchCount(logFile, fileA) === 1, `A still switched exactly once`);
  } finally {
    try { ws.close(); } catch {}
    await hub.close();
    for (const f of [fileA, fileB]) { try { fs.unlinkSync(path.join(sessionDir, f)); } catch {} }
  }
}
