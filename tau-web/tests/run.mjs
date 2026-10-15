// Orchestrator: runs the P0 matrix (default) with per-case setup/teardown.
//   node tests/run.mjs [--filter H3] [--filter H7,H8,H9] [--list]
//   TEST_REAL_HUB=1 node tests/run.mjs --filter H6   (real pi hub, slower)
import fs from "node:fs";
import path from "node:path";
import { ensureTmp, TMP_DIR } from "./helpers.mjs";

const E2E_DIR = new URL("./e2e/", import.meta.url).pathname;

const ORDER = [
  "h1-http.test.mjs",
  "h2-static.test.mjs",
  "h3-late-file.test.mjs",
  "h4-failfast.test.mjs",
  "h5-timeout.test.mjs",
  "h6-headless.test.mjs",
  "h7-uplink-list.test.mjs",
  "h8-live-section.test.mjs",
  "h9-drive-cancel.test.mjs",
  "h10-processes.test.mjs",
  "h11-reswitch.test.mjs",
  "h12-viewer.test.mjs",
  "d1-drive-attach.test.mjs",
  "d5-auth.test.mjs",
  "p2-guards.test.mjs",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { filter: null, list: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--filter" && args[i + 1]) out.filter = args[++i].toUpperCase();
    else if (args[i] === "--list") out.list = true;
  }
  return out;
}

const { filter, list } = parseArgs();

const cases = [];
for (const file of ORDER) {
  const mod = await import(path.join(E2E_DIR, file));
  const id = (mod.id || file.split("-")[0]).toUpperCase();
  cases.push({ id, file, title: mod.title || file, run: mod.run });
}

if (list) {
  for (const c of cases) console.log(`${c.id}\t${c.file}\t${c.title}`);
  process.exit(0);
}

const wanted = filter
  ? cases.filter((c) => filter.split(",").map((s) => s.trim()).includes(c.id))
  : cases;
if (filter && wanted.length === 0) {
  console.error(`no cases match filter ${filter}`);
  process.exit(2);
}

ensureTmp();
console.log(`tau-web e2e: ${wanted.map((c) => c.id).join(" ")}${process.env.TEST_REAL_HUB === "1" ? " (real hub)" : " (stub hub)"}`);
const results = [];
for (const c of wanted) {
  const t0 = Date.now();
  try {
    await c.run();
    results.push({ id: c.id, ok: true, ms: Date.now() - t0 });
    console.log(`  PASS ${c.id} (${Date.now() - t0}ms) ${c.title}`);
  } catch (e) {
    results.push({ id: c.id, ok: false, ms: Date.now() - t0, error: e });
    console.log(`  FAIL ${c.id} (${Date.now() - t0}ms) ${c.title}\n       ${String(e?.message || e).split("\n").join("\n       ")}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — failed: ${failed.map((f) => f.id).join(" ")}` : ""}`);
if (!failed.length && !process.env.TAU_E2E_KEEP) {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
}
process.exit(failed.length ? 1 : 0);
