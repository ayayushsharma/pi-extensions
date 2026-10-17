// X5 — headless spawn failures must not leave zombie bindings (B3):
//   1. an invalid cwd is refused synchronously (no session registered);
//   2. a valid cwd whose `pi` binary cannot spawn registers a backend that
//      is reaped on the async 'error'/'close' — the old code only listened
//      for 'exit', so the binding lingered and a retry rejoined a corpse.
// Uses PI_WEB_PI_BIN=/nonexistent: the hub itself boots from the real pi.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import {
  assert, assertPortFree, basePort, TMP_DIR, ensureTmp,
  waitFor, connectWs, wsRpc, fetchJson,
} from "../helpers.mjs";

export const requires = ["pi"];
export const id = "X5";
export const title = "headless failure: bad cwd refused + dead spawn leaves no zombie binding";

async function sessionList(ws) {
  const r = await wsRpc(ws, { type: "list_sessions" });
  const list = r.event?.data?.sessions;
  assert(Array.isArray(list), `list_sessions returned sessions array, got ${JSON.stringify(r).slice(0, 120)}`);
  return list;
}

export async function run() {
  ensureTmp();
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "x5-"));
  fs.writeFileSync(path.join(dir, "not-a-dir.txt"), "file");
  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({
    port,
    extraEnv: { PI_WEB_PI_BIN: path.join(dir, "does-not-exist-pi") },
  });
  try {
    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`);
    try {
      // 1. Invalid cwd is refused before any child is spawned.
      const fileCwd = await wsRpc(ws, { type: "start_session", cwd: path.join(dir, "not-a-dir.txt") });
      assert(fileCwd.event?.success === false && /not a directory/.test(fileCwd.event?.error || ""), `file cwd refused, got ${JSON.stringify(fileCwd).slice(0, 140)}`);
      const noCwd = await wsRpc(ws, { type: "start_session", cwd: path.join(dir, "missing-dir") });
      assert(noCwd.event?.success === false && /invalid cwd/.test(noCwd.event?.error || ""), `missing cwd refused, got ${JSON.stringify(noCwd).slice(0, 140)}`);
      assert((await sessionList(ws)).length === 0, "no session registered after refused cwds");
      const status = await fetchJson(`${hub.url}/api/headless/status?cwd=${encodeURIComponent(path.join(dir, "missing-dir"))}&file=x.jsonl`);
      assert(status.json?.isActive === false, `status inactive for refused cwd, got ${JSON.stringify(status.json)}`);

      // 2. Valid cwd + unspawnable binary: the ack races the failure, but the
      // registry entry must disappear once 'error'/'close' lands.
      const started = await wsRpc(ws, { type: "start_session", cwd: os.tmpdir() });
      assert(started.event?.success === true, `spawn attempt acked, got ${JSON.stringify(started).slice(0, 140)}`);
      const key = started.event?.data?.sessionKey;
      assert(key, "start_session returned a sessionKey");
      await waitFor(async () => {
        const list = await sessionList(ws);
        return list.some((s) => s.cwd === os.tmpdir()) ? null : true;
      }, { timeout: 6000, label: "dead backend reaped from the registry" });

      // Re-joining with the leaked key must not resurrect a corpse either:
      // it spawns again (fails again) and is reaped again.
      const rejoin = await wsRpc(ws, { type: "start_session", cwd: os.tmpdir(), sessionKey: key });
      assert(rejoin.event?.success === true, `rejoin acked, got ${JSON.stringify(rejoin).slice(0, 140)}`);
      await waitFor(async () => {
        const list = await sessionList(ws);
        return list.some((s) => s.cwd === os.tmpdir()) ? null : true;
      }, { timeout: 6000, label: "rejoined dead backend reaped" });
    } finally {
      ws.close();
    }
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
