/**
 * headless — a persistent `pi --mode rpc` child, one per session file.
 *
 * Framing is LF-only JSONL (ADR-003). Spawn failure / exit / close all funnel
 * through one idempotent retire so a dead child can never be re-bound (B3).
 * Same-file resume is a no-op (ADR-015); switching a running agent is refused.
 */
import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { hubLog, hubDebug } from "../log.js";
import { randId } from "../protocol.js";
import { Runner, type RunnerKind } from "./runner.js";

export function buildHeadlessChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(extra || {}) };
  for (const k of ["PI_HUB_USER", "PI_HUB_PASS", "TAU_USER", "TAU_PASS"]) delete env[k];
  for (const k of Object.keys(env)) {
    if (k === "PI_HUB_AUTH" || k.startsWith("PI_HUB_AUTH_")) delete env[k];
    if (k === "TAU_AUTH" || k.startsWith("TAU_AUTH_")) delete env[k];
  }
  env.PI_HUB_DISABLED = "1";
  env.TAU_DISABLED = "1";
  return env;
}

export function assertValidCwd(cwd: string): void {
  let st: any;
  try {
    st = statSync(cwd);
  } catch {
    throw new Error(`invalid cwd "${cwd}": does not exist or is not accessible`);
  }
  if (!st.isDirectory()) throw new Error(`invalid cwd "${cwd}": not a directory`);
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** One LF-JSONL child process with id-correlated requests. */
export class RpcSession extends EventEmitter {
  readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private killed = false;
  private settled = false;

  constructor(opts: {
    bin: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
  }) {
    super();
    assertValidCwd(opts.cwd);
    this.proc = spawn(opts.bin, opts.args || ["--mode", "rpc"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildHeadlessChildEnv(opts.env),
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      const msg = String(chunk).trim();
      if (msg) hubLog(`child[${this.proc.pid}] stderr: ${msg.slice(0, 500)}`);
    });
    // spawn failure emits 'error' + 'close' and never 'exit' — all are terminal
    this.proc.on("error", (err) => this.finish(null, err));
    this.proc.on("close", (code) => this.finish(code, null));
    this.proc.on("exit", (code) => this.finish(code, null));
    hubLog(`child spawn pid=${this.proc.pid} bin=${opts.bin} cwd=${opts.cwd}`);
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      hubLog("child: skipping malformed JSON line");
      return;
    }
    if (frame && frame.type === "response" && frame.id && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.success === false) p.reject(new Error(String(frame.error || "command failed")));
      else p.resolve(frame);
    }
    this.emit("frame", frame);
  }

  private finish(code: number | null, err: Error | null): void {
    if (this.settled) return;
    this.settled = true;
    hubLog(`child pid=${this.proc.pid} settled code=${code} err=${err?.message || ""}`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err || new Error(`child exited (code ${code})`));
      this.pending.delete(id);
    }
    for (const cb of this.listeners("exit")) {
      try {
        (cb as any)(code, err);
      } catch {}
    }
    this.emit("settled");
  }

  private listeners(name: string): Array<(...a: any[]) => void> {
    return this.rawListeners(name) as any;
  }

  send(cmd: any): void {
    if (this.settled || this.killed) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
    } catch (e) {
      hubLog("child write failed:", String(e));
    }
  }

  request(cmd: any, timeoutMs = 15000): Promise<any> {
    const id = cmd.id || randId("req");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...cmd, id });
    });
  }

  kill(): void {
    this.killed = true;
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        if (!this.settled) this.proc.kill("SIGKILL");
      } catch {}
    }, 2000).unref?.();
  }
}

export class HeadlessRunner extends Runner {
  readonly rpc: RpcSession;
  private dead = false;

  constructor(opts: {
    id?: string;
    kind?: RunnerKind;
    cwd: string;
    absFile?: string | null;
    bin: string;
    env?: NodeJS.ProcessEnv;
  }) {
    super(opts.id || randId("hr"), "headless", opts.cwd);
    if (opts.absFile) {
      this.absFile = opts.absFile;
      this.sessionFile = basename(opts.absFile);
    }
    this.rpc = new RpcSession({ bin: opts.bin, cwd: opts.cwd, env: opts.env });
    this.pid = this.rpc.pid;
    this.rpc.on("frame", (frame: any) => this.onRpcFrame(frame));
    this.rpc.on("exit", (code: number | null) => this.retire(code));
  }

  private onRpcFrame(frame: any): void {
    hubDebug(`child[${this.pid}] frame ${frame?.type}${frame?.command ? ":" + frame.command : ""}${frame?.id ? " id=" + frame.id : ""}`);
    if (frame?.type === "response" && frame?.command === "get_state" && frame.success) {
      const sf = frame?.data?.sessionFile;
      if (typeof sf === "string" && sf) this.setFile(sf);
      if (frame?.data?.model?.id) this.model = frame.data.model.id as string;
      else if (frame?.data?.model?.name) this.model = frame.data.model.name as string;
      if (frame?.data?.thinkingLevel) this.thinkingLevel = frame.data.thinkingLevel;
      if (typeof frame?.data?.isStreaming === "boolean") {
        this.isStreaming = frame.data.isStreaming;
        this.state = frame.data.isStreaming ? "working" : "idle";
      }
    }
    if (frame?.type === "message_end" && frame?.message?.role === "user") {
      // anything user-visible means the child is alive and committed
      this.lastActiveAt = Date.now();
    }
    this.emitEvent(frame);
  }

  private setFile(absPath: string): void {
    const abs = resolve(absPath);
    const base = basename(abs);
    if (this.absFile === abs) return;
    this.absFile = abs;
    this.sessionFile = base;
    this.emitEvent({ type: "session_file", sessionFile: base, cwd: this.cwd });
  }

  /** Resolve get_state once the child is up; rejects on exit/timeout. */
  async ready(timeoutMs = 20000): Promise<void> {
    await this.rpc.request({ type: "get_state" }, timeoutMs);
  }

  /** ADR-015: same-file resume is a no-op; never switch a running agent. */
  async resume(absFile: string): Promise<void> {
    const abs = resolve(absFile);
    if (this.absFile === abs) return;
    if (this.dead) throw new Error("runner is no longer running");
    if (this.state === "working") {
      throw new Error("session is running — wait for it to finish before switching");
    }
    await this.rpc.request({ type: "switch_session", sessionPath: abs }, 30000);
    // Identity change must go out as an event: the child starts on its own
    // throwaway file and only then switches, so without this the registry
    // index and every client keep showing the throwaway name.
    this.setFile(abs);
    this.state = "idle";
    this.isStreaming = false;
  }

  command(cmd: any): void {
    if (this.dead) return;
    hubDebug(`child[${this.pid}] <- ${cmd?.type}${cmd?.id ? " id=" + cmd.id : ""}`);
    this.rpc.send(cmd);
  }

  request(cmd: any, timeoutMs?: number): Promise<any> {
    return this.rpc.request(cmd, timeoutMs);
  }

  close(): void {
    this.rpc.kill();
  }

  get isDead(): boolean {
    return this.dead;
  }

  private retire(code: number | null): void {
    if (this.dead) return;
    this.dead = true;
    this.state = "dead";
    this.isStreaming = false;
    this.emitEvent({ type: "runner_exit", code });
  }
}
