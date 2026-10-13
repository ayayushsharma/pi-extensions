// Layer A — hub-shaped static server. Serves public/ like the hub does
// (GET / → 302 /hub/, /hub/ shell is the only entry) with NO WS backend:
// any Upgrade to /ws is refused so the client hits its disconnected path.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function startStaticServer({ port, staticDir }) {
  const server = http.createServer((req, res) => {
    let urlPath = (req.url || "/").split("?")[0];
    if (urlPath === "/" || urlPath === "/index.html") {
      res.writeHead(302, { Location: "/hub/" });
      res.end();
      return;
    }
    if (urlPath === "/hub" || urlPath === "/hub/") urlPath = "/hub/index.html";
    // Minimal API surface so the shell boots without pageerrors on Layer A.
    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "hub", authEnabled: false, version: "e2e-static" }));
      return;
    }
    if (urlPath === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }
    if (urlPath.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found (layer A static)" }));
      return;
    }
    const filePath = path.join(staticDir, urlPath);
    if (!filePath.startsWith(staticDir)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
  });
  // Refuse WS upgrades: the disconnected layer must fail fast, never hang.
  server.on("upgrade", (req, sock) => {
    try {
      sock.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } catch {}
    try { sock.destroy(); } catch {}
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => server.close(() => r(true))),
    }));
  });
}
