// H6 — headless round-trip on the WS: start_session + prompt.
// Against the stub (default, CI) the simulated backend echoes HEADLESS-OK.
// With TEST_REAL_HUB=1 it runs against a real `pi` hub + real headless child.
import { WebSocket } from "ws";
import os from "node:os";
import { startHubStub } from "../hub-stub.mjs";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR, waitFor } from "../helpers.mjs";

export const requires = () => (process.env.TEST_REAL_HUB === "1" ? ["pi"] : []);
export const id = "H6";
export const title = "start_session + prompt HEADLESS-OK round-trip";

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

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const real = process.env.TEST_REAL_HUB === "1";
  const hub = real
    ? await bootRealHub({ port })
    : await startHubStub({ port, staticDir: PUBLIC_DIR });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
      setTimeout(() => rej(new Error("ws connect timeout")), 10000);
    });
    try {
      // os.tmpdir(): "/tmp" does not exist on some hosts (e.g. Termux /
      // is read-only) and the headless child spawns with this cwd.
      const started = await rpc(ws, { type: "start_session", cwd: os.tmpdir() });
      assert(started.event?.success === true, `start_session failed: ${JSON.stringify(started)}`);
      assert(started.event?.data?.sessionKey, "start_session missing sessionKey");

      if (real) {
        // Real headless child: ask it to echo. The child is a live pi agent;
        // keep the prompt side-effect-free and distinctive.
        const seen = [];
        ws.on("message", (raw) => {
          try {
            const m = JSON.parse(String(raw));
            if (m.type === "rpc_event" && m.event?.type === "message_update") {
              seen.push(m.event.assistantMessageEvent?.delta || "");
            }
          } catch {}
        });
        await rpc(ws, { type: "rpc_command", command: { type: "prompt", message: "Reply with exactly: HEADLESS-OK" } }, { timeout: 120000 });
        await waitFor(async () => (seen.join("").includes("HEADLESS-OK") ? true : null), {
          timeout: 120000, label: "HEADLESS-OK in stream",
        });
      } else {
        const texts = [];
        ws.on("message", (raw) => {
          try {
            const m = JSON.parse(String(raw));
            if (m.type === "rpc_event" && m.event?.type === "message_update") {
              texts.push(m.event.assistantMessageEvent?.delta || "");
            }
          } catch {}
        });
        await rpc(ws, { type: "rpc_command", command: { type: "prompt", message: "say HEADLESS-OK" } });
        await waitFor(async () => (texts.join("").includes("HEADLESS-OK") ? true : null), {
          timeout: 10000, label: "HEADLESS-OK echo",
        });
      }
    } finally {
      try { ws.close(); } catch {}
    }
  } finally {
    await hub.close();
  }
}
