/**
 * hub — the control plane: HTTP + WS, runner registry, hub.sock relay.
 * Started only in the `hub` role on session_start; stopped idempotently.
 */
import * as http from "node:http";
import type { HubConfig } from "../env.js";
import { hubLog } from "../log.js";
import { resolveSessionPath } from "../store/sessions.js";
import { RunnerRegistry } from "../runners/registry.js";
import { Auth } from "./auth.js";
import { DialogBroker } from "./dialogs.js";
import { Relay } from "./relay.js";
import { WsHub } from "./ws.js";
import { HubSocketServer } from "../mirror/socket.js";
import {
  claimSingleton,
  readAdvert,
  releaseSingleton,
  writeAdvert,
} from "./singleton.js";
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
  private listening = false;
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
      // The hub's own bind address is legitimate Host by construction:
      // without it a hub bound to a LAN IP (dev-hub.sh) would refuse its
      // own clients, while anything else non-loopback stays default-deny.
      [config.host],
    );
  }

  get runners(): RunnerRegistry {
    return this.registry;
  }

  async start(): Promise<HubStartInfo> {
    // A hub instance is single-use in practice, but a failed start after a
    // stop() must still be able to release its advert claim (stop() returns
    // early when this flag is stale).
    this.stopped = false;
    // A8: a wildcard bind without credentials would expose every control
    // surface to the LAN. Refuse before claiming anything (a refused hub
    // must not block the advert scope).
    const wildcard = this.config.host === "0.0.0.0" || this.config.host === "::";
    if (wildcard && !this.auth.enabled) {
      throw new Error(
        `refusing to bind ${this.config.host} without credentials: set PI_HUB_USER/PI_HUB_PASS ` +
          `(tunnel hostnames stay pinned via PI_HUB_ALLOWED_HOSTS)`,
      );
    }
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
      ...sessionRoutes({
        config: this.config,
        registry: this.registry,
        defaultCwd: this.ctx?.cwd || process.cwd(),
      }),
    ];
    this.server = createHttpServer({
      auth: this.auth,
      routes,
      staticDir: this.config.staticDir,
    });
    // Consent must be armed *before* the server can accept sockets: the
    // confirmer closure resolves `this.relay` lazily, so setting it early is
    // safe and closes the window where an attach could bypass it.
    this.ws.setDriveConfirm(this.config.driveConfirm, (pid) => this.relay?.requestDriveConfirm(pid) ?? Promise.resolve(false));
    this.ws.attach(this.server);

    // Singleton (ADR-021): one hub per advert scope. Claim before binding so
    // a second starter refuses while this hub is still coming up. The claim
    // carries our own pid, so any failure below releases it via stop().
    await claimSingleton(this.config.advertPath, {
      sock: this.config.sockPath,
      port: this.config.port,
      host: this.config.host,
      pid: process.pid,
      startedAt: Date.now(),
    });
    try {
      const port = await this.listen(this.config.port);
      this.listening = true;

      // hub.sock: a *live* hub on our path is a duplicate hub — refuse.
      // Any other bind problem keeps the old behaviour: HTTP UI without the relay.
      this.socket = new HubSocketServer(this.config.sockPath);
      let socketOk = false;
      try {
        await this.socket.start();
        this.relay = new Relay({ server: this.socket, registry: this.registry, dialogs });
        this.relay.start();
        socketOk = true;
      } catch (e) {
        const msg = (e as Error).message || "";
        if (/another hub is listening/.test(msg)) {
          throw new Error(`${msg} — refusing to start a second hub (advert: ${this.config.advertPath})`);
        }
        hubLog(`hub.sock unavailable: ${msg}`);
        this.socket = null;
      }

      this.heartbeat = setInterval(() => this.ws?.heartbeat(), 30000);
      this.heartbeat.unref?.();
      this.stopped = false;
      const url = `http://${this.config.host}:${port}`;
      if (socketOk) this.advertise(port);
      // Simultaneous-start guard: two starters can both pass the pre-bind
      // claim check, and the advert keeps only the last writer. The loser
      // stands down instead of running as an unadvertised shadow hub.
      await new Promise((r) => setTimeout(r, 250));
      if (socketOk) {
        const cur = readAdvert(this.config.advertPath);
        if (!cur || cur.pid !== process.pid) {
          throw new Error(
            `another hub claimed ${this.config.advertPath} during startup — standing down so only one hub runs`,
          );
        }
      }
      hubLog(`hub listening on ${url} (socket=${socketOk ? this.config.sockPath : "off"})`);
      try {
        this.ctx?.ui?.setStatus?.("pi-hub", `Hub: ${this.config.host}:${port}`);
      } catch {}
      return { url, port, socket: socketOk };
    } catch (e) {
      try {
        this.stop();
      } catch {}
      throw e;
    }
  }

  /** Publish our socket in a stable file: a TUI started in another directory
   *  (or against a dev hub with PI_HUB_DIR set) still finds the hub. */
  private advertise(port: number): void {
    try {
      writeAdvert(this.config.advertPath, {
        sock: this.config.sockPath,
        port,
        host: this.config.host,
        pid: process.pid,
        startedAt: Date.now(),
      });
    } catch (e) {
      hubLog(`advert file failed: ${(e as Error).message}`);
    }
  }

  private unadvertise(): void {
    releaseSingleton(this.config.advertPath);
  }

  /**
   * Bind exactly the configured port (ADR-021). A busy port used to bump
   * silently to port+1, which stranded a shadow hub beside the real one
   * (tunnel still pointed at the old port). Now it fails with directions.
   */
  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: any) => {
        if (err?.code === "EADDRINUSE") {
          reject(
            new Error(
              `port ${port} is already in use — refusing to start a second hub. ` +
                `Stop the running hub first, or use a different PI_HUB_PORT with its own ` +
                `PI_HUB_ADVERT_FILE. Advert: ${this.config.advertPath}`,
            ),
          );
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
      // A start that never bound (port busy, duplicate hub) leaves a server
      // that was never listening — closing it would throw, so only close
      // what actually bound.
      if (this.listening) this.server?.close();
      this.server = null;
      this.listening = false;
    } catch {}
    this.unadvertise();
    hubLog("hub stopped");
  }
}
