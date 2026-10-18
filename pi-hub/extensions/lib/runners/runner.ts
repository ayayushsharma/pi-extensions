/**
 * runner — the single abstraction over every pi session the hub can drive.
 *
 *   headless: a `pi --mode rpc` child spawned by the hub (one writer/file)
 *   live:     a TUI that dialed in over hub.sock (relay, never dual-write)
 *
 * Registry invariants (tested): one process per session file; same-file bind
 * is a no-op; a running agent is never switched; events carry a monotonic
 * seq with a bounded replay ring for reconnect.
 */
import { hubLog } from "../log.js";

export type RunnerKind = "headless" | "live";
export type RunnerState = "idle" | "working" | "waiting" | "dead";

export interface RunnerInfo {
  id: string;
  kind: RunnerKind;
  cwd: string;
  sessionFile: string | null;
  absFile: string | null;
  pid?: number;
  title?: string;
  state: RunnerState;
  isStreaming: boolean;
  /** set when the session's own folder was gone and the child fell back */
  cwdFallback?: { from: string; to: string } | null;
  model?: string | null;
  thinkingLevel?: string | null;
  viewers: number;
  lastActiveAt: number;
  clientCount: number;
}

export type RunnerFrame = { runnerId: string; seq: number; event: any };

const REPLAY_RING = 200;

export abstract class Runner {
  readonly id: string;
  readonly kind: RunnerKind;
  cwd: string;
  /** basename shown in the UI; null until a fresh child reports its file */
  sessionFile: string | null = null;
  /** resolved absolute path, used for identity in the registry */
  absFile: string | null = null;
  pid?: number;
  title?: string;
  state: RunnerState = "idle";
  isStreaming = false;
  /** {from,to} when the requested cwd vanished and the hub fell back (R-10) */
  cwdFallback: { from: string; to: string } | null = null;
  model: string | null = null;
  thinkingLevel: string | null = null;
  lastActiveAt = Date.now();

  private seq = 0;
  private ring: RunnerFrame[] = [];
  private clients = new Set<unknown>();
  private listeners = new Set<(f: RunnerFrame) => void>();

  constructor(id: string, kind: RunnerKind, cwd: string) {
    this.id = id;
    this.kind = kind;
    this.cwd = cwd;
  }

  info(): RunnerInfo {
    return {
      id: this.id,
      kind: this.kind,
      cwd: this.cwd,
      sessionFile: this.sessionFile,
      absFile: this.absFile,
      pid: this.pid,
      title: this.title,
      state: this.state,
      isStreaming: this.isStreaming,
      cwdFallback: this.cwdFallback,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      viewers: this.clients.size,
      lastActiveAt: this.lastActiveAt,
      clientCount: this.clients.size,
    };
  }

  /** Fan-out hook: hub WS layer subscribes once per runner. */
  onFrame(cb: (f: RunnerFrame) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Push a normalized event; assigns seq and keeps the replay ring. */
  emitEvent(event: any): RunnerFrame {
    const frame: RunnerFrame = { runnerId: this.id, seq: ++this.seq, event };
    this.lastActiveAt = Date.now();
    this.ring.push(frame);
    if (this.ring.length > REPLAY_RING) this.ring.shift();
    this.applyStatusHints(event);
    for (const cb of [...this.listeners]) {
      try {
        cb(frame);
      } catch (e) {
        hubLog("runner listener failed:", String(e));
      }
    }
    return frame;
  }

  replayFrom(seq: number): RunnerFrame[] {
    return this.ring.filter((f) => f.seq > seq);
  }

  lastSeq(): number {
    return this.seq;
  }

  bind(ws: unknown): void {
    this.clients.add(ws);
  }

  unbind(ws: unknown): void {
    this.clients.delete(ws);
  }

  viewers(): number {
    return this.clients.size;
  }

  hasClient(ws: unknown): boolean {
    return this.clients.has(ws);
  }

  protected applyStatusHints(event: any): void {
    if (!event || typeof event !== "object") return;
    if (event.type === "agent_start") {
      this.state = "working";
      this.isStreaming = true;
    } else if (event.type === "agent_end") {
      this.state = "idle";
      this.isStreaming = false;
    } else if (event.type === "runner_status" || event.type === "status") {
      if (typeof event.isStreaming === "boolean") this.isStreaming = event.isStreaming;
      if (event.model) this.model = event.model;
      if (event.thinkingLevel) this.thinkingLevel = event.thinkingLevel;
    }
  }

  abstract command(cmd: any): void;
  abstract close(): void;
}
