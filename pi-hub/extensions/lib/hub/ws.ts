/**
 * ws — one browser connection. A connection binds one runner (the sidebar is
 * the switcher, ADR-008), receives that runner's event stream, and may be the
 * single driver of a live TUI (ADR-014). Deltas are coalesced per client.
 */
import type * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Auth } from "./auth.js";
import type { DialogBroker } from "./dialogs.js";
import type { RunnerRegistry } from "../runners/registry.js";
import { RPC_COMMANDS, streamDelta } from "../protocol.js";
import { hubDebug, hubLog } from "../log.js";

const MAX_BUFFERED = 1024 * 1024;

interface Client {
  id: number;
  ws: WebSocket;
  boundId: string | null;
  driverId: string | null;
  lastSeq: number;
  deltaText: string;
  deltaThinking: string;
  deltaTpl: any;
  deltaTimer: NodeJS.Timeout | null;
}

export interface WsDeps {
  auth: Auth;
  registry: RunnerRegistry;
  dialogs: DialogBroker;
  version: string;
  resolveSessionPath: (dirName: string, file: string) => string;
  defaultCwd: string;
}

export class WsHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private driverByRunner = new Map<string, Client>();
  private nextId = 1;

  constructor(private deps: WsDeps) {
    deps.registry.onFrame((frame) => this.fanOut(frame));
  }

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!this.deps.auth.wsAuthenticated(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  close(): void {
    for (const c of this.clients) {
      try {
        c.ws.close();
      } catch {}
    }
    this.clients.clear();
    this.driverByRunner.clear();
    try {
      this.wss?.close();
    } catch {}
    this.wss = null;
  }

  broadcast(frame: any): void {
    for (const c of this.clients) this.send(c, frame);
  }

  private send(c: Client, frame: any): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    if ((c.ws as any).bufferedAmount > MAX_BUFFERED) return;
    try {
      c.ws.send(JSON.stringify(frame));
    } catch {}
  }

  /** Flush coalesced deltas before any non-delta frame so order is intact. */
  private flushDeltas(c: Client): void {
    if (c.deltaTimer) {
      clearTimeout(c.deltaTimer);
      c.deltaTimer = null;
    }
    if (c.deltaTpl && (c.deltaText || c.deltaThinking)) {
      const ev = JSON.parse(JSON.stringify(c.deltaTpl.event));
      ev.assistantMessageEvent.delta = c.deltaText || c.deltaThinking;
      this.send(c, { type: "event", ...c.deltaTpl, event: ev });
    }
    c.deltaText = "";
    c.deltaThinking = "";
    c.deltaTpl = null;
  }

  private deliver(c: Client, frame: any): void {
    const delta = streamDelta(frame);
    if (delta) {
      if (!delta.delta) return;
      if (!c.deltaTpl) c.deltaTpl = frame;
      if (delta.kind === "text") c.deltaText += delta.delta;
      else c.deltaThinking += delta.delta;
      if (!c.deltaTimer) {
        c.deltaTimer = setTimeout(() => this.flushDeltas(c), 40);
        (c.deltaTimer as any).unref?.();
      }
      return;
    }
    this.flushDeltas(c);
    this.send(c, { type: "event", ...frame });
  }

  private fanOut(frame: any): void {
    const runner = this.deps.registry.get(frame.runnerId);
    if (!runner) return;
    // Dialog requests are registered once (owner-broker) and broadcast as
    // `dialog` frames — never re-sent per bound client (ADR-007).
    if (
      frame.event?.type === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(frame.event.method)
    ) {
      this.deps.dialogs.registerHeadless(frame.runnerId, frame.event);
      return;
    }
    for (const c of this.clients) {
      if (c.boundId !== frame.runnerId) continue;
      if (frame.seq > c.lastSeq + 1 && c.lastSeq > 0) {
        for (const missed of runner.replayFrom(c.lastSeq)) this.deliver(c, missed);
      }
      c.lastSeq = frame.seq;
      hubDebug(`ws[${c.id}] <- ${frame.runnerId} seq=${frame.seq} ${frame.event?.type || "?"}`);
      this.deliver(c, frame);
    }
  }

  /** Called by the relay when a mirror dialog arrives (not bound to a WS). */
  broadcastDialog(frame: any): void {
    this.broadcast(frame);
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = {
      id: this.nextId++,
      ws,
      boundId: null,
      driverId: null,
      lastSeq: 0,
      deltaText: "",
      deltaThinking: "",
      deltaTpl: null,
      deltaTimer: null,
    };
    this.clients.add(client);
    ws.on("pong", () => {});
    ws.on("message", (data) => this.onMessage(client, String(data)));
    ws.on("close", () => this.cleanup(client));
    ws.on("error", () => this.cleanup(client));
    this.send(client, {
      type: "hello",
      version: this.deps.version,
      mode: "hub",
      auth: this.deps.auth.enabled,
      features: ["runners", "live", "dialogs", "files", "processes"],
    });
    this.send(client, { type: "runners", runners: this.deps.registry.list().map((r) => r.info()) });
  }

  private cleanup(client: Client): void {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    if (client.deltaTimer) clearTimeout(client.deltaTimer);
    if (client.boundId) this.deps.registry.unbind(client.ws);
    for (const [runnerId, driver] of this.driverByRunner) {
      if (driver === client) {
        this.driverByRunner.delete(runnerId);
        this.broadcast({ type: "detached", runnerId, reason: "browser disconnected" });
      }
    }
  }

  private ack(client: Client, id: string | undefined, frame: any): void {
    this.send(client, { ...frame, id });
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(client, { type: "error", message: "invalid JSON" });
    }
    hubDebug(`ws[${client.id}] recv ${msg.type}${msg.id ? ` id=${msg.id}` : ""}`);
    const id = typeof msg.id === "string" ? msg.id : undefined;
    try {
      switch (msg.type) {
        case "ping":
          return this.send(client, { type: "pong" });
        case "bind":
          return await this.handleBind(client, id, msg);
        case "rpc_command":
        case "command":
          return this.handleCommand(client, id, msg.command || msg);
        case "attach":
          return this.handleAttach(client, id, msg);
        case "detach":
          return this.handleDetach(client, id);
        case "unbind": {
          if (client.boundId) this.deps.registry.unbind(client.ws);
          client.boundId = null;
          client.lastSeq = 0;
          return this.ack(client, id, { type: "unbound" });
        }
        case "close":
          return this.handleClose(client, id, msg);
        case "extension_ui_response":
          this.deps.dialogs.resolve(msg.id || id, msg);
          return this.ack(client, id, { type: "ack" });
        case "instances":
          return this.ack(client, id, {
            type: "response",
            command: "instances",
            success: true,
            data: { instances: this.deps.registry.list().map((r) => r.info()) },
          });
        default:
          return this.send(client, { type: "error", message: `unknown message type: ${msg.type}` });
      }
    } catch (e: any) {
      this.send(client, { type: "error", id, message: e?.message || String(e) });
    }
  }

  private async handleBind(client: Client, id: string | undefined, msg: any): Promise<void> {
    let runner;
    if (msg.runnerId) {
      runner = this.deps.registry.get(msg.runnerId);
      if (!runner) throw new Error("runner not found");
      this.deps.registry.bind(client.ws, runner);
    } else if (msg.dirName && msg.file) {
      const abs = this.deps.resolveSessionPath(msg.dirName, msg.file);
      runner = await this.deps.registry.bindHeadless(client.ws, { cwd: msg.cwd || this.deps.defaultCwd, absFile: abs });
    } else {
      const cwd = String(msg.cwd || this.deps.defaultCwd);
      runner = await this.deps.registry.bindHeadless(client.ws, { cwd, absFile: null });
    }
    client.boundId = runner.id;
    client.lastSeq = 0;
    this.ack(client, id, { type: "bound", runner: runner.info(), lastSeq: runner.lastSeq() });
  }

  private handleCommand(client: Client, id: string | undefined, command: any): void {
    const runner = client.boundId ? this.deps.registry.get(client.boundId) : undefined;
    if (!runner) {
      this.send(client, { type: "error", id, message: "no runner bound" });
      return;
    }
    if (command?.type && !RPC_COMMANDS.has(command.type)) {
      this.send(client, { type: "error", id, message: `command not allowed: ${command.type}` });
      return;
    }
    runner.command(command);
    this.ack(client, id, { type: "ack", command: command?.type });
  }

  private handleAttach(client: Client, id: string | undefined, msg: any): void {
    const runner = this.deps.registry.get(msg.runnerId || client.boundId || "");
    if (!runner || runner.kind !== "live") throw new Error("not a live runner");
    const holder = this.driverByRunner.get(runner.id);
    if (holder && holder !== client && !msg.take) {
      this.send(client, { type: "driver_busy", id, runnerId: runner.id, heldBy: holder.id });
      return;
    }
    if (holder && holder !== client) {
      holder.driverId = null;
      this.send(holder, { type: "detached", runnerId: runner.id, reason: "driver taken over" });
    }
    client.driverId = runner.id;
    this.driverByRunner.set(runner.id, client);
    this.ack(client, id, { type: "attached", runnerId: runner.id, runner: runner.info() });
  }

  private handleDetach(client: Client, id: string | undefined): void {
    if (client.driverId) {
      this.driverByRunner.delete(client.driverId);
      this.ack(client, id, { type: "detached", runnerId: client.driverId, reason: "user" });
      client.driverId = null;
    } else {
      this.ack(client, id, { type: "detached" });
    }
  }

  private handleClose(client: Client, id: string | undefined, msg: any): void {
    const runnerId = msg.runnerId || client.boundId;
    const runner = runnerId ? this.deps.registry.get(runnerId) : undefined;
    if (!runner) throw new Error("runner not found");
    if (runner.kind === "headless") {
      this.deps.registry.closeById(runner.id);
      this.ack(client, id, { type: "closed", runnerId: runner.id });
    } else {
      this.ack(client, id, { type: "error", message: "live sessions are killed from the process list" });
    }
  }

  isDriver(runnerId: string, clientId: number): boolean {
    return this.driverByRunner.get(runnerId)?.id === clientId;
  }

  driverId(runnerId: string): number | null {
    return this.driverByRunner.get(runnerId)?.id ?? null;
  }

  noteRunnerRemoved(runnerId: string): void {
    this.driverByRunner.delete(runnerId);
  }

  heartbeat(): void {
    for (const c of this.clients) {
      try {
        c.ws.ping();
      } catch {
        hubLog("ws heartbeat failed");
      }
    }
  }
}
