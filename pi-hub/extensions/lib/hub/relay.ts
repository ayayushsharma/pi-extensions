/**
 * relay — hub side of hub.sock (ADR-014). Mirrors announce themselves; the
 * hub turns records into live runners, forwards events, and routes drive
 * commands and dialog answers back by pid.
 */
import { hubLog } from "../log.js";
import { randId } from "../protocol.js";
import type { RunnerRegistry } from "../runners/registry.js";
import type { LiveRunner } from "../runners/live.js";
import type { DialogBroker } from "./dialogs.js";
import type { HubSocketServer } from "../mirror/socket.js";

/** Answered well before the browser's own attach timeout (30 s). */
export const DRIVE_CONFIRM_TIMEOUT_MS = 25000;

export class Relay {
  private deps: {
    server: HubSocketServer;
    registry: RunnerRegistry;
    dialogs: DialogBroker;
  };
  private confirmWaiters = new Map<string, (confirmed: boolean) => void>();

  constructor(deps: {
    server: HubSocketServer;
    registry: RunnerRegistry;
    dialogs: DialogBroker;
  }) {
    this.deps = deps;
  }

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
      case "drive_confirm_reply": {
        const resolve = this.confirmWaiters.get(frame.id);
        if (resolve) {
          this.confirmWaiters.delete(frame.id);
          resolve(frame.confirmed === true);
        }
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

  /**
   * Opt-in drive consent (PI_HUB_DRIVE_CONFIRM): ask the TUI user to confirm
   * a browser attach. Resolves false on deny, timeout, disconnect, or an old
   * mirror that never answers — fail-closed, never fail-open.
   */
  requestDriveConfirm(pid: number, timeoutMs = DRIVE_CONFIRM_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const id = randId("confirm");
      const timer = setTimeout(() => {
        this.confirmWaiters.delete(id);
        resolve(false);
      }, timeoutMs);
      if (timeoutMs > 0 && typeof (timer as any)?.unref === "function") (timer as any).unref();
      this.confirmWaiters.set(id, (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed);
      });
      if (!this.deps.server.sendToPid(pid, { type: "drive_confirm", id, pid })) {
        clearTimeout(timer);
        this.confirmWaiters.delete(id);
        resolve(false);
      }
    });
  }

  pendingConfirmCount(): number {
    return this.confirmWaiters.size;
  }
}
