/**
 * hub-socket — private unix-socket transport between hub and mirrors (ADR-010).
 *
 * The hub (control plane) listens on `~/.pi/tau/hub.sock`; each mirror (data
 * plane / live TUI) dials it and announces itself. Browsers never speak this
 * protocol — they talk to the hub's HTTP/WS port and the hub relays.
 *
 * Auth is the filesystem: the socket sits in a 0700 directory, so only the
 * same UID can dial it. There is no shared secret to create, rotate, or go
 * stale across boot order — a mirror that boots before the hub simply keeps
 * retrying until the socket appears.
 *
 * Framing: newline-delimited JSON. Every frame is `{ type, ... }`.
 *   mirror → hub : hello, status, event, snapshot, response
 *   hub → mirror : drive, snapshot (request), dialog_relay, health
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export type Frame = { type: string; [key: string]: any };

export interface MirrorRecord {
  /** Stable per-connection id. */
  id: string;
  pid: number;
  port: number;
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  model: any;
  isStreaming: boolean;
  connectedAt: number;
}

export function hubSocketPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return process.env.TAU_HUB_SOCKET || path.join(home, ".pi", "tau", "hub.sock");
}

function encode(frame: Frame): string {
  return JSON.stringify(frame) + "\n";
}

/** Split a socket's bytes into newline-delimited JSON frames. */
function attachLineReader(sock: net.Socket, onFrame: (frame: Frame) => void): void {
  let buffer = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try { onFrame(JSON.parse(line)); } catch { /* skip malformed line */ }
      }
      idx = buffer.indexOf("\n");
    }
  });
}

// ═══════════════════════════════════════
// Hub side (listener)
// ═══════════════════════════════════════

export class HubSocketServer {
  private server: net.Server | null = null;
  private conns = new Map<string, { sock: net.Socket; rec: MirrorRecord }>();
  private byPid = new Map<number, string>();

  constructor(
    private hooks: {
      onHello: (rec: MirrorRecord) => void;
      onUpdate: (rec: MirrorRecord) => void;
      onGone: (rec: MirrorRecord) => void;
      onFrame: (rec: MirrorRecord, frame: Frame) => void;
      onError: (e: Error) => void;
    },
  ) {}

  start(): void {
    if (this.server) return;
    const sockPath = hubSocketPath();
    fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
    // A crashed hub can leave a stale socket that blocks bind.
    try { fs.unlinkSync(sockPath); } catch { /* none */ }
    const server = net.createServer((sock) => this.onConnection(sock));
    server.on("error", (e) => this.hooks.onError(e as Error));
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
    });
    this.server = server;
  }

  private onConnection(sock: net.Socket): void {
    let rec: MirrorRecord | null = null;
    attachLineReader(sock, (frame) => {
      if (frame.type === "hello") {
        rec = this.register(sock, frame);
        return;
      }
      if (!rec) return; // frames before hello are ignored
      if (frame.type === "status") { this.update(rec, frame); return; }
      this.hooks.onFrame(rec, frame);
    });
    const drop = () => { if (rec) this.unregister(rec); };
    sock.on("close", drop);
    sock.on("error", () => { /* close handler cleans up */ });
  }

  private register(sock: net.Socket, frame: Frame): MirrorRecord {
    const id = `${frame.pid}-${Date.now().toString(36)}`;
    const rec: MirrorRecord = {
      id,
      pid: Number(frame.pid) || 0,
      port: Number(frame.port) || 0,
      cwd: String(frame.cwd || ""),
      sessionFile: frame.sessionFile || null,
      sessionName: frame.sessionName || null,
      model: frame.model || null,
      isStreaming: !!frame.isStreaming,
      connectedAt: Date.now(),
    };
    this.conns.set(id, { sock, rec });
    if (rec.pid) this.byPid.set(rec.pid, id);
    this.hooks.onHello(rec);
    return rec;
  }

  private update(rec: MirrorRecord, frame: Frame): void {
    if (frame.cwd !== undefined) rec.cwd = String(frame.cwd);
    if (frame.sessionFile !== undefined) rec.sessionFile = frame.sessionFile;
    if (frame.sessionName !== undefined) rec.sessionName = frame.sessionName;
    if (frame.model !== undefined) rec.model = frame.model;
    rec.isStreaming = !!frame.isStreaming;
    this.hooks.onUpdate(rec);
  }

  private unregister(rec: MirrorRecord): void {
    if (!this.conns.delete(rec.id)) return;
    if (this.byPid.get(rec.pid) === rec.id) this.byPid.delete(rec.pid);
    this.hooks.onGone(rec);
  }

  /** Look a mirror up by connection id or pid (browsers carry pids). */
  get(key: string): MirrorRecord | undefined {
    const byId = this.conns.get(key);
    if (byId) return byId.rec;
    const pid = Number(key);
    if (!Number.isFinite(pid)) return undefined;
    const id = this.byPid.get(pid);
    return id ? this.conns.get(id)?.rec : undefined;
  }

  list(): MirrorRecord[] {
    return [...this.conns.values()].map((c) => c.rec);
  }

  send(id: string, frame: Frame): boolean {
    const conn = this.conns.get(id);
    if (!conn || conn.sock.destroyed) return false;
    try { conn.sock.write(encode(frame)); return true; } catch { return false; }
  }

  stop(): void {
    for (const conn of this.conns.values()) {
      try { conn.sock.destroy(); } catch { /* already gone */ }
    }
    this.conns.clear();
    this.byPid.clear();
    try { this.server?.close(); } catch { /* already closed */ }
    this.server = null;
    try { fs.unlinkSync(hubSocketPath()); } catch { /* none */ }
  }
}

// ═══════════════════════════════════════
// Mirror side (dialer)
// ═══════════════════════════════════════

export class HubSocketClient {
  private sock: net.Socket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private backoffMs = 1000;
  connected = false;

  constructor(
    private hooks: {
      hello: () => Frame;
      onCommand: (frame: Frame) => void;
      onError: (e: Error) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.sock) return;
    const sockPath = hubSocketPath();
    // Hub not up yet is normal (boot order); retry without erroring.
    if (!fs.existsSync(sockPath)) { this.scheduleRetry(); return; }

    const sock = net.connect(sockPath);
    this.sock = sock;
    sock.on("connect", () => {
      this.connected = true;
      this.backoffMs = 1000;
      try { sock.write(encode(this.hooks.hello())); } catch { /* retry on close */ }
    });
    attachLineReader(sock, (frame) => this.hooks.onCommand(frame));
    const drop = () => {
      if (this.sock !== sock) return;
      this.connected = false;
      this.sock = null;
      try { sock.destroy(); } catch { /* already gone */ }
      this.scheduleRetry();
    };
    sock.on("close", drop);
    sock.on("error", (e) => { this.hooks.onError(e as Error); drop(); });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, 15000);
      this.connect();
    }, this.backoffMs);
  }

  push(frame: Frame): boolean {
    if (!this.connected || !this.sock || this.sock.destroyed) return false;
    try { this.sock.write(encode(frame)); return true; } catch { return false; }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.sock?.destroy(); } catch { /* already gone */ }
    this.sock = null;
    this.connected = false;
  }
}
