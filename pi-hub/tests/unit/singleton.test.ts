// Unit tests for the hub singleton (ADR-021): one hub per advert scope.
// Fast (temp dirs + loopback probes only, no hub/child/browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const singleton = await import("../../extensions/lib/hub/singleton.ts");
const probe = await import("../../extensions/lib/probe.ts");

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pihub-unit-singleton-"));
const advertIn = (d) => path.join(d, "hub.json");

/** A pid that stays alive for the test (killed afterwards). */
function livePid() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return child;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function heldPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

test("readAdvert returns null for missing/corrupt/incomplete files", () => {
  const d = dir();
  assert.equal(singleton.readAdvert(advertIn(d)), null);
  fs.writeFileSync(advertIn(d), "not json");
  assert.equal(singleton.readAdvert(advertIn(d)), null);
  fs.writeFileSync(advertIn(d), JSON.stringify({ pid: 123 }));
  assert.equal(singleton.readAdvert(advertIn(d)), null);
});

test("writeAdvert/readAdvert round-trip", () => {
  const d = dir();
  const claim = { sock: "/tmp/x/hub.sock", port: 8292, host: "127.0.0.1", pid: process.pid, startedAt: Date.now() };
  singleton.writeAdvert(advertIn(d), claim);
  assert.deepEqual(singleton.readAdvert(advertIn(d)), claim);
});

test("releaseSingleton removes only our own claim", () => {
  const d = dir();
  singleton.writeAdvert(advertIn(d), { sock: "", port: 1, host: "127.0.0.1", pid: process.pid, startedAt: Date.now() });
  singleton.releaseSingleton(advertIn(d));
  assert.equal(fs.existsSync(advertIn(d)), false);

  singleton.writeAdvert(advertIn(d), { sock: "", port: 1, host: "127.0.0.1", pid: 999999999, startedAt: Date.now() });
  singleton.releaseSingleton(advertIn(d));
  assert.equal(fs.existsSync(advertIn(d)), true);
});

test("pidAlive distinguishes live, dead and invalid pids", () => {
  const child = livePid();
  try {
    assert.equal(singleton.pidAlive(process.pid), true);
    assert.equal(singleton.pidAlive(child.pid), true);
    assert.equal(singleton.pidAlive(999999999), false);
    assert.equal(singleton.pidAlive(0), false);
    assert.equal(singleton.pidAlive(1), false);
    assert.equal(singleton.pidAlive("1234"), false);
    assert.equal(singleton.pidAlive(undefined), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("findLiveHub ignores free scopes, stale files and our own claim", async () => {
  const d = dir();
  assert.equal(await singleton.findLiveHub(advertIn(d)), null);

  // Dead pid: stale even though the port/sock point nowhere.
  singleton.writeAdvert(advertIn(d), { sock: "", port: 1, host: "127.0.0.1", pid: 999999999, startedAt: Date.now() - 60000 });
  assert.equal(await singleton.findLiveHub(advertIn(d)), null);

  // Our own pid: reclaimable (a previous start in this process).
  singleton.writeAdvert(advertIn(d), { sock: "", port: 1, host: "127.0.0.1", pid: process.pid, startedAt: Date.now() });
  assert.equal(await singleton.findLiveHub(advertIn(d)), null);
});

test("findLiveHub sees a live hub via its TCP port", async () => {
  const d = dir();
  const child = livePid();
  const held = await heldPort();
  try {
    singleton.writeAdvert(advertIn(d), {
      sock: "",
      port: held.port,
      host: "127.0.0.1",
      pid: child.pid,
      startedAt: Date.now() - 60000,
    });
    const live = await singleton.findLiveHub(advertIn(d));
    assert.ok(live, "expected the port holder to count as live");
    assert.equal(live.pid, child.pid);
  } finally {
    held.server.close();
    child.kill("SIGKILL");
  }
  // Port gone and started long ago: stale, even though the pid lives.
  const child2 = livePid();
  try {
    const port = await freePort();
    singleton.writeAdvert(advertIn(d), {
      sock: "",
      port,
      host: "127.0.0.1",
      pid: child2.pid,
      startedAt: Date.now() - 60000,
    });
    assert.equal(await singleton.findLiveHub(advertIn(d)), null);
  } finally {
    child2.kill("SIGKILL");
  }
});

test("findLiveHub sees a live hub via its socket", async () => {
  const d = dir();
  const child = livePid();
  const sockPath = path.join(d, "hub.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(sockPath, resolve));
  try {
    const port = await freePort();
    singleton.writeAdvert(advertIn(d), {
      sock: sockPath,
      port,
      host: "127.0.0.1",
      pid: child.pid,
      startedAt: Date.now() - 60000,
    });
    const live = await singleton.findLiveHub(advertIn(d));
    assert.ok(live, "expected the socket holder to count as live");
  } finally {
    server.close();
    child.kill("SIGKILL");
  }
});

test("findLiveHub treats a just-claimed hub as live (still binding)", async () => {
  const d = dir();
  const child = livePid();
  try {
    const port = await freePort();
    singleton.writeAdvert(advertIn(d), {
      sock: path.join(d, "missing.sock"),
      port,
      host: "127.0.0.1",
      pid: child.pid,
      startedAt: Date.now(),
    });
    const live = await singleton.findLiveHub(advertIn(d));
    assert.ok(live, "a fresh claim must block even before its port accepts");
  } finally {
    child.kill("SIGKILL");
  }
});

test("claimSingleton refuses a live hub and reclaims a stale one", async () => {
  const d = dir();
  const child = livePid();
  const held = await heldPort();
  const mine = { sock: "", port: 1, host: "127.0.0.1", pid: process.pid, startedAt: Date.now() };
  try {
    singleton.writeAdvert(advertIn(d), {
      sock: "",
      port: held.port,
      host: "127.0.0.1",
      pid: child.pid,
      startedAt: Date.now() - 60000,
    });
    await assert.rejects(singleton.claimSingleton(advertIn(d), mine), /already running/);
    // The refused claim must not overwrite the owner's advert.
    assert.equal(singleton.readAdvert(advertIn(d)).pid, child.pid);
  } finally {
    held.server.close();
    child.kill("SIGKILL");
  }

  singleton.writeAdvert(advertIn(d), { sock: "", port: 1, host: "127.0.0.1", pid: 999999999, startedAt: 1 });
  await singleton.claimSingleton(advertIn(d), mine);
  assert.equal(singleton.readAdvert(advertIn(d)).pid, process.pid);
});

test("probePort reports open/closed loopback ports", async () => {
  const held = await heldPort();
  try {
    assert.equal(await probe.probePort("127.0.0.1", held.port), true);
  } finally {
    held.server.close();
  }
  assert.equal(await probe.probePort("127.0.0.1", await freePort()), false);
  assert.equal(await probe.probePort("127.0.0.1", 0), false);
});
