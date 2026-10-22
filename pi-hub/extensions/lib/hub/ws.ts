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
import { RPC_COMMANDS, streamDelta, validateCommandImages } from "../protocol.js";
import { validateExportPath } from "../store/sessions.js";
import { hubDebug, hubLog } from "../log.js";

/**
 * Verbs a previewing browser may send to a live TUI without driving it
 * (ADR-009/014: preview is read-only history + banner, no input). Every
 * other verb mutates the TUI and requires attach (the single driver).
 */
const LIVE_PREVIEW_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_commands",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
]);

const MAX_BUFFERED = 1024 * 1024;

interface Client {
  id: number;
  ws: WebSocket;
  boundId: string | null;
  driverId: string | null;
  /** highest DELIVERED seq: a backpressured drop must not advance it (H5),
   *  or the gap is never replayed. Coalesced deltas commit theirs on flush. */
  lastSeq: number;
  deltaText: string;
  deltaThinking: string;
  /** first buffered seq and highest buffered seq: the coalescer's closed
   *  range. A later frame is contiguous only past deltaSeq, not lastSeq. */
  deltaStart: number;
  deltaSeq: number;
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
  private deps: WsDeps;
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private driverByRunner = new Map<string, Client>();
  private nextId = 1;

  constructor(deps: WsDeps) {
    this.deps = deps;
    deps.registry.onFrame((frame) => this.fanOut(frame));
  }

  attach(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      void this.onUpgrade(req, socket, head).catch(() => {
        try {
          socket.destroy();
        } catch {}
      });
    });
  }

  /** Connection flood guard (S9/S10): one browser holds 1–2 sockets; a
   *  misbehaving client holding hundreds is cut off with 429. */
  private wsCountByIp = new Map<string, number>();
  private static readonly MAX_WS_PER_IP = 32;
  /** Opt-in drive consent (PI_HUB_DRIVE_CONFIRM): set once the relay exists. */
  private driveConfirm = false;
  private driveConfirmer: ((pid: number) => Promise<boolean>) | null = null;

  setDriveConfirm(enabled: boolean, request?: (pid: number) => Promise<boolean>): void {
    this.driveConfirm = enabled;
    this.driveConfirmer = request || null;
  }

  private async onUpgrade(req: http.IncomingMessage, socket: any, head: Buffer): Promise<void> {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!this.deps.auth.hostAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = this.deps.auth.clientIp(req);
    const held = this.wsCountByIp.get(ip) || 0;
    if (held >= WsHub.MAX_WS_PER_IP) {
      hubLog(`ws upgrade refused: ${ip} holds ${held} sockets`);
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const verdict = await this.deps.auth.authenticateRequest(req);
    if (verdict !== "ok") {
      socket.write(
        verdict === "limited"
          ? "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    this.wsCountByIp.set(ip, held + 1);
    socket.once("close", () => {
      const n = (this.wsCountByIp.get(ip) || 1) - 1;
      if (n <= 0) this.wsCountByIp.delete(ip);
      else this.wsCountByIp.set(ip, n);
    });
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
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

  /** Send a runner-scoped frame only to clients bound to that runner. Live
   *  dialogs are driver-only; headless dialogs go to every viewer (first
   *  answer wins, the rest are closed by the broker). */
  sendToRunner(runnerId: string, frame: any, opts: { driverOnly?: boolean } = {}): void {
    const driver = opts.driverOnly ? this.driverByRunner.get(runnerId) : undefined;
    for (const c of this.clients) {
      if (c.boundId !== runnerId) continue;
      if (opts.driverOnly && c !== driver) continue;
      this.send(c, frame);
    }
  }

  /** false when the frame was dropped (slow consumer), so the caller can
   *  leave lastSeq alone and let the next frame replay the gap (H5). */
  private send(c: Client, frame: any): boolean {
    if (c.ws.readyState !== WebSocket.OPEN) return false;
    if ((c.ws as any).bufferedAmount > MAX_BUFFERED) return false;
    try {
      c.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Flush coalesced deltas before any non-delta frame so order is intact.
   *  A dropped flush keeps lastSeq behind: the batch is discarded and the
   *  ring replays it on the next frame (H5/H9). The return value is part of
   *  the contract: callers may only advance past the empty delta when the
   *  preceding batch actually reached the socket. */
  private flushDeltas(c: Client): boolean {
    if (c.deltaTimer) {
      clearTimeout(c.deltaTimer);
      c.deltaTimer = null;
    }
    let ok = true;
    if (c.deltaTpl && (c.deltaText || c.deltaThinking)) {
      const ev = JSON.parse(JSON.stringify(c.deltaTpl.event));
      ev.assistantMessageEvent.delta = c.deltaText || c.deltaThinking;
      // Stamp the batch with the max seq it covers, not the first frame's:
      // the client records lastSeen from this seq, and a replay from an
      // understated seq would redeliver (and duplicate) applied deltas.
      ok = this.send(c, { type: "event", ...c.deltaTpl, seq: c.deltaSeq, event: ev });
      if (ok) c.lastSeq = c.deltaSeq;
    }
    c.deltaText = "";
    c.deltaThinking = "";
    c.deltaStart = 0;
    c.deltaSeq = 0;
    c.deltaTpl = null;
    return ok;
  }

  /** Drop a pending delta batch without delivering it. Called when the
   *  client changes runner/unbinds: its seqs belong to the old stream and
   *  must never be flushed into the new binding (H9). */
  private resetDeltas(c: Client): void {
    if (c.deltaTimer) {
      clearTimeout(c.deltaTimer);
      c.deltaTimer = null;
    }
    c.deltaText = "";
    c.deltaThinking = "";
    c.deltaStart = 0;
    c.deltaSeq = 0;
    c.deltaTpl = null;
  }

  /** The seq through which this client is either delivered or coalesced.
   *  lastSeq alone is behind while a delta batch is accumulating. */
  private frontier(c: Client): number {
    return c.deltaTpl ? c.deltaSeq : c.lastSeq;
  }

  private deliver(c: Client, frame: any): void {
    const seq = frame.seq;
    if (!Number.isInteger(seq) || seq <= 0) return;
    if (seq <= c.lastSeq) return; // duplicate delivery
    // A coalesced delta still includes its own range; never append it again
    // if a replay loop asks for it while the batch is pending.
    if (c.deltaTpl && seq >= c.deltaStart && seq <= c.deltaSeq) return;
    // Do not leap a gap. fanOut replays it first; if that replay itself hit
    // backpressure, this frame is left in the ring for the next trigger.
    if (seq > this.frontier(c) + 1) return;

    const delta = streamDelta(frame);
    if (delta) {
      if (!delta.delta) {
        // An empty delta is a barrier: flush the pending batch first, and
        // advance lastSeq only when the flush actually reached the socket.
        // Otherwise the next replay would skip the batch (H9).
        if (this.flushDeltas(c) && seq === c.lastSeq + 1) c.lastSeq = seq;
        return;
      }
      if (!c.deltaTpl) {
        c.deltaTpl = frame;
        c.deltaStart = seq;
      }
      if (delta.kind === "text") c.deltaText += delta.delta;
      else c.deltaThinking += delta.delta;
      c.deltaSeq = Math.max(c.deltaSeq, seq);
      if (!c.deltaTimer) {
        c.deltaTimer = setTimeout(() => this.flushDeltas(c), 40);
        (c.deltaTimer as any).unref?.();
      }
      return;
    }
    if (!this.flushDeltas(c)) return;
    if (seq !== c.lastSeq + 1) return;
    if (this.send(c, { type: "event", ...frame })) c.lastSeq = seq;
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
      if (frame.seq > this.frontier(c) + 1) {
        // The triggering frame is already in the ring (emitEvent pushes
        // before notifying); replay only the gap, it is delivered below.
        // No lastSeq>0 guard: binds start at the head, so seq 0 can only
        // mean "nothing delivered yet" and the gap is real (H5).
        // Frames in the coalescer's range are already buffered, not
        // delivered — redelivering them would double-count their text.
        for (const missed of runner.replayFrom(c.lastSeq)) {
          if (missed.seq >= frame.seq) continue;
          if (c.deltaTpl && missed.seq >= c.deltaStart && missed.seq <= c.deltaSeq) continue;
          this.deliver(c, missed);
        }
      }
      hubDebug(`ws[${c.id}] <- ${frame.runnerId} seq=${frame.seq} ${frame.event?.type || "?"}`);
      this.deliver(c, frame);
    }
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
      deltaStart: 0,
      deltaSeq: 0,
      deltaTpl: null,
      deltaTimer: null,
    };
    this.clients.add(client);
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
    this.resetDeltas(client);
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
          return await this.handleAttach(client, id, msg);
        case "detach":
          return this.handleDetach(client, id);
        case "unbind": {
          if (client.boundId) this.deps.registry.unbind(client.ws);
          this.resetDeltas(client);
          client.boundId = null;
          client.lastSeq = 0;
          return this.ack(client, id, { type: "unbound" });
        }
        case "close":
          return this.handleClose(client, id, msg);
        case "extension_ui_response": {
          const ok = this.deps.dialogs.resolve(msg.id || id, msg, {
            runnerId: client.boundId,
            isDriver: (runnerId) => this.driverByRunner.get(runnerId) === client,
          });
          if (!ok) this.send(client, { type: "error", id, message: "dialog is not pending for this runner" });
          return this.ack(client, id, { type: "ack" });
        }
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
      runner = await this.deps.registry.bindHeadless(client.ws, {
        cwd: msg.cwd || this.deps.defaultCwd,
        absFile: abs,
        fallbackCwd: this.deps.defaultCwd,
      });
    } else {
      const cwd = String(msg.cwd || this.deps.defaultCwd);
      runner = await this.deps.registry.bindHeadless(client.ws, { cwd, absFile: null, fallbackCwd: this.deps.defaultCwd });
    }
    this.resetDeltas(client);
    client.boundId = runner.id;
    // A rebinding client may resume from its last seen seq: the runner's
    // 200-event ring replays the gap on the next frame (never behind the
    // runner's current head). A fresh bind starts AT the head (not 0), so a
    // first frame lost to backpressure is still replayed (H5).
    const since = Number(msg.sinceSeq);
    client.lastSeq = Number.isFinite(since) && since > 0 ? Math.min(since, runner.lastSeq()) : runner.lastSeq();
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
    const imageError = validateCommandImages(command);
    if (imageError) {
      this.send(client, { type: "error", id, message: imageError });
      return;
    }
    if (command?.type === "export_html" && typeof command.outputPath === "string" && command.outputPath.trim()) {
      // S3: a client-controlled path must never reach the child's exporter
      // unchecked. Validated (and absolutized) here; without outputPath the
      // child exports next to the session file, already inside the store.
      try {
        command = { ...command, outputPath: validateExportPath(command.outputPath, runner.absFile) };
      } catch (e: any) {
        this.send(client, { type: "error", id, message: e?.message || "invalid export path" });
        return;
      }
    }
    if (runner.kind === "live" && command?.type && !LIVE_PREVIEW_COMMANDS.has(command.type)) {
      // ADR-014 single driver, enforced (not just UI-disabled): previewing
      // browsers read, only the attached driver writes. Without this any
      // bound socket could steer a TUI it never attached to.
      if (this.driverByRunner.get(runner.id) !== client) {
        this.send(client, { type: "error", id, message: "not driving this TUI — attach first" });
        return;
      }
    }
    runner.command(command);
    this.ack(client, id, { type: "ack", command: command?.type });
  }

  private async handleAttach(client: Client, id: string | undefined, msg: any): Promise<void> {
    const runner = this.deps.registry.get(msg.runnerId || client.boundId || "");
    if (!runner || runner.kind !== "live") throw new Error("not a live runner");
    const holder = this.driverByRunner.get(runner.id);
    if (holder && holder !== client && !msg.take) {
      this.send(client, { type: "driver_busy", id, runnerId: runner.id, heldBy: holder.id });
      return;
    }
    if (this.driveConfirm && runner.pid) {
      // Opt-in drive consent: the TUI user approves each attach (including
      // takeovers) on their own terminal. Asked after the busy check so
      // refused attempts never pester the TUI. Deny/timeout fails closed.
      let confirmed = false;
      try {
        confirmed = this.driveConfirmer ? await this.driveConfirmer(runner.pid) : false;
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        this.send(client, { type: "error", id, message: "drive not confirmed by the TUI" });
        return;
      }
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

  /** Called by hub.ts when a runner is removed (driver mapping is by id). */
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
