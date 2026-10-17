// Layer B — static + fake WS backend speaking the WS contract (§4).
// Modes:
//   default   ack new_session {backendKey, cwd}, NO session_file → UI stays put.
//   late-file ack + delayed session_file → #session=<base> pin + New session tab.
//   no-ack    answer nothing → client 15s timeout message.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function serveFile(staticDir, urlPath, res) {
  if (urlPath === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", mode: "hub", authEnabled: false, version: "e2e-fake" }));
    return;
  }
  if (urlPath === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects: [] }));
    return;
  }
  if (urlPath.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found (fake backend)" }));
    return;
  }
  const filePath = path.join(staticDir, urlPath);
  if (!filePath.startsWith(staticDir)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

export function startFakeBackend({ port, staticDir, mode = "default" }) {
  const server = http.createServer((req, res) => {
    let urlPath = (req.url || "/").split("?")[0];
    if (urlPath === "/" || urlPath === "/index.html") {
      res.writeHead(302, { Location: "/hub/" });
      res.end();
      return;
    }
    if (urlPath === "/hub" || urlPath === "/hub/") urlPath = "/hub/index.html";
    serveFile(staticDir, urlPath, res);
  });
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const id = msg.id;
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
      if (msg.type === "new_session") {
        if (mode === "no-ack") return; // client must surface the exact timeout
        const ack = {
          type: "rpc_event",
          id,
          event: {
            type: "response", id, command: "new_session", success: true,
            data: { backendKey: `fake-${Date.now().toString(36)}`, cwd: msg.cwd || "/tmp/e2e" },
          },
        };
        ws.send(JSON.stringify(ack));
        if (mode === "late-file") {
          const base = `fresh-${Date.now().toString(36)}.jsonl`;
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({
                type: "session_file",
                sessionFile: `/tmp/e2e-sessions/${base}`,
                cwd: msg.cwd || "/tmp/e2e",
              }));
            } catch {}
          }, 300);
        }
        return;
      }
      // Generic rule (§4): ack any other {id} message with an empty success.
      if (id) {
        ws.send(JSON.stringify({
          type: "rpc_event", id,
          event: { type: "response", id, command: msg.type, success: true, data: {} },
        }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${port}`,
      mode,
      close: () => new Promise((r) => { try { wss.close(); } catch {} server.close(() => r(true)); }),
    }));
  });
}
