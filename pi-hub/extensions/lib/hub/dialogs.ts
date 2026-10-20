/**
 * dialogs — single-driver broker for extension UI requests (ADR-007).
 * Browser answers when connected; otherwise the owner (TUI/child) keeps its
 * native behavior. Requests are attributed to a runner.
 */
import type { RunnerRegistry } from "../runners/registry.js";

type Owner =
  | { kind: "headless"; runnerId: string }
  | { kind: "mirror"; runnerId: string; pid: number };

export class DialogBroker {
  private pending = new Map<string, Owner>();

  constructor(
    private deps: {
      broadcast: (frame: any) => void;
      registry: RunnerRegistry;
      sendMirror: (pid: number, frame: any) => boolean;
    },
  ) {}

  registerHeadless(runnerId: string, request: any): void {
    if (!request?.id) return;
    this.pending.set(request.id, { kind: "headless", runnerId });
    this.deps.broadcast({ type: "dialog", runnerId, request });
  }

  registerMirror(pid: number, runnerId: string, request: any): void {
    if (!request?.id) return;
    this.pending.set(request.id, { kind: "mirror", runnerId, pid });
    this.deps.broadcast({ type: "dialog", runnerId, request });
  }

  resolve(id: string, response: any): boolean {
    const owner = this.pending.get(id);
    if (!owner) return false;
    this.pending.delete(id);
    const payload = { type: "extension_ui_response", id, ...response };
    if (owner.kind === "headless") {
      this.deps.registry.get(owner.runnerId)?.command(payload);
    } else {
      this.deps.sendMirror(owner.pid, { type: "dialog_relay", id, response });
    }
    return true;
  }

  releaseRunner(runnerId: string): void {
    for (const [id, owner] of this.pending) {
      if (owner.runnerId === runnerId) {
        this.pending.delete(id);
        this.deps.broadcast({ type: "dialog_cancelled", runnerId, id });
      }
    }
  }
}
