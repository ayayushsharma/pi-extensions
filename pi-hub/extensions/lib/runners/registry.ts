/**
 * registry — the switchboard. One process per session file; same-file bind is
 * a no-op; a running agent is never switched; the pool cap evicts idle only.
 */
import * as fs from "node:fs";
import { resolve } from "node:path";
import { hubLog } from "../log.js";
import { sessionCwd } from "../store/sessions.js";
import { HeadlessRunner, assertValidCwd } from "./headless.js";
import { LiveRunner, type LiveRecord } from "./live.js";
import { Runner, type RunnerFrame } from "./runner.js";

export interface RegistryOptions {
  bin: string;
  ttlMs?: number;
  maxHeadless?: number;
  env?: NodeJS.ProcessEnv;
  onFrame?: (frame: RunnerFrame) => void;
}

export type RegistryChange =
  | { type: "added"; runner: Runner }
  | { type: "status"; runner: Runner }
  | { type: "removed"; runner: Runner };

export class RunnerRegistry {
  private runners = new Map<string, Runner>();
  private byFile = new Map<string, Runner>();
  private byPid = new Map<number, Runner>();
  private binding = new Map<unknown, string>();
  private pendingBinds = new Map<string, Promise<Runner>>();
  /** Files whose previous child is still shutting down. A bind waits for the
   *  exit (or fails honestly) instead of starting a second writer (H8). */
  private closingByFile = new Map<string, Runner>();
  private timers = new Map<string, NodeJS.Timeout>();
  private changeListeners = new Set<(c: RegistryChange) => void>();
  private frameListeners = new Set<(f: RunnerFrame) => void>();
  private spawnAt: number[] = [];

  private opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.opts = opts;
  }

  list(): Runner[] {
    return [...this.runners.values()];
  }

  get(id: string): Runner | undefined {
    return this.runners.get(id);
  }

  getByFile(absFile: string): Runner | undefined {
    return this.byFile.get(resolve(absFile));
  }

  getByPid(pid: number): Runner | undefined {
    return this.byPid.get(pid);
  }

  runnerFor(ws: unknown): Runner | undefined {
    const id = this.binding.get(ws);
    return id ? this.runners.get(id) : undefined;
  }

  onChange(cb: (c: RegistryChange) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onFrame(cb: (f: RunnerFrame) => void): void {
    this.frameListeners.add(cb);
  }

  private change(c: RegistryChange): void {
    for (const cb of [...this.changeListeners]) {
      try {
        cb(c);
      } catch {}
    }
  }

  private add(runner: Runner): void {
    this.runners.set(runner.id, runner);
    if (runner.absFile) this.byFile.set(resolve(runner.absFile), runner);
    if (runner.pid) this.byPid.set(runner.pid, runner);
    runner.onFrame((f) => {
      // keep file/pid indexes fresh if a child discovers its identity later
      if (runner.absFile && this.byFile.get(resolve(runner.absFile)) !== runner) {
        this.byFile.set(resolve(runner.absFile), runner);
      }
      for (const cb of this.frameListeners) {
        try {
          cb(f);
        } catch {}
      }
      const ev = f.event;
      if (ev?.type === "session_file" || ev?.type === "runner_status" || ev?.type === "agent_start" || ev?.type === "agent_end") {
        this.change({ type: "status", runner });
      }
      if (ev?.type === "runner_exit") this.remove(runner);
    });
    this.change({ type: "added", runner });
  }

  private remove(runner: Runner): void {
    if (!this.runners.has(runner.id)) return;
    this.runners.delete(runner.id);
    if (runner.absFile) {
      const abs = resolve(runner.absFile);
      if (this.byFile.get(abs) === runner) this.byFile.delete(abs);
      if (this.closingByFile.get(abs) === runner) this.closingByFile.delete(abs);
    }
    if (runner.pid && this.byPid.get(runner.pid) === runner) this.byPid.delete(runner.pid);
    for (const [ws, id] of this.binding) if (id === runner.id) this.binding.delete(ws);
    const t = this.timers.get(runner.id);
    if (t) clearTimeout(t);
    this.timers.delete(runner.id);
    this.change({ type: "removed", runner });
  }

  /** One spawn per session file, shared by concurrent binds (H2): the
   *  first caller spawns; the rest await the same promise and bind the
   *  same runner instead of starting a second child. */
  private async spawnHeadless(cwd: string, abs: string | null, cwdFallback: { from: string; to: string } | null): Promise<HeadlessRunner> {
    // Spawn throttle: children cost seconds and tens of MB each. Human
    // flows (tabs, picker, reload storms) never approach 20 spawns/min;
    // a looping client does. Thrown before the spawn, never after.
    const now = Date.now();
    this.spawnAt = this.spawnAt.filter((t) => now - t < 60_000);
    if (this.spawnAt.length >= 20) {
      throw new Error("spawn rate limit exceeded — close idle sessions first");
    }
    this.spawnAt.push(now);
    // A fresh child in the same cwd with no identity yet is not reusable.
    const runner = new HeadlessRunner({ cwd, absFile: abs, bin: this.opts.bin, env: this.opts.env });
    runner.cwdFallback = cwdFallback;
    this.add(runner);
    this.enforceCap(runner.id);
    try {
      await runner.ready();
      if (abs) await runner.resume(abs);
    } catch (e) {
      // A half-initialized child is still a writer; close it through the
      // registry so its file is unindexed and a retry waits for the exit.
      this.closeRunner(runner);
      throw e;
    }
    return runner;
  }

  /** Bind a browser to a headless child for a session (resuming when needed). */
  async bindHeadless(
    ws: unknown,
    opts: { cwd: string; absFile?: string | null; fallbackCwd?: string },
  ): Promise<Runner> {
    const requested = resolve(opts.cwd || process.cwd());
    const abs = opts.absFile ? resolve(opts.absFile) : null;
    // R-10: a session whose folder is gone must still open — resume in the
    // hub's default cwd and let the UI explain why (silent fallback would
    // run tools in the wrong tree without telling anyone). Resume-only: a
    // fresh bind with a bad cwd is an honest error, never a quiet move into
    // another directory. The stored-cwd check covers resumes that name a
    // valid-but-different cwd while the session's own folder is gone and
    // matches what was asked for (pi would refuse the switch otherwise).
    let cwd = requested;
    let cwdFallback: { from: string; to: string } | null = null;
    if (!abs) {
      assertValidCwd(cwd);
    } else {
      let valid = true;
      try {
        assertValidCwd(cwd);
      } catch {
        valid = false;
      }
      if (valid) {
        try {
          const stored = sessionCwd(abs);
          valid = !stored || resolve(stored) !== cwd || fs.existsSync(stored);
        } catch {
          valid = true;
        }
      }
      if (!valid) {
        cwd = resolve(opts.fallbackCwd || process.env.HOME || process.cwd());
        assertValidCwd(cwd);
        cwdFallback = { from: requested, to: cwd };
        hubLog(`cwd fallback: ${requested} -> ${cwd}`);
      }
    }

    // H8: the old owner is unindexed as soon as close starts, but its child
    // may still be running SIGTERM/SIGKILL. Wait for the actual exit before
    // spawning a replacement; if it refuses to die, report it instead of
    // violating the one-writer-per-file invariant.
    if (abs) {
      const closing = this.closingByFile.get(abs);
      if (closing) {
        const exited = await closing.waitForExit(3000);
        if (!exited) throw new Error("session is still closing — retry in a moment");
        if (this.closingByFile.get(abs) === closing) this.closingByFile.delete(abs);
      }
    }

    let runner = abs ? this.byFile.get(abs) : undefined;
    if (runner?.closing) {
      const exited = await runner.waitForExit(3000);
      if (!exited) throw new Error("session is still closing — retry in a moment");
      this.unindexFile(runner);
      runner = undefined;
    }
    if (runner && runner.kind !== "headless") {
      // A live TUI owns this file: never spawn a second writer behind it
      // (dual-write), and never hand its relay to a plain bind — driving a
      // live session requires attach (ADR-014 single driver, C1).
      throw new Error("session is owned by a live TUI — attach to it instead of binding");
    }
    if (abs && (!runner || runner.state === "dead")) {
      // Serialized resume: concurrent binds for one file share the first
      // caller's spawn (H2). A dead indexed runner is never reused — a
      // retry landing mid-SIGTERM spawns fresh instead of binding a corpse.
      let pending = this.pendingBinds.get(abs);
      if (!pending) {
        pending = this.spawnHeadless(cwd, abs, cwdFallback);
        this.pendingBinds.set(abs, pending);
        void pending.then(
          () => { if (this.pendingBinds.get(abs) === pending) this.pendingBinds.delete(abs); },
          () => { if (this.pendingBinds.get(abs) === pending) this.pendingBinds.delete(abs); },
        );
      }
      runner = await pending;
    } else if (!runner) {
      runner = await this.spawnHeadless(cwd, null, null);
    }
    if (runner.closing || runner.state === "dead") {
      throw new Error("session closed while binding — retry");
    }
    if (cwdFallback) runner.cwdFallback = cwdFallback;
    this.bind(ws, runner);
    return runner;
  }

  bind(ws: unknown, runner: Runner): void {
    const previous = this.runnerFor(ws);
    if (previous && previous !== runner) previous.unbind(ws);
    this.binding.set(ws, runner.id);
    runner.bind(ws);
    const t = this.timers.get(runner.id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(runner.id);
    }
  }

  unbind(ws: unknown): void {
    const runner = this.runnerFor(ws);
    if (!runner) return;
    this.binding.delete(ws);
    runner.unbind(ws);
    this.scheduleTtl(runner);
  }

  /**
   * Live runners are keyed by pid only (ADR-019, clarified): two TUIs may
   * legitimately open the same session file, and collapsing them by file
   * orphans the first TUI's relay (its pid mapping is lost and its events
   * drop). One headless child per file stays the rule; live is one runner
   * per announcing process. A same-pid re-announce (re-dial, session
   * switch) refreshes the record and the drive channel, whose old socket
   * is dead.
   */
  addLive(record: LiveRecord, onDrive: (frame: any) => void): LiveRunner {
    const existing = this.byPid.get(record.pid) as LiveRunner | undefined;
    if (existing && existing.kind === "live") {
      existing.updateRecord(record);
      existing.onDrive = onDrive;
      if (existing.absFile) this.byFile.set(resolve(existing.absFile), existing);
      return existing;
    }
    const runner = new LiveRunner(record, onDrive);
    this.add(runner);
    return runner;
  }

  removeLive(pid: number, reason = "disconnected"): void {
    const runner = this.byPid.get(pid);
    if (runner && runner.kind === "live") (runner as LiveRunner).kill(reason);
  }

  closeById(id: string): boolean {
    const runner = this.runners.get(id);
    if (!runner) return false;
    this.closeRunner(runner);
    return true;
  }

  closeByPid(pid: number): boolean {
    const runner = this.byPid.get(pid);
    if (!runner) return false;
    this.closeRunner(runner);
    return true;
  }

  /** A closing runner stops owning its file at once: a retry waits for the
   *  process exit instead of landing on a child mid-SIGTERM (H8). Exit still
   *  removes it fully; the identity guard keeps a newer owner safe. */
  private closeRunner(runner: Runner): void {
    if (runner.closing) return;
    this.unindexFile(runner);
    const abs = runner.absFile ? resolve(runner.absFile) : null;
    runner.closing = true;
    if (abs) this.closingByFile.set(abs, runner);
    runner.close();
  }

  private unindexFile(runner: Runner): void {
    if (runner.absFile && this.byFile.get(resolve(runner.absFile)) === runner) {
      this.byFile.delete(resolve(runner.absFile));
    }
  }

  /** LRU cap: zero-viewer, idle runners first; a running agent is never killed. */
  private enforceCap(protectId?: string): void {
    const max = this.opts.maxHeadless || 0;
    if (max <= 0) return;
    const headless = () =>
      [...this.runners.values()].filter(
        (r) => r.kind === "headless" && r.state !== "dead" && !r.closing,
      );
    while (headless().length > max) {
      const candidates = headless().filter(
        (r) => r.id !== protectId && r.state !== "working" && !r.closing,
      );
      if (!candidates.length) {
        hubLog(`pool cap ${max}: all runners are working — not evicting`);
        return;
      }
      candidates.sort((a, b) => a.viewers() - b.viewers() || a.lastActiveAt - b.lastActiveAt);
      const victim = candidates[0];
      hubLog(`pool cap ${max}: evicting ${victim.id}`);
      this.closeRunner(victim);
    }
  }

  private scheduleTtl(runner: Runner): void {
    if (!this.opts.ttlMs || this.opts.ttlMs <= 0) return;
    if (runner.state === "working" || runner.viewers() > 0) return;
    if (this.timers.has(runner.id)) return;
    const t = setTimeout(() => {
      this.timers.delete(runner.id);
      if (runner.viewers() === 0 && runner.state !== "working" && !runner.closing) {
        this.closeRunner(runner);
      }
    }, this.opts.ttlMs);
    t.unref?.();
    this.timers.set(runner.id, t);
  }

  shutdownAll(): void {
    this.pendingBinds.clear();
    for (const r of this.runners.values()) {
      try {
        this.closeRunner(r);
      } catch {}
    }
    this.runners.clear();
    this.byFile.clear();
    this.byPid.clear();
    this.binding.clear();
    this.closingByFile.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
