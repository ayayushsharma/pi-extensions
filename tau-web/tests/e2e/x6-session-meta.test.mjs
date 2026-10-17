// X6 — the session-history endpoint must describe the WHOLE session, not the
// slice it ships. `/api/sessions/:dir/:file?limit=N` windows `entries` to the
// tail, but the header needs the session's model/thinking level, and those
// change entries sit at the TOP of the file: a >50-entry session's first paint
// used to arrive with no way to know its model (H19 covers the client side).
// Real hub, HTTP only, no browser, no headless child — SKIPs without `pi`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, fetchJson } from "../helpers.mjs";

export const requires = ["pi"];
export const id = "X6";
export const title = "session history: model/thinking describe the whole file, not the window";

const DIR_NAME = "--tmp-e2e-x6--";

function entry(type, extra = {}) {
  return JSON.stringify({ type, parentId: null, timestamp: new Date().toISOString(), ...extra });
}

function seededSession(total = 62) {
  // model/thinking changes at the top, then enough filler that a `?limit=5`
  // tail cannot contain any change entry; a later pair proves "last wins".
  const lines = [
    entry("session", { id: "s0", cwd: "/tmp/e2e-x6" }),
    entry("model_change", { id: "m1", modelId: "x6-early-model" }),
    entry("thinking_level_change", { id: "t1", thinkingLevel: "low" }),
  ];
  for (let i = 0; i < total; i++) lines.push(entry("message", { id: `p${i}`, message: { role: "user", content: `filler ${i}` } }));
  lines.push(entry("model_change", { id: "m2", modelId: "x6-late-model" }));
  lines.push(entry("thinking_level_change", { id: "t2", thinkingLevel: "high" }));
  for (let i = 0; i < total; i++) lines.push(entry("message", { id: `q${i}`, message: { role: "assistant", content: `filler ${i}` } }));
  return { text: lines.join("\n") + "\n", total: lines.length, last5: lines.slice(-5) };
}

export async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-e2e-x6-"));
  const store = path.join(dir, "store");
  fs.mkdirSync(path.join(store, DIR_NAME), { recursive: true });
  const windowed = seededSession();
  fs.writeFileSync(path.join(store, DIR_NAME, "windowed.jsonl"), windowed.text);
  fs.writeFileSync(path.join(store, DIR_NAME, "bare.jsonl"), [
    entry("session", { id: "b0", cwd: "/tmp/e2e-x6" }),
    ...Array.from({ length: 60 }, (_, i) => entry("message", { id: `b${i}`, message: { role: "user", content: "no change entries" } })),
  ].join("\n") + "\n");

  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({ port, extraEnv: { PI_CODING_AGENT_SESSION_DIR: store } });
  try {
    const get = async (q) => {
      const r = await fetchJson(`${hub.url}/api/sessions/${DIR_NAME}/windowed.jsonl${q}`);
      assert(r.res.status === 200, `GET ${q || "(full)"} status ${r.res.status}`);
      return r.json;
    };

    // ── windowed tail: entries are a slice, the identity is the whole file ──
    const tail = await get("?limit=5");
    assert(Array.isArray(tail.entries) && tail.entries.length === 5, `?limit=5 shipped ${tail.entries?.length} entries`);
    assert(tail.entries.every((e) => e.type === "message"), "?limit=5 shipped a change entry (fixture no longer windows the top)");
    assert(tail.model?.id === "x6-late-model", `?limit=5 model is ${JSON.stringify(tail.model)}, expected the last change (x6-late-model)`);
    assert(tail.thinkingLevel === "high", `?limit=5 thinkingLevel is ${tail.thinkingLevel}, expected the last change (high)`);

    // ── paging backwards must not change the session identity either ──
    const before = tail.entries[0].id;
    const page = await get(`?limit=2&before=${encodeURIComponent(before)}`);
    assert(page.entries.length === 2, `paging page shipped ${page.entries.length} entries`);
    assert(page.model?.id === "x6-late-model" && page.thinkingLevel === "high", "paging changed the session identity");

    // ── full read: unchanged shape + same identity ──
    const full = await get("");
    assert(full.entries.length === windowed.total, `full read shipped ${full.entries.length}/${windowed.total} entries`);
    assert(full.model?.id === "x6-late-model" && full.thinkingLevel === "high", "full read lost the identity");
    assert(JSON.stringify(full.entries.slice(-5)) === JSON.stringify(windowed.last5.map((l) => JSON.parse(l))), "full read tail mismatch");

    // ── a session with no change entries reports null, not a stale guess ──
    const bare = await fetchJson(`${hub.url}/api/sessions/${DIR_NAME}/bare.jsonl?limit=5`);
    assert(bare.res.status === 200, `bare session status ${bare.res.status}`);
    assert(bare.json.model === null, `bare model is ${JSON.stringify(bare.json.model)}, expected null`);
    assert(bare.json.thinkingLevel === null, `bare thinkingLevel is ${JSON.stringify(bare.json.thinkingLevel)}, expected null`);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
