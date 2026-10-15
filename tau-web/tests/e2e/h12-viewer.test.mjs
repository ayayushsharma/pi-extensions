// H12 — read-only file viewer endpoint (/api/files/content).
// Serves file text jailed to the VIEWED session's cwd (resolved
// server-side from the session file, never trusted from the client):
// inside -> content, outside -> refused, unknown session -> refused,
// binary -> flagged not served, oversize -> head + truncated flag.
//
// Needs the real hub (the stub has no session registry): TEST_REAL_HUB=1.
// HTTP-only, no WS, no browser. The session store is a throwaway
// PI_CODING_AGENT_SESSION_DIR so production transcripts are untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, TMP_DIR, ensureTmp } from "../helpers.mjs";

export const id = "H12";
export const title = "viewer endpoint: content jailed to the viewed session";

async function get(url, params) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${url}/api/files/content?${q}`);
  return res.json();
}

export async function run() {
  ensureTmp();
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "h12-"));
  const projDir = path.join(dir, "proj");
  const storeDir = path.join(dir, "sessions", "proj");
  fs.mkdirSync(storeDir, { recursive: true });

  // Viewed session: first line carries the cwd the jail resolves.
  const key = "2000-01-01T00-00-00-000Z_deadbeef.jsonl";
  fs.writeFileSync(
    path.join(storeDir, key),
    JSON.stringify({ type: "session", version: 1, id: "x", timestamp: 0, cwd: projDir }) + "\n",
  );
  const src = path.join(projDir, "hello.py");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(src, "def hi():\n    return 'tau'\n");
  fs.writeFileSync(path.join(projDir, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0xff]));
  fs.writeFileSync(path.join(dir, "outside.txt"), "must not leak");
  const big = path.join(projDir, "big.txt");
  fs.writeFileSync(big, "x".repeat(300 * 1024));

  const port = await basePort();
  assertPortFree(port);
  const hub = await bootRealHub({ port, extraEnv: { PI_CODING_AGENT_SESSION_DIR: path.join(dir, "sessions") } });
  try {
    // 1. Inside the jail: content served.
    const ok = await get(hub.url, { path: src, sessionKey: key });
    assert(ok.content === "def hi():\n    return 'tau'\n", `content served, got ${JSON.stringify(ok).slice(0, 80)}`);
    assert(ok.truncated === false, "small file not truncated");
    assert(ok.path === fs.realpathSync(src), "realpath returned");

    // 2. Outside the jail: refused.
    const out = await get(hub.url, { path: path.join(dir, "outside.txt"), sessionKey: key });
    assert(out.error === "Outside the viewed session", `escape refused, got ${JSON.stringify(out)}`);

    // 3. Unknown session: refused (no jail resolvable).
    const nos = await get(hub.url, { path: src, sessionKey: "nope.jsonl" });
    assert(/Unknown session/.test(nos.error || ""), `unknown session refused, got ${JSON.stringify(nos)}`);

    // 4. Binary: flagged, bytes not served.
    const bin = await get(hub.url, { path: path.join(projDir, "blob.bin"), sessionKey: key });
    assert(bin.binary === true && !("content" in bin), `binary flagged, got ${JSON.stringify(bin)}`);

    // 5. Oversize: 256 KiB head + truncated flag.
    const bg = await get(hub.url, { path: big, sessionKey: key });
    assert(bg.truncated === true, "big file truncated");
    assert(bg.content.length === 256 * 1024, `head is 256 KiB, got ${bg.content?.length}`);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
