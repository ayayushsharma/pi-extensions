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

/**
 * Short liveness probe for a socket path: resolves true when a listener
 * answers (live hub — the file must not be touched), false when dialing
 * fails fast (stale file or no listener). A connect that hangs is treated
 * as live: unlinking on a timeout could steal a loaded hub's socket.
 */
function probeSocketLive(sockPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let sock: net.Socket | null = null;
    const timer = setTimeout(() => finish(true), timeoutMs);
    function finish(live: boolean): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* already gone */ }
      resolve(live);
    }
    try {
      sock = net.connect(sockPath);
    } catch {
      finish(false);
      return;
    }
    sock.on("connect", () => finish(true));
    sock.on("error", () => finish(false));
  });
}

/** True while `p` is still the exact socket file we bound (same inode). */
function isOurSocket(ours: { path: string; dev: number; ino: number }): boolean {
  try {
    const cur = fs.statSync(ours.path);
    return cur.dev === ours.dev && cur.ino === ours.ino;
  } catch { return false; } // no file — nothing of ours to remove
}

/** Remove `ours.path`, but only while it is still the file we bound. */
function removeIfOurs(ours: { path: string; dev: number; ino: number }): void {
  if (!isOurSocket(ours)) return;
  try { fs.unlinkSync(ours.path); } catch { /* raced */ }
}

// ═══════════════════════════════════════
// Hub side (listener)
// ═══════════════════════════════════════

export class HubSocketServer {
  private server: net.Server | null = null;
  private conns = new Map<string, { sock: net.Socket; rec: MirrorRecord }>();
  private byPid = new Map<number, string>();
  /** Identity (path + inode) of the socket file this instance bound, if any. */
  private boundSocket: { path: string; dev: number; ino: number } | null = null;
  /** Bumps on every start/stop so a stop during an async start cancels it. */
  private startGen = 0;

  constructor(
    private hooks: {
      onHello: (rec: MirrorRecord) => void;
      onUpdate: (rec: MirrorRecord) => void;
      onGone: (rec: MirrorRecord) => void;
      onFrame: (rec: MirrorRecord, frame: Frame) => void;
      onError: (e: Error) => void;
    },
  ) {}

  /**
   * Bind the private socket. Never steals a live hub's path: when something
   * already sits at the socket path, a short connect decides — a live
   * listener answers (report via onError, return false, leave the file
   * alone), while a stale file from a crashed hub is unlinked and bound as
   * before. Resolves true once listening, false when refused or the bind
   * failed (a failed bind also clears the server so start() can be retried).
   */
  async start(): Promise<boolean> {
    if (this.server) return true;
    const gen = ++this.startGen;
    const sockPath = hubSocketPath();
    try {
      fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
    } catch (e) {
      this.hooks.onError(e as Error);
      return false;
    }
    if (fs.existsSync(sockPath)) {
      if (await probeSocketLive(sockPath)) {
        this.hooks.onError(new Error(`hub socket ${sockPath} is already served by a live hub; refusing to steal it`));
        return false;
      }
      if (gen !== this.startGen || this.server) return this.server !== null;
      // Stale socket with no listener — unlink and bind as before.
      try { fs.unlinkSync(sockPath); } catch { /* raced; the bind will tell */ }
    }
    if (gen !== this.startGen || this.server) return this.server !== null;
    let listening = false;
    const server = net.createServer((sock) => this.onConnection(sock));
    server.on("error", (e) => {
      if (!listening && this.server === server) this.server = null;
      this.hooks.onError(e as Error);
    });
    this.server = server;
    let bound: boolean;
    // Earliest observation of the file we just created — a peer following
    // the probe protocol can only replace it after this point, so comparing
    // a later stat against boundId detects a mid-start takeover.
    let boundId: { dev: number; ino: number } | null = null;
    try {
      bound = await new Promise<boolean>((resolve) => {
        const onErr = () => resolve(false);
        server.once("error", onErr);
        server.listen(sockPath, () => {
          listening = true;
          server.removeListener("error", onErr);
          try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
          try {
            const st = fs.statSync(sockPath);
            boundId = { dev: st.dev, ino: st.ino };
          } catch { boundId = null; }
          resolve(true);
        });
      });
    } catch (e) {
      if (this.server === server) this.server = null;
      this.hooks.onError(e as Error);
      return false;
    }
    if (gen !== this.startGen) {
      // stop() ran while binding — tear down only what is still ours.
      // close() itself unlinks the socket path, so it must not run once
      // the file belongs to a newer hub; an orphaned listener fd is
      // unreachable via the path and dies with the process.
      const fresh = boundId ? { path: sockPath, ...boundId } : null;
      if (bound && fresh && isOurSocket(fresh)) {
        try { server.close(); } catch { /* already closed */ }
        removeIfOurs(fresh); // close() usually already unlinked it
      } else if (!bound) {
        try { server.close(); } catch { /* already closed */ }
      } else {
        // Takeover mid-start: unref (not close) so the abandoned listener
        // cannot hold the event loop open.
        try { server.unref(); } catch { /* already closed */ }
      }
      if (this.server === server) this.server = null;
      return false;
    }
    if (!bound) return false;
    this.boundSocket = boundId ? { path: sockPath, ...boundId } : null;
    return true;
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
    this.startGen++;
    for (const conn of this.conns.values()) {
      try { conn.sock.destroy(); } catch { /* already gone */ }
    }
    this.conns.clear();
    this.byPid.clear();
    const server = this.server;
    this.server = null;
    const ours = this.boundSocket;
    this.boundSocket = null;
    // NOTE: server.close() unlinks the socket path itself, so it must only
    // run while the file is still the one we bound — a stopping old hub
    // must never delete (via close or unlink) a newer hub's socket, and a
    // refused/failed start leaves nothing to remove. A server left
    // listening on a superseded path is unreachable and dies with the
    // process; the next start() heals any stale file left behind.
    if (server && ours && isOurSocket(ours)) {
      try { server.close(); } catch { /* already closed */ }
      removeIfOurs(ours); // close() usually already unlinked it
    } else if (!server && ours) {
      removeIfOurs(ours);
    } else if (server) {
      // Takeover (or start still in flight): never close() — it unlinks the
      // path — just unref so an abandoned listener cannot hold the loop.
      try { server.unref(); } catch { /* already closed */ }
    }
    // server without ours (refused/failed/in-flight start): leave it alone —
    // the in-flight start() tears itself down via the generation check.
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
