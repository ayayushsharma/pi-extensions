/**
 * hub — the control plane: HTTP + WS, runner registry, hub.sock relay.
 * Started only in the `hub` role on session_start; stopped idempotently.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { HubConfig } from "../env.js";
import { hubLog } from "../log.js";
import { resolveSessionPath } from "../store/sessions.js";
import { RunnerRegistry } from "../runners/registry.js";
import { Auth } from "./auth.js";
import { DialogBroker } from "./dialogs.js";
import { Relay } from "./relay.js";
import { WsHub } from "./ws.js";
import { HubSocketServer } from "../mirror/socket.js";
import { createHttpServer, type Route } from "./http.js";
import { coreRoutes } from "./routes/core.js";
import { sessionRoutes } from "./routes/sessions.js";

export interface HubStartInfo {
  url: string;
  port: number;
  socket: boolean;
}

export class Hub {
  private server: http.Server | null = null;
  private socket: HubSocketServer | null = null;
  private relay: Relay | null = null;
  private ws: WsHub | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private registry!: RunnerRegistry;
  readonly auth: Auth;
  private startedAt = Date.now();
  private stopped = false;

  constructor(
    private config: HubConfig,
    private ctx: any,
  ) {
    this.auth = new Auth(
      config.user,
      config.pass,
      config.authEnabled,
      config.allowedHosts,
      config.allowAnyHost,
    );
  }

  get runners(): RunnerRegistry {
    return this.registry;
  }

  async start(): Promise<HubStartInfo> {
    this.registry = new RunnerRegistry({
      bin: this.config.piBin,
      ttlMs: this.config.ttlMs,
      maxHeadless: this.config.maxHeadless,
    });
    const dialogs = new DialogBroker({
      broadcast: (f) => this.ws?.broadcast(f),
      registry: this.registry,
      sendMirror: (pid, f) => this.socket?.sendToPid(pid, f) ?? false,
    });
    this.ws = new WsHub({
      auth: this.auth,
      registry: this.registry,
      dialogs,
      version: this.config.version,
      resolveSessionPath,
      defaultCwd: this.ctx?.cwd || process.cwd(),
    });
    this.registry.onChange((c) => {
      if (c.type === "removed") {
        this.ws?.noteRunnerRemoved(c.runner.id);
        dialogs.releaseRunner(c.runner.id);
      }
      this.ws?.broadcast({
        type: c.type === "added" ? "runner_added" : c.type === "removed" ? "runner_removed" : "runner_status",
        runner: c.runner.info(),
        reason: c.type === "removed" ? "exited" : undefined,
      });
    });

    const routes: Route[] = [
      ...coreRoutes({
        config: this.config,
        auth: this.auth,
        registry: this.registry,
        wsHub: this.ws,
        startedAt: this.startedAt,
        defaultCwd: this.ctx?.cwd || process.cwd(),
      }),
      ...sessionRoutes({ config: this.config, registry: this.registry }),
    ];
    this.server = createHttpServer({
      auth: this.auth,
      routes,
      staticDir: this.config.staticDir,
    });
    this.ws.attach(this.server);

    const port = await this.listen(this.config.port, 5);

    // hub.sock: failure to bind a live socket must not kill the HTTP UI
    this.socket = new HubSocketServer(this.config.sockPath);
    let socketOk = false;
    try {
      await this.socket.start();
      this.relay = new Relay({ server: this.socket, registry: this.registry, dialogs });
      this.relay.start();
      socketOk = true;
    } catch (e) {
      hubLog(`hub.sock unavailable: ${(e as Error).message}`);
      this.socket = null;
    }

    this.heartbeat = setInterval(() => this.ws?.heartbeat(), 30000);
    this.heartbeat.unref?.();
    this.stopped = false;
    const url = `http://${this.config.host}:${port}`;
    if (socketOk) this.advertise(port);
    hubLog(`hub listening on ${url} (socket=${socketOk ? this.config.sockPath : "off"})`);
    try {
      this.ctx?.ui?.setStatus?.("pi-hub", `Hub: ${this.config.host}:${port}`);
    } catch {}
    return { url, port, socket: socketOk };
  }

  /** Publish our socket in a stable file: a TUI started in another directory
   *  (or against a dev hub with PI_HUB_DIR set) still finds the hub. */
  private advertise(port: number): void {
    try {
      fs.mkdirSync(path.dirname(this.config.advertPath), { recursive: true });
      fs.writeFileSync(
        this.config.advertPath,
        JSON.stringify({ sock: this.config.sockPath, port, host: this.config.host, pid: process.pid, startedAt: Date.now() }, null, 2),
      );
    } catch (e) {
      hubLog(`advert file failed: ${(e as Error).message}`);
    }
  }

  private unadvertise(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.advertPath, "utf8"));
      if (raw?.pid === process.pid) fs.rmSync(this.config.advertPath, { force: true });
    } catch {}
  }

  private listen(port: number, attemptsLeft: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: any) => {
        if (err?.code === "EADDRINUSE" && attemptsLeft > 0) {
          hubLog(`port ${port} in use, trying ${port + 1}`);
          this.server!.removeListener("error", onError);
          this.listen(port + 1, attemptsLeft - 1).then(resolve, reject);
        } else {
          reject(err);
        }
      };
      this.server!.once("error", onError);
      this.server!.listen(port, this.config.host, () => {
        this.server!.removeListener("error", onError);
        resolve(port);
      });
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      this.relay = null;
      this.socket?.stop();
      this.socket = null;
    } catch {}
    try {
      this.ws?.close();
      this.ws = null;
    } catch {}
    try {
      this.registry?.shutdownAll();
    } catch {}
    try {
      this.server?.close();
      this.server = null;
    } catch {}
    this.unadvertise();
    hubLog("hub stopped");
  }
}
