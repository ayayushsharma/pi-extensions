/**
 * headless-bridge — on-demand `pi --mode rpc` children for tau-web.
 * Single-file module, no extra deps. Imported by mirror-server.ts.
 * - One backend per tab (uuid keys, never __new__::shared).
 * - Child env injects TAU_DISABLED=1 (C3).
 * - LF-only JSONL framing (U+2028/29 safe).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";

export type RpcEvent = any;
export type RpcCommand = any;

export interface HeadlessOptions {
  piBin?: string;
  ttlMs?: number;
}

export function resolveHeadlessOptions(): Required<HeadlessOptions> {
  return {
    piBin: process.env.PI_WEB_PI_BIN || process.env.TAU_PI_BIN || "pi",
    ttlMs: parseInt(process.env.PI_WEB_TTL_MS || process.env.TAU_HEADLESS_TTL_MS || "900000", 10) || 900000,
  };
}

export class RpcSession {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private killed = false;

  constructor(opts: {
    piBin: string;
    cwd: string;
    sessionFile?: string;
    env?: NodeJS.ProcessEnv;
    onEvent: (event: any) => void;
    onError: (message: string) => void;
    onExit: (code: number | null) => void;
  }) {
    this.proc = spawn(opts.piBin, ["--mode", "rpc"], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TAU_DISABLED: "1", ...(opts.env || {}) },
    });
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "").trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length > 0) {
          try { opts.onEvent(JSON.parse(line)); } catch { /* skip malformed */ }
        }
        idx = this.buffer.indexOf("\n");
      }
    });
    this.proc.stderr.on("data", (chunk: string) => {
      const msg = String(chunk).trim();
      if (msg) opts.onError(msg);
    });
    this.proc.on("error", (err) => opts.onError(err.message));
    this.proc.on("exit", (code) => opts.onExit(code));
    if (opts.sessionFile) {
      this.send({ type: "switch_session", sessionPath: opts.sessionFile });
    }
  }

  send(command: any): void {
    if (this.killed || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(command) + "\n", "utf-8");
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    try {
      this.proc.kill("SIGTERM");
      setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {} }, 2000);
    } catch {}
  }
}

export type ManagedHeadless = {
  id: string;
  cwd: string;
  sessionFile: string | null;
  rpc: RpcSession;
  clients: Set<any>;
  isAgentRunning: boolean;
  idleTimer: NodeJS.Timeout | null;
  isClosing: boolean;
  discoveredFile: string | null;
};

export class HeadlessRegistry {
  private sessions = new Map<string, ManagedHeadless>();
  private socketBinding = new Map<any, ManagedHeadless>();
  private opts = resolveHeadlessOptions();
  private homeDir = resolve(homedir() || "/");

  constructor(
    private hooks: {
      onEvent: (managed: ManagedHeadless, event: any) => void;
      onError: (managed: ManagedHeadless, message: string) => void;
      onExit: (managed: ManagedHeadless, code: number | null) => void;
      log: (...args: any[]) => void;
    },
  ) {}

  get size(): number { return this.sessions.size; }

  statusFor(cwd: string, file: string): { isActive: boolean; isWorking: boolean } {
    const key = `${resolve(cwd)}::${basename(file)}`;
    for (const m of this.sessions.values()) {
      if (m.isClosing) continue;
      if (m.cwd === resolve(cwd) && (m.sessionFile === basename(file) || m.discoveredFile === basename(file) || m.id === key)) {
        return { isActive: m.isAgentRunning || m.clients.size > 0, isWorking: m.isAgentRunning };
      }
    }
    return { isActive: false, isWorking: false };
  }

  attach(ws: any, cwdRaw?: string, sessionFileRaw?: string | null): ManagedHeadless {
    const cwd = cwdRaw && cwdRaw.trim().length > 0 ? resolve(cwdRaw) : this.homeDir;
    const sessionFile = sessionFileRaw && sessionFileRaw.length > 0 ? basename(sessionFileRaw) : null;
    // One backend per tab: new sessions get a uuid, existing files rejoin by cwd::file.
    let managed: ManagedHeadless | undefined;
    if (sessionFile) {
      for (const m of this.sessions.values()) {
        if (!m.isClosing && m.cwd === cwd && (m.sessionFile === sessionFile || m.discoveredFile === sessionFile)) {
          managed = m;
          break;
        }
      }
    }
    if (!managed) {
      const id = `${cwd}::${sessionFile ?? `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
      managed = this.create(cwd, sessionFile, id);
    }
    this.detach(ws);
    managed.clients.add(ws);
    if (managed.idleTimer) { clearTimeout(managed.idleTimer); managed.idleTimer = null; }
    this.socketBinding.set(ws, managed);
    return managed;
  }

  private create(cwd: string, sessionFile: string | null, id: string): ManagedHeadless {
    let managed: ManagedHeadless | null = null;
    // Resolve session file to absolute pi session path when only a basename is given.
    // Headless children run with cwd=project dir; pi resolves --session relative to session store.
    const rpc = new RpcSession({
      piBin: this.opts.piBin,
      cwd,
      onEvent: (event: any) => {
        if (!managed) return;
        if (event?.type === "agent_start") {
          managed.isAgentRunning = true;
          if (managed.idleTimer) { clearTimeout(managed.idleTimer); managed.idleTimer = null; }
        }
        if (event?.type === "agent_end") {
          managed.isAgentRunning = false;
          this.scheduleIdleCleanup(managed);
        }
        if (event?.type === "response" && event?.command === "get_state" && event?.success) {
          const sf = event?.data?.sessionFile;
          if (typeof sf === "string" && sf.length > 0) managed.discoveredFile = basename(sf);
        }
        this.hooks.onEvent(managed, event);
      },
      onError: (message) => { if (managed) this.hooks.onError(managed, message); },
      onExit: (code) => {
        if (!managed) return;
        managed.isAgentRunning = false;
        managed.isClosing = true;
        if (managed.idleTimer) clearTimeout(managed.idleTimer);
        this.sessions.delete(managed.id);
        this.hooks.onExit(managed, code);
        for (const client of managed.clients) {
          if (this.socketBinding.get(client) === managed) this.socketBinding.delete(client);
        }
        managed.clients.clear();
      },
      log: undefined as any,
    } as any);
    managed = {
      id, cwd, sessionFile, rpc,
      clients: new Set(), isAgentRunning: false,
      idleTimer: null, isClosing: false, discoveredFile: null,
    };
    // If resuming an existing file, switch after spawn (RpcSession sends switch only for absolute path variant).
    if (sessionFile) {
      // Session files live under ~/.pi/agent/sessions/--cwd--/<file>; pi resolves by sessionPath.
      // We pass through switch_session with the basename-derived lookup done lazily via get_state.
      // Best-effort: ask child for state first; switch happens on first rpc_command if needed.
      (managed as any).pendingSwitchFile = sessionFile;
    }
    this.sessions.set(id, managed);
    return managed;
  }

  command(ws: any, command: any): { ok: boolean; error?: string } {
    const managed = this.socketBinding.get(ws);
    if (!managed || managed.isClosing) return { ok: false, error: "no active session" };
    (managed as any).pendingSwitchFile = undefined;
    managed.rpc.send(command);
    return { ok: true };
  }

  switchToFile(managed: ManagedHeadless, absSessionPath: string): void {
    (managed as any).pendingSwitchFile = undefined;
    managed.rpc.send({ type: "switch_session", sessionPath: absSessionPath });
  }

  bindingOf(ws: any): ManagedHeadless | undefined {
    return this.socketBinding.get(ws);
  }

  detach(ws: any): void {
    const current = this.socketBinding.get(ws);
    if (!current) return;
    current.clients.delete(ws);
    this.socketBinding.delete(ws);
    this.scheduleIdleCleanup(current);
  }

  closeByFile(cwd: string, filename: string): void {
    const base = basename(filename);
    for (const m of this.sessions.values()) {
      if (m.cwd === resolve(cwd) && (m.sessionFile === base || m.discoveredFile === base)) {
        m.isClosing = true;
        if (m.idleTimer) clearTimeout(m.idleTimer);
        this.sessions.delete(m.id);
        m.rpc.kill();
      }
    }
  }

  private scheduleIdleCleanup(managed: ManagedHeadless): void {
    if (managed.isClosing || managed.clients.size > 0 || managed.isAgentRunning || managed.idleTimer) return;
    managed.idleTimer = setTimeout(() => {
      managed.idleTimer = null;
      if (managed.clients.size > 0 || managed.isAgentRunning || managed.isClosing) return;
      managed.isClosing = true;
      this.sessions.delete(managed.id);
      managed.rpc.kill();
    }, this.opts.ttlMs);
  }

  shutdownAll(): void {
    for (const m of this.sessions.values()) {
      try { m.rpc.kill(); } catch {}
    }
    this.sessions.clear();
    this.socketBinding.clear();
  }
}
