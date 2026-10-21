// Unit tests for pi-process discovery — the feature that must also work on
// Android/Termux, where `process.platform === "android"` and pi runs as
// `node …/pi-coding-agent/…/cli.js`. A fake /proc tree keeps this fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const proc = await import("../../extensions/lib/processes.ts");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-unit-proc-"));
const PROC = path.join(ROOT, "proc");
fs.mkdirSync(PROC);

function fake(pid: number, argv: string[], { rssPages = 1000, cwd = ROOT, exe = "/usr/bin/node" } = {}): number {
  const dir = path.join(PROC, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cmdline"), `${argv.join("\0")}\0`);
  fs.writeFileSync(path.join(dir, "statm"), `1000 ${rssPages} 200 1 0 300 0`);
  if (cwd) fs.symlinkSync(cwd, path.join(dir, "cwd"));
  if (exe) fs.symlinkSync(exe, path.join(dir, "exe"));
  return pid;
}

const onProc = proc.supportsProcessScan();
const skip = onProc ? false : "no /proc on this platform";

test("platform gate accepts Linux, Android and macOS, rejects the rest", () => {
  assert.equal(proc.supportsProcessScan("linux"), true);
  assert.equal(proc.supportsProcessScan("android"), true, "Termux reports android, not linux");
  assert.equal(proc.supportsProcessScan("darwin"), true, "macOS scans through ps");
  assert.equal(proc.supportsProcessScan("win32"), false);
});

test("fingerprint matches pi's real argv shapes, never a random node", { skip }, () => {
  fake(100, ["/usr/bin/pi", "--mode", "rpc"]); // compiled/shim name
  fake(101, ["node", "/x/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--mode", "rpc"]);
  fake(102, ["/bin/sh", "/home/u/scripts/pi-node.sh", "-e", "."]); // wrapper before exec
  fake(103, ["node", "/srv/app/server.js", "--port", "3000"]); // unrelated node
  fake(104, ["python3", "/srv/pi.py"]); // substring "pi" is not enough
  fake(105, ["node", "/opt/pi/bundle/cli.js"]);
  fake(106, ["/usr/bin/nodejs", "/opt/pi-coding-agent/dist/cli.js"]);
  fake(107, ["/bin/sh", "/srv/run.sh"], { exe: "/opt/pi" }); // exe fallback
  fake(108, ["bun", "/opt/pi-coding-agent/dist/cli.js", "--mode", "rpc"]);
  fake(109, ["/system/bin/sh", "/data/data/com.termux/files/usr/lib/node_modules/.bin/pi"]);

  assert.equal(proc.isPiProcess(100, PROC), true);
  assert.equal(proc.isPiProcess(101, PROC), true, "node + pi-coding-agent path");
  assert.equal(proc.isPiProcess(102, PROC), true, "pi-node.sh wrapper");
  assert.equal(proc.isPiProcess(103, PROC), false, "plain node app");
  assert.equal(proc.isPiProcess(104, PROC), false, "pi.py is not pi");
  assert.equal(proc.isPiProcess(105, PROC), true, "bundle/cli.js");
  assert.equal(proc.isPiProcess(106, PROC), true, "nodejs + pi install");
  assert.equal(proc.isPiProcess(107, PROC), true, "exe basename pi");
  assert.equal(proc.isPiProcess(108, PROC), true, "bun + pi install");
  assert.equal(proc.isPiProcess(109, PROC), true, "npm .bin/pi shim");
  assert.equal(proc.isPiProcess(0, PROC), false);
  assert.equal(proc.isPiProcess(9999, PROC), false, "missing pid");
});

test("scan lists only pi pids, labels hub children, skips self and init", { skip }, () => {
  const out = proc.scanPiProcesses(new Set([101]), 101, PROC);
  assert.equal(out.unsupported, undefined);
  const pids = out.processes.map((p) => p.pid);
  assert.deepEqual(pids, [100, 102, 105, 106, 107, 108, 109], "103/104 excluded, 101 is self");
  const child = out.processes.find((p) => p.pid === 100);
  assert.equal(child?.owner, "live");
  assert.equal(child?.rssKb, 4000, "statm pages -> KiB");
  assert.equal(child?.cwd, ROOT);

  const owned = proc.scanPiProcesses(new Set([100]), 999, PROC);
  assert.equal(owned.processes.find((p) => p.pid === 100)?.owner, "hub");
});

test("kill refuses self, init, hub-owned and non-pi pids before signalling", { skip }, async () => {
  await assert.rejects(proc.killLivePiProcess(1, new Set(), 999, PROC), /invalid pid/);
  await assert.rejects(proc.killLivePiProcess(0, new Set(), 999, PROC), /invalid pid/);
  await assert.rejects(proc.killLivePiProcess(999, new Set(), 999, PROC), /hub itself/);
  await assert.rejects(proc.killLivePiProcess(100, new Set([100]), 999, PROC), /close_session/);
  await assert.rejects(proc.killLivePiProcess(103, new Set(), 999, PROC), /not a pi process/);
});

test("ps parse keeps pid/rss/command apart, skips pid 1 and junk", () => {
  const rows = proc.parsePs(
    "  4669 198432 02:05:23 /usr/local/bin/pi --mode rpc\n" +
    "   123    512 00:00 node /srv/app/server.js\n" +
    "     1      64 3-02:05:23 /sbin/launchd\n" +
    "junk line\n",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 4669);
  assert.equal(rows[0].rssKb, 198432);
  assert.ok(rows[0].startedAt !== null && rows[0].startedAt <= Date.now());
  assert.equal(rows[0].command, "/usr/local/bin/pi --mode rpc");
  assert.equal(rows[1].pid, 123);
});
