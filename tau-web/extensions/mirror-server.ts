/**
 * Tau Hub Extension
 *
 * Runs a headless-first Hub daemon inside a Pi process (`pi -e tau-web
 * --mode rpc`): an HTTP+WS server that serves the browser UI and owns
 * sessions through spawned headless backends. Browsers also attach to
 * live TUI mirrors through the hub relay (ADR-014); mirrors never serve
 * browsers directly (no per-TUI port, no "go to live server").
 *
 * - Spawns/manages headless pi children per session (persistent backends)
 * - Accepts commands from the browser and executes them via the extension API
 * - Relays attach/drive between browsers and live TUI mirrors (hub.sock)
 * - Serves static files for the Tau web UI
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, WebSocket } from "ws";
import { HeadlessRegistry } from "./headless-bridge.js";
import { resolveRole, type TauRole } from "./lib/config.js";
import { HubSocketServer, HubSocketClient, type MirrorRecord, type Frame } from "./lib/hub-socket.js";
import { scanPiProcesses, killLivePiProcess, ProcessKillError } from "./lib/processes.js";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Load tau settings from ~/.pi/agent/settings.json (falls back to env vars)
function loadTauSettings(): { port: number; host: string; autoStart: boolean; user: string; pass: string; authEnabled?: boolean; projectsDir?: string; projects?: string[] } {
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
    projects: parseProjectsList(process.env.TAU_PROJECTS_JSON || process.env.TAU_PROJECTS || settings.projects),
  };
}

// `tau.projects` accepts an array, a JSON string, or a `:`/`,`-separated list.
// These are explicit extra roots the hub may browse and start sessions in,
// alongside `tau.projectsDir` and the user home.
function parseProjectsList(raw: unknown): string[] | undefined {
  if (!raw) return undefined;
  try {
    if (Array.isArray(raw)) return raw.filter((s) => typeof s === "string" && s.trim()).map((s) => String(s));
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      if (trimmed.startsWith("[")) {
        const arr = JSON.parse(trimmed);
        return Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim()) : undefined;
      }
      return trimmed.split(/[:,]/).map((s) => s.trim()).filter(Boolean);
    }
  } catch { /* ignore malformed */ }
  return undefined;
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
// HttpOnly cookie session after verifying JSON credentials. Tokens live in
// memory only: a server restart invalidates them and the UI re-prompts.
const authTokens = new Map<string, number>();
// S13: cookie tokens expire after 30 days (matching the Set-Cookie Max-Age).
// Stored as token -> createdAt; pruned lazily on each auth check so a leaked
// token stops working without a restart. The 200-token cap is kept.
const AUTH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
// S12: Basic-auth backoff reuses the login failure counter per source IP.
// The first few failures answer immediately (a single typo stays fast);
// above the threshold each failure waits progressively (mirroring the login
// 500ms slope, capped ~2s) so a guessing loop cannot spin tight.
const BASIC_AUTH_FAIL_THRESHOLD = 3;
const BASIC_AUTH_BACKOFF_CAP_MS = 2000;
// Login brute-force backoff: per-source-IP failure count with decay. No
// persistent blocklist — a forgotten password must never lock the owner out.
const loginFailures = new Map<string, { count: number; at: number }>();
// S9: loginFailures and apiAccessLog grow by key forever (one entry per
// source IP / method+path). Prune stale entries on access (older than the
// 10-minute failure window / 1 hour for the log throttle) with a hard cap
// so a scan of spoofed IPs or ever-changing query strings cannot grow hub
// memory without bound.
const LOGIN_FAIL_MAX_ENTRIES = 1000;
const API_ACCESS_LOG_TTL_MS = 60 * 60 * 1000;
const API_ACCESS_LOG_MAX_ENTRIES = 1000;
// S10: WS backpressure guards. maxPayload caps a single inbound client
// frame (streaming deltas are bytes–KBs); the bufferedAmount cap stops one
// slow browser from growing hub memory without bound during a long stream.
const WS_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const WS_BUFFERED_CAP_BYTES = 16 * 1024 * 1024;
function pruneLoginFailures(now: number = Date.now()): void {
  try {
    for (const [k, v] of loginFailures) {
      if (now - v.at > LOGIN_FAIL_WINDOW_MS) loginFailures.delete(k);
    }
    while (loginFailures.size > LOGIN_FAIL_MAX_ENTRIES) {
      const first = loginFailures.keys().next().value;
      if (first === undefined) break;
      loginFailures.delete(first);
    }
  } catch {}
}
function pruneExpiredAuthTokens(now: number = Date.now()): void {
  try {
    for (const [tok, createdAt] of authTokens) {
      if (now - createdAt > AUTH_TOKEN_TTL_MS) authTokens.delete(tok);
    }
  } catch {}
}
function isAuthTokenValid(token: string): boolean {
  if (!token) return false;
  const createdAt = authTokens.get(token);
  if (createdAt === undefined) return false;
  if (Date.now() - createdAt > AUTH_TOKEN_TTL_MS) {
    try { authTokens.delete(token); } catch {}
    return false;
  }
  return true;
}
function basicClientKey(req: http.IncomingMessage): string {
  try { return req.socket.remoteAddress || "unknown"; } catch { return "unknown"; }
}
function recordBasicFailure(req: http.IncomingMessage): number {
  const key = basicClientKey(req);
  const now = Date.now();
  pruneLoginFailures(now);
  const prev = loginFailures.get(key);
  const fails = (prev && now - prev.at < LOGIN_FAIL_WINDOW_MS) ? prev.count + 1 : 1;
  loginFailures.set(key, { count: fails, at: now });
  return fails;
}
function clearBasicFailures(req: http.IncomingMessage): void {
  try { loginFailures.delete(basicClientKey(req)); } catch {}
}
function basicBackoffMs(fails: number): number {
  if (fails <= BASIC_AUTH_FAIL_THRESHOLD) return 0;
  return Math.min(500 * (fails - BASIC_AUTH_FAIL_THRESHOLD), BASIC_AUTH_BACKOFF_CAP_MS);
}
function sleepAuthBackoff(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
// API access-log throttle (method+path -> last logged ms); diagnostics only.
const apiAccessLog = new Map<string, number>();
function pruneApiAccessLog(now: number = Date.now()): void {
  try {
    for (const [k, at] of apiAccessLog) {
      if (now - at > API_ACCESS_LOG_TTL_MS) apiAccessLog.delete(k);
    }
    while (apiAccessLog.size > API_ACCESS_LOG_MAX_ENTRIES) {
      const first = apiAccessLog.keys().next().value;
      if (first === undefined) break;
      apiAccessLog.delete(first);
    }
  } catch {}
}
// S5: shared capped body reader for every POST route. Unbounded
// `body += chunk` accumulation lets an unauthenticated client (e.g. a huge
// /api/login POST) grow memory without bound; readBody answers 413 and
// destroys the stream as soon as maxBytes is exceeded, so the whole body is
// never buffered. Normal-sized bodies reach onBody unchanged (the same string
// the old inline accumulators produced), preserving each route's existing
// JSON parse/error handling.
const BODY_LIMIT_LOGIN = 64 * 1024;
const BODY_LIMIT_JSON = 256 * 1024;
const BODY_LIMIT_RPC = 1024 * 1024;
const BODY_LIMIT_CLIENT_ERROR = 8 * 1024;
function readBody(req: http.IncomingMessage, res: http.ServerResponse, maxBytes: number, onBody: (body: string) => void): void {
  let size = 0;
  let body = "";
  let over = false;
  req.on("data", (chunk: Buffer) => {
    if (over) return;
    size += chunk.length;
    if (size > maxBytes) {
      over = true;
      try {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
      } catch {}
      try { req.destroy(); } catch {}
      return;
    }
    body += chunk.toString();
  });
  req.on("end", () => { if (!over) onBody(body); });
  req.on("error", () => {});
}
// S7: /api/client-error is auth-exempt (a locked-out client must still be able
// to report), so it gets a per-source-IP rate limit on top of the 8 KiB cap:
// at most 20 logged reports per minute; excess answers 429 and is never
// written to tau.log.
const CLIENT_ERROR_MAX_PER_MIN = 20;
const CLIENT_ERROR_WINDOW_MS = 60 * 1000;
const clientErrorHits = new Map<string, number[]>();
function clientErrorAllowed(ip: string): boolean {
  const now = Date.now();
  let hits = clientErrorHits.get(ip);
  if (!hits) {
    hits = [];
    if (clientErrorHits.size > 1000) { const first = clientErrorHits.keys().next().value; if (first !== undefined) clientErrorHits.delete(first); }
    clientErrorHits.set(ip, hits);
  }
  while (hits.length > 0 && now - hits[0] > CLIENT_ERROR_WINDOW_MS) hits.shift();
  if (hits.length >= CLIENT_ERROR_MAX_PER_MIN) return false;
  hits.push(now);
  return true;
}
const AUTH_COOKIE = "tau_auth";
let serverStartedAt = "";
let tauWebVersion = "0.1.0";
try { tauWebVersion = require("../package.json").version || tauWebVersion; } catch {}
function mintAuthToken(): string {
  try {
    const t = require("node:crypto").randomBytes(32).toString("hex");
    pruneExpiredAuthTokens();
    authTokens.set(t, Date.now());
    if (authTokens.size > 200) { const first = authTokens.keys().next().value; if (first) authTokens.delete(first); }
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
// Secure flag only when the transport is actually encrypted: setting it on
// plain HTTP would stop the browser storing the cookie at all (local
// loopback dev stays HTTP, world-facing deploys sit behind TLS that sets
// X-Forwarded-Proto or terminates on this socket).
function cookieAttr(req: http.IncomingMessage): string {
  try {
    const sock = req.socket as any;
    const proto = (req.headers["x-forwarded-proto"] as string || "").split(",")[0].trim().toLowerCase();
    if (sock?.encrypted || proto === "https") return "; Secure";
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
      // Hub-only (ADR-011): the hub shell is the only entry point.
      if (fs.existsSync(path.join(candidate, "hub", "index.html"))) return candidate;
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

function getRunningInstances(): Array<{ port: number; pid: number; sessionFile: string; cwd: string; startedAt?: string }> {
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
  return dedupeBySessionFile(instances);
}

/**
 * Collapse registry rows that point at the same session file.
 *
 * A session can be resumed by a fresh process — kill + restart, or a second
 * TUI opened in the same cwd — and each owner binds its own port and writes
 * its own `${pid}.json`. Without this the sidebar lists the same session once
 * per port ("same session on multiple ports"). Only the most recently started
 * owner is advertised: that is the process the user just resumed, and the one
 * whose port is live. Rows without a session file (scratch backends) are left
 * alone — several of those may legitimately coexist.
 */
function dedupeBySessionFile<T extends { sessionFile?: string | null; startedAt?: string }>(list: T[]): T[] {
  const byFile = new Map<string, T>();
  const unowned: T[] = [];
  for (const inst of list) {
    const file = inst.sessionFile;
    if (!file) { unowned.push(inst); continue; }
    const prev = byFile.get(file);
    if (!prev) { byFile.set(file, inst); continue; }
    const prevAt = Date.parse(prev.startedAt || "") || 0;
    const nextAt = Date.parse(inst.startedAt || "") || 0;
    if (nextAt >= prevAt) byFile.set(file, inst);
  }
  return [...unowned, ...byFile.values()];
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
    // Fail-safe: a process we cannot inspect must NOT be treated as a
    // zombie — the caller SIGTERMs zombies, and killing a live session on a
    // failed `ps` (missing toybox flags on Termux, permissions) would
    // destroy the user's session.
    return false;
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

function credentialsMatch(user: string, pass: string): boolean {
  try {
    const a = Buffer.from(`${user}:${pass}`);
    const b = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`);
    if (a.length === 0 || a.length !== b.length) return false;
    return require("node:crypto").timingSafeEqual(a, b);
  } catch { return false; }
}
// S8: set_auth re-auth compares the caller-supplied password against the
// configured pass only (no username round-trip on the WS path).
function authPassMatches(provided: string): boolean {
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(AUTH_PASS);
    if (a.length === 0 || a.length !== b.length) return false;
    return require("node:crypto").timingSafeEqual(a, b);
  } catch { return false; }
}
// Browser auth is cookie-only: the login form POSTs JSON credentials once,
// the server mints an HttpOnly cookie session, and every later fetch / WS
// handshake carries the cookie. No WWW-Authenticate is ever sent, so the
// browser's native login prompt can never appear.)
function checkCookieAuth(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  pruneExpiredAuthTokens();
  const token = parseAuthCookie(req);
  return isAuthTokenValid(token);
}
// WS entry: browsers present the cookie session (cookie tokens live in this
// process's memory and can't authenticate a different pi process).
// Shared-secret credentials from an Authorization: Basic header (the login
// endpoint's legacy fallback below).
function parseBasicCredentials(header: string | undefined): { user: string; pass: string } | null {
  try {
    const m = (header || "").match(/^Basic\s+(.+)$/i);
    if (!m) return null;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch { return null; }
}
function checkWsAuth(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  if (checkCookieAuth(req)) return true;
  const creds = parseBasicCredentials(req.headers.authorization as string);
  return !!creds && credentialsMatch(creds.user, creds.pass);
}

// ─── Anti-rebinding (ADR-010) ───
// A page on an attacker origin can reach a loopback server after a DNS
// rebind, and the browser will happily attach the tau_auth cookie to the WS
// handshake. Cookie auth alone therefore does not stop it, so the WS upgrade
// (and /api/*) also check the Host/Origin. Localhost, IP literals (LAN /
// Tailscale 100.x) and *.ts.net are allowed; any other hostname must be
// opted in via TAU_ALLOWED_HOSTS. TAU_ALLOW_ANY_HOST=1 disables the check.
function hostnameOf(header: string | undefined): string {
  if (!header) return "";
  const h = header.trim().toLowerCase();
  const m = h.match(/^\[([^\]]+)\](?::\d+)?$/) || h.match(/^([^:]+)(?::\d+)?$/);
  return m ? m[1] : h;
}
function isAllowedHostName(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  // Bare IP literals: an attacker page cannot make the Host header an IP it
  // does not control, and cookie auth still gates the socket.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return true;
  if (hostname.endsWith(".ts.net")) return true; // Tailscale Serve / MagicDNS
  const extra = (process.env.TAU_ALLOWED_HOSTS || "")
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(hostname)) return true;
  const bind = hostnameOf(HOST);
  return !!bind && bind === hostname;
}
/** The explicit port a Host header carries, or null when it carries none. */
function explicitPortOfHost(header: string | undefined): string | null {
  if (!header) return null;
  const h = header.trim().toLowerCase();
  const v6 = h.match(/^\[[^\]]+\]:(\d+)$/); // [::1]:12040
  if (v6) return v6[1];
  const m = h.match(/^[^:]+:(\d+)$/); // host:port (unbracketed IPv6 has no port)
  return m ? m[1] : null;
}
function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" || protocol === "wss:" ? "443" : "80";
}
function checkRequestOrigin(req: http.IncomingMessage): boolean {
  if (process.env.TAU_ALLOW_ANY_HOST === "1") return true;
  const host = req.headers["host"] as string | undefined;
  if (!isAllowedHostName(hostnameOf(host))) return false;
  const origin = req.headers["origin"] as string | undefined;
  // Browsers always send Origin on WS + cross-origin fetches; a value that
  // does not match the requested Host is the rebinding signature. Non-browser
  // clients send none, and are not the threat model here.
  if (origin) {
    let originUrl: URL;
    try { originUrl = new URL(origin); } catch { return false; }
    if (hostnameOf(originUrl.host) !== hostnameOf(host)) return false;
    // Hostname alone is not enough: a page at http://127.0.0.1:12099 could
    // still reach ws://127.0.0.1:12040. When the Host header pins a port,
    // the Origin's effective port must match it. A portless Host means a
    // TLS-terminating proxy (Serve / cloudflared) forwarded a bare public
    // name, where the loopback port is unknowable — fall back to hostname.
    const hostPort = explicitPortOfHost(host);
    if (hostPort) {
      const originPort = originUrl.port || defaultPortForProtocol(originUrl.protocol);
      if (hostPort !== originPort) return false;
    }
  }
  return true;
}

function sendAuthRequired(res: http.ServerResponse) {
  res.writeHead(401, {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

// S6: baseline security headers on every HTTP response. Frame + nosniff
// are free; CSP is frame-ancestors only — the app uses inline handlers
// and CDN assets, so script-src/style-src would break it.
function setSecurityHeaders(res: http.ServerResponse) {
  try {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  } catch {}
}

export default function (pi: ExtensionAPI) {
  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  // ─── tau-web: headless backends + web dialogs ───
  const headless = new HeadlessRegistry({
    onEvent: (managed, event) => {
      if (event && event.type === "extension_ui_request") {
        // Dialogs travel the plain {type:"event"} path only. Sending the
        // generic rpc_event copy as well made the browser render every
        // headless dialog twice (the second render cancelled the first).
        pendingDialogs.set(event.id, { kind: "headless", managed });
        for (const client of managed.clients) {
          // Tag the owner so the abort button can target this backend.
          sendTo(client, { type: "event", event: { ...event, headless: true } });
        }
        return;
      }
      // Forward headless events in pi-web envelope so one UI speaks both dialects.
      for (const client of managed.clients) {
        sendTo(client, { type: "rpc_event", event });
      }
    },
    // A brand-new headless child's session file is only known after it answers
    // get_state. Tell the owning tab so it can pin #session=<basename> — the
    // URL identity that makes reload/resume work (ADR-010 §UI flow 2).
    onFileDiscovered: (managed, file) => {
      for (const client of managed.clients) {
        sendTo(client, { type: "session_file", sessionFile: file, cwd: managed.cwd });
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
  // pending dialogs: requestId -> { kind: 'mirror' } | { kind: 'headless', managed }
  const pendingDialogs = new Map<string, { kind: "mirror" } | { kind: "headless"; managed: any }>();

  // ─── Hub role (ADR-010, relay restored ADR-014) ───
  // The same package runs as control plane (hub: no TUI, owns sessions) or
  // data plane (mirror: a live TUI dialing the hub over hub.sock). The role
  // decides which transport is active: hub listens on the private unix
  // socket, mirror dials it. Mirrors never serve browsers directly (no
  // per-TUI port) — attach/drive flows through the hub relay only.
  let role: TauRole = "mirror";
  let hubSockets: HubSocketServer | null = null;
  let hubForwarder: HubSocketClient | null = null;
  // hub: browserWs -> mirror it is driving over the socket
  const hubUplinkSubs = new Map<WebSocket, { mirrorId: string; pid: number; port: number }>();
  // hub: dialog request id -> mirror id, so the response routes back
  const hubDialogOwner = new Map<string, string>();
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
      // A dialog can be answered by a direct browser OR (mirror role) a
      // browser attached through the hub. Neither present -> leave it to the
      // TUI's native prompt.
      const useLocal = clients.size > 0;
      const useHub = role === "mirror" && !!hubForwarder?.connected;
      if (!useLocal && !useHub) return null;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const request = { type: "extension_ui_request", id, method, ...payload };
      pendingDialogs.set(id, { kind: "mirror" });
      if (useLocal) broadcast({ type: "event", event: request });
      if (useHub) hubForwarder!.push({ type: "dialog", request });
      try { ctx.ui.notify(`Dialog open in browser (${method}) — answer there.`, "info"); } catch {}
      return new Promise((resolve) => {
        const poll = () => {
          // All answer channels gone mid-dialog: release the TUI to its native prompt.
          const stillLocal = clients.size > 0;
          const stillHub = role === "mirror" && !!hubForwarder?.connected;
          if (!stillLocal && !stillHub) { pendingDialogs.delete(id); try { (pendingDialogs as any).responses?.delete(id); } catch {} resolve(undefined); return; }
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
  // The event ctx goes stale after session replacement (/new, fork,
  // switch, reload) — pi throws on any touch past that point. Validate on
  // every read: a stale ctx is cleared (the next event re-arms it) and
  // callers degrade to their existing no-ctx paths instead of throwing.
  function liveCtx(): ExtensionContext | null {
    if (!latestCtx) return null;
    try {
      void latestCtx.sessionManager.getSessionFile();
      return latestCtx;
    } catch {
      latestCtx = null;
      return null;
    }
  }

  // Pending RPC-style requests from browser (id -> resolver)
  const pendingRequests = new Map<string, (response: any) => void>();

  // ═══════════════════════════════════════
  // Helper: send to one client
  // ═══════════════════════════════════════
  function isWsBackpressured(ws: WebSocket): boolean {
    try { return (((ws as any).bufferedAmount || 0) as number) > WS_BUFFERED_CAP_BYTES; } catch { return false; }
  }
  function sendTo(ws: WebSocket, data: any) {
    if (ws.readyState !== WebSocket.OPEN) return;
    // S10: one slow browser must not grow hub memory without bound during
    // streaming — skip frames once its buffer exceeds the cap. The skipped
    // client keeps its socket (heartbeat + shapes unchanged) and catches
    // up when it drains; normal (<1 MiB) frames flow untouched.
    if (isWsBackpressured(ws)) return;
    try { ws.send(JSON.stringify(data)); } catch {}
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: any) {
    let json: string;
    try { json = JSON.stringify(data); } catch { return; }
    for (const client of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (isWsBackpressured(client)) continue;
      try { client.send(json); } catch {}
    }
  }

  let mirrorUrl = "";
  let tailscaleUrl = "";

  // ═══════════════════════════════════════
  // Helper: stop the server
  // ═══════════════════════════════════════
  function stopServer() {
    try { headless.shutdownAll(); } catch {}
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

  // The /tau, /taustart, /taustop and /qr commands controlled the per-TUI
  // mirror server, which no longer exists (ADR-014: hub-relayed attach
  // only, no per-TUI port). Do not re-add without a hub-side equivalent.

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

      // A hub owns no user-facing session of its own (its transcript comes
      // from headless children), so never broadcast the hub process's events.
      if (role !== "mirror") return;

      const forwarded = normalizeForwardedEvent(eventType, event);
      // Forward to all connected browser clients (direct access), wrapped in
      // { type: "event", event } to match the frontend protocol.
      broadcast({ type: "event", event: forwarded });
      // …and to the hub over the socket, so browsers attached through the hub
      // see the same live stream.
      if (hubForwarder?.connected) hubForwarder.push({ type: "event", event: forwarded });
      // Identity (model / streaming flag) changes matter to the hub's list.
      if (eventType === "agent_start" || eventType === "agent_end" || eventType === "model_select") {
        pushMirrorStatus();
      }
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
  // tau-web: session path resolution (L6)
  // ═══════════════════════════════════════
  function cwdToSessionDir(cwd: string): string {
    const n = path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    return `--${n}--`;
  }
  // Lossy display-only decode of a session dir name. The encoding maps
  // every `/` to `-`, so literal dashes in project names (true-knowledge)
  // cannot round-trip — NEVER use this where correctness matters (bind cwd,
  // identity compares). Prefer the session header's `cwd` (parseSessionFile)
  // or the live instance record; fall back to this for display only.
  function lossyDecodeSessionDir(dirName: string): string {
    return dirName.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
  }
  function resolveHeadlessSessionPath(cwd: string, filename: string): string | null {
    if (!filename || filename.includes("/") || filename.includes("\\") || !filename.endsWith(".jsonl")) return null;
    const dir = path.join(SESSIONS_DIR, cwdToSessionDir(cwd));
    const abs = path.resolve(path.join(dir, filename));
    const root = path.resolve(SESSIONS_DIR);
    if (!(abs === root || abs.startsWith(root + path.sep))) return null;
    return abs;
  }

  // ═══════════════════════════════════════
  // Hub relay (ADR-010, restored ADR-014): private-socket listener on the
  // hub, dial-out forwarder on mirrors, uplink attach/drive fan-out.
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
  // Hub role (ADR-010): control-plane socket + mirror forwarder
  // ═══════════════════════════════════════

  // A mirror accepts exactly these 4 commands from the hub. `drive` payloads
  // are additionally checked against the session-lifecycle blocklist below, so
  // the socket can steer a TUI but never start/close/switch sessions on it.
  const HUB_DRIVE_DENY = new Set([
    "start_session", "new_session", "close_session", "list_sessions",
    "detach_session", "uplink_list", "uplink_attach", "uplink_detach", "uplink_command",
  ]);

  /** Hub: start the private listener and fan mirror traffic to browsers. */
  function startHubSocket() {
    if (hubSockets) return;
    hubSockets = new HubSocketServer({
      onHello: (rec) => {
        tauLog(`[Hub] mirror connected pid=${rec.pid} cwd=${rec.cwd} port=${rec.port}`);
        broadcast({ type: "mirrors_changed" });
      },
      onUpdate: () => broadcast({ type: "mirrors_changed" }),
      onGone: (rec) => {
        for (const [bw, sub] of hubUplinkSubs) {
          if (sub.mirrorId !== rec.id) continue;
          hubUplinkSubs.delete(bw);
          sendTo(bw, { type: "uplink_dead", port: sub.port, pid: sub.pid, headlessContinue: true });
        }
        // S9: drop hub bookkeeping for this mirror's dialogs so a
        // disconnected mirror cannot leave parked entries behind.
        try { releaseDialogsForMirror(rec.id); } catch {}
        broadcast({ type: "mirrors_changed" });
      },
      onFrame: (rec, frame) => handleMirrorFrame(rec, frame),
      onError: (e) => tauLog(`[Hub] socket error: ${e?.message || e}`),
    });
    hubSockets.start();
  }

  /** Hub: route one frame from a mirror to the browsers driving it. */
  function handleMirrorFrame(rec: MirrorRecord, frame: Frame) {
    const port = rec.port;
    if (frame.type === "event") {
      for (const [bw, sub] of hubUplinkSubs) {
        if (sub.mirrorId !== rec.id) continue;
        sendTo(bw, { type: "rpc_event", event: frame.event, uplink: true, port });
        if (frame.event?.type === "extension_ui_request" && frame.event?.id) {
          hubDialogOwner.set(frame.event.id, rec.id);
          pendingDialogs.set(frame.event.id, { kind: "mirror" });
        }
      }
      return;
    }
    if (frame.type === "snapshot" || frame.type === "response") {
      for (const [bw, sub] of hubUplinkSubs) {
        if (sub.mirrorId !== rec.id) continue;
        const event = frame.type === "snapshot" ? { ...frame, type: "mirror_sync", uplink: true } : frame;
        sendTo(bw, { type: "rpc_event", event, uplink: true, port });
      }
      return;
    }
    if (frame.type === "dialog") {
      // A TUI wrapped by wrapUiDialogs pushes dialog requests here (not on the
      // plain `event` path). Remember which mirror owns the id so the browser's
      // extension_ui_response can be relayed back via `dialog_relay`, and hand
      // the request to every browser driving this mirror as a normal UI event.
      const request = frame.request;
      if (request?.id) {
        hubDialogOwner.set(request.id, rec.id);
        pendingDialogs.set(request.id, { kind: "mirror" });
      }
      for (const [bw, sub] of hubUplinkSubs) {
        if (sub.mirrorId !== rec.id) continue;
        sendTo(bw, { type: "rpc_event", event: request, uplink: true, port });
      }
      return;
    }
  }

  /** Hub: browser picks a live TUI from the shared mirror list. */
  function hubAttachUplink(browserWs: WebSocket, pid: number) {
    // Never drive the hub itself, even if a stale client names its pid.
    if (Number(pid) === process.pid) {
      sendTo(browserWs, { type: "error", message: "The hub session cannot be driven — attach another session" });
      return;
    }
    const rec = hubSockets?.get(String(pid));
    if (!rec) {
      sendTo(browserWs, { type: "error", message: "That session is not connected to the hub" });
      return;
    }
    hubUplinkSubs.set(browserWs, { mirrorId: rec.id, pid: rec.pid, port: rec.port || rec.pid });
    sendTo(browserWs, { type: "uplink_attached", port: rec.port || rec.pid, pid: rec.pid, sessionFile: rec.sessionFile, cwd: rec.cwd });
    // Ask for a fresh snapshot so a browser joining mid-session is current.
    hubSockets?.send(rec.id, { type: "snapshot" });
  }

  function hubDetachUplink(browserWs: WebSocket) {
    if (hubUplinkSubs.delete(browserWs)) sendTo(browserWs, { type: "uplink_detached" });
  }

  // S9: parked dialogs must not outlive their answerer. Headless dialogs
  // park a pi child on extension_ui_request until the browser answers;
  // hub-relayed mirror dialogs park the mirror's wrapUiDialogs poller until
  // dialog_relay arrives. When the last browser that could answer goes
  // away, answer cancelled on its behalf so the waiter is released.
  // Supersede/timeout answers still flow through the normal
  // extension_ui_response path while the entry exists.
  function cancelHeadlessDialog(id: string): void {
    const entry = pendingDialogs.get(id) as any;
    if (!entry || entry.kind !== "headless" || !entry.managed) return;
    try { entry.managed.rpc.send({ type: "extension_ui_response", id, cancelled: true }); } catch {}
    pendingDialogs.delete(id);
    try { (pendingDialogs as any).responses?.delete(id); } catch {}
    try { hubDialogOwner.delete(id); } catch {}
  }
  function releaseHeadlessDialogsForBrowser(): void {
    // managed.clients already had ws removed via headless.detach(); cancel
    // only dialogs with nobody left to answer — a sibling tab still bound
    // to the same backend keeps its dialog.
    for (const [id, entry] of [...pendingDialogs]) {
      if ((entry as any).kind !== "headless") continue;
      const managed = (entry as any).managed;
      if (!managed || managed.clients.size === 0) cancelHeadlessDialog(id);
    }
  }
  function releaseHubDialogsForMirror(mirrorId: string): void {
    // Browser gone with no remaining driver for this mirror: tell the
    // mirror its dialogs are cancelled so its poller wakes promptly, then
    // drop hub bookkeeping. When at least one driver remains, keep the
    // entries — the dialog is still answerable.
    for (const sub of hubUplinkSubs.values()) {
      if (sub.mirrorId === mirrorId) return;
    }
    for (const [id, owner] of [...hubDialogOwner]) {
      if (owner !== mirrorId) continue;
      hubDialogOwner.delete(id);
      pendingDialogs.delete(id);
      try { (pendingDialogs as any).responses?.delete(id); } catch {}
      try { hubSockets?.send(mirrorId, { type: "dialog_relay", id, response: { cancelled: true } }); } catch {}
    }
  }
  function releaseDialogsForBrowser(mirrorIdBefore: string | undefined): void {
    try { releaseHeadlessDialogsForBrowser(); } catch {}
    try { if (mirrorIdBefore) releaseHubDialogsForMirror(mirrorIdBefore); } catch {}
  }
  function releaseDialogsForMirror(mirrorId: string): void {
    // Mirror gone: its waiter self-releases via the forwarder-drop poller,
    // so just drop hub bookkeeping (no headless child parks on these).
    try {
      for (const [id, owner] of [...hubDialogOwner]) {
        if (owner !== mirrorId) continue;
        hubDialogOwner.delete(id);
        pendingDialogs.delete(id);
        try { (pendingDialogs as any).responses?.delete(id); } catch {}
      }
    } catch {}
  }

  function hubDrive(browserWs: WebSocket, command: any) {
    const sub = hubUplinkSubs.get(browserWs);
    if (!sub || !hubSockets) { sendTo(browserWs, { type: "error", message: "uplink not attached" }); return; }
    hubSockets.send(sub.mirrorId, { type: "drive", command });
  }

  /** Mirror: dial the hub and announce ourselves. */
  function startHubForwarder() {
    if (hubForwarder) return;
    hubForwarder = new HubSocketClient({
      hello: () => {
        const c = liveCtx();
        return {
          type: "hello",
          pid: process.pid,
          port: 0, // No per-TUI port (ADR-014: hub-relayed attach only)
          cwd: c?.cwd || process.cwd(),
          sessionFile: c?.sessionManager.getSessionFile() || null,
          sessionName: c ? pi.getSessionName() : null,
          model: c?.model || null,
          isStreaming: c ? !c.isIdle() : false,
        };
      },
      onCommand: (frame) => handleHubCommand(frame),
      onError: () => { /* hub absent is normal — retry handles it */ },
    });
    hubForwarder.start();
  }

  /** Mirror: a frame from the hub's 4-command allowlist. */
  function handleHubCommand(frame: Frame) {
    if (frame.type === "snapshot") {
      const c = liveCtx();
      if (c) {
        // buildStateSnapshot yields a direct-browser `mirror_sync`; the hub
        // rewrites our `snapshot` frame back to `mirror_sync` for browsers.
        buildStateSnapshot(c).then(
          (snap) => hubForwarder?.push({ ...snap, type: "snapshot" }),
          () => hubForwarder?.push({ type: "snapshot", entries: [], total: 0, model: null }),
        );
      } else {
        hubForwarder?.push({ type: "snapshot", entries: [], total: 0, model: null });
      }
      return;
    }
    if (frame.type === "drive") {
      const command = frame.command;
      if (!command || typeof command.type !== "string" || HUB_DRIVE_DENY.has(command.type)) {
        hubForwarder?.push({ type: "response", command: command?.type || "unknown", success: false, error: "command not allowed over hub socket", id: command?.id });
        return;
      }
      // Reuse the full command handler via a socket-backed fake WS: one
      // implementation, no dialect drift between direct and hub-driven paths.
      handleCommand(hubSocketShim, command);
      return;
    }
    if (frame.type === "dialog_relay") {
      // S9: ignore late relays for an already-released dialog so the
      // responses map cannot grow by key forever. Live dialogs still resolve
      // via the poller; supersede/timeout arrive while the entry exists.
      if (!frame.id || !pendingDialogs.has(frame.id)) return;
      (pendingDialogs as any).responses = (pendingDialogs as any).responses || new Map();
      const response = frame.response && Object.keys(frame.response).length > 0 ? frame.response : { cancelled: true };
      (pendingDialogs as any).responses.set(frame.id, response);
      return;
    }
    if (frame.type === "health") {
      pushMirrorStatus();
      return;
    }
  }

  // Fake WS that makes the mirror's own reply frames travel to the hub instead
  // of a browser socket. `readyState: 1` matches WebSocket.OPEN in sendTo().
  const hubSocketShim: any = {
    readyState: WebSocket.OPEN,
    send: (payload: string) => {
      try { hubForwarder?.push(JSON.parse(payload)); return true; } catch { return false; }
    },
    close: () => {}, ping: () => {}, terminate: () => {},
  };

  /** Mirror: tell the hub our current session identity (cheap, idempotent). */
  function pushMirrorStatus() {
    if (role !== "mirror" || !hubForwarder?.connected) return;
    const c = liveCtx();
    hubForwarder.push({
      type: "status",
      cwd: c?.cwd || process.cwd(),
      sessionFile: c?.sessionManager.getSessionFile() || null,
      sessionName: c ? pi.getSessionName() : null,
      model: c?.model || null,
      isStreaming: c ? !c.isIdle() : false,
    });
  }
  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: WebSocket, command: any) {
    // ─── tau-web unified protocol (headless + uplink + dialogs) ───
    // Lifecycle: sessions are PERSISTENT — browser close/reload only
    // detaches (unbinds WS); the pi child keeps running. Kill only via
    // close_session (bound session) or TTL opt-in. /new == new_session.
    if (command && typeof command.type === "string" && ["start_session", "new_session", "close_session", "list_sessions", "detach_session", "rpc_command", "ping", "uplink_list", "uplink_attach", "uplink_detach", "uplink_command", "extension_ui_response"].includes(command.type)) {
      try {
        switch (command.type) {
          case "start_session": {
            const cwd = typeof command.cwd === "string" && command.cwd.trim() ? command.cwd : process.cwd();
            const file = typeof command.sessionFile === "string" && command.sessionFile ? command.sessionFile : null;
            const fresh = command.fresh === true;
            let managed;
            try {
              managed = headless.attach(ws, cwd, file, { fresh, sessionKey: typeof command.sessionKey === "string" ? command.sessionKey : undefined });
            } catch (e: any) {
              sendTo(ws, { type: "rpc_event", event: { type: "response", command: "start_session", success: false, error: e?.message || "invalid cwd" }, id: command.id });
              return;
            }
            if (file && !fresh) {
              const abs = resolveHeadlessSessionPath(managed.cwd, file);
              // Skip the switch when this backend is already on the file:
              // re-issuing switch_session cancels the in-flight turn, so
              // returning to (or reselecting) a running session would kill
              // its run and bake "Command aborted" into the transcript.
              if (abs && fs.existsSync(abs) && managed.switchedFile !== abs) headless.switchToFile(managed, abs);
            }
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "start_session", success: true, data: { sessionKey: managed.id, cwd: managed.cwd, isAgentRunning: managed.isAgentRunning } }, id: command.id });
            return;
          }
          case "new_session": {
            // /new semantics: old session keeps running detached, fresh
            // empty session bound to this tab.
            const cwd = typeof command.cwd === "string" && command.cwd.trim() ? command.cwd : undefined;
            let managed;
            try {
              managed = headless.newSession(ws, cwd);
            } catch (e: any) {
              sendTo(ws, { type: "rpc_event", event: { type: "response", command: "new_session", success: false, error: e?.message || "invalid cwd" }, id: command.id });
              return;
            }
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "new_session", success: true, data: { sessionKey: managed.id, cwd: managed.cwd } }, id: command.id });
            return;
          }
          case "close_session": {
            const ok = headless.closeSession(ws);
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "close_session", success: ok }, id: command.id });
            return;
          }
          case "list_sessions": {
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "list_sessions", success: true, data: { sessions: headless.listSessions() } }, id: command.id });
            return;
          }
          case "detach_session": {
            headless.detach(ws);
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "detach_session", success: true }, id: command.id });
            return;
          }
          case "rpc_command": {
            // Inject the browser's request id so the backend's response resolves
            // the browser's pending control command (set_model, cycle_thinking…).
            const inner = command.command && typeof command.command === "object"
              ? { ...command.command, id: command.id }
              : command.command;
            const r = headless.command(ws, inner);
            if (!r.ok) sendTo(ws, { type: "error", message: r.error || "no active session" });
            return;
          }
          case "ping": { sendTo(ws, { type: "pong" }); return; }
          case "uplink_list": {
            // Hub: the shared mirror list (all TUIs that dialed hub.sock). A
            // mirror does not proxy other TUIs (ADR-010) — cross-attach is
            // hub-only — so it reports an empty list and the UI offers no
            // Attach.
            const list = role === "hub" && hubSockets
              ? hubSockets.list().map((r) => ({
                  port: r.port || r.pid, pid: r.pid, cwd: r.cwd, sessionFile: r.sessionFile,
                  sessionName: r.sessionName, active: r.isStreaming, hub: true,
                }))
              : [];
            sendTo(ws, { type: "rpc_event", event: { type: "response", command: "uplink_list", success: true, data: { instances: list } }, id: command.id });
            return;
          }
          case "uplink_attach": {
            if (role === "hub") hubAttachUplink(ws, Number(command.pid));
            else sendTo(ws, { type: "error", message: "Cross-session attach is only available through the hub" });
            return;
          }
          case "uplink_detach": {
            if (role === "hub") hubDetachUplink(ws);
            else sendTo(ws, { type: "uplink_detached" });
            return;
          }
          case "uplink_command": {
            if (role === "hub") { hubDrive(ws, command.command); return; }
            sendTo(ws, { type: "error", message: "No uplink on a mirror — attach through the hub" });
            return;
          }
          case "extension_ui_response": {
            const { id, ...rest } = command;
            // Hub-routed dialog: relay back to the mirror that raised it.
            const hubOwner = id ? hubDialogOwner.get(id) : undefined;
            if (hubOwner && hubSockets) {
              hubDialogOwner.delete(id);
              hubSockets.send(hubOwner, { type: "dialog_relay", id, response: rest });
              pendingDialogs.delete(id);
              return;
            }
            const pend = id ? pendingDialogs.get(id) : undefined;
            if (pend?.kind === "headless" && (pend as any).managed) {
              try { (pend as any).managed.rpc.send({ type: "extension_ui_response", id, ...rest }); } catch {}
              pendingDialogs.delete(id);
              return;
            }
            // Mirror-owned dialog awaited via wrapUiDialogs poller. Ignore
            // late answers for an already-released dialog so the responses
            // map cannot grow by key forever (S9); live supersede/timeout
            // answers arrive while the entry still exists.
            if (id && pendingDialogs.has(id)) {
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
    const ctx = liveCtx(); // stale (post-replacement) ctx reads as null — every branch below already handles that

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
            // Hub-only (ADR-011): Tau's own server-control commands are gone
            // (no per-TUI server to stop/start/QR). List everything else.
            const cmds = pi.getCommands();
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
          // Canonical pi levels (matches the web header dropdown).
          const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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

        // `compaction.enabled` lives in pi settings and only takes effect on
        // (re)load — the extension API cannot flip it at runtime. The old
        // web toggle acked success while changing nothing, so it was removed
        // (client + this case). Compaction itself is driven via `compact`.

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
            // No shell: outputPath comes from the web client and must never
            // reach a command line (quote-injection). execFile passes argv
            // directly, so hostile characters are inert.
            const { execFileSync } = require("node:child_process");
            const piBin = process.env.PI_WEB_PI_BIN || process.env.TAU_PI_BIN || "pi";
            // S3: outputPath is client-controlled. Constrain it the way
            // /api/sessions/export does — inside the session store only.
            // No outputPath (the UI path) exports next to the session file.
            const storeRoot = path.resolve(SESSIONS_DIR);
            const rawOut = typeof command.outputPath === "string" ? command.outputPath.trim() : "";
            const argv = ["--export", sessionFile];
            if (rawOut) {
              const absOut = path.resolve(rawOut);
              if (absOut !== storeRoot && !absOut.startsWith(storeRoot + path.sep)) {
                throw new Error("Output must be inside the session store");
              }
              // A symlinked parent inside the store must not redirect the
              // write outside: jail the resolved parent when it exists.
              try {
                const parentReal = fs.realpathSync(path.dirname(absOut));
                if (parentReal !== storeRoot && !parentReal.startsWith(storeRoot + path.sep)) {
                  throw new Error("Output must be inside the session store");
                }
              } catch (e: any) {
                if (e?.message === "Output must be inside the session store") throw e;
                // Parent missing: keep the string-prefix jail above; pi
                // --export fails cleanly if the directory does not exist.
              }
              argv.push(absOut);
            }
            const output = execFileSync(piBin, argv, { cwd: process.cwd(), timeout: 30000, encoding: "utf-8" });
            // pi prints the output path
            const result = output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: any) {
            sendTo(ws, error("export_html", e.message));
          }
          break;
        }

        // ─── Commands & Files ───
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
          // S8: changing authEnabled is re-authenticated — the current
          // password must accompany the request, otherwise an XSS with a
          // live socket could persist auth-off.
          if (!authPassMatches(typeof command.pass === "string" ? command.pass : "")) {
            sendTo(ws, error("set_auth", "Invalid password"));
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
  async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    // S6: every response (static, /api/*, 401/403/redirect) carries the
    // baseline headers. Set before the auth/route branches so no early
    // return skips them; later writeHead calls merge with these.
    setSecurityHeaders(res);
    let urlPath = req.url || "/";

    // Auth gate — API only. The static shell (index.html / app.js / style.css)
    // MUST stay reachable without credentials: it renders the login overlay
    // that mints the cookie session. Gating it would answer an unauthenticated
    // navigation with a raw JSON 401 and the app could never load to log in.
    // Everything sensitive is under /api/ (or the separately-gated /ws upgrade).
    const isApi = urlPath.startsWith("/api/");
    const authExempt = urlPath === "/api/health" || urlPath === "/api/login" || urlPath === "/api/logout" || urlPath === "/api/client-error";
    // Throttled access log for /api/* — reveals exactly what a browser
    // requests (method, path, credentials present) without flooding on the
    // 1s instance poll. Keyed per method+path, one line / 10s.
    if (isApi) {
      try {
        const key = `${req.method} ${urlPath}`;
        const now = Date.now();
        pruneApiAccessLog(now);
        if (now - (apiAccessLog.get(key) || 0) > 10000) {
          apiAccessLog.set(key, now);
          tauLog(`[api] ${req.method} ${urlPath} auth=${authExempt ? "exempt" : (checkWsAuth(req) ? "yes" : "no")}`);
        }
      } catch {}
    }
    // HTTP APIs accept the same credentials as the WS upgrade: cookie session
    // OR Authorization: Basic. Cached/legacy clients authenticate with Basic
    // headers (no cookie mint yet) — rejecting them here made "logged in" UIs
    // 401 on every call while /api/login was never even hit.
    // S12: Basic failures reuse loginFailures (shared with /api/login) per
    // source IP. Success clears the counter; failure records it and, above
    // the threshold, waits progressively (capped ~2s) before the 401 so a
    // guessing loop cannot spin tight. Single-typo failures stay immediate.
    if (authEnabled && isApi && !authExempt) {
      if (checkCookieAuth(req)) {
        // Cookie valid — no Basic accounting.
      } else {
        const creds = parseBasicCredentials(req.headers.authorization as string);
        if (!creds) {
          sendAuthRequired(res);
          return;
        }
        if (credentialsMatch(creds.user, creds.pass)) {
          clearBasicFailures(req);
        } else {
          const fails = recordBasicFailure(req);
          const wait = basicBackoffMs(fails);
          if (wait > 0) await sleepAuthBackoff(wait);
          sendAuthRequired(res);
          return;
        }
      }
    }
    // Anti-rebinding: reject cross-origin / unlisted-host API calls outright.
    if (isApi && !authExempt && !checkRequestOrigin(req)) {
      tauLog(`[api] rejected host=${req.headers.host} origin=${req.headers.origin}`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    // Handle API routes
    if (isApi) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Hub shell is mounted at /hub/ (public/hub/index.html) so the URL stays
    // clean. The hub redirects its root there.
    if (role === "hub" && (urlPath === "/" || urlPath === "/index.html")) {
      res.writeHead(302, { Location: "/hub/" });
      res.end();
      return;
    }
    if (urlPath === "/hub" || urlPath === "/hub/") urlPath = "/hub/index.html";
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

      // The app shell must never go stale. A cached old app.js talking to a
      // newer server breaks badly (e.g. pre-cookie login flows that 401-loop),
      // and with no Cache-Control/validators the browser had no way to
      // revalidate. Serve validators + no-cache so it revalidates every load
      // and gets a cheap 304 when unchanged (this is what made the
      // Cloudflare-fronted origin keep an ancient client while LAN was fine).
      const lastModified = stats.mtime.toUTCString();
      const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Last-Modified", lastModified);
      res.setHeader("ETag", etag);

      const ims = req.headers["if-modified-since"];
      const inm = req.headers["if-none-match"];
      if ((typeof inm === "string" && inm === etag) ||
          (typeof ims === "string" && new Date(ims).getTime() >= Math.floor(stats.mtimeMs / 1000) * 1000)) {
        res.writeHead(304);
        res.end();
        return;
      }

      res.writeHead(200, { "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  function handleApiRoute(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string) {
    // S11: no wildcard CORS — the UI is same-origin, so no route needs
    // Access-Control-Allow-Origin. Omitting it keeps a cross-origin page
    // from reading /api/* JSON (e.g. auth-exempt /api/health) while
    // same-origin fetch/cookies keep working.
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Browser crash beacon: uncaught errors / rejections from the client are
    // POSTed here so a failing app shell is visible in tau.log even when the
    // browser console isn't being watched.
    if (urlPath === "/api/client-error" && req.method === "POST") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!clientErrorAllowed(ip)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Too many requests" }));
        try { req.destroy(); } catch {}
        return;
      }
      readBody(req, res, BODY_LIMIT_CLIENT_ERROR, (body) => {
        try { tauLog(`[client] ${body}`); } catch {}
        res.writeHead(204);
        res.end();
      });
      return;
    }

    if (urlPath === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", mode: role, mirrorUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform, authEnabled, startedAt: serverStartedAt || undefined, version: tauWebVersion }));
      return;
    }

    // Cookie-session login: JSON credentials in, HttpOnly cookie out.
    // The browser sends the cookie on fetches AND the WS handshake (which
    // can't carry custom headers). No Basic Auth anywhere client-side.
    if (urlPath === "/api/login" && req.method === "POST") {
      if (!authEnabled || !AUTH_CONFIGURED) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, authRequired: false }));
        return;
      }
      readBody(req, res, BODY_LIMIT_LOGIN, async (body) => {
        let user = "";
        let pass = "";
        try {
          const parsed = JSON.parse(body);
          // Usernames are trimmed (mobile keyboards add stray spaces and
          // autocapitalize the first letter — the input also carries
          // autocapitalize="off", this is the server-side belt). Passwords
          // are never trimmed: spaces can be significant.
          user = String(parsed.user || "").trim();
          pass = String(parsed.pass || "");
        } catch {}
        // Legacy fallback: pre-cookie clients authenticate the login POST
        // itself with an Authorization: Basic header and no JSON body.
        // Accept it so a browser running cached pre-update files can still
        // log in (it mints the same cookie session and self-heals).
        if (!user) {
          const legacy = parseBasicCredentials(req.headers.authorization as string);
          if (legacy) { user = legacy.user; pass = legacy.pass; }
        }
        const clientKey = req.socket.remoteAddress || "unknown";
        if (user && credentialsMatch(user, pass)) {
          loginFailures.delete(clientKey);
          // Success audit (username only): distinguishes "POST never
          // arrives" from "login ok but the browser drops the cookie".
          try { tauLog(`[Mirror] login ok (user: "${user}")`); } catch {}
          const token = mintAuthToken();
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `${AUTH_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${cookieAttr(req)}; Max-Age=2592000`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          // Log the attempted username (never the password): a loop of
          // failures with "Ayush" vs "ayush" here means autocapitalize.
          try { tauLog(`[Mirror] login failed (user: "${user}")`); } catch {}
          // Backoff before answering: 500ms x failures, capped at 5s, with
          // 10-minute decay. Slows online guessing to a crawl while a lone
          // typo costs the owner half a second.
          pruneLoginFailures();
          const prev = loginFailures.get(clientKey);
          const fails = (prev && Date.now() - prev.at < 10 * 60 * 1000) ? prev.count + 1 : 1;
          loginFailures.set(clientKey, { count: fails, at: Date.now() });
          await new Promise((r) => setTimeout(r, Math.min(500 * fails, 5000)));
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid username or password" }));
        }
      });
      return;
    }

    if (urlPath === "/api/logout" && req.method === "POST") {
      const token = parseAuthCookie(req);
      if (token) authTokens.delete(token);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/${cookieAttr(req)}; Max-Age=0`,
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
      // S4: resolve symlinks before the jail so a link inside a root that
      // points outside is refused. Missing targets realpath-fail -> 404.
      let realPath: string;
      try {
        realPath = fs.realpathSync(path.resolve(filePath));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (!isRealPathAllowed(realPath)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Path outside allowed roots" }));
        return;
      }
      try {
        const stat = fs.statSync(realPath);
        if (!stat.isFile()) throw new Error("Not a file");
        // S4b: SVG served inline would execute as the hub origin when
        // navigated to. Force it to download; sandbox all previews so a
        // mislabelled payload cannot run there either. <img> thumbnails of
        // raster images are unaffected (images need no script origin).
        const headers: Record<string, string> = {
          "Content-Type": mimeType,
          "Cache-Control": "max-age=60",
          // S6: keep the sandbox jail and add the baseline frame-ancestors
          // guard (this writeHead overrides the global CSP, so restate it).
          "Content-Security-Policy": "sandbox; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        };
        if (ext === "svg") {
          headers["Content-Disposition"] = `attachment; filename="${path.basename(realPath).replace(/"/g, "")}"`;
        }
        res.writeHead(200, headers);
        fs.createReadStream(realPath).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, { "Content-Type": "application/json" });
      // ADR-010: only the hub owns the switchboard. A mirror cannot dial other
      // TUIs (uplink_attach is hub-only), so exposing the whole registry here
      // would advertise Attach buttons for servers this process cannot drive.
      // Scope a mirror to its own row; the hub still sees every instance.
      const registry = getRunningInstances();
      // The hub is a switchboard, never a session: its own pi process is not
      // listed, so no browser can navigate into or drive the hub itself. A
      // mirror keeps its own-row-only scope (that row IS its session view).
      const visible = role === "hub"
        ? registry.filter((i) => i.pid !== process.pid)
        : registry.filter((i) => i.pid === process.pid);
      // Flag in-process instances (the old-tau ghost rides along in every pi
      // process): the UI tags them `local` and offers no Attach for them.
      const local = visible.map((i) => ({ ...i, local: i.pid === process.pid }));
      // On the hub, also surface socket-registered mirrors that never started
      // their own HTTP server (TAU_DISABLED), so the Live list is complete.
      const mirrors = role === "hub" && hubSockets
        ? hubSockets.list().map((r) => ({
            port: r.port || r.pid, pid: r.pid, cwd: r.cwd, sessionFile: r.sessionFile,
            sessionName: r.sessionName, active: r.isStreaming, local: false, hub: true,
          }))
        : [];
      const byPid = new Map<string, any>();
      for (const i of [...local, ...mirrors]) byPid.set(String(i.pid), { ...byPid.get(String(i.pid)), ...i });
      // A session resumed on a new port must not show up once per port.
      const merged = dedupeBySessionFile([...byPid.values()]);
      res.end(JSON.stringify({ instances: merged }));
      return;
    }

    if (urlPath === "/api/projects" && req.method === "GET") {
      serveProjectsList(res);
      return;
    }

    if (urlPath === "/api/projects/launch" && req.method === "POST") {
      // iTerm2 automation is macOS-only — say so instead of failing obscurely.
      if (process.platform !== "darwin") {
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Project launch is only supported on macOS (iTerm2)" }));
        return;
      }
      readBody(req, res, BODY_LIMIT_JSON, (body) => {
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

    // Live backend status for one session (drives the background-run watch
    // in the UI): registry lookup only, no session-file parsing. Same
    // auth + origin gates as every other /api/* route.
    if ((urlPath === "/api/headless/status" || urlPath.startsWith("/api/headless/status?")) && req.method === "GET") {
      try {
        const q = new URL(`http://localhost${req.url}`);
        const cwd = q.searchParams.get("cwd") || "";
        const file = q.searchParams.get("file") || "";
        if (!cwd || !file) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "cwd and file query params required" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(headless.statusFor(cwd, file)));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e?.message || "status failed" }));
      }
      return;
    }

    // Live pi processes on this box (ADR-013): read-only visibility +
    // on-demand kill so the browser can free resources. Process
    // management only — no transcript proxy, no session driving, no
    // file writes. Same auth + origin gates as every other /api/* route.
    if (urlPath === "/api/processes" && req.method === "GET") {
      try {
        const { processes, unsupported } = scanPiProcesses(process.pid, headless.childPids());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ processes, unsupported }));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e?.message || "process scan failed" }));
      }
      return;
    }
    if (urlPath === "/api/processes/kill" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, async (body) => {
        try {
          const { pid } = JSON.parse(body);
          // Hub-owned children go through the registry so WS bindings and
          // bookkeeping retire together (never a raw signal under the hub).
          if (typeof pid === "number" && headless.childPids().has(pid)) {
            const closed = headless.closeByPid(pid);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: closed, pid, owner: "hub", exited: closed }));
            return;
          }
          const result = await killLivePiProcess(pid, process.pid, headless.childPids());
          // Best-effort: drop the stale tau-instances row for a reaped pid.
          try { fs.unlinkSync(path.join(INSTANCES_DIR, `${result.pid}.json`)); } catch {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          const status = e instanceof ProcessKillError ? e.status : 400;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e?.message || "kill failed" }));
        }
      });
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
        const fc = liveCtx();
        if (!explicitPath && fc) {
          try {
            const entries = fc.sessionManager.getEntries();
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

    // Read-only file content for the IDE-like viewer. Jailed to the
    // viewed session's cwd (resolved server-side from the session file,
    // never trusted from the client): ?path= + ?sessionKey=. Caps size,
    // sniffs binary, follows symlinks via realpath before jailing.
    if (urlPath === "/api/files/content" || urlPath.startsWith("/api/files/content?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      try {
        const q = new URL(`http://localhost${req.url}`);
        const rawPath = q.searchParams.get("path");
        const sessionKey = q.searchParams.get("sessionKey");
        if (!rawPath || !sessionKey || sessionKey.includes("/")) {
          res.end(JSON.stringify({ error: "path + sessionKey required" }));
          return;
        }
        // Resolve the session's cwd from its file (first line carries it).
        let jail: string | null = null;
        try {
          const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const cand = path.join(SESSIONS_DIR, d.name, sessionKey);
            if (!fs.existsSync(cand)) continue;
            const fd = fs.openSync(cand, "r");
            try {
              const buf = Buffer.alloc(4096);
              const n = fs.readSync(fd, buf, 0, 4096, 0);
              const firstLine = buf.subarray(0, n).toString("utf-8").split("\n")[0];
              const parsed: any = JSON.parse(firstLine || "{}");
              if (parsed?.type === "session" && typeof parsed.cwd === "string" && parsed.cwd) {
                jail = path.resolve(parsed.cwd);
              }
            } catch {} finally { fs.closeSync(fd); }
            break;
          }
        } catch {}
        if (!jail || !fs.existsSync(jail)) {
          res.end(JSON.stringify({ error: "Unknown session — cannot jail the read" }));
          return;
        }
        let abs: string;
        try {
          abs = fs.realpathSync(path.resolve(rawPath));
        } catch {
          res.end(JSON.stringify({ error: "File not found" }));
          return;
        }
        const jailReal = fs.realpathSync(jail);
        if (abs !== jailReal && !abs.startsWith(jailReal + path.sep)) {
          res.end(JSON.stringify({ error: "Outside the viewed session" }));
          return;
        }
        const st = fs.statSync(abs);
        if (!st.isFile()) {
          res.end(JSON.stringify({ error: "Not a file" }));
          return;
        }
        const MAX = 256 * 1024;
        const fd2 = fs.openSync(abs, "r");
        let content: string;
        let truncated = false;
        let binary = false;
        try {
          const head = Buffer.alloc(Math.min(st.size, 8192));
          fs.readSync(fd2, head, 0, head.length, 0);
          binary = head.includes(0);
          const take = Math.min(st.size, MAX);
          const buf = Buffer.alloc(take);
          fs.readSync(fd2, buf, 0, take, 0);
          content = buf.toString("utf-8");
          truncated = st.size > MAX;
        } finally { fs.closeSync(fd2); }
        if (binary) {
          res.end(JSON.stringify({ path: abs, binary: true, size: st.size }));
          return;
        }
        res.end(JSON.stringify({ path: abs, size: st.size, truncated, content }));
      } catch (err: any) {
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Create a single directory for the session picker. Jailed under $HOME
    // (no general FS write pipe); the parent must already exist — the
    // picker only offers New-folder inside the browsed directory.
    if (urlPath === "/api/files/mkdir" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, (body) => {
        try {
          const { path: raw } = JSON.parse(body);
          if (!raw || typeof raw !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          const home = fs.realpathSync(process.env.HOME || "/");
          const abs = path.resolve(raw);
          if (abs !== home && !abs.startsWith(home + path.sep)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Outside the home directory" }));
            return;
          }
          if (fs.existsSync(abs)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Already exists" }));
            return;
          }
          // S14: the string-prefix jail above does not see a symlinked
          // parent (~/link -> /etc + ~/link/new passes). The parent must
          // already exist, so resolve it and jail the resolved parent.
          let parentReal: string;
          try {
            parentReal = fs.realpathSync(path.dirname(abs));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Parent not found" }));
            return;
          }
          if (parentReal !== home && !parentReal.startsWith(home + path.sep)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Outside the home directory" }));
            return;
          }
          fs.mkdirSync(abs); // non-recursive: the parent is the browsed dir
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ path: abs }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session summaries for the session picker: one directory's sessions
    // with title (rename > first user message), date and running state,
    // most-recent-first. ?cwd= is matched against session header cwds.
    if (urlPath === "/api/sessions/summaries" || urlPath.startsWith("/api/sessions/summaries?")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      // handleApiRoute is sync: run the async scan in an IIFE.
      (async () => {
      try {
        const q = new URL(`http://localhost${req.url}`);
        const cwd = q.searchParams.get("cwd");
        if (!cwd) { res.end(JSON.stringify({ sessions: [] })); return; }
        const want = path.resolve(cwd);
        const readline = await import("node:readline");
        const running = new Set(
          getRunningInstances().map((i: any) => i.sessionFile).filter(Boolean)
        );
        const out: any[] = [];
        const seenSummaries = new Set<string>();
        if (fs.existsSync(SESSIONS_DIR)) {
          for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
            if (!dir.isDirectory()) continue;
            const projectDir = path.join(SESSIONS_DIR, dir.name);
            for (const file of fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"))) {
              try {
                const filePath = path.join(projectDir, file);
                const cached: any = await cachedParseSessionFile(filePath, readline);
                if (!cached) continue;
                seenSummaries.add(filePath);
                const parsed = cached.parsed;
                if (!parsed || path.resolve(parsed.cwd || "") !== want) continue;
                out.push({
                  file, dirName: dir.name, filePath,
                  title: parsed.name || parsed.firstMessage || "(empty session)",
                  date: parsed.timestamp || cached.mtimeMs,
                  mtime: cached.mtimeMs,
                  running: running.has(filePath),
                });
              } catch { /* skip unreadable */ }
            }
          }
          sweepSessionSummaryCache(seenSummaries);
        }
        out.sort((a, b) => b.mtime - a.mtime || (b.date || 0) - (a.date || 0));
        res.end(JSON.stringify({ sessions: out }));
      } catch (err: any) {
        try { res.end(JSON.stringify({ error: err.message })); } catch {}
      }
      })();
      return;
    }

    // Fork a session: byte-identical transcript copy under a fresh pi-style
    // name in the same project dir. The client binds the copy through the
    // normal resume path, so no new spawn protocol is needed.
    if (urlPath === "/api/sessions/fork" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, (body) => {
        try {
          const { dirName, file } = JSON.parse(body);
          if (!dirName || !file || typeof file !== "string" || !file.endsWith(".jsonl")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "dirName + .jsonl file required" }));
            return;
          }
          const root = path.resolve(SESSIONS_DIR);
          const src = path.resolve(path.join(SESSIONS_DIR, dirName, file));
          if (src !== root && !src.startsWith(root + path.sep)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden" }));
            return;
          }
          if (!fs.existsSync(src)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          const { randomUUID } = require("node:crypto");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const dest = path.join(path.dirname(src), `${stamp}_${randomUUID()}.jsonl`);
          fs.copyFileSync(src, dest);
          invalidateSessionSummary(dest);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ file: path.basename(dest), dirName }));
        } catch (err: any) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Git context for the session status bar (branch / repo root / dirty).
    // execFile (argv, no shell) so a hostile cwd can't inject a command.
    // NB: handleApiRoute receives urlPath WITH the query string still attached.
    if ((urlPath === "/api/git" || urlPath.startsWith("/api/git?")) && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      try {
        const gitUrl = new URL(`http://localhost${req.url}`);
        const rawCwd = gitUrl.searchParams.get("cwd") || process.cwd();
        const cwd = path.resolve(rawCwd);
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          res.end(JSON.stringify({ repo: false, error: "not a directory" }));
          return;
        }
        const { execFileSync } = require("node:child_process");
        const git = (args: string[]) =>
          execFileSync("git", ["-C", cwd, ...args], {
            timeout: 4000,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        const root = git(["rev-parse", "--show-toplevel"]);
        let branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
        let detached = false;
        if (branch === "HEAD") {
          detached = true;
          branch = git(["rev-parse", "--short", "HEAD"]);
        }
        let dirty = false;
        try { dirty = git(["status", "--porcelain"]).length > 0; } catch {}
        res.end(JSON.stringify({ repo: true, root, branch, detached, dirty }));
      } catch {
        res.end(JSON.stringify({ repo: false }));
      }
      return;
    }

    // File browser: open file natively (awaits the result — the old code
    // answered ok:true before the opener even ran, so Android (no xdg-open)
    // silently did nothing).
    if (urlPath === "/api/open" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, async (body) => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          // S4: resolve symlinks before the jail so a link inside a root
          // that points outside is refused. Missing targets -> 404.
          let realFp: string;
          try {
            realFp = fs.realpathSync(path.resolve(fp));
          } catch {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
            return;
          }
          if (!isRealPathAllowed(realFp)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Path outside allowed roots" }));
            return;
          }
          const { execFile } = await import("node:child_process");
          const run = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
            execFile(cmd, args, (err) => { if (err) reject(err); else resolve(); });
          });
          try {
            if (process.platform === "win32") {
              await run("explorer", [realFp]);
            } else if (process.platform === "darwin") {
              await run("open", [realFp]);
            } else {
              try { await run("xdg-open", [realFp]); }
              catch { await run("termux-open", [realFp]); }
            }
          } catch (err: any) {
            tauLog("[Mirror] open failed:", err.message);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `No file opener on this host (${err.message})` }));
            return;
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
      readBody(req, res, BODY_LIMIT_RPC, async (body) => {
        try {
          const command = JSON.parse(body);
          // Binding/routing commands need a real browser WS: the fake socket
          // below never closes, so start_session would leak a headless
          // backend (persistent now — no TTL to save us) and
          // uplink_attach would leak a proxied TUI connection. The UI speaks
          // these over /ws; over HTTP they are rejected, never half-run.
          if (command && typeof command.type === "string" &&
            ["start_session", "new_session", "close_session", "list_sessions", "detach_session", "rpc_command", "uplink_attach", "uplink_detach", "uplink_command", "extension_ui_response", "ping"].includes(command.type)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: `${command.type} requires a WebSocket connection`, id: command.id }));
            return;
          }
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

    // Session delete — constrained to the session store. The old code
    // unlinked any path the client named.
    if (urlPath === "/api/sessions/delete" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, (body) => {
        try {
          const { filePath } = JSON.parse(body);
          if (!filePath || typeof filePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          const root = path.resolve(SESSIONS_DIR);
          const abs = path.resolve(filePath);
          if ((!abs.startsWith(root + path.sep) && abs !== root) || !abs.endsWith(".jsonl")) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Only session files can be deleted" }));
            return;
          }
          if (getRunningInstances().some((i) => i.sessionFile === abs)) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session is owned by a live TUI" }));
            return;
          }
          if (!fs.existsSync(abs)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          fs.unlinkSync(abs);
          invalidateSessionSummary(abs);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Session rename — appends a session_info entry, mirroring what pi does
    // when a session is renamed. History files only: files owned by
    // another running session are refused (ADR-003: never write a live
    // session's file from a second process).
    if (urlPath === "/api/sessions/rename" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, (body) => {
        try {
          const { dirName, file, name } = JSON.parse(body);
          const clean = typeof name === "string" ? name.trim().slice(0, 120) : "";
          if (!clean) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Name cannot be empty" }));
            return;
          }
          if (typeof dirName !== "string" || typeof file !== "string" || !file.endsWith(".jsonl")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "dirName and a .jsonl file are required" }));
            return;
          }
          const root = path.resolve(SESSIONS_DIR);
          const abs = path.resolve(path.join(SESSIONS_DIR, dirName, file));
          if (abs !== root && !abs.startsWith(root + path.sep)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden" }));
            return;
          }
          if (!fs.existsSync(abs)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          const liveOwner = getRunningInstances().find((i) => i.sessionFile === abs);
          if (liveOwner) {
            const rc = liveCtx();
            if (rc && liveOwner.pid === process.pid) {
              const ownFile = rc.sessionManager.getSessionFile();
              if (ownFile === abs) {
                pi.setSessionName(clean);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: true, name: clean }));
                return;
              }
            }
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session is owned by a live TUI — rename it there" }));
            return;
          }
          // parentId = id of the last entry, so the tree stays well-formed.
          let parentId: string | null = null;
          try {
            const stat = fs.statSync(abs);
            const fd = fs.openSync(abs, "r");
            const tail = Buffer.alloc(Math.min(4096, stat.size));
            fs.readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length));
            fs.closeSync(fd);
            const lines = tail.toString("utf8").split("\n").filter((l) => l.trim());
            for (let k = lines.length - 1; k >= 0; k--) {
              try { const e = JSON.parse(lines[k]); if (e && typeof e.id === "string") { parentId = e.id; break; } } catch {}
            }
          } catch {}
          const entry = { type: "session_info", id: require("node:crypto").randomUUID(), parentId, timestamp: new Date().toISOString(), name: clean };
          fs.appendFileSync(abs, JSON.stringify(entry) + "\n", "utf8");
          invalidateSessionSummary(abs);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, name: clean }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Export a history session to HTML. The WS `export_html` command only
    // knows the hub process's own session (ctx), so the sidebar's per-item
    // Export button needs this: same `pi --export` CLI pointed at the
    // selected history file. Read-only — safe on any file.
    if (urlPath === "/api/sessions/export" && req.method === "POST") {
      readBody(req, res, BODY_LIMIT_JSON, (body) => {
        try {
          const { dirName, file } = JSON.parse(body);
          if (typeof dirName !== "string" || typeof file !== "string" || !file.endsWith(".jsonl")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "dirName and a .jsonl file are required" }));
            return;
          }
          const root = path.resolve(SESSIONS_DIR);
          const abs = path.resolve(path.join(SESSIONS_DIR, dirName, file));
          if (abs !== root && !abs.startsWith(root + path.sep)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden" }));
            return;
          }
          if (!fs.existsSync(abs)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          // Explicit output next to the input (inside the session store, so
          // /api/file/download can serve it). No shell: argv only.
          const outAbs = abs.replace(/\.jsonl$/, ".html");
          const { execFileSync } = require("node:child_process");
          const piBin = process.env.PI_WEB_PI_BIN || process.env.TAU_PI_BIN || "pi";
          execFileSync(piBin, ["--export", abs, outAbs], { cwd: process.cwd(), timeout: 60000, encoding: "utf-8" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, path: outAbs }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Download for files the server itself produced (export_html output).
    // Constrained to .html under the session store — not a general file pipe.
    if ((urlPath === "/api/file/download" || urlPath.startsWith("/api/file/download?")) && req.method === "GET") {
      try {
        const dlUrl = new URL(`http://localhost${req.url}`);
        const qp = dlUrl.searchParams.get("path") || "";
        const root = path.resolve(SESSIONS_DIR);
        const abs = path.resolve(qp);
        if (!qp || (!abs.startsWith(root + path.sep) && abs !== root) || path.extname(abs).toLowerCase() !== ".html") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Only exported HTML under the session store can be downloaded" }));
          return;
        }
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error("Not a file");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="${path.basename(abs).replace(/"/g, "")}"`,
        });
        fs.createReadStream(abs).pipe(res);
      } catch (err: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Not found" }));
      }
      return;
    }

    // Memoryd check
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ═══════════════════════════════════════
  // Sessions list endpoint
  // ═══════════════════════════════════════
  // ── P1/P5: session-store caches ──
  // serveSessionsList used to fully re-parse every .jsonl on every
  // GET /api/sessions (0.31–0.41 s at ~95 sessions, polled every 15 s).
  // Parsed summaries are cached per absolute path and validated by
  // (mtimeMs, size): an unchanged file is never re-parsed, while a
  // rename/fork/delete that touches a file changes its stat (or removes
  // it) so the next request re-reads exactly that file. Response shapes
  // are unchanged — the cache only skips the re-parse.
  type SessionSummaryCacheEntry = { mtimeMs: number; size: number; parsed: any };
  const sessionSummaryCache = new Map<string, SessionSummaryCacheEntry>();
  const SESSION_SUMMARY_CACHE_MAX = 2000;
  // P5: /api/projects rolls up the same store. A per-request readdir+stat
  // of every session file is cached briefly as a built map; mutation
  // endpoints (rename/delete/fork) reset it via invalidateSessionSummary,
  // so hub-driven changes are immediate and only external writes lag by
  // the TTL at most.
  let sessionInfoMapCache: { at: number; map: Map<string, { count: number; lastActive: number }> } = {
    at: 0,
    map: new Map(),
  };
  const SESSION_INFO_MAP_TTL_MS = 10000;
  function invalidateSessionSummary(filePath: string): void {
    sessionSummaryCache.delete(filePath);
    sessionInfoMapCache.at = 0;
  }
  async function cachedParseSessionFile(
    filePath: string,
    readline: any
  ): Promise<{ parsed: any; mtimeMs: number; size: number } | null> {
    let mtimeMs = 0;
    let size = 0;
    try {
      const stat = fs.statSync(filePath);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      sessionSummaryCache.delete(filePath);
      return null;
    }
    const hit = sessionSummaryCache.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
      return { parsed: hit.parsed, mtimeMs, size };
    }
    const parsed = await parseSessionFile(filePath, readline);
    // Cache negative results too (header-less one-shots): the
    // (mtimeMs, size) key re-parses as soon as the file grows.
    if (sessionSummaryCache.size >= SESSION_SUMMARY_CACHE_MAX && !sessionSummaryCache.has(filePath)) {
      const oldest = sessionSummaryCache.keys().next().value;
      if (oldest !== undefined) sessionSummaryCache.delete(oldest);
    }
    sessionSummaryCache.set(filePath, { mtimeMs, size, parsed });
    return { parsed, mtimeMs, size };
  }
  function sweepSessionSummaryCache(seen: Set<string>): void {
    // Drop entries for files the store scan no longer lists (deleted or
    // renamed away) so the map cannot accumulate stale entries over time.
    for (const key of sessionSummaryCache.keys()) {
      if (!seen.has(key)) sessionSummaryCache.delete(key);
    }
  }

  // tmux live-file detection used to spawn tmux/pgrep/lsof subprocesses on
  // every /api/sessions call. The result is cached briefly; when tmux is
  // not installed the negative answer is remembered for the process.
  let tmuxInstalled: boolean | null = null;
  let tmuxFilesCache: Set<string> = new Set();
  let tmuxFilesCacheAt = 0;
  const TMUX_FILES_CACHE_TTL_MS = 8000;
  function getTmuxSessionFiles(): Set<string> {
    if (process.platform === "win32") return new Set();
    if (tmuxInstalled === false) return new Set();
    if (Date.now() - tmuxFilesCacheAt < TMUX_FILES_CACHE_TTL_MS) return tmuxFilesCache;
    try {
      const { execSync } = require("node:child_process");
      if (tmuxInstalled === null) {
        try {
          execSync("command -v tmux 2>/dev/null", { encoding: "utf8" });
          tmuxInstalled = true;
        } catch {
          tmuxInstalled = false;
          return new Set();
        }
      }
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
      tmuxFilesCache = tmuxFiles;
      tmuxFilesCacheAt = Date.now();
      return tmuxFiles;
    } catch {
      // No tmux server (or no panes): remember the empty answer briefly so
      // the failure path does not respawn subprocesses on every request.
      tmuxFilesCache = new Set();
      tmuxFilesCacheAt = Date.now();
      return tmuxFilesCache;
    }
  }

  // The explorer's root set: `tau.projectsDir` (every subdir is a project)
  // plus any explicit `tau.projects[]` entries (which may live anywhere).
  function resolveProjectsRoots(): { dir: string | null; extras: string[] } {
    const expand = (p: string) => (p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p);
    const rawDir = TAU_SETTINGS.projectsDir;
    return {
      dir: rawDir ? expand(rawDir) : null,
      extras: (TAU_SETTINGS.projects || []).map(expand),
    };
  }

  // Session counts + recency per project path, TTL-cached (P5) so
  // /api/projects does not readdir+stat the whole store per request.
  function buildSessionInfoMap(): Map<string, { count: number; lastActive: number }> {
    if (Date.now() - sessionInfoMapCache.at < SESSION_INFO_MAP_TTL_MS) return sessionInfoMapCache.map;
    const map = new Map<string, { count: number; lastActive: number }>();
    if (!fs.existsSync(SESSIONS_DIR)) return map;
    for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const sessionDir = path.join(SESSIONS_DIR, dir.name);
      let files: string[] = [];
      try { files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      let lastMtime = 0;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(sessionDir, f));
          if (stat.mtimeMs > lastMtime) lastMtime = stat.mtimeMs;
        } catch {}
      }
      // Key by both the encoded dir name and the lossy-decoded path so an
      // exact candidate match wins and a cross-version dir still lines up.
      const info = { count: files.length, lastActive: lastMtime };
      map.set(dir.name, info);
      const decoded = lossyDecodeSessionDir(dir.name);
      if (!map.has(decoded)) map.set(decoded, info);
    }
    sessionInfoMapCache = { at: Date.now(), map };
    return map;
  }

  function serveProjectsList(res: http.ServerResponse) {
    const { dir, extras } = resolveProjectsRoots();
    if (!dir && extras.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: [], roots: [] }));
      return;
    }

    try {
      const instances = getRunningInstances();
      const sessionInfo = buildSessionInfoMap();
      const projects: any[] = [];
      const seen = new Set<string>();

      const addProject = (fullPath: string, name: string) => {
        const key = path.resolve(fullPath);
        if (seen.has(key)) return;
        seen.add(key);
        const info = sessionInfo.get(cwdToSessionDir(fullPath)) || sessionInfo.get(key) || { count: 0, lastActive: 0 };
        projects.push({
          name,
          path: fullPath,
          sessionCount: info.count,
          lastActive: info.lastActive || null,
          active: instances.some((i) => i.cwd === fullPath),
        });
      };

      if (dir && fs.existsSync(dir)) {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && !e.name.startsWith(".")) addProject(path.join(dir, e.name), e.name);
          }
        } catch {}
      }
      for (const p of extras) {
        try {
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) addProject(p, path.basename(p) || p);
        } catch {}
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects, roots: [dir, ...extras].filter(Boolean) }));
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
      const seen = new Set<string>();

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        // Display fallback only — the authoritative project path comes from
        // the session headers' cwd below (the dir encoding is lossy).

        const sessions: any[] = [];

        for (const file of files) {
          try {
            const filePath = path.join(projectDir, file);
            const cached = await cachedParseSessionFile(filePath, readline);
            if (!cached) continue;
            seen.add(filePath);
            if (cached.parsed) {
              const isTmux = tmuxFiles.has(filePath);
              sessions.push({ ...cached.parsed, file, filePath, mtime: cached.mtimeMs, ...(isTmux && { tmux: true }) });
            }
          } catch { /* skip */ }
        }

        sessions.sort((a, b) => b.mtime - a.mtime);

        if (sessions.length > 0) {
          // Project path = most common header cwd across its sessions
          // (exact even when the project name contains dashes); the lossy
          // dir decode is only the last-resort fallback.
          const cwdCounts = new Map<string, number>();
          for (const s of sessions) {
            if (s.cwd && typeof s.cwd === "string") cwdCounts.set(s.cwd, (cwdCounts.get(s.cwd) || 0) + 1);
          }
          let bestCwd: string | null = null;
          let bestN = 0;
          for (const [c, n] of cwdCounts) {
            if (n > bestN) { bestN = n; bestCwd = c; }
          }
          projects.push({ path: bestCwd || lossyDecodeSessionDir(dir.name), dirName: dir.name, sessions });
        }
      }

      sweepSessionSummaryCache(seen);
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
    // Traversal rejection: dirName/file come from the URL. `..` segments
    // would otherwise escape SESSIONS_DIR (e.g. reading settings.json,
    // which may hold tau credentials).
    if (!file.endsWith(".jsonl")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not a session file" }));
      return;
    }
    const root = path.resolve(SESSIONS_DIR);
    const filePath = path.resolve(path.join(SESSIONS_DIR, dirName, file));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

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
    let assistantMessageCount = 0;
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
        } else if (entry.type === "message" && entry.message?.role === "assistant") {
          // Only a real assistant turn counts; an aborted run can leave an
          // empty assistant entry behind.
          const content = entry.message.content;
          const hasText = typeof content === "string"
            ? content.trim().length > 0
            : Array.isArray(content) && content.some((b: any) => b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0);
          if (hasText) assistantMessageCount++;
        }
      } catch { /* skip */ }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    if (!header?.id) return null;
    // Hide empty scratch sessions (no user turn) and incomplete one-shot pipe
    // runs (a lone user message that never got an assistant reply). A finished
    // single-turn session is real and must stay listed/resumable — the old
    // `lineCount <= 8` rule also hid those, which broke reload of a fresh
    // web-started session.
    if (userMessageCount === 0) return null;
    if (userMessageCount <= 1 && assistantMessageCount === 0 && lineCount <= 8) return null;

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

  // File browsing is allowlisted (AGENTS.md: no unauthenticated filesystem
  // exposure). Roots are the user home, the configured project roots, and any
  // explicit TAU_FS_ROOTS. Session-driven browsing always lands inside these.
  function fsAllowedRoots(): string[] {
    const roots: string[] = [];
    if (process.env.HOME) roots.push(process.env.HOME);
    const { dir, extras } = resolveProjectsRoots();
    if (dir) roots.push(dir);
    roots.push(...extras);
    for (const r of (process.env.TAU_FS_ROOTS || "").split(/[:,]/)) {
      if (r.trim()) roots.push(r.trim());
    }
    return [...new Set(roots.map((r) => path.resolve(r)))];
  }

  function isPathAllowed(target: string): boolean {
    const resolved = path.resolve(target);
    return fsAllowedRoots().some((root) => resolved === root || resolved.startsWith(root + path.sep));
  }

  // Symlink-aware jail for S4/S14: `isPathAllowed` above is a string-prefix
  // check on the unresolved path, so a symlink inside an allowed root that
  // points outside (secret.png -> ~/.pi/agent/settings.json) still passes.
  // Callers that touch the filesystem resolve with fs.realpathSync first and
  // jail the resolved target against the resolved roots.
  function isRealPathAllowed(realAbs: string): boolean {
    const roots = fsAllowedRoots().map((r) => {
      try { return fs.realpathSync(r); } catch { return r; }
    });
    return roots.some((root) => realAbs === root || realAbs.startsWith(root + path.sep));
  }

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!isPathAllowed(dirPath)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Path outside allowed roots", roots: fsAllowedRoots() }));
        return;
      }
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
      res.end(JSON.stringify({ path: dirPath, parent: path.dirname(dirPath), items }));
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
        const decodedPath = lossyDecodeSessionDir(dir.name);
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
            let sessionCwd = "";
            let firstMessage = "";
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                  if (typeof entry.cwd === "string" && entry.cwd) sessionCwd = entry.cwd;
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
                project: sessionCwd || decodedPath,
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
    // S10: cap a single inbound client frame (deltas are bytes–KBs); a
    // >2 MiB frame is rejected by ws (close 1009) without crashing the hub.
    wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
    try { wss.on("error", (e: any) => tauLog(`[tau-web] WS server error: ${e?.message || e}`)); } catch {}

    server.on("upgrade", async (request, socket, head) => {
      if (!checkRequestOrigin(request)) {
        tauLog(`[tau-web] WS upgrade rejected (host=${request.headers.host} origin=${request.headers.origin})`);
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      // S12: same Basic backoff as the HTTP gate — cookie first (no
      // accounting), Basic success clears, Basic failure records and waits
      // progressively (capped ~2s) before the 401.
      if (authEnabled) {
        if (checkCookieAuth(request)) {
          // Cookie valid — no Basic accounting.
        } else {
          const creds = parseBasicCredentials(request.headers.authorization as string);
          if (!creds || !credentialsMatch(creds.user, creds.pass)) {
            if (creds) {
              const fails = recordBasicFailure(request);
              const wait = basicBackoffMs(fails);
              if (wait > 0) await sleepAuthBackoff(wait);
            }
            try { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); } catch {}
            socket.destroy();
            return;
          }
          clearBasicFailures(request);
        }
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

      // Send initial state. The hub owns no session of its own — the
      // browser's transcript comes from a headless child (start_session /
      // rpc_command) — so no snapshot follows; the view binds headless.
      sendTo(ws, { type: "state", isStreaming: false, mode: role });

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
        const subBefore = hubUplinkSubs.get(ws);
        clients.delete(ws);
        try { headless.detach(ws); } catch {}
        hubDetachUplink(ws);
        // S9: a browser that disconnects mid-dialog releases the dialog —
        // headless waiters get extension_ui_response {cancelled:true}, hub
        // waiters get dialog_relay {cancelled:true} when nobody else drives
        // the mirror — so a parked dialog cannot hang a child.
        try { releaseDialogsForBrowser(subBefore?.mirrorId); } catch {}
      });

      ws.on("error", (e) => {
        tauLog("[Mirror] Client error:", e);
        const subBefore = hubUplinkSubs.get(ws);
        clients.delete(ws);
        try { headless.detach(ws); } catch {}
        hubDetachUplink(ws);
        try { releaseDialogsForBrowser(subBefore?.mirrorId); } catch {}
      });
    });

    // Heartbeat keeps mobile/Tailscale sessions alive and removes stale clients.
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.readyState !== WebSocket.OPEN) {
          const subBefore = hubUplinkSubs.get(client);
          clients.delete(client);
          try { headless.detach(client); } catch {}
          hubDetachUplink(client);
          try { releaseDialogsForBrowser(subBefore?.mirrorId); } catch {}
          continue;
        }

        if (!(client as any).isAlive) {
          const subBefore = hubUplinkSubs.get(client);
          try { client.terminate(); } catch {}
          clients.delete(client);
          try { headless.detach(client); } catch {}
          hubDetachUplink(client);
          try { releaseDialogsForBrowser(subBefore?.mirrorId); } catch {}
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
      tauLog(`[tau-web] Hub server running on ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}`);
      ctx.ui.setStatus("mirror", `Hub: ${localIp}:${port}${tailscaleIp ? ` • TS: ${tailscaleIp}:${port}` : ""}`);

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

      ctx.ui.notify(`Tau hub: ${mirrorUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ""}`, "info");
    };

    tryListen(PORT);
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    role = resolveRole(ctx);
    try { wrapUiDialogs(ctx); } catch (e) { tauLog("[tau-web] wrapUiDialogs failed:", (e as any)?.message || e); }

    // Skip mirror startup in subagent child processes
    // (pi-subagents sets PI_SUBAGENT_CHILD=1; child processes loading Tau
    // should not attempt to start their own mirror server)
    if (process.env.PI_SUBAGENT_CHILD === "1") {
      tauDebug("[Mirror] Subagent child process detected (PI_SUBAGENT_CHILD=1), skipping auto-start.");
      return;
    }

    // Role transport (ADR-010): the hub listens on the private socket, a
    // mirror dials it. Started only when this process is a real server — a
    // headless child (`TAU_DISABLED=1`) must never bind hub.sock or the
    // registry, or it would fight the hub that spawned it.
    if (!TAU_AUTO_START) {
      tauDebug("[Mirror] Tau auto-start disabled (TAU_DISABLED=1).");
      return;
    }

    if (role === "hub") {
      startHubSocket();
      startServer(ctx);
    } else {
      // Mirror role serves no HTTP (ADR-014: no per-TUI port) — it dials
      // the hub and relays attach/drive through hub.sock only.
      startHubForwarder();
    }
  });

  // ═══════════════════════════════════════
  // Cleanup on shutdown
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async () => {
    try { hubSockets?.stop(); } catch {}
    hubSockets = null;
    try { hubForwarder?.stop(); } catch {}
    hubForwarder = null;
    hubUplinkSubs.clear();
    hubDialogOwner.clear();
    stopServer();
    tauDebug("[Mirror] Server shut down");
  });
}
