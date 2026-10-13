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
  maxHeadless?: number;
}

export function resolveHeadlessOptions(): Required<HeadlessOptions> {
  // TTL <= 0 means NEVER auto-reap: headless sessions survive browser
  // close/reload and keep running until explicitly closed via
  // close_session / closeByFile or server shutdown. Set PI_WEB_TTL_MS
  // (or TAU_HEADLESS_TTL_MS) to a positive ms value to opt back into
  // idle reaping on memory-constrained boxes.
  const raw = process.env.PI_WEB_TTL_MS || process.env.TAU_HEADLESS_TTL_MS || "0";
  // Optional hard cap on concurrent headless children (LRU eviction on
  // lastActiveMs). 0 = unlimited. Never evicts a running agent; prefers
  // zero-client sessions. For memory-constrained boxes set e.g. 4.
  const rawMax = process.env.TAU_MAX_HEADLESS || process.env.PI_WEB_MAX_HEADLESS || "0";
  return {
    piBin: process.env.PI_WEB_PI_BIN || process.env.TAU_PI_BIN || "pi",
    ttlMs: parseInt(raw, 10) || 0,
    maxHeadless: Math.max(0, parseInt(rawMax, 10) || 0),
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

  get pid(): number | undefined {
    try { return this.proc.pid; } catch { return undefined; }
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
  // True only for a web /new backend: it may announce its discovered file so
  // the tab can pin #session=<basename>. Ambient scratch binds stay hash-less.
  hashDiscovery: boolean;
  // lastActiveMs tracks the last event/client activity so the optional
  // TTL or LRU pool cap (TAU_MAX_HEADLESS) can reap truly-idle sessions first.
  lastActiveMs: number;
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
      onFileDiscovered?: (managed: ManagedHeadless, file: string) => void;
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

  attach(ws: any, cwdRaw?: string, sessionFileRaw?: string | null, opts?: { fresh?: boolean; sessionKey?: string | null }): ManagedHeadless {
    const cwd = cwdRaw && cwdRaw.trim().length > 0 ? resolve(cwdRaw) : this.homeDir;
    const sessionFile = sessionFileRaw && sessionFileRaw.length > 0 ? basename(sessionFileRaw) : null;
    // One backend per session (shared across tabs on the same file).
    // opts.fresh (web /new) always spawns a new backend, never rejoins —
    // the old session keeps running detached, like pi's /new keeps the old file.
    let managed: ManagedHeadless | undefined;
    // Exact rejoin (reload-proof): the client names the backend id from its
    // last start_session ack. Matched against live registry ids only, so a
    // stale key can never attach a wrong or recycled session — it just
    // misses and falls through to the file scan below.
    const wantKey = opts?.sessionKey;
    if (wantKey && !opts?.fresh) {
      for (const m of this.sessions.values()) {
        if (!m.isClosing && m.id === wantKey) { managed = m; break; }
      }
    }
    if (!managed && sessionFile && !opts?.fresh) {
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
    managed.lastActiveMs = Date.now();
    if (managed.idleTimer) { clearTimeout(managed.idleTimer); managed.idleTimer = null; }
    this.socketBinding.set(ws, managed);
    // Web /new (fresh) spawns a file-less child whose session file is unknown
    // until it answers get_state; ask now so the tab can pin #session=basename.
    // Ambient binds (cold open / scratch) stay hash-less by design.
    if (opts?.fresh) { managed.hashDiscovery = true; this.requestState(managed); }
    return managed;
  }

  /** Web /new: unbind from the current session (it keeps running
   *  detached) and spawn a fresh empty session in the same or given cwd. */
  newSession(ws: any, cwdRaw?: string): ManagedHeadless {
    const current = this.socketBinding.get(ws);
    const cwd = cwdRaw && cwdRaw.trim().length > 0
      ? resolve(cwdRaw)
      : current?.cwd || this.homeDir;
    return this.attach(ws, cwd, null, { fresh: true });
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
        managed.lastActiveMs = Date.now();
        if (event?.type === "agent_start") {
          managed.isAgentRunning = true;
          if (managed.idleTimer) { clearTimeout(managed.idleTimer); managed.idleTimer = null; }
        }
        if (event?.type === "agent_end") {
          managed.isAgentRunning = false;
          // Persistent by default: a finished run stays alive with zero
          // clients so the user can resume from any tab. Only reap when
          // an opt-in positive TTL is configured.
          this.scheduleIdleCleanup(managed);
          // Discovery fallback: if the spawn-time get_state came back empty
          // (child not ready yet), the first run's end is a safe retry point.
          this.requestState(managed);
        }
        if (event?.type === "response" && event?.command === "get_state" && event?.success) {
          const sf = event?.data?.sessionFile;
          if (typeof sf === "string" && sf.length > 0) {
            const base = basename(sf);
            if (managed.discoveredFile !== base) {
              const wasKnown = !!managed.sessionFile; // resumed sessions know their file already
              managed.discoveredFile = base;
              // Only announce genuinely-new identities for a /new backend; a
              // resumed session's file is already pinned in the tab's URL.
              if (!wasKnown && managed.hashDiscovery) this.hooks.onFileDiscovered?.(managed, base);
            }
          }
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
    });
    managed = {
      id, cwd, sessionFile, rpc,
      clients: new Set(), isAgentRunning: false,
      idleTimer: null, isClosing: false, discoveredFile: null,
      hashDiscovery: false,
      lastActiveMs: Date.now(),
    };
    // Resuming an existing file is issued by the caller via switchToFile
    // after start_session resolves the absolute session path.
    this.sessions.set(id, managed);
    this.enforcePoolCap(id);
    return managed;
  }

  /** Ask a child for its current state (used to discover a fresh file). */
  private requestState(managed: ManagedHeadless): void {
    if (managed.isClosing || !managed.hashDiscovery) return;
    if (managed.sessionFile || managed.discoveredFile) return; // identity already known
    try { managed.rpc.send({ type: "get_state" }); } catch { /* child gone */ }
  }

  /** LRU cap (TAU_MAX_HEADLESS): keep at most N children alive. Evicts the
   *  least-recently-active session, preferring zero-client ones, and never a
   *  running agent (active work is never killed). Skips the session we just
   *  created so a fresh tab can't be reaped out from under itself. */
  private enforcePoolCap(protectId?: string): void {
    const max = this.opts.maxHeadless;
    if (max <= 0) return;
    while (this.sessions.size > max) {
      const candidates = [...this.sessions.values()].filter(
        (m) => m.id !== protectId && !m.isClosing && !m.isAgentRunning,
      );
      if (candidates.length === 0) {
        this.hooks.log(`[headless] pool cap ${max} exceeded (${this.sessions.size}) but no idle session to evict — all running`);
        return;
      }
      candidates.sort((a, b) => {
        const az = a.clients.size === 0 ? 0 : 1;
        const bz = b.clients.size === 0 ? 0 : 1;
        if (az !== bz) return az - bz; // zero-client first
        return a.lastActiveMs - b.lastActiveMs; // then least-recently-active
      });
      const victim = candidates[0];
      this.hooks.log(`[headless] pool cap ${max}: evicting LRU ${victim.id} (clients=${victim.clients.size}, idleMs=${Date.now() - victim.lastActiveMs})`);
      victim.isClosing = true;
      if (victim.idleTimer) { clearTimeout(victim.idleTimer); victim.idleTimer = null; }
      this.sessions.delete(victim.id);
      try { victim.rpc.kill(); } catch {}
      for (const client of victim.clients) {
        if (this.socketBinding.get(client) === victim) this.socketBinding.delete(client);
      }
      victim.clients.clear();
    }
  }

  command(ws: any, command: any): { ok: boolean; error?: string } {
    const managed = this.socketBinding.get(ws);
    if (!managed || managed.isClosing) return { ok: false, error: "no active session" };
    managed.rpc.send(command);
    return { ok: true };
  }

  switchToFile(managed: ManagedHeadless, absSessionPath: string): void {
    managed.rpc.send({ type: "switch_session", sessionPath: absSessionPath });
  }

  bindingOf(ws: any): ManagedHeadless | undefined {
    return this.socketBinding.get(ws);
  }

  detach(ws: any): void {
    // Unbind only — the session keeps running detached (even with zero
    // clients, even mid-run). Browser kill/reload never kills pi work.
    // Reaped only via closeSession/closeByFile/shutdownAll, or an
    // opt-in positive TTL.
    const current = this.socketBinding.get(ws);
    if (!current) return;
    current.clients.delete(ws);
    this.socketBinding.delete(ws);
    this.scheduleIdleCleanup(current);
  }

  /** Explicit kill from the web UI: terminate the caller's bound session. */
  closeSession(ws: any): boolean {
    const current = this.socketBinding.get(ws);
    if (!current) return false;
    this.retire(current);
    return true;
  }

  /** Explicit kill from the web UI by OS pid (ADR-013): same teardown as
   *  closeSession so WS bindings never dangle. */
  closeByPid(pid: number): boolean {
    for (const m of this.sessions.values()) {
      if (!m.isClosing && m.rpc.pid === pid) {
        this.retire(m);
        return true;
      }
    }
    return false;
  }

  /** Pids of live headless children — marks `owner: "hub"` rows in
   *  /api/processes so the UI can tell backends from terminal sessions. */
  childPids(): Set<number> {
    const out = new Set<number>();
    for (const m of this.sessions.values()) {
      if (m.isClosing) continue;
      const pid = m.rpc.pid;
      if (typeof pid === "number") out.add(pid);
    }
    return out;
  }

  private retire(managed: ManagedHeadless): void {
    managed.isClosing = true;
    if (managed.idleTimer) { clearTimeout(managed.idleTimer); managed.idleTimer = null; }
    this.sessions.delete(managed.id);
    try { managed.rpc.kill(); } catch {}
    for (const client of managed.clients) {
      if (this.socketBinding.get(client) === managed) this.socketBinding.delete(client);
    }
    managed.clients.clear();
  }

  listSessions(): Array<{ id: string; cwd: string; sessionFile: string | null; discoveredFile: string | null; clients: number; isAgentRunning: boolean; lastActiveMs: number }> {
    return [...this.sessions.values()]
      .filter((m) => !m.isClosing)
      .map((m) => ({ id: m.id, cwd: m.cwd, sessionFile: m.sessionFile, discoveredFile: m.discoveredFile, clients: m.clients.size, isAgentRunning: m.isAgentRunning, lastActiveMs: m.lastActiveMs }));
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
    // Persistent by default (ttlMs <= 0): never auto-reap. Running agents
    // are never reaped regardless of TTL.
    if (this.opts.ttlMs <= 0) return;
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
