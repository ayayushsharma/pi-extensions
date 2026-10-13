// P2 guards — traversal, rebinding, dead-protocol silence (testing.md §7 P2).
// Fast, no browser needed except where noted.
import net from "node:net";
import { WebSocket } from "ws";
import { startHubStub } from "../hub-stub.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR } from "../helpers.mjs";

export const id = "P2";
export const title = "hardening: traversal, rebinding, dead WS contract";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR });
  try {
    // Traversal: `..` in rename/export/download → rejected.
    for (const route of ["rename", "delete", "export", "download"]) {
      const r = await fetch(`${hub.url}/api/sessions/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "../../etc/passwd.jsonl" }),
      });
      assert(r.status === 403, `${route} traversal: ${r.status}, want 403`);
    }

    // Rebinding: wrong Host → rejected on /api/*. fetch forbids setting
    // Host, so speak raw HTTP over TCP to control the header exactly.
    async function rawStatus(hostHeader, origin) {
      const status = await new Promise((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1");
        let buf = "";
        sock.on("connect", () => {
          sock.write(
            `GET /api/sessions HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n` +
            (origin ? `Origin: ${origin}\r\n` : "") + `\r\n`,
          );
        });
        sock.on("data", (c) => { buf += c.toString(); });
        sock.on("close", () => {
          const m = buf.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
          resolve(m ? Number(m[1]) : -1);
        });
        sock.on("error", reject);
        setTimeout(() => { try { sock.destroy(); } catch {} resolve(-1); }, 5000);
      });
      return status;
    }
    const badHost = await rawStatus("evil.example.com");
    assert(badHost === 403, `bad Host: ${badHost}, want 403`);
    // Wrong Origin → rejected.
    const badOrigin = await rawStatus(`127.0.0.1:${port}`, "http://evil.example.com");
    assert(badOrigin === 403, `bad Origin: ${badOrigin}, want 403`);
    // Dev bypass exists but is opt-in.
    process.env.TAU_ALLOW_ANY_HOST = "1";
    try {
      const bypass = await rawStatus("evil.example.com");
      assert(bypass === 200, `TAU_ALLOW_ANY_HOST bypass broken: ${bypass}`);
    } finally {
      delete process.env.TAU_ALLOW_ANY_HOST;
    }

    // Dead protocol (ADR-011): stale top-level mirror_sync / session_switch /
    // mirror_sync_request get no answer and must not hang the socket.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => {
      ws.on("open", res);
      ws.on("error", rej);
      setTimeout(() => rej(new Error("ws timeout")), 8000);
    });
    try {
      const answered = [];
      ws.on("message", (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (m.type === "response") answered.push(m);
        } catch {}
      });
      for (const t of ["mirror_sync", "session_switch", "mirror_sync_request", "session_switch_request"]) {
        ws.send(JSON.stringify({ type: t, id: `dead-${t}` }));
      }
      // Ordinary traffic still works on the same socket (not hung).
      const pong = await new Promise((resolve) => {
        ws.once("message", (raw) => {
          try { if (JSON.parse(String(raw)).type === "pong") resolve(true); } catch {}
        });
        ws.send(JSON.stringify({ type: "ping" }));
        setTimeout(() => resolve(false), 3000);
      });
      assert(pong === true, "socket hung after dead-protocol frames");
      await new Promise((r) => setTimeout(r, 500));
      const deadAnswers = answered.filter((m) => String(m.id || "").startsWith("dead-"));
      assert(deadAnswers.length === 0, `dead contract answered: ${JSON.stringify(deadAnswers)}`);
    } finally {
      ws.close();
    }
  } finally {
    await hub.close();
  }
}
