/**
 * socket — hub.sock NDJSON transport. The hub listens, mirrors dial.
 * 0700 directory + 0600 socket: kernel UID perms are the authenticator
 * (ADR-010/014), no PSK.
 *
 * Stale-path safety (B9): a live socket is never hijacked; only a path that
 * refuses a connect is reclaimed. `stop()` only unlinks its own inode.
 */
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { hubLog } from "../log.js";

function probeSocket(sockPath: string, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let done = false;
    const finish = (alive: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(alive);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), timeoutMs).unref?.();
  });
}

interface Conn {
  socket: net.Socket;
  buffer: string;
  pid?: number;
}

export class HubSocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private conns = new Set<Conn>();
  private ownedIno: bigint | null = null;

  constructor(private sockPath: string) {
    super();
  }

  async start(): Promise<void> {
    const dir = path.dirname(this.sockPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
    if (fs.existsSync(this.sockPath)) {
      if (await probeSocket(this.sockPath)) {
        throw new Error(`another hub is listening on ${this.sockPath}`);
      }
      try {
        fs.unlinkSync(this.sockPath);
      } catch {}
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.once("error", reject);
      server.listen(this.sockPath, () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
    try {
      fs.chmodSync(this.sockPath, 0o600);
      this.ownedIno = fs.statSync(this.sockPath).ino;
    } catch {}
  }

  private onConnection(socket: net.Socket): void {
    const conn: Conn = { socket, buffer: "" };
    this.conns.add(conn);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      conn.buffer += chunk;
      let idx = conn.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = conn.buffer.slice(0, idx).replace(/\r$/, "").trim();
        conn.buffer = conn.buffer.slice(idx + 1);
        if (line) {
          try {
            const frame = JSON.parse(line);
            if (frame && typeof frame.pid === "number") conn.pid = frame.pid;
            this.emit("frame", frame, (reply: any) => this.sendTo(conn, reply));
          } catch {
            hubLog("socket: malformed frame dropped");
          }
        }
        idx = conn.buffer.indexOf("\n");
      }
    });
    const drop = () => {
      this.conns.delete(conn);
      if (conn.pid) this.emit("close", conn.pid);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private sendTo(conn: Conn, frame: any): void {
    if (conn.socket.destroyed) return;
    try {
      conn.socket.write(`${JSON.stringify(frame)}\n`);
    } catch {}
  }

  sendToPid(pid: number, frame: any): boolean {
    for (const conn of this.conns) {
      if (conn.pid === pid) {
        this.sendTo(conn, frame);
        return true;
      }
    }
    return false;
  }

  broadcast(frame: any): void {
    for (const conn of this.conns) this.sendTo(conn, frame);
  }

  count(): number {
    return this.conns.size;
  }

  stop(): void {
    for (const conn of this.conns) {
      try {
        conn.socket.destroy();
      } catch {}
    }
    this.conns.clear();
    try {
      this.server?.close();
    } catch {}
    this.server = null;
    try {
      if (this.ownedIno !== null && fs.statSync(this.sockPath).ino === this.ownedIno) {
        fs.unlinkSync(this.sockPath);
      }
    } catch {}
  }
}

export class HubSocketClient extends EventEmitter {
  connected = false;
  private socket: net.Socket | null = null;
  private buffer = "";
  private stopped = false;
  private retryMs = 1000;

  constructor(private sockPath: string) {
    super();
  }

  connect(): void {
    this.stopped = false;
    this.dial();
  }

  private dial(): void {
    if (this.stopped) return;
    const socket = net.connect(this.sockPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.connected = true;
      this.retryMs = 1000;
      this.emit("connected");
    });
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "").trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) {
          try {
            this.emit("frame", JSON.parse(line));
          } catch {}
        }
        idx = this.buffer.indexOf("\n");
      }
    });
    const retry = () => {
      if (this.connected) this.emit("disconnected");
      this.connected = false;
      this.socket = null;
      if (this.stopped) return;
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 30000);
      setTimeout(() => this.dial(), wait).unref?.();
    };
    socket.on("close", retry);
    socket.on("error", () => {
      try {
        socket.destroy();
      } catch {}
    });
  }

  send(frame: any): void {
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(`${JSON.stringify(frame)}\n`);
    } catch {}
  }

  stop(): void {
    this.stopped = true;
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = null;
    this.connected = false;
  }
}
