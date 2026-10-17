// H13 — session picker endpoints: summaries, mkdir, fork.
// summaries: one cwd's sessions with title/date/running, newest first.
// mkdir: single dir under $HOME; escapes + existing refused.
// fork: byte-identical copy under a fresh pi-style name; traversal refused.
//
// Needs the real hub (extension code): TEST_REAL_HUB=1. HTTP-only.
// Throwaway PI_CODING_AGENT_SESSION_DIR keeps production transcripts safe.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, TMP_DIR, ensureTmp } from "../helpers.mjs";

export const requires = ["pi"];
export const id = "H13";
export const title = "picker endpoints: summaries + mkdir + fork";

export async function run() {
  ensureTmp();
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "h13-"));
  const projDir = path.join(dir, "proj");
  const storeDir = path.join(dir, "sessions", "proj");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });

  const keyA = "2000-01-01T00-00-00-000Z_aaaa.jsonl";
  const keyB = "2001-01-01T00-00-00-000Z_bbbb.jsonl";
  const msg = (text) => JSON.stringify({ type: "message", message: { role: "user", content: text } });
  // An assistant turn each: parseSessionFile hides lone-user-message
  // one-shots, and the picker must mirror the sidebar (real sessions only).
  const ans = (text) => JSON.stringify({ type: "message", message: { role: "assistant", content: text } });
  fs.writeFileSync(path.join(storeDir, keyA),
    JSON.stringify({ type: "session", version: 1, id: "a", timestamp: 1000, cwd: projDir }) + "\n" + msg("first session prompt") + "\n" + ans("first reply") + "\n");
  fs.writeFileSync(path.join(storeDir, keyB),
    JSON.stringify({ type: "session", version: 1, id: "b", timestamp: 2000, cwd: projDir }) + "\n" + msg("second session prompt") + "\n" + ans("second reply") + "\n");
  // A session from another project must not leak into this cwd's list.
  const other = path.join(dir, "sessions", "other");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, "2002-01-01T00-00-00-000Z_cccc.jsonl"),
    JSON.stringify({ type: "session", version: 1, id: "c", timestamp: 3000, cwd: "/elsewhere" }) + "\n");

  const port = await basePort();
  assertPortFree(port);
  const hub = await bootRealHub({ port, extraEnv: { PI_CODING_AGENT_SESSION_DIR: path.join(dir, "sessions") } });
  try {
    // 1. Summaries: both sessions, newest first, titles from first message.
    let r = await fetch(`${hub.url}/api/sessions/summaries?cwd=${encodeURIComponent(projDir)}`);
    let d = await r.json();
    assert(d.sessions?.length === 2, `two summaries, got ${JSON.stringify(d).slice(0, 120)}`);
    assert(d.sessions[0].file === keyB && d.sessions[1].file === keyA, "most-recent-first");
    assert(d.sessions[0].title === "second session prompt", `title from first message, got ${d.sessions[0].title}`);
    assert(d.sessions[0].running === false, "nothing running in the test hub");

    // 2. Unknown cwd: empty, not an error.
    r = await fetch(`${hub.url}/api/sessions/summaries?cwd=${encodeURIComponent(path.join(dir, "nobody"))}`);
    d = await r.json();
    assert(Array.isArray(d.sessions) && d.sessions.length === 0, "unknown cwd -> []");

    // 3. mkdir: creates a single dir under HOME.
    const fresh = path.join(os.homedir(), `.h13-${Date.now()}`);
    r = await fetch(`${hub.url}/api/files/mkdir`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fresh }),
    });
    d = await r.json();
    assert(d.path === fresh && fs.statSync(fresh).isDirectory(), "mkdir creates");
    fs.rmdirSync(fresh);

    // 4. mkdir outside HOME: refused.
    r = await fetch(`${hub.url}/api/files/mkdir`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/definitely-not-home-h13" }),
    });
    d = await r.json();
    assert(/Outside the home/.test(d.error || ""), `escape refused, got ${JSON.stringify(d)}`);

    // 5. Fork: identical copy under a fresh name in the same dir.
    const before = fs.readFileSync(path.join(storeDir, keyA), "utf8");
    r = await fetch(`${hub.url}/api/sessions/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dirName: "proj", file: keyA }),
    });
    d = await r.json();
    assert(d.file && d.file !== keyA && d.file.endsWith(".jsonl"), `fork named, got ${JSON.stringify(d)}`);
    assert(fs.readFileSync(path.join(storeDir, d.file), "utf8") === before, "fork byte-identical");

    // 6. Fork traversal: refused.
    r = await fetch(`${hub.url}/api/sessions/fork`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dirName: "..", file: keyA }),
    });
    d = await r.json();
    assert(/Forbidden|not found/i.test(d.error || ""), `traversal refused, got ${JSON.stringify(d)}`);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
