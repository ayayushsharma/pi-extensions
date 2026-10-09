/**
 * Mirror Server Extension
 * 
 * Starts a WebSocket + HTTP server inside the running Pi process,
 * allowing a browser to connect and mirror the TUI session in real-time.
 * 
 * - Forwards all Pi events to connected browser clients
 * - Accepts commands from the browser and executes them via the extension API
 * - Serves static files for the Tau web UI
 * - Sends full state snapshot on client connect (messages, model, etc.)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import { HeadlessRegistry } from "./headless-bridge.js";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import QRCode from "qrcode";

// Load tau settings from ~/.pi/agent/settings.json (falls back to env vars)
function loadTauSettings(): { port: number; host: string; autoStart: boolean; user: string; pass: string; authEnabled?: boolean; projectsDir?: string } {
  let settings: any = {};
  try {
    const settingsPath = path.join(process.env.HOME || "~", ".pi/agent/settings.json");
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).tau || {};
  } catch {}
  // tau-web defaults: 127.0.0.1:8192 (Termux-safe). Env overrides, PI_WEB_* aliases kept for pi-web compat.
  const portRaw = process.env.TAU_MIRROR_PORT || process.env.PI_WEB_PORT || settings.port || "8192";
  const hostRaw = process.env.TAU_HOST || process.env.PI_WEB_HOST || settings.host || "127.0.0.1";
  return {
    port: parseInt(portRaw, 10) || 8192,
    host: hostRaw,
    autoStart: !(
      process.env.TAU_DISABLED === "1" || process.env.TAU_DISABLED === "true" ||
      settings.disabled === true
    ),
    user: process.env.TAU_USER || settings.user || "",
    pass: process.env.TAU_PASS || settings.pass || "",
    authEnabled: settings.authEnabled,
    projectsDir: process.env.TAU_PROJECTS_DIR || settings.projectsDir,
  };
}

const TAU_SETTINGS = loadTauSettings();
const PORT = TAU_SETTINGS.port;
const HOST = TAU_SETTINGS.host;
const TAU_AUTO_START = TAU_SETTINGS.autoStart;
const AUTH_USER = TAU_SETTINGS.user;
const AUTH_PASS = TAU_SETTINGS.pass;
const AUTH_CONFIGURED = !!(AUTH_USER && AUTH_PASS);
let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;
// ─── tau-web inline login: cookie sessions ───
// Browsers can't set headers on a WS handshake, so the login form mints an
// HttpOnly cookie session after verifying Basic credentials. Tokens live in
// memory only: a server restart invalidates them and the UI re-prompts.
const authTokens = new Set<string>();
const AUTH_COOKIE = "tau_auth";
let serverStartedAt = "";
let tauWebVersion = "0.1.0";
try { tauWebVersion = require("../package.json").version || tauWebVersion; } catch {}
function mintAuthToken(): string {
  try {
    const t = require("node:crypto").randomBytes(32).toString("hex");
    authTokens.add(t);
    if (authTokens.size > 200) { const first = authTokens.values().next().value; if (first) authTokens.delete(first); }
    return t;
  } catch { return ""; }
}
function parseAuthCookie(req: http.IncomingMessage): string {
  try {
    const header = req.headers.cookie || "";
    for (const part of header.split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === AUTH_COOKIE) return rest.join("=");
    }
  } catch {}
  return "";
}
// @ts-ignore — __dirname is provided by jiti at runtime
const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();

function findPublicDir(): string {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (dir: string) => {
      const normalized = path.resolve(dir);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    };

    // 1) Common extension-relative paths
    addCandidate(path.resolve(__dirname, "public"));
    addCandidate(path.resolve(__dirname, "../public"));

    // 2) Installed package path (for npm-installed extension execution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("tau-web/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkgPath = require.resolve("tau-mirror/package.json");
      addCandidate(path.join(path.dirname(pkgPath), "public"));
    } catch {}

    // 3) Development fallback from current working directory
    addCandidate(path.resolve(process.cwd(), "public"));
    addCandidate(path.resolve(process.cwd(), "node_modules/tau-mirror/public"));

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    }

    // Keep previous fallback behavior
    return path.resolve(process.cwd(), "public");
}
const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, ".pi", "agent");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, "sessions");
const INSTANCES_DIR = path.join(USER_HOME, ".pi", "tau-instances");

// ─── File logger ───
// Never write to stdout/stderr: Pi's fullscreen TUI owns the terminal
// (especially visible inside tmux, where stray output covers the prompt).
// User-visible messages go via ctx.ui.notify()/setStatus(); everything
// else goes to a log file. Set TAU_DEBUG=1 for verbose logging.
const LOG_FILE = process.env.TAU_LOG_FILE || path.join(USER_HOME, ".pi", "tau", "tau.log");
const TAU_DEBUG = process.env.TAU_DEBUG === "1" || process.env.TAU_DEBUG === "true";
function tauLog(...args: any[]) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}
function tauDebug(...args: any[]) {
  if (TAU_DEBUG) tauLog(...args);
}

// Tau's own slash commands — never exposed to remote web clients.
const MIRROR_OWN_COMMANDS = new Set(["tau", "taustart", "taustop", "qr"]);

// Instance registry — tracks all running Tau servers
function registerInstance(port: number, sessionFile: string, cwd: string) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const info = { port, pid: process.pid, sessionFile, cwd, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(INSTANCES_DIR, `${process.pid}.json`), JSON.stringify(info));
}

function updateInstanceSession(sessionFile: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.sessionFile = sessionFile;
    fs.writeFileSync(file, JSON.stringify(info));
  } catch {}
}

function unregisterInstance() {
  try { fs.unlinkSync(path.join(INSTANCES_DIR, `${process.pid}.json`)); } catch {}
}

function getRunningInstances(): Array<{ port: number; pid: number; sessionFile: string; cwd: string }> {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: any[] = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Check if process is still alive
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
  return instances;
}

/**
 * Kill zombie Tau instances — processes that are alive but orphaned
 * (e.g. tmux pane was killed without session_shutdown firing).
 * A zombie is detected by checking if the process has a controlling terminal.
 * If it doesn't, the HTTP server is the only thing keeping it alive.
 */
function cleanupZombieInstances() {
  if (process.platform === "win32") return;
  if (!fs.existsSync(INSTANCES_DIR)) return;
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Skip our own process
      if (info.pid === process.pid) continue;
      // Check if process is alive
      try {
        process.kill(info.pid, 0);
      } catch {
        // Already dead — clean up
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
        continue;
      }
      // Use shared zombie detection
      if (isZombieProcess(info.pid)) {
        tauLog(`[Mirror] Killing zombie Tau instance (PID ${info.pid}, port ${info.port})`);
        process.kill(info.pid, "SIGTERM");
        try { fs.unlinkSync(path.join(INSTANCES_DIR, file)); } catch {}
      }
    } catch {}
  }
}

function isZombieProcess(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    const { execSync } = require("node:child_process");
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: "utf8" }).trim();
    return !tty || tty === "??" || tty === "-";
  } catch {
    return true;
  }
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function saveTauSetting(key: string, value: any) {
  const settingsPath = path.join(process.env.HOME || "~", ".pi/agent/settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function checkBasicCredentials(header: string | undefined): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon === -1) return false;
    return decoded.slice(0, colon) === AUTH_USER && decoded.slice(colon + 1) === AUTH_PASS;
  } catch { return false; }
}
function checkBasicAuth(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  if (checkBasicCredentials(req.headers.authorization)) return true;
  // Inline-login cookie session (minted by POST /api/login, memory-only).
  const token = parseAuthCookie(req);
  return !!token && authTokens.has(token);
}

function sendAuthRequired(res: http.ServerResponse) {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Tau"',
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  // ─── tau-web unified: headless backends + uplink proxy + web dialogs ───
  const headless = new HeadlessRegistry({
    onEvent: (managed, event) => {
      // Forward headless events in pi-web envelope so one UI speaks both dialects.
      for (const client of managed.clients) {
        sendTo(client, { type: "rpc_event", event });
      }
      // extension_ui_request from `pi --mode rpc` children arrives here: surface it
      // as a first-class dialog event too (failures never silent, ADR-007).
      if (event && event.type === "extension_ui_request") {
        pendingDialogs.set(event.id, { kind: "headless", managed });
        for (const client of managed.clients) {
          sendTo(client, { type: "event", event });
        }
      }
    },
    onError: (managed, message) => {
      for (const client of managed.clients) {
        sendTo(client, { type: "error", message });
      }
      tauLog(`[tau-web] headless error (${managed.cwd}):`, message);
    },
    onExit: (managed, code) => {
      for (const client of managed.clients) {
        sendTo(client, { type: "session_ended", code });
      }
    },
    log: tauLog,
  });
  // uplink: browserWs -> { upstream: WebSocket, port, pid, failures, dead }
  const uplinks = new Map<WebSocket, { upstream: WebSocket; port: number; pid: number; failures: number; dead: boolean }>();
  // pending dialogs: requestId -> { kind: 'mirror' } | { kind: 'headless', managed }
  const pendingDialogs = new Map<string, { kind: "mirror" } | { kind: "headless"; managed: any }>();
  // Wrap ctx.ui dialogs so the browser owns them when connected (full web dialogs, ADR-007).
  // No two-drivers: when browser clients exist, TUI shows a notice instead of a second prompt.
  const wrappedCtx = new WeakSet<object>();
  function wrapUiDialogs(ctx: ExtensionContext) {
    const ui: any = (ctx as any).ui;
    if (!ui || wrappedCtx.has(ui)) return;
    wrappedCtx.add(ui);
    const orig: Record<string, any> = {
      select: ui.select?.bind(ui),
      confirm: ui.confirm?.bind(ui),
      input: ui.input?.bind(ui),
      editor: ui.editor?.bind(ui),
    };
    const awaitBrowser = (method: string, payload: any): Promise<any> | null => {
      if (clients.size === 0) return null;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const request = { type: "extension_ui_request", id, method, ...payload };
      pendingDialogs.set(id, { kind: "mirror" });
      broadcast({ type: "event", event: request });
      try { ctx.ui.notify(`Dialog open in browser (${method}) — answer there.`, "info"); } catch {}
      return new Promise((resolve) => {
        const poll = () => {
          // Browser vanished mid-dialog: release the TUI back to its native prompt.
          if (clients.size === 0) { pendingDialogs.delete(id); resolve(undefined); return; }
          const entry = (pendingDialogs as any).responses?.get?.(id);
          if (entry !== undefined) {
            (pendingDialogs as any).responses.delete(id);
            pendingDialogs.delete(id);
            resolve(entry);
          } else if (!pendingDialogs.has(id)) {
            resolve(undefined); // cancelled elsewhere
          } else {
            setTimeout(poll, 50);
          }
        };
        poll();
      });
    };
    if (orig.select) ui.select = async (...args: any[]) => {
      const p = awaitBrowser("select", { title: args[0], options: args[1], timeout: args[2]?.timeout });
      if (p) { const r: any = await p; if (r?.cancelled) return undefined; return r?.value; }
      return orig.select(...args);
    };
    if (orig.confirm) ui.confirm = async (...args: any[]) => {
      const p = awaitBrowser("confirm", { title: args[0], message: args[1], timeout: args[2]?.timeout });
      if (p) { const r: any = await p; if (r?.cancelled) return false; return !!r?.confirmed; }
      return orig.confirm(...args);
    };
    if (orig.input) ui.input = async (...args: any[]) => {
      const p = awaitBrowser("input", { title: args[0], placeholder: args[1], timeout: args[2]?.timeout });
      if (p) { const r: any = await p; if (r?.cancelled) return undefined; return r?.value; }
      return orig.input(...args);
    };
    if (orig.editor) ui.editor = async (...args: any[]) => {
      const p = awaitBrowser("editor", { title: args[0], prefill: args[1], timeout: args[2]?.timeout });
      if (p) { const r: any = await p; if (r?.cancelled) return undefined; return r?.value; }
      return orig.editor(...args);
    };
    (pendingDialogs as any).responses = (pendingDialogs as any).responses || new Map<string, any>();
  }
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const clients = new Set<WebSocket>();

  // Store latest context reference for use in command handlers
  let latestCtx: ExtensionContext | null = null;

  // Pending RPC-style requests from browser (id -> resolver)
  const pendingRequests = new Map<string, (response: any) => void>();

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function sendTo(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: any) {
    const json = JSON.stringify(data);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  }

  let mirrorUrl = "";
  let tailscaleUrl = "";

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  function stopServer() {
    try { headless.shutdownAll(); } catch {}
    for (const [bw, e] of uplinks) { try { (e as any).dead = true; e.upstream.close(); } catch {} }
    uplinks.clear();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (wss) {
      for (const client of clients) {
        client.close();
      }
      clients.clear();
      wss.close();
      wss = null;
    }
    if (server) {
      server.close();
      server = null;
    }
    unregisterInstance();
    mirrorUrl = "";
    tailscaleUrl = "";
  }

  // ═══════════════════════════════════════
  // /tau-stop and /tau-start commands
  // ═══════════════════════════════════════
  pi.registerCommand("taustop", {
    description: "Stop the Tau mirror server",
    handler: async (_args, ctx) => {
      if (!server) {
        ctx.ui.notify("Tau is not running", "warning");
        return;
      }
      stopServer();
      ctx.ui.setStatus("mirror", "");
      ctx.ui.notify("Tau mirror server stopped", "info");
      tauLog("[Mirror] Server stopped via /taustop");
    },
  });

  pi.registerCommand("taustart", {
    description: "Start the Tau mirror server",
    handler: async (_args, ctx) => {
      if (server) {
        ctx.ui.notify(`Tau is already running at ${mirrorUrl}`, "warning");
        return;
      }
      startServer(ctx);
      ctx.ui.notify("Tau mirror server starting...", "info");
    },
  });

  // ═══════════════════════════════════════
  // /qr command — show QR code to connect
  // ═══════════════════════════════════════
  pi.registerCommand("tau", {
    description: "Open Tau web UI in browser",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const { exec } = require("node:child_process");
      exec(`open "${mirrorUrl}"`);
      ctx.ui.notify(`Opened ${mirrorUrl}`, "info");
    },
  });

  pi.registerCommand("qr", {
    description: "Show QR code for Tau mirror URL",
    handler: async (_args, ctx) => {
      if (!mirrorUrl) {
        ctx.ui.notify("Mirror server not running yet", "warning");
        return;
      }
      const qrPageUrl = `${mirrorUrl}/api/qr`;
      ctx.ui.notify(`Tau: ${mirrorUrl}  •  QR: ${qrPageUrl}`, "info");
      // Open in default browser
      const { exec } = require("node:child_process");
      exec(`open "${qrPageUrl}"`);
    },
  });

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "session_before_compact", "session_compact", "session_compact_failed",
    "auto_retry_start", "auto_retry_end",
    "model_select",
  ] as const;

  // Pi's extension-level compaction events arrive as session_before_compact /
  // session_compact / session_compact_failed; the web client renders the
  // normalized compaction_start / compaction_end pair. (The old
  // "auto_compaction_*" names are not pi events and never fired, which is why
  // a compacting TUI looked stuck in the browser.)
  function normalizeForwardedEvent(eventType: string, event: any): any {
    if (eventType === "session_before_compact") {
      return { type: "compaction_start", reason: event?.reason, willRetry: event?.willRetry };
    }
    if (eventType === "session_compact") {
      return {
        type: "compaction_end",
        reason: event?.reason,
        aborted: false,
        willRetry: event?.willRetry,
        summary: event?.compactionEntry?.summary,
        tokensBefore: event?.compactionEntry?.tokensBefore,
      };
    }
    if (eventType === "session_compact_failed") {
      return {
        type: "compaction_end",
        reason: event?.reason,
        aborted: event?.aborted,
        willRetry: event?.willRetry,
        errorMessage: event?.errorMessage,
      };
    }
    return { type: eventType, ...event };
  }

  for (const eventType of eventTypes) {
    pi.on(eventType as any, async (event: any, ctx: ExtensionContext) => {
      latestCtx = ctx;

      // Forward event to all connected browser clients
      // Wrap in { type: "event", event: ... } to match the existing frontend protocol
      broadcast({ type: "event", event: normalizeForwardedEvent(eventType, event) });
    });
  }

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
  });

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: any) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    const sessionName = pi.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      pi.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({ type: "event", event: { type: "session_name", name: title } });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find(m => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, "")
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = title.substring(0, spaceIdx > 20 ? spaceIdx : 57) + "…";
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    // Get session entries for message history
    const entries = ctx.sessionManager.getEntries();

    // Get model info
    const model = ctx.model;
    const thinkingLevel = pi.getThinkingLevel();
    const sessionName = pi.getSessionName();
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      sessionName,
      sessionFile,
      isStreaming: !ctx.isIdle(),
      contextUsage,
    };
  }

  // ═══════════════════════════════════════
  // tau-web: session path resolution + uplink verification (L1, L6)
  // ═══════════════════════════════════════
  function cwdToSessionDir(cwd: string): string {
    const n = path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    return `--${n}--`;
  }
  function resolveHeadlessSessionPath(cwd: string, filename: string): string | null {
    if (!filename || filename.includes("/") || filename.includes("\\") || !filename.endsWith(".jsonl")) return null;
    const dir = path.join(SESSIONS_DIR, cwdToSessionDir(cwd));
    const abs = path.resolve(path.join(dir, filename));
    const root = path.resolve(SESSIONS_DIR);
    if (!(abs === root || abs.startsWith(root + path.sep))) return null;
    return abs;
  }
  function readTauCreds(): { user: string; pass: string } {
    // Re-read per connect (L6); never log or forward.
    try {
      const p = path.join(USER_HOME, ".pi", "agent", "settings.json");
      const s = JSON.parse(fs.readFileSync(p, "utf8")).tau || {};
      return { user: process.env.TAU_USER || s.user || "", pass: process.env.TAU_PASS || s.pass || "" };
    } catch { return { user: process.env.TAU_USER || "", pass: process.env.TAU_PASS || "" }; }
  }
  function verifyUplinkTarget(port: number, pid: number): { ok: boolean; error?: string } {
    // L1: fingerprint + proc check + loopback-only.
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "bad port" };
    // Never proxy our own process (self-loop) or its in-process ghost.
    if (pid === process.pid) return { ok: false, error: "cannot attach to own server process" };
    let info: any = null;
    try {
      const f = path.join(INSTANCES_DIR, `${pid}.json`);
      info = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch { return { ok: false, error: "unknown instance" }; }
    if (info.port !== port || info.pid !== pid) return { ok: false, error: "instance mismatch" };
    try { process.kill(pid, 0); } catch { return { ok: false, error: "process gone" }; }
    if (process.platform !== "win32") {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        if (!/pi/i.test(cmd)) return { ok: false, error: "not a pi process" };
      } catch { return { ok: false, error: "proc check failed" }; }
    }
    return { ok: true };
  }
  function uplinkHealth(port: number): Promise<any> {
    return new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 3000 }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => { try { req.destroy(); } catch {} resolve(null); });
    });
  }
  async function attachUplink(browserWs: WebSocket, port: number, pid: number) {
    const v = verifyUplinkTarget(port, pid);
    if (!v.ok) { sendTo(browserWs, { type: "error", message: `uplink rejected: ${v.error}` }); return; }
    const health: any = await uplinkHealth(port);
    // Fingerprint: must be a mirror. /api/health is auth-exempt; instances list is auth-gated.
    if (!health || health.mode !== "mirror") {
      sendTo(browserWs, { type: "error", message: "uplink rejected: bad fingerprint" });
      return;
    }
    detachUplink(browserWs);
    const creds = readTauCreds();
    const auth = creds.user ? `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString("base64")}` : undefined;
    const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: auth ? { Authorization: auth } : undefined } as any);
    const entry = { upstream, port, pid, failures: 0, dead: false, sawSync: false, syncTimer: null as any };
    uplinks.set(browserWs, entry);
    let opened = false;
    upstream.on("open", () => {
      opened = true;
      entry.failures = 0;
      sendTo(browserWs, { type: "uplink_attached", port, pid });
      // Mirror targets (tau) push an initial snapshot on connect. Only ask
      // explicitly if none arrives shortly — the second snapshot would make the
      // UI re-render the whole history twice back-to-back (visible flash).
      entry.syncTimer = setTimeout(() => {
        if (entry.dead || entry.sawSync) return;
        try { (upstream as any).send(JSON.stringify({ type: "mirror_sync_request" })); } catch {}
      }, 600);
    });
    upstream.on("message", (data) => {
      if (entry.dead) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "mirror_sync") {
          entry.sawSync = true;
          if (entry.syncTimer) { clearTimeout(entry.syncTimer); entry.syncTimer = null; }
        }
        if (msg.type === "event") {
          // Re-wrap to the unified envelope (ADR-004).
          sendTo(browserWs, { type: "rpc_event", event: msg.event, uplink: true, port });
          if (msg.event?.type === "extension_ui_request" && msg.event?.id) {
            pendingDialogs.set(msg.event.id, { kind: "mirror" });
            (pendingDialogs as any).responses = (pendingDialogs as any).responses || new Map();
            // Track which uplink owns it so the response routes back.
            (pendingDialogs as any).uplinkOwner = (pendingDialogs as any).uplinkOwner || new Map();
            (pendingDialogs as any).uplinkOwner.set(msg.event.id, entry);
          }
        } else if (msg.type === "mirror_sync" || msg.type === "response" || msg.type === "state") {
          sendTo(browserWs, { type: "rpc_event", event: msg, uplink: true, port });
        } else {
          sendTo(browserWs, { type: "rpc_event", event: msg, uplink: true, port });
        }
      } catch {}
    });
    const onDrop = () => {
      if (entry.dead) return;
      entry.failures++;
      if (entry.failures > 8) {
        entry.dead = true;
        try { upstream.close(); } catch {}
        uplinks.delete(browserWs);
        // Give up ~2 min equivalent → offer headless-continue on same file (L5).
        sendTo(browserWs, { type: "uplink_dead", port, pid, headlessContinue: true });
        return;
      }
      const delay = Math.min(15000, 500 * Math.pow(2, entry.failures));
      setTimeout(() => { if (!entry.dead && uplinks.get(browserWs) === entry && !opened) attachUplink(browserWs, port, pid); }, delay);
    };
    upstream.on("close", onDrop);
    upstream.on("error", () => {});
  }
  function detachUplink(browserWs: WebSocket) {
    const e = uplinks.get(browserWs);
    if (!e) return;
    e.dead = true;
    if (e.syncTimer) { clearTimeout(e.syncTimer); e.syncTimer = null; }
    try { e.upstream.close(); } catch {}
    uplinks.delete(browserWs);
  }
  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket, command: any) {
    // ─── tau-web unified protocol (headless + uplink + dialogs) ───
    if (command && typeof command.type === "string" && ["start_session", "detach_session", "rpc_command", "ping", "uplink_list", "uplink_attach", "uplink_detach", "uplink_command", "extension_ui_response"].includes(command.type)) {
      try {
        switch (command.type) {
          case "start_session": {
            const cwd = typeof command.cwd === "string" && command.cwd.trim() ? command.cwd : process.cwd();
            const file = typeof command.sessionFile === "string" && command.sessionFile ? command.sessionFile : null;
            const managed = headless.attach(ws, cwd, file);
            if (file) {
              const abs = resolveHeadlessSessionPath(managed.cwd, file);
              if (abs && fs.existsSync(abs)) headless.switchToFile(managed, abs);
            }
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "start_session", success: true, data: { sessionKey: managed.id } }, id: command.id });
            return;
          }
          case "detach_session": {
            headless.detach(ws);
            detachUplink(ws);
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "detach_session", success: true }, id: command.id });
            return;
          }
          case "rpc_command": {
            // Route to uplink when attached (live TUI owns the run), else headless.
            // Inject the browser's request id so the backend's response resolves
            // the browser's pending control command (set_model, cycle_thinking…).
            const inner = command.command && typeof command.command === "object"
              ? { ...command.command, id: command.id }
              : command.command;
            const up = uplinks.get(ws);
            if (up && !up.dead) {
              try { (up.upstream as any).send(JSON.stringify(inner)); } catch {}
              return;
            }
            const r = headless.command(ws, inner);
            if (!r.ok) sendTo(ws, { type: "error", message: r.error || "no active session" });
            return;
          }
          case "ping": { sendTo(ws, { type: "pong" }); return; }
          case "uplink_list": {
            const list = getRunningInstances().filter((i) => i.pid !== process.pid);
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "uplink_list", success: true, data: { instances: list } }, id: command.id });
            return;
          }
          case "uplink_attach": {
            await attachUplink(ws, Number(command.port), Number(command.pid));
            return;
          }
          case "uplink_detach": { detachUplink(ws); sendTo(ws, { type: "uplink_detached" }); return; }
          case "uplink_command": {
            const up = uplinks.get(ws);
            if (!up || up.dead) { sendTo(ws, { type: "error", message: "uplink not attached" }); return; }
            // Same id injection as rpc_command: the upstream stamps its response
            // with this id so the browser can match it to the pending command.
            const inner = command.command && typeof command.command === "object"
              ? { ...command.command, id: command.id }
              : command.command;
            try { (up.upstream as any).send(JSON.stringify(inner)); } catch {}
            return;
          }
          case "extension_ui_response": {
            const { id, ...rest } = command;
            const owner = (pendingDialogs as any).uplinkOwner?.get?.(id);
            if (owner && !owner.dead) {
              try { (owner.upstream as any).send(JSON.stringify({ type: "extension_ui_response", id, ...rest })); } catch {}
              (pendingDialogs as any).uplinkOwner.delete(id);
              pendingDialogs.delete(id);
              return;
            }
            const pend = id ? pendingDialogs.get(id) : undefined;
            if (pend?.kind === "headless" && (pend as any).managed) {
              try { (pend as any).managed.rpc.send({ type: "extension_ui_response", id, ...rest }); } catch {}
              pendingDialogs.delete(id);
              return;
            }
            // Mirror-owned dialog awaited via wrapUiDialogs poller.
            if (id) {
              (pendingDialogs as any).responses = (pendingDialogs as any).responses || new Map();
              (pendingDialogs as any).responses.set(id, rest && Object.keys(rest).length > 0 ? rest : { cancelled: true });
            }
            return;
          }
        }
      } catch (e: any) {
        sendTo(ws, { type: "error", message: e?.message || String(e) });
        return;
      }
    }
    const id = command.id;
    const ctx = latestCtx;

    const success = (cmd: string, data?: any) => {
      const resp: any = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    try {
      switch (command.type) {
        // ─── Prompting ───
        case "prompt": {
          // Messages starting with "/" are slash commands — expand them
          // server-side instead of sending the literal text to the model.
          const isSlashCmd = typeof command.message === "string"
            && command.message.trimStart().startsWith("/");
          if (ctx && !ctx.isIdle()) {
            const behavior = command.streamingBehavior || "steer";
            if (behavior === "steer") {
              pi.sendUserMessage(command.message, isSlashCmd ? { deliverAs: "steer", expandPromptTemplates: true } : { deliverAs: "steer" });
            } else {
              pi.sendUserMessage(command.message, isSlashCmd ? { deliverAs: "followUp", expandPromptTemplates: true } : { deliverAs: "followUp" });
            }
          } else {
            // Build content with optional images
            if (command.images?.length) {
              const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
              const content: any[] = [{ type: "text", text: command.message || "(see attached image)" }];
              for (const img of command.images) {
                if (!img.data || typeof img.data !== "string") {
                  tauLog("[mirror-server] Skipping image: missing or invalid data");
                  continue;
                }
                // Strip data URL prefix if accidentally included
                const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                const mimeType = (validMimes.includes(img.mimeType) ? img.mimeType : "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                tauDebug(`[mirror-server] Image: mimeType=${mimeType}, dataLen=${data.length}, rawMimeType=${img.mimeType}`);
                const imageBlock = {
                  type: "image" as const,
                  data: data,
                  mimeType: mimeType,
                };
                // Defensive: verify mimeType is actually set (debug crash where it was missing)
                if (!imageBlock.mimeType) {
                  tauLog(`[mirror-server] BUG: mimeType is falsy after assignment! img.mimeType=${img.mimeType}, falling back to image/png`);
                  imageBlock.mimeType = "image/png";
                }
                content.push(imageBlock);
              }
              // Only send content array if we actually have images, otherwise just text
              const hasImages = content.some((c: any) => c.type === "image");
              if (hasImages) {
                pi.sendUserMessage(content);
              } else if (isSlashCmd) {
                pi.sendUserMessage(command.message, { expandPromptTemplates: true });
              } else {
                pi.sendUserMessage(command.message);
              }
            } else if (isSlashCmd) {
              pi.sendUserMessage(command.message, { expandPromptTemplates: true });
            } else {
              pi.sendUserMessage(command.message);
            }
          }
          sendTo(ws, success("prompt"));
          break;
        }

        case "steer": {
          const msg = command.message;
          const slash = typeof msg === "string" && msg.trimStart().startsWith("/");
          pi.sendUserMessage(msg, slash ? { deliverAs: "steer", expandPromptTemplates: true } : { deliverAs: "steer" });
          sendTo(ws, success("steer"));
          break;
        }

        case "follow_up": {
          const msg = command.message;
          const slash = typeof msg === "string" && msg.trimStart().startsWith("/");
          pi.sendUserMessage(msg, slash ? { deliverAs: "followUp", expandPromptTemplates: true } : { deliverAs: "followUp" });
          sendTo(ws, success("follow_up"));
          break;
        }

        case "abort": {
          if (ctx) ctx.abort();
          sendTo(ws, success("abort"));
          break;
        }

        // ─── State ───
        case "get_commands": {
          try {
            // Hide Tau's own commands — running them remotely is risky or
            // pointless (e.g. /taustop would kill the server the web UI
            // itself is connected through; /tau and /qr open a browser on
            // the host machine). They remain available in the terminal TUI.
            const cmds = pi.getCommands().filter((c: any) => !MIRROR_OWN_COMMANDS.has(c.name));
            sendTo(ws, success("get_commands", { commands: cmds }));
          } catch (e: any) {
            sendTo(ws, error("get_commands", e.message || String(e)));
          }
          break;
        }

        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          const model = ctx.model;
          const state = {
            model,
            thinkingLevel: pi.getThinkingLevel(),
            isStreaming: !ctx.isIdle(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionName: pi.getSessionName(),
            autoCompactionEnabled: true, // Extension can't easily check this
          };
          sendTo(ws, success("get_state", state));
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          sendTo(ws, success("get_available_models", { models }));
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          const model = models.find(
            (m: any) => m.provider === command.provider && m.id === command.modelId
          );
          if (!model) {
            sendTo(ws, error("set_model", `Model not found: ${command.provider}/${command.modelId}`));
            break;
          }
          const ok = await pi.setModel(model);
          if (!ok) {
            sendTo(ws, error("set_model", "No API key for this model"));
            break;
          }
          sendTo(ws, success("set_model", model));
          break;
        }

        case "cycle_model": {
          // Extension API doesn't have cycleModel directly
          // Workaround: get available models, find current, pick next
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const availModels = await ctx.modelRegistry.getAvailable();
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const idx = availModels.findIndex(
            (m: any) => m.provider === currentModel.provider && m.id === currentModel.id
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          await pi.setModel(nextModel);
          sendTo(ws, success("cycle_model", {
            model: nextModel,
            thinkingLevel: pi.getThinkingLevel(),
          }));
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          const levels = ["off", "minimal", "low", "medium", "high"];
          const current = pi.getThinkingLevel();
          const idx = levels.indexOf(current);
          const next = levels[(idx + 1) % levels.length];
          pi.setThinkingLevel(next as any);
          const actual = pi.getThinkingLevel();
          sendTo(ws, success("cycle_thinking_level", { level: actual }));
          break;
        }

        case "set_thinking_level": {
          pi.setThinkingLevel(command.level);
          sendTo(ws, success("set_thinking_level"));
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const usage = ctx.getContextUsage();
          const entries = ctx.sessionManager.getEntries();
          let userMessages = 0, assistantMessages = 0, toolCalls = 0;
          for (const e of entries) {
            if (e.type === "message") {
              if (e.message?.role === "user") userMessages++;
              else if (e.message?.role === "assistant") assistantMessages++;
              else if (e.message?.role === "toolResult") toolCalls++;
            }
          }
          sendTo(ws, success("get_session_stats", {
            sessionFile: ctx.sessionManager.getSessionFile(),
            userMessages,
            assistantMessages,
            toolCalls,
            totalMessages: entries.length,
            tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
          }));
          break;
        }

        case "set_session_name": {
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          pi.setSessionName(name);
          sendTo(ws, success("set_session_name"));
          break;
        }

        case "set_auto_compaction": {
          // Extension can't easily toggle auto-compaction
          // Just acknowledge
          sendTo(ws, success("set_auto_compaction"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Announce the manual compaction on the same envelope as forwarded
            // events; the real session_compact / session_compact_failed
            // subscriptions deliver the end (and cover auto-compaction).
            broadcast({ type: "event", event: { type: "compaction_start", reason: "manual", willRetry: false } });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: any) => {
                broadcast({ type: "event", event: { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, summary: result?.summary } });
              },
              onError: (err: any) => {
                broadcast({ type: "event", event: { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: err?.message || String(err) } });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            const { execSync } = require("node:child_process");
            const args = command.outputPath
              ? `"${sessionFile}" "${command.outputPath}"`
              : `"${sessionFile}"`;
            const output = execSync(`pi --export ${args}`, { cwd: process.cwd(), timeout: 30000, encoding: "utf-8" });
            // pi prints the output path
            const result = output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: any) {
            sendTo(ws, error("export_html", e.message));
          }
          break;
        }

        // ─── Commands & Files ───
        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = await buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: AUTH_CONFIGURED, enabled: authEnabled }));
          break;
        }

        case "set_auth": {
          if (!AUTH_CONFIGURED) {
            sendTo(ws, error("set_auth", "No credentials configured. Set tau.user and tau.pass in settings.json"));
            break;
          }
          authEnabled = !!command.enabled;
          saveTauSetting("authEnabled", authEnabled);
          broadcast({ type: "event", event: { type: "auth_changed", enabled: authEnabled } });
          sendTo(ws, success("set_auth", { enabled: authEnabled }));
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: any) {
      sendTo(ws, error(command.type || "unknown", e.message || String(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";

    // Auth gate — exempt /api/health (monitoring) and /api/login + /api/logout (the login flow itself)
    const authExempt = urlPath === "/api/health" || urlPath === "/api/login" || urlPath === "/api/logout";
    if (authEnabled && !authExempt && !checkBasicAuth(req)) {
      sendAuthRequired(res);
      return;
    }

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Default to index.html
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/qr") {
      if (!mirrorUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Server not ready" }));
        return;
      }
      const qrPromises = [QRCode.toDataURL(mirrorUrl, { width: 256, margin: 2 })];
      if (tailscaleUrl) qrPromises.push(QRCode.toDataURL(tailscaleUrl, { width: 256, margin: 2 }));
      Promise.all(qrPromises).then((dataUrls: string[]) => {
        const tsSection = tailscaleUrl && dataUrls[1]
          ? `<p style="margin-top:24px;color:rgba(255,255,255,0.3);font-size:11px">TAILSCALE</p><img src="${dataUrls[1]}" width="256" height="256" alt="Tailscale QR"><a href="${tailscaleUrl}">${tailscaleUrl}</a>`
          : "";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width"><title>Tau — Connect</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#131316;color:#fff;font-family:-apple-system,sans-serif}
img{border-radius:12px}a{color:#b87a5c;font-size:18px;margin-top:16px}p{color:rgba(255,255,255,0.5);font-size:13px;margin-top:8px}</style>
</head><body><p style="color:rgba(255,255,255,0.3);font-size:11px">LAN</p><img src="${dataUrls[0]}" width="256" height="256" alt="QR Code"><a href="${mirrorUrl}">${mirrorUrl}</a>${tsSection}<p style="margin-top:16px">Scan to open Tau on your phone</p></body></html>`);
      }).catch((e: any) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: "mirror", mirrorUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform, authEnabled, startedAt: serverStartedAt || undefined, version: tauWebVersion }));
      return;
    }

    // Inline login: verify Basic credentials, mint an HttpOnly cookie session.
    // The browser sends the cookie on fetches AND the WS handshake (which
    // can't carry custom headers), so this replaces the native login prompt.
    if (urlPath === "/api/login" && req.method === "POST") {
      if (!authEnabled || !AUTH_CONFIGURED) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, authRequired: false }));
        return;
      }
      if (checkBasicCredentials(req.headers.authorization)) {
        const token = mintAuthToken();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid username or password" }));
      }
      return;
    }

    if (urlPath === "/api/logout" && req.method === "POST") {
      const token = parseAuthCookie(req);
      if (token) authTokens.delete(token);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // File preview — serve image bytes for thumbnail display in the browser
    if ((urlPath === "/api/file/preview" || urlPath.startsWith("/api/file/preview?")) && req.method === "GET") {
      const previewUrl = new URL(`http://localhost${req.url}`);
      const filePath = previewUrl.searchParams.get("path");
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "path required" }));
        return;
      }
      const IMAGE_PREVIEW_MIMES: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon",
      };
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mimeType = IMAGE_PREVIEW_MIMES[ext];
      if (!mimeType) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a previewable image" }));
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) throw new Error("Not a file");
        res.writeHead(200, { "Content-Type": mimeType, "Cache-Control": "max-age=60" });
        fs.createReadStream(filePath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      // Flag in-process instances (the old-tau ghost rides along in every pi
      // process): the UI tags them `local` and offers no Attach for them.
      const list = getRunningInstances().map((i) => ({ ...i, local: i.pid === process.pid }));
      res.end(JSON.stringify({ instances: list }));
      return;
    }

    if (urlPath === "/api/projects" && req.method === "GET") {
      serveProjectsList(res);
      return;
    }

    if (urlPath === "/api/projects/launch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { path: projectPath } = JSON.parse(body);
          if (!projectPath || typeof projectPath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          // Resolve ~ in path
          const resolved = projectPath.startsWith("~")
            ? path.join(process.env.HOME || "", projectPath.slice(1))
            : projectPath;
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Directory not found" }));
            return;
          }
          const { execSync } = require("node:child_process");
          const escaped = resolved.replace(/'/g, "'\\''");
          execSync(`osascript -e 'tell app "iTerm2" to create window with default profile command "cd '"'"'${escaped}'"'"' && pi"'`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const explicitPath = filesUrl.searchParams.get("path");
        let dirPath = explicitPath || process.cwd();
        if (!explicitPath && latestCtx) {
          try {
            const entries = latestCtx.sessionManager.getEntries();
            const sessionEntry = entries.find((e: any) => e.type === "session");
            if (sessionEntry?.cwd) dirPath = sessionEntry.cwd;
          } catch {}
        }
        serveFileList(res, dirPath);
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // File browser: open file natively
    if (urlPath === "/api/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const { execFile } = await import("node:child_process");
          if (process.platform === "win32") {
            const { exec } = await import("node:child_process");
            const safe = fp.replace(/'/g, "''").replace(/"/g, '');
            exec(`powershell -NoProfile -WindowStyle Hidden -Command "& { $wsh = New-Object -ComObject WScript.Shell; $wsh.Run('explorer \\"${safe}\\"', 1, $false) }"`, (err) => {
              if (err) tauLog("[Mirror] open failed:", err.message);
            });
          } else if (process.platform === "darwin") {
            execFile("open", [fp], (err) => {
              if (err) tauLog("[Mirror] open failed:", err.message);
            });
          } else {
            execFile("xdg-open", [fp], (err) => {
              if (err) tauLog("[Mirror] open failed:", err.message);
            });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session file endpoint: /api/sessions/:dirName/:file
    const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      serveSessionFile(res, sessionMatch[1], sessionMatch[2]);
      return;
    }

    // RPC proxy — handle via WebSocket command handler
    if (urlPath === "/api/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const command = JSON.parse(body);
          // Create a fake WebSocket-like object to capture the response
          const responsePromise = new Promise<any>((resolve) => {
            const fakeWs = {
              readyState: WebSocket.OPEN,
              send: (data: string) => resolve(JSON.parse(data)),
            } as any;
            handleCommand(fakeWs, command);
          });
          const response = await responsePromise;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // Session switch — in mirror mode, this is a no-op (session is controlled by TUI)
    if (urlPath === "/api/sessions/switch" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, mirror: true, note: "Session switching is controlled by the TUI in mirror mode" }));
      return;
    }

    // Session delete
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        try {
          const { filePath } = JSON.parse(body);
          if (!filePath || typeof filePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          if (!fs.existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          fs.unlinkSync(filePath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Memoryd check
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ═══════════════════════════════════════
  // Sessions list endpoint
  // ═══════════════════════════════════════
  function getTmuxSessionFiles(): Set<string> {
    if (process.platform === "win32") return new Set();
    try {
      const { execSync } = require("node:child_process");
      // Get tmux pane PIDs
      const paneOutput = execSync("tmux list-panes -a -F '#{pane_pid}' 2>/dev/null", { encoding: "utf8" });
      const tmuxFiles = new Set<string>();

      for (const shellPid of paneOutput.trim().split("\n").filter(Boolean)) {
        try {
          // Find Pi (node) processes that are children of tmux shells
          const children = execSync(`pgrep -P ${shellPid} 2>/dev/null`, { encoding: "utf8" });
          for (const pid of children.trim().split("\n").filter(Boolean)) {
            // Check what .jsonl files this process has open
            const lsofOut = execSync(`lsof -p ${pid} 2>/dev/null | grep '\\.jsonl'`, { encoding: "utf8" });
            for (const line of lsofOut.trim().split("\n").filter(Boolean)) {
              const match = line.match(/\/.+\.jsonl$/);
              if (match) tmuxFiles.add(match[0]);
            }
          }
        } catch { /* no match */ }
      }
      return tmuxFiles;
    } catch {
      return new Set();
    }
  }

  function serveProjectsList(res: http.ServerResponse) {
    const projectsDir = TAU_SETTINGS.projectsDir;
    if (!projectsDir) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [] }));
      return;
    }

    const resolved = projectsDir.startsWith("~")
      ? path.join(process.env.HOME || "", projectsDir.slice(1))
      : projectsDir;

    if (!fs.existsSync(resolved)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [], error: "Directory not found" }));
      return;
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const instances = getRunningInstances();

      // Build session count + recency map from session history
      const sessionInfo = new Map<string, { count: number; lastActive: number }>();
      if (fs.existsSync(SESSIONS_DIR)) {
        for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
          // Check if this session dir maps to a subdirectory of the projects folder
          if (!decodedPath.startsWith(resolved + "/") && !decodedPath.startsWith(resolved)) continue;

          const sessionDir = path.join(SESSIONS_DIR, dir.name);
          const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
          let lastMtime = 0;
          for (const f of files) {
            try {
              const stat = fs.statSync(path.join(sessionDir, f));
              if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
            } catch {}
          }
          sessionInfo.set(decodedPath, { count: files.length, lastActive: lastMtime });
        }
      }

      const projects = entries
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => {
          const fullPath = path.join(resolved, e.name);
          const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
          const isActive = instances.some(i => i.cwd === fullPath);
          return {
            name: e.name,
            path: fullPath,
            sessionCount: info.count,
            lastActive: info.lastActive || null,
            active: isActive,
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      const tmuxFiles = getTmuxSessionFiles();
      const readline = await import("node:readline");
      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const projects: any[] = [];

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");

        const sessions: any[] = [];

        for (const file of files) {
          try {
            const filePath = path.join(projectDir, file);
            const parsed = await parseSessionFile(filePath, readline);
            if (parsed) {
              const stat = fs.statSync(filePath);
              const isTmux = tmuxFiles.has(filePath);
              sessions.push({ ...parsed, file, filePath, mtime: stat.mtimeMs, ...(isTmux && { tmux: true }) });
            }
          } catch { /* skip */ }
        }

        sessions.sort((a, b) => b.mtime - a.mtime);

        if (sessions.length > 0) {
          projects.push({ path: decodedPath, dirName: dir.name, sessions });
        }
      }

      projects.sort((a, b) => {
        const aTime = a.sessions[0]?.mtime || 0;
        const bTime = b.sessions[0]?.mtime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFile(res: http.ServerResponse, dirName: string, file: string) {
    const filePath = path.join(SESSIONS_DIR, dirName, file);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    const entries: any[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try { entries.push(JSON.parse(buffer)); } catch { /* skip */ }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: any) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: any = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: any) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch { /* skip */ }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    if (!header?.id) return null;
    if (userMessageCount <= 1 && lineCount <= 8) return null; // pipe mode

    return {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules", ".git", "__pycache__", ".DS_Store", ".Trash",
    ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
    "venv", ".venv", "env", ".env.local",
    ".pi", "coverage", ".nyc_output", ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items: any[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (IGNORED_NAMES.has(entry.name)) continue;

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* skip inaccessible */ }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));

        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = path.join(projectDir, file);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let firstMessage = "";
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text && text.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet = (start > 0 ? "…" : "") + text.substring(start, end) + (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch { /* skip line */ }
            }

            rl.close();
            stream.destroy();

            if (matches.length > 0) {
              results.push({
                filePath,
                project: decodedPath,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch { /* skip file */ }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable)
  // ═══════════════════════════════════════
  function startServer(ctx: ExtensionContext) {
    if (server) return; // Already running

    // Clean up zombie instances from killed tmux panes etc.
    cleanupZombieInstances();

    server = http.createServer(serveStaticFile);
    wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (request, socket, head) => {
      if (authEnabled && !checkBasicAuth(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Tau\"\r\n\r\n");
        socket.destroy();
        return;
      }
      if (request.url === "/ws") {
        wss!.handleUpgrade(request, socket, head, (ws) => {
          wss!.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws) => {
      tauDebug("[Mirror] Browser client connected");
      clients.add(ws);
      (ws as any).isAlive = true;

      ws.on("pong", () => {
        (ws as any).isAlive = true;
      });

      // Send initial state
      sendTo(ws, { type: "state", isStreaming: false, mode: "mirror" });

      // Immediately send state snapshot
      if (latestCtx) {
        buildStateSnapshot(latestCtx).then((snapshot) => {
          sendTo(ws, snapshot);
        });
      }

      ws.on("message", (data) => {
        try {
          const command = JSON.parse(data.toString());
          handleCommand(ws, command);
        } catch (e) {
          tauLog("[Mirror] Failed to parse client message:", e);
        }
      });

      ws.on("close", () => {
        tauDebug("[Mirror] Browser client disconnected");
        clients.delete(ws);
        try { headless.detach(ws); } catch {}
        try {
          const e = uplinks.get(ws);
          if (e) { (e as any).dead = true; try { e.upstream.close(); } catch {} uplinks.delete(ws); }
        } catch {}
      });

      ws.on("error", (e) => {
        tauLog("[Mirror] Client error:", e);
        clients.delete(ws);
        try { headless.detach(ws); } catch {}
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          clients.delete(client);
          continue;
        }

        if (!(client as any).isAlive) {
          try { client.terminate(); } catch {}
          clients.delete(client);
          continue;
        }

        (client as any).isAlive = false;
        try { client.ping(); } catch {}
      }
    }, 20000);

    const tryListen = (port: number, maxAttempts = 10) => {
      server!.listen(port, HOST, () => {
        onListening(port);
      });
      server!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          // Check if a stale Tau instance owns this port and kill it
          const instances = getRunningInstances();
          const stale = instances.find(i => i.port === port && i.pid !== process.pid);
          if (stale && isZombieProcess(stale.pid)) {
            tauLog(`[Mirror] Port ${port} in use by stale Tau instance (PID ${stale.pid}), killing...`);
            try { process.kill(stale.pid, "SIGTERM"); } catch {}
            // Wait briefly then retry the same port
            setTimeout(() => {
              server!.removeAllListeners("error");
              tryListen(port, maxAttempts);
            }, 500);
            return;
          }
          tauLog(`[Mirror] Port ${port} in use, trying ${port + 1}...`);
          server!.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          tauLog(`[Mirror] Failed to start server:`, err.message);
        }
      });
    };

    const onListening = (port: number) => {
      const isLoopback = HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost";

      let localIp = "localhost";
      let tailscaleIp = "";

      if (!isLoopback) {
        // Get local IP for display — prefer en0/en1 (WiFi/Ethernet) over bridges/VPNs
        const nets = require("node:os").networkInterfaces();
        let fallbackIp = "";
        const preferred = ["en0", "en1"];
        for (const name of preferred) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal) {
              localIp = net.address;
              break;
            }
          }
          if (localIp !== "localhost") break;
        }
        if (localIp === "localhost") {
          for (const name of Object.keys(nets)) {
            if (name.startsWith("bridge") || name.startsWith("utun") || name.startsWith("lo")) continue;
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal && (net.address.startsWith("192.168.") || net.address.startsWith("10."))) {
                localIp = net.address;
                break;
              }
            }
            if (localIp !== "localhost") break;
          }
        }
        if (localIp === "localhost" && fallbackIp) localIp = fallbackIp;

        // Detect Tailscale IP (100.x.x.x CGNAT range)
        for (const name of Object.keys(nets)) {
          for (const net of nets[name] || []) {
            if (net.family === "IPv4" && !net.internal && net.address.startsWith("100.")) {
              tailscaleIp = net.address;
              break;
            }
          }
          if (tailscaleIp) break;
        }
      }

      mirrorUrl = `http://${localIp}:${port}`;
      tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : "";
      serverStartedAt = new Date().toISOString();
      tauLog(`[Mirror] Tau mirror server running on ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}`);
      ctx.ui.setStatus("mirror", `Mirror: ${localIp}:${port}${tailscaleIp ? ` • TS: ${tailscaleIp}:${port}` : ""}`);

      // Sibling check: the old `tau` package and `tau-web` must never run together.
      // Both load in every pi process (installed packages + -e), both read the
      // same TAU_MIRROR_PORT, and the loser bumps +1 — a ghost old-code mirror.
      // Same PID + different port in the registry == in-process sibling.
      // Sibling check now (catches the case where tau started first) and again
      // after 5s (tau-web usually wins the race, tau registers moments later).
      const warnSibling = () => {
        try {
          const sibling = getRunningInstances().find((i) => i.pid === process.pid && i.port !== port);
          if (sibling) tauLog(`[Mirror] WARNING: sibling mirror already running in this process on :${sibling.port} (old tau package?). Run only ONE of tau / tau-web — remove the other from settings packages.`);
        } catch {}
      };
      warnSibling();
      setTimeout(warnSibling, 5000).unref?.();

      // Register this instance
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());

      ctx.ui.notify(`Tau mirror: ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}  •  /qr for QR code`, "info");
    };

    tryListen(PORT);
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    try { wrapUiDialogs(ctx); } catch (e) { tauLog("[tau-web] wrapUiDialogs failed:", (e as any)?.message || e); }

    // Skip mirror startup in subagent child processes
    // (pi-subagents sets PI_SUBAGENT_CHILD=1; child processes loading Tau
    // should not attempt to start their own mirror server)
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      tauDebug("[Mirror] Subagent child process detected (PI_SUBAGENT_CHILD=1), skipping auto-start.");
      return;
    }

    if (!TAU_AUTO_START) {
      tauDebug("[Mirror] Tau auto-start disabled (TAU_DISABLED=1). Use /tau-start to start manually.");
      return;
    }

    startServer(ctx);
  });

  // ═══════════════════════════════════════
  // Cleanup on shutdown
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async () => {
    stopServer();
    tauDebug("[Mirror] Server shut down");
  });
}
