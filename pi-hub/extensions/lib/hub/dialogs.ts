/**
 * dialogs — single-driver broker for extension UI requests (ADR-007).
 * Browser answers when connected; otherwise the owner (TUI/child) keeps its
 * native behavior. Requests are attributed to a runner and delivered only to
 * browsers bound to that runner (and, for a live TUI, only its driver).
 *
 * Bounded by construction: every request has a timeout and the broker caps
 * pending requests. If nobody answers, the owner is cancelled so a headless
 * child or TUI cannot wait forever.
 */
import type { RunnerRegistry } from "../runners/registry.js";

type Owner =
  | { kind: "headless"; runnerId: string }
  | { kind: "mirror"; runnerId: string; pid: number };

interface Pending {
  owner: Owner;
  timer: NodeJS.Timeout;
}

export interface DialogResponder {
  /** runner the answering websocket is bound to */
  runnerId: string | null;
  /** for a live runner: true only for the single attached driver */
  isDriver: (runnerId: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_PENDING = 32;

function cancelPayload(id: string, reason: string): any {
  return { type: "extension_ui_response", id, cancelled: true, reason };
}

export class DialogBroker {
  private pending = new Map<string, Pending>();
  private timeoutMs: number;
  private maxPending: number;
  private deps: {
    sendToRunner: (runnerId: string, frame: any, opts?: { driverOnly?: boolean }) => void;
    registry: RunnerRegistry;
    sendMirror: (pid: number, frame: any) => boolean;
  };

  constructor(
    deps: {
      sendToRunner: (runnerId: string, frame: any, opts?: { driverOnly?: boolean }) => void;
      registry: RunnerRegistry;
      sendMirror: (pid: number, frame: any) => boolean;
    },
    opts: { timeoutMs?: number; maxPending?: number } = {},
  ) {
    this.deps = deps;
    this.timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxPending = Math.max(1, opts.maxPending ?? DEFAULT_MAX_PENDING);
  }

  registerHeadless(runnerId: string, request: any): void {
    this.register({ kind: "headless", runnerId }, request, false);
  }

  registerMirror(pid: number, runnerId: string, request: any): void {
    // A previewing browser sees the TUI but must not answer its dialogs;
    // only the single driver (ADR-014) gets the modal.
    this.register({ kind: "mirror", runnerId, pid }, request, true);
  }

  private register(owner: Owner, request: any, driverOnly: boolean): void {
    if (!request?.id) return;
    const id = String(request.id);
    if (this.pending.has(id)) this.cancel(id, "replaced");
    while (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.cancel(oldest, "too many pending dialogs");
    }
    const timer = setTimeout(() => this.cancel(id, "timed out"), this.timeoutMs);
    timer.unref?.();
    this.pending.set(id, { owner, timer });
    this.deps.sendToRunner(owner.runnerId, { type: "dialog", runnerId: owner.runnerId, request }, { driverOnly });
  }

  resolve(id: string, response: any, by?: DialogResponder): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    // A browser may only answer a dialog for the runner it is bound to, and
    // a live TUI only through its single driver socket (ADR-014/007).
    if (by) {
      if (by.runnerId !== entry.owner.runnerId) return false;
      if (entry.owner.kind === "mirror" && !by.isDriver(entry.owner.runnerId)) return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.sendOwner(entry.owner, { type: "extension_ui_response", id, ...response });
    // Other viewers of the same runner (two headless browser tabs, say) may
    // still have the modal open. Close the scoped viewers once.
    this.sendClient(entry.owner, { type: "dialog_cancelled", runnerId: entry.owner.runnerId, id, reason: "answered" });
    return true;
  }

  releaseRunner(runnerId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.owner.runnerId === runnerId) this.cancel(id, "runner closed");
    }
  }

  /** Cancel a request and tell both ends: the owner stops waiting, and any
   *  browser showing the scoped modal closes it. */
  private cancel(id: string, reason: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    this.sendOwner(entry.owner, cancelPayload(id, reason));
    this.sendClient(entry.owner, { type: "dialog_cancelled", runnerId: entry.owner.runnerId, id, reason });
  }

  private sendOwner(owner: Owner, payload: any): void {
    if (owner.kind === "headless") {
      this.deps.registry.get(owner.runnerId)?.command(payload);
      return;
    }
    const { type: _type, id, ...response } = payload;
    this.deps.sendMirror(owner.pid, { type: "dialog_relay", id, response });
  }

  private sendClient(owner: Owner, frame: any): void {
    this.deps.sendToRunner(owner.runnerId, frame, { driverOnly: owner.kind === "mirror" });
  }

  /** Test seam: pending requests are always bounded. */
  pendingCount(): number {
    return this.pending.size;
  }
}
