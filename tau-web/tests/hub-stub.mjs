// CI hub stub — implements the hub HTTP/WS contracts (testing.md §§3–4,
// ADR-014) without a pi process, so P0 runs anywhere. A real hub is used
// instead when TEST_REAL_HUB=1 (see hub-real.mjs).
//
// Covered: health, /→302, static, login/logout + 401, /api/rpc frame
// contract (binding cmds rejected over HTTP like the real hub; unknown
// commands answered `Unknown command` like the real hub), /api/instances
// (one fake live TUI, ADR-014), traversal guards, Host/Origin rebinding
// check, WS router (new/start/rpc/ping/uplink/unknown; stale mirror frames
// stay dead).
//
// The fake live TUI is relay-shaped, not a real pi: uplink_attach is
// answered with uplink_attached, uplink_detach with uplink_detached, and
// uplink_command acks success. No hub.sock listener — the stub answers
// the relay protocol directly. drive=1 pins and the Drive/preview/banner
// flow work against it (H8/H9/D1).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// ADR-011 dead contract (ADR-014 keeps it): stale mirror frames stay dead —
// no answer, and the socket must not hang. Uplink verbs are live (see the
// WS router below), never in this set.
const DEAD_FRAMES = new Set([
  "mirror_sync", "session_switch", "mirror_sync_request", "session_switch_request",
]);

// One fake live TUI for the attach relay. Shaped like a real /api/instances
// row (port/pid/sessionFile/cwd/local/startedAt); the port is TEST-LOCAL,
// nothing listens on it — attach never dials, it just completes the relay.
const FAKE_LIVE = {
  port: 18777, pid: 42421,
  sessionFile: "/tmp/e2e-live/019d8010-0000-4000-8000-000000000000.jsonl",
  cwd: "/tmp/e2e-live", local: false, startedAt: new Date().toISOString(),
};

function hostnameOf(header) {
  if (!header) return "";
  const h = String(header).trim().toLowerCase();
  const m = h.match(/^\[([^\]]+)\](?::\d+)?$/) || h.match(/^([^:]+)(?::\d+)?$/);
  return m ? m[1] : h;
}
function isAllowedHostName(hostname, bindHost) {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return true;
  if (hostname.endsWith(".ts.net")) return true;
  return !!bindHost && bindHost === hostname;
}

export function startHubStub({ port, staticDir, auth = null, version = "e2e-stub", processes = [] }) {
  const authEnabled = !!(auth && auth.user && auth.pass);
  const tokens = new Set();
  const startedAt = new Date().toISOString();

  function parseCookie(req) {
    try {
      for (const part of String(req.headers.cookie || "").split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (k === "tau_auth") return rest.join("=");
      }
    } catch {}
    return "";
  }
  function authed(req) {
    if (!authEnabled) return true;
    const t = parseCookie(req);
    if (t && tokens.has(t)) return true;
    const m = String(req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
    if (m) {
      try {
        const dec = Buffer.from(m[1], "base64").toString("utf8");
        const i = dec.indexOf(":");
        if (i >= 0 && timingEq(dec.slice(0, i), dec.slice(i + 1))) return true;
      } catch {}
    }
    return false;
  }
  function timingEq(u, p) {
    try {
      const a = Buffer.from(`${u}:${p}`);
      const b = Buffer.from(`${auth.user}:${auth.pass}`);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }
  function originOk(req) {
    if (process.env.TAU_ALLOW_ANY_HOST === "1") return true;
    const host = req.headers.host;
    if (!isAllowedHostName(hostnameOf(host), "127.0.0.1")) return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (hostnameOf(u.host) !== hostnameOf(host)) return false;
      } catch { return false; }
    }
    return true;
  }

  function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  }

  // ── HTTP ──
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || "/").split("?")[0];
    const isApi = urlPath.startsWith("/api/");
    const authExempt = urlPath === "/api/health" || urlPath === "/api/login" || urlPath === "/api/logout" || urlPath === "/api/client-error";

    if (req.url === "/api/client-error" && req.method === "POST") {
      req.resume();
      req.on("end", () => { res.writeHead(204); res.end(); });
      return;
    }
    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "hub", authEnabled, startedAt, version }));
      return;
    }
    if (isApi && !authExempt && !authed(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (isApi && !authExempt && !originOk(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    if (urlPath === "/api/login" && req.method === "POST") {
      if (!authEnabled) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, authRequired: false }));
        return;
      }
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        let u = "", p = "";
        try { const j = JSON.parse(body); u = String(j.user || "").trim(); p = String(j.pass || ""); } catch {}
        if (u && timingEq(u, p)) {
          const t = crypto.randomBytes(32).toString("hex");
          tokens.add(t);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `tau_auth=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid username or password" }));
        }
      });
      return;
    }
    if (urlPath === "/api/logout" && req.method === "POST") {
      const t = parseCookie(req);
      if (t) tokens.delete(t);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "tau_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (urlPath === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }
    // ADR-013: table-backed process list + kill with the real hub's
    // validation semantics (400 bad/self pid, 404 stale pid).
    if (urlPath === "/api/processes" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ processes, unsupported: false }));
      return;
    }
    if (urlPath === "/api/processes/kill" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const { pid } = JSON.parse(body);
          if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: pid === process.pid ? "refusing to kill the hub itself" : "pid must be a positive integer" }));
            return;
          }
          const i = processes.findIndex((p) => p.pid === pid);
          if (i < 0) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `no live pi process with pid ${pid}` }));
            return;
          }
          const [row] = processes.splice(i, 1);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, pid, owner: row.owner || "live", signal: "SIGTERM", exited: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (urlPath === "/api/instances" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ instances: [FAKE_LIVE] }));
      return;
    }
    if (urlPath === "/api/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const command = JSON.parse(body);
          const wsOnly = ["start_session", "new_session", "close_session", "list_sessions",
            "detach_session", "rpc_command", "extension_ui_response", "ping",
            "uplink_list", "uplink_attach", "uplink_detach", "uplink_command"];
          if (command && wsOnly.includes(command.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: `${command.type} requires a WebSocket connection`, id: command.id }));
            return;
          }
          if (command && DEAD_FRAMES.has(command.type)) {
            // Stale mirror frames: rejected as unknown (over HTTP there is
            // no socket to keep silent on — the answer is the rejection).
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ type: "response", command: command.type, success: false, error: `Unknown command: ${command.type}`, id: command.id }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "response", command: command?.type || "unknown", success: true, data: {}, id: command?.id }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    // Traversal-guarded stubs: only bare .jsonl basenames, `..` rejected.
    const trav = (v) => typeof v === "string" && (v.includes("..") || v.includes("/") || v.includes("\\"));
    if ((urlPath === "/api/sessions/rename" || urlPath === "/api/sessions/delete" ||
         urlPath === "/api/sessions/export" || urlPath === "/api/sessions/download") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const j = JSON.parse(body);
          const v = j.filePath || j.file || j.sessionFile || "";
          if (trav(v) || (v && !String(v).endsWith(".jsonl"))) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "rejected" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (isApi) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (urlPath === "/" || urlPath === "/index.html") {
      res.writeHead(302, { Location: "/hub/" });
      res.end();
      return;
    }
    let file = urlPath;
    if (file === "/hub" || file === "/hub/") file = "/hub/index.html";
    if (file === "/") file = "/index.html";
    const filePath = path.join(staticDir, file);
    if (!filePath.startsWith(staticDir)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  // ── WS ──
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const p = (req.url || "").split("?")[0];
    if (p !== "/ws") { try { sock.destroy(); } catch {} return; }
    if (authEnabled && !authed(req)) {
      try { sock.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
      try { sock.destroy(); } catch {}
      return;
    }
    if (!originOk(req)) {
      try { sock.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
      try { sock.destroy(); } catch {}
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    // Identity frame like the real hub: marks this socket hub-mode so the
    // client offers cross-session drive (serverMode === 'hub').
    send(ws, { type: "state", mode: "hub", isStreaming: false });
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const id = msg.id;
      const ack = (command, data) => send(ws, {
        type: "rpc_event", id,
        event: { type: "response", id, command, success: true, data: data || {} },
      });
      const unknown = (command) => send(ws, {
        type: "rpc_event", id,
        event: { type: "response", id, command, success: false, error: `Unknown command: ${command}` },
      });
      switch (msg.type) {
        case "ping": send(ws, { type: "pong" }); return;
        case "new_session":
          ack("new_session", { sessionKey: `stub-${Date.now().toString(36)}`, cwd: msg.cwd || "/tmp/e2e" });
          return;
        case "start_session":
          ack("start_session", { sessionKey: `stub-${Date.now().toString(36)}`, cwd: msg.cwd || "/tmp/e2e" });
          if (msg.sessionFile) {
            setTimeout(() => send(ws, { type: "session_file", sessionFile: msg.sessionFile, cwd: msg.cwd || "/tmp/e2e" }), 50);
          }
          return;
        case "rpc_command": {
          // Simulated headless round-trip: prompt echoes HEADLESS-OK.
          const inner = msg.command || {};
          if (inner.type === "prompt" && typeof inner.message === "string" && inner.message.includes("HEADLESS-OK")) {
            send(ws, { type: "rpc_event", event: { type: "message_start", message: { role: "assistant" } } });
            send(ws, {
              type: "rpc_event",
              event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "HEADLESS-OK" } },
            });
            send(ws, { type: "rpc_event", event: { type: "message_end", message: { role: "assistant", content: "HEADLESS-OK" } } });
          }
          if (id) ack(inner.type || "rpc_command", {});
          return;
        }
        case "detach_session":
        case "close_session":
        case "list_sessions":
          ack(msg.type, msg.type === "list_sessions" ? { sessions: [] } : {});
          return;
        case "uplink_list":
          ack("uplink_list", { instances: [FAKE_LIVE] });
          return;
        case "uplink_attach": {
          const row = msg.port === FAKE_LIVE.port ? FAKE_LIVE : null;
          send(ws, {
            type: "uplink_attached",
            port: msg.port, pid: msg.pid,
            sessionFile: (row && row.sessionFile) || msg.sessionFile || null,
          });
          return;
        }
        case "uplink_detach":
          send(ws, { type: "uplink_detached" });
          return;
        case "uplink_command":
          // Relay ack (covers pollAttachedState get_state and routed
          // prompts): success with no payload, id-correlated.
          if (id) ack("uplink_command", {});
          return;
        default:
          // Dead contract: stale mirror frames stay dead — no answer, and
          // the socket must not hang.
          if (DEAD_FRAMES.has(msg.type)) return;
          if (id) unknown(msg.type);
          else send(ws, { type: "rpc_event", event: { type: "response", id, command: msg.type, success: false, error: `Unknown command: ${msg.type}` } });
          return;
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => {
        try { wss.close(); } catch {}
        server.close(() => r(true));
      }),
    }));
  });
}
