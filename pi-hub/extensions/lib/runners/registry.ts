/**
 * registry — the switchboard. One process per session file; same-file bind is
 * a no-op; a running agent is never switched; the pool cap evicts idle only.
 */
import { basename, resolve } from "node:path";
import { hubLog } from "../log.js";
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
  private timers = new Map<string, NodeJS.Timeout>();
  private changeListeners = new Set<(c: RegistryChange) => void>();
  private frameListeners = new Set<(f: RunnerFrame) => void>();

  constructor(private opts: RegistryOptions) {}

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
    if (runner.absFile && this.byFile.get(resolve(runner.absFile)) === runner) {
      this.byFile.delete(resolve(runner.absFile));
    }
    if (runner.pid && this.byPid.get(runner.pid) === runner) this.byPid.delete(runner.pid);
    for (const [ws, id] of this.binding) if (id === runner.id) this.binding.delete(ws);
    const t = this.timers.get(runner.id);
    if (t) clearTimeout(t);
    this.timers.delete(runner.id);
    this.change({ type: "removed", runner });
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
    // run tools in the wrong tree without telling anyone).
    let cwd = requested;
    let cwdFallback: { from: string; to: string } | null = null;
    try {
      assertValidCwd(cwd);
    } catch {
      cwd = resolve(opts.fallbackCwd || process.env.HOME || process.cwd());
      assertValidCwd(cwd);
      cwdFallback = { from: requested, to: cwd };
      hubLog(`cwd fallback: ${requested} -> ${cwd}`);
    }

    let runner = abs ? this.byFile.get(abs) : undefined;
    if (!runner) {
      // A fresh child in the same cwd with no identity yet is not reusable.
      runner = new HeadlessRunner({ cwd, absFile: abs, bin: this.opts.bin, env: this.opts.env });
      runner.cwdFallback = cwdFallback;
      this.add(runner);
      this.enforceCap(runner.id);
      try {
        await (runner as HeadlessRunner).ready();
        if (abs) await (runner as HeadlessRunner).resume(abs);
      } catch (e) {
        runner.close();
        throw e;
      }
    } else if (cwdFallback && runner.kind === "headless") {
      runner.cwdFallback = cwdFallback;
    }
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

  addLive(record: LiveRecord, onDrive: (frame: any) => void): LiveRunner {
    let existing = this.byPid.get(record.pid) as LiveRunner | undefined;
    if (!existing) existing = this.getByFile(record.sessionFile || "") as LiveRunner | undefined;
    if (existing && existing.kind === "live") {
      existing.updateRecord(record);
      if (existing.pid && existing.pid !== record.pid) {
        this.byPid.delete(existing.pid);
        existing.pid = record.pid;
        this.byPid.set(record.pid, existing);
      }
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
    runner.close();
    return true;
  }

  closeByPid(pid: number): boolean {
    const runner = this.byPid.get(pid);
    if (!runner) return false;
    runner.close();
    return true;
  }

  /** LRU cap: zero-viewer, idle runners first; a running agent is never killed. */
  private enforceCap(protectId?: string): void {
    const max = this.opts.maxHeadless || 0;
    if (max <= 0) return;
    const headless = () =>
      [...this.runners.values()].filter((r) => r.kind === "headless" && r.state !== "dead");
    while (headless().length > max) {
      const candidates = headless().filter(
        (r) => r.id !== protectId && r.state !== "working",
      );
      if (!candidates.length) {
        hubLog(`pool cap ${max}: all runners are working — not evicting`);
        return;
      }
      candidates.sort((a, b) => a.viewers() - b.viewers() || a.lastActiveAt - b.lastActiveAt);
      const victim = candidates[0];
      hubLog(`pool cap ${max}: evicting ${victim.id}`);
      victim.close();
    }
  }

  private scheduleTtl(runner: Runner): void {
    if (!this.opts.ttlMs || this.opts.ttlMs <= 0) return;
    if (runner.state === "working" || runner.viewers() > 0) return;
    if (this.timers.has(runner.id)) return;
    const t = setTimeout(() => {
      this.timers.delete(runner.id);
      if (runner.viewers() === 0 && runner.state !== "working") runner.close();
    }, this.opts.ttlMs);
    t.unref?.();
    this.timers.set(runner.id, t);
  }

  shutdownAll(): void {
    for (const r of this.runners.values()) {
      try {
        r.close();
      } catch {}
    }
    this.runners.clear();
    this.byFile.clear();
    this.byPid.clear();
    this.binding.clear();
  }
}
