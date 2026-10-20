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

const registry = () => new RunnerRegistry({ bin: "pi-never-spawned" });
const noopDrive = () => {};
const live = (pid, file) => ({
  pid,
  cwd: "/tmp",
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
    reg.bindHeadless({}, { cwd: "/tmp", absFile: file, fallbackCwd: "/tmp" }),
    /live TUI/,
  );
  // ...while an unowned absFile would proceed to spawn (no live owner):
  // we only assert the refusal here; spawning is covered by integration.
});

test("bindHeadless with a fresh bad cwd fails honestly (no silent fallback)", async () => {
  const reg = registry();
  const gone = path.join(ROOT, "no-such-dir");
  await assert.rejects(reg.bindHeadless({}, { cwd: gone, absFile: null, fallbackCwd: "/tmp" }), /invalid cwd/);
  assert.equal(reg.list().length, 0, "no zombie runner left behind");
});
