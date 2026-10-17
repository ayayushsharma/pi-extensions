/**
 * relay — hub side of hub.sock (ADR-014). Mirrors announce themselves; the
 * hub turns records into live runners, forwards events, and routes drive
 * commands and dialog answers back by pid.
 */
import { hubLog } from "../log.js";
import type { RunnerRegistry } from "../runners/registry.js";
import type { LiveRunner } from "../runners/live.js";
import type { DialogBroker } from "./dialogs.js";
import type { HubSocketServer } from "../mirror/socket.js";

export class Relay {
  constructor(
    private deps: {
      server: HubSocketServer;
      registry: RunnerRegistry;
      dialogs: DialogBroker;
    },
  ) {}

  start(): void {
    const { server, registry, dialogs } = this.deps;
    server.on("frame", (frame: any, reply: (f: any) => void) => {
      try {
        this.onFrame(frame, reply);
      } catch (e) {
        hubLog("relay frame failed:", String(e));
      }
    });
    server.on("close", (pid: number) => {
      registry.removeLive(pid, "TUI disconnected");
    });
  }

  private onFrame(frame: any, reply: (f: any) => void): void {
    const { registry, dialogs } = this.deps;
    if (!frame || typeof frame.type !== "string") return;
    switch (frame.type) {
      case "hello": {
        const runner = registry.addLive(
          {
            pid: frame.pid,
            cwd: frame.cwd,
            sessionFile: frame.sessionFile || null,
            name: frame.name,
            port: frame.port,
          },
          (out) => this.deps.server.sendToPid(frame.pid, out),
        );
        hubLog(`mirror connected pid=${frame.pid} cwd=${frame.cwd}`);
        reply({ type: "hello_ack", hub: true, runnerId: runner.id });
        break;
      }
      case "status": {
        const runner = registry.getByPid(frame.pid) as LiveRunner | undefined;
        if (runner) runner.pushStatus(frame.status || frame);
        break;
      }
      case "event": {
        const runner = registry.getByPid(frame.pid) as LiveRunner | undefined;
        if (runner) runner.push({ ...frame.event, live: true });
        break;
      }
      case "snapshot": {
        const runner = registry.getByPid(frame.pid) as LiveRunner | undefined;
        if (runner) runner.push({ type: "snapshot", ...frame.snapshot });
        break;
      }
      case "dialog": {
        const runner = registry.getByPid(frame.pid);
        if (runner) dialogs.registerMirror(frame.pid, runner.id, frame.request);
        break;
      }
      case "bye": {
        registry.removeLive(frame.pid, "TUI closed");
        break;
      }
      default:
        hubLog(`relay: unknown frame ${frame.type}`);
    }
  }

  sendDrive(pid: number, command: any): boolean {
    return this.deps.server.sendToPid(pid, { type: "drive", command });
  }
}
