/**
 * live — a TUI that dialed into the hub over hub.sock. The hub never writes
 * that session's file; it relays frames and forwards drive commands.
 */
import { Runner } from "./runner.js";

export interface LiveRecord {
  pid: number;
  cwd: string;
  sessionFile: string | null;
  name?: string;
  port?: number;
}

export class LiveRunner extends Runner {
  onDrive: (frame: any) => void;
  private dead = false;

  constructor(record: LiveRecord, onDrive: (frame: any) => void) {
    super(`live-${record.pid}`, "live", record.cwd);
    this.pid = record.pid;
    this.absFile = record.sessionFile;
    this.sessionFile = record.sessionFile ? record.sessionFile.split(/[\\/]/).pop() || null : null;
    this.title = record.name;
    this.onDrive = onDrive;
  }

  updateRecord(record: Partial<LiveRecord>): void {
    if (record.cwd) this.cwd = record.cwd;
    if (record.name !== undefined) this.title = record.name;
    if (record.sessionFile !== undefined) {
      this.absFile = record.sessionFile;
      this.sessionFile = record.sessionFile ? record.sessionFile.split(/[\\/]/).pop() || null : null;
    }
  }

  pushStatus(status: any): void {
    if (status && typeof status.isStreaming === "boolean") this.isStreaming = status.isStreaming;
    if (status?.model) this.model = status.model;
    if (status?.thinkingLevel) this.thinkingLevel = status.thinkingLevel;
    this.state = this.isStreaming ? "working" : "idle";
    this.emitEvent({ type: "runner_status", ...status, isStreaming: this.isStreaming });
  }

  push(event: any): void {
    this.emitEvent(event);
  }

  command(cmd: any): void {
    if (this.dead) return;
    this.onDrive({ type: "drive", command: cmd });
  }

  close(): void {
    this.closing = true;
    this.kill("closed from hub");
  }

  kill(reason: string): void {
    if (this.dead) return;
    this.closing = true;
    this.dead = true;
    this.state = "dead";
    this.emitEvent({ type: "runner_exit", reason });
  }

  get isDead(): boolean {
    return this.dead;
  }
}
