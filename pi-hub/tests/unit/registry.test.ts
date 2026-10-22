// Unit tests for the runner registry invariants that need no child process:
// live runners are keyed by pid (ADR-019 clarified), headless binds reuse by
// file, live-owned files refuse plain binds, fresh bad cwds fail honestly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-unit-registry-"));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(ROOT, "sessions");
process.env.PI_CODING_AGENT_DIR = path.join(ROOT, "agent");

const { RunnerRegistry } = await import("../../extensions/lib/runners/registry.ts");
const { Runner } = await import("../../extensions/lib/runners/runner.ts");

const registry = () => new RunnerRegistry({ bin: "pi-never-spawned" });

/** A runner whose process never exits on its own, for close/wait tests. */
class FakeRunner extends Runner {
  closes = 0;
  constructor(id: string, absFile: string, cwd = ROOT) {
    super(id, "headless", cwd);
    this.absFile = absFile;
    this.state = "idle";
  }
  command() {}
  close() {
    this.closes++;
    this.closing = true;
    this.state = "dead";
  }
  waitForExit() {
    return Promise.resolve(false);
  }
}
const noopDrive = () => {};
const live = (pid, file) => ({
  pid,
  cwd: ROOT,
  sessionFile: file,
  name: `tui-${pid}`,
});

test("addLive keys by pid: two TUIs on one file stay two runners", () => {
  const reg = registry();
  const file = "/tmp/shared/session.jsonl";
  const a = reg.addLive(live(101, file), noopDrive);
  const b = reg.addLive(live(102, file), noopDrive);
  assert.notEqual(a.id, b.id);
  assert.equal(reg.getByPid(101)?.id, a.id);
  assert.equal(reg.getByPid(102)?.id, b.id);
  // Both push independently; neither orphaned the other.
  a.push({ type: "agent_start" });
  b.push({ type: "agent_start" });
  assert.equal(reg.getByPid(101)?.state, "working");
  assert.equal(reg.getByPid(102)?.state, "working");
});

test("addLive re-announce refreshes the record and the drive channel", () => {
  const reg = registry();
  const calls = [];
  const first = reg.addLive(live(201, "/tmp/a.jsonl"), () => calls.push("old"));
  const second = reg.addLive({ pid: 201, cwd: "/tmp/b", sessionFile: "/tmp/b.jsonl", name: "renamed" }, () => calls.push("new"));
  assert.equal(first.id, second.id, "same pid reuses the runner");
  assert.equal(second.cwd, "/tmp/b");
  assert.equal(second.title, "renamed");
  second.command({ type: "prompt", message: "hi" });
  assert.deepEqual(calls, ["new"], "drive goes to the fresh socket, not the dead one");
});

test("bindHeadless refuses a file owned by a live TUI (attach instead)", async () => {
  const reg = registry();
  const file = "/tmp/owned/session.jsonl";
  reg.addLive(live(301, file), noopDrive);
  await assert.rejects(
    reg.bindHeadless({}, { cwd: ROOT, absFile: file, fallbackCwd: ROOT }),
    /live TUI/,
  );
  // ...while an unowned absFile would proceed to spawn (no live owner):
  // we only assert the refusal here; spawning is covered by integration.
});

test("bindHeadless with a fresh bad cwd fails honestly (no silent fallback)", async () => {
  const reg = registry();
  const gone = path.join(ROOT, "no-such-dir");
  await assert.rejects(reg.bindHeadless({}, { cwd: gone, absFile: null, fallbackCwd: ROOT }), /invalid cwd/);
  assert.equal(reg.list().length, 0, "no zombie runner left behind");
});

test("a closing runner is unindexed at once and a rebind waits, not spawns (H8)", async () => {
  const reg = registry();
  const file = path.join(ROOT, "h8-session.jsonl");
  const runner = new FakeRunner("h8", file);
  (reg as any).add(runner);
  assert.equal(reg.getByFile(file)?.id, "h8");

  assert.equal(reg.closeById("h8"), true);
  assert.equal(reg.getByFile(file), undefined, "file is unowned during SIGTERM");
  assert.equal(runner.closes, 1);
  await assert.rejects(
    reg.bindHeadless({}, { cwd: ROOT, absFile: file }),
    /still closing/,
    "a second writer is refused while the first process is alive",
  );
});

test("TTL closes through the same closing state and unindexes the file (H2/H8)", async () => {
  const reg = new RunnerRegistry({ bin: "pi-never-spawned", ttlMs: 5 });
  const file = path.join(ROOT, "ttl-session.jsonl");
  const runner = new FakeRunner("ttl", file);
  (reg as any).add(runner);
  const ws = { id: "ws" };
  reg.bind(ws, runner);
  reg.unbind(ws); // zero viewers starts the idle timer
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runner.closes, 1, "idle TTL fired");
  assert.equal(runner.closing, true);
  assert.equal(reg.getByFile(file), undefined, "TTL close unindexes");
});
