// D1 — uplink relay over raw WS: stale mirror frames stay dead (no answer,
// ADR-011); uplink_list acks, uplink_attach answers uplink_attached,
// uplink_detach answers uplink_detached; unknown commands are rejected.
// The socket stays usable throughout.
import { WebSocket } from "ws";
import { startHubStub } from "../hub-stub.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const id = "D1";
export const title = "uplink relay frames answered, dead frames silent";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  const ws = new WebSocket(`${hub.url.replace("http", "ws")}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const frames = [];
    ws.on("message", (raw) => {
      try { frames.push(JSON.parse(String(raw))); } catch {}
    });
    // Stale mirror frames: no answer expected for any of these.
    for (const [i, type] of ["mirror_sync", "session_switch", "mirror_sync_request", "session_switch_request"].entries()) {
      ws.send(JSON.stringify({ type, id: `d1-dead-${i}` }));
    }
    // Live relay: list acks, attach/detach answer, unknown rejected.
    ws.send(JSON.stringify({ type: "uplink_list", id: "d1-list" }));
    ws.send(JSON.stringify({ type: "uplink_attach", port: 18777, pid: 42421, id: "d1-attach" }));
    ws.send(JSON.stringify({ type: "frobnicate", id: "d1-frob" }));
    await new Promise((r) => setTimeout(r, 1500));
    assert(!frames.some((f) => ["mirror_sync", "session_switch", "mirror_sync_request", "session_switch_request"].includes(f?.event?.command)),
      `dead frame answered: ${JSON.stringify(frames).slice(0, 300)}`);
    const list = frames.find((f) => f?.event?.command === "uplink_list");
    assert(list?.event?.success === true && Array.isArray(list.event.data?.instances),
      `uplink_list not acked: ${JSON.stringify(frames).slice(0, 400)}`);
    assert(frames.some((f) => f.type === "uplink_attached" && f.port === 18777),
      `uplink_attached missing: ${JSON.stringify(frames).slice(0, 400)}`);
    const rej = frames.find((f) => f?.event?.command === "frobnicate");
    assert(rej?.event?.success === false && /Unknown command: frobnicate/.test(rej.event.error || ""),
      `frobnicate not rejected: ${JSON.stringify(frames).slice(0, 300)}`);

    // Detach answers; socket still alive.
    ws.send(JSON.stringify({ type: "uplink_detach", id: "d1-detach" }));
    await new Promise((r) => setTimeout(r, 1000));
    assert(frames.some((f) => f.type === "uplink_detached"), "uplink_detached missing");
    ws.send(JSON.stringify({ type: "ping" }));
    await new Promise((r) => setTimeout(r, 1000));
    assert(frames.some((f) => f.type === "pong"), "socket died");
  } finally {
    try { ws.close(); } catch {}
    await hub.close();
  }
}
