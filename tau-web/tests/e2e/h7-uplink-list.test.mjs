// H7 — uplink relay contract: `uplink_list` acks over WS with instances,
// /api/instances lists the live TUI, and uplink verbs require WS over HTTP
// (400, like the real hub — ADR-014).
import { WebSocket } from "ws";
import { startHubStub } from "../hub-stub.mjs";
import { assert, assertPortFree, basePort, fetchJson, PUBLIC_DIR } from "../helpers.mjs";

export const id = "H7";
export const title = "uplink relay contract: list/instances live, WS-only over HTTP";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  try {
    // /api/instances: the live TUI row.
    const { res: ires, json: ij } = await fetchJson(`${hub.url}/api/instances`);
    assert(ires.status === 200, `/api/instances: ${ires.status}, want 200`);
    assert(Array.isArray(ij?.instances) && ij.instances.length > 0, `no instances: ${JSON.stringify(ij)}`);
    const row = ij.instances[0];
    assert(Number.isInteger(row.port) && Number.isInteger(row.pid) && row.sessionFile,
      `row shape: ${JSON.stringify(row)}`);

    // Uplink verbs over HTTP require a WebSocket, like the real hub.
    const { res: rres, json: rj } = await fetchJson(`${hub.url}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "uplink_list", id: "h7" }),
    });
    assert(rres.status === 400, `uplink_list HTTP status: ${rres.status}, want 400`);
    assert(/requires a WebSocket/.test(rj?.error || ""), `wrong error: ${JSON.stringify(rj)}`);

    // Over WS, uplink_list acks with the same instances.
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
      ws.send(JSON.stringify({ type: "uplink_list", id: "h7-ws" }));
      await new Promise((r) => setTimeout(r, 1500));
      const ack = frames.find((f) => f?.event?.command === "uplink_list");
      assert(ack?.event?.success === true, `no ack: ${JSON.stringify(frames).slice(0, 400)}`);
      assert(Array.isArray(ack.event.data?.instances) && ack.event.data.instances.length > 0,
        `no instances in ack: ${JSON.stringify(ack).slice(0, 300)}`);
    } finally {
      try { ws.close(); } catch {}
    }
  } finally {
    await hub.close();
  }
}
