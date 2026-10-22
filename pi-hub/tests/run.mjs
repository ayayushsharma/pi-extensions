// run.mjs — pi-hub test runner. `node tests/run.mjs [--unit|--integration|--e2e|--all] [--strict]`
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPi, realStoreDiff, realStoreSnapshot } from "./helpers.mjs";
import { startFakeLLM } from "./fixtures/fake-llm.mjs";
import { runIntegration } from "./integration.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const onlyUnit = args.includes("--unit") && !args.includes("--integration") && !args.includes("--all");
const wantUnit = args.includes("--unit") || args.includes("--all");
const wantIntegration =
  args.includes("--integration") ||
  args.includes("--all") ||
  (!args.includes("--e2e") && !args.includes("--termux") && !onlyUnit);
const wantE2E = args.includes("--e2e") || args.includes("--all");
const wantFirefox = args.includes("--firefox") || args.includes("--all");
const wantTermux = args.includes("--termux");
const strict = args.includes("--strict");

const log = (line) => process.stdout.write(`${line}\n`);

/** Unit phase: pure helpers, no hub/child/browser (Node strips the .ts types). */
async function runUnit({ log }) {
  // Node 26 rejects a directory argument to --test on Termux; pass the
  // explicit files (also keeps discovery ordering stable). T1.
  const unitFiles = fs
    .readdirSync(path.join(PKG_ROOT, "tests", "unit"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `./tests/unit/${name}`);
  const out = await new Promise((resolve) => {
    execFile(process.execPath, ["--import", "./tests/unit/ts-resolve.mjs", "--test", ...unitFiles], { cwd: PKG_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ status: err?.code ?? 0, stdout, stderr }),
    );
  });
  const text = `${out.stdout || ""}${out.stderr || ""}`;
  const results = [];
  for (const line of text.split("\n")) {
    const pass = /^\s*✔\s+(.+?)(?:\s+\(\d.*\))?\s*$/.exec(line);
    const fail = /^\s*✖\s+(.+?)(?:\s+\(\d.*\))?\s*$/.exec(line);
    if (pass) results.push({ name: `U ${pass[1]}`, ok: true, detail: "" });
    else if (fail) results.push({ name: `U ${fail[1]}`, ok: false, detail: "" });
  }
  if (!results.length) {
    results.push({ name: "U unit suite", ok: out.status === 0, detail: `exit ${out.status}${text ? `: ${text.trim().split("\n").slice(-1)[0]}` : ""}` });
  }
  for (const r of results) log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  return results;
}

// Every test runs against a local fake model: no keys, no cost, no variance.
const llm = await startFakeLLM();
process.env.PI_HUB_TEST_LLM_URL = llm.url;
const storeBefore = realStoreSnapshot();

// Suites run concurrently: they use their own ports, temp dirs and sandboxes,
// and wall time is what matters. Log lines are tagged so the interleaving
// stays readable.
const pi = findPi();
const jobs = [];
const suiteStart = Date.now();
const suiteWalls = [];
const suite = (tag, fn) => jobs.push(
  (async () => {
    const t0 = Date.now();
    try {
      return (await fn({ log: (line) => log(`[${tag}] ${line}`) })) || [];
    } finally {
      suiteWalls.push([tag, Date.now() - t0]);
    }
  })(),
);
if (wantUnit) suite("unit", runUnit);
if (!pi) {
  if (wantIntegration || wantE2E) log("pi binary not found — skipping integration/e2e (set PI_BIN or install pi)");
  jobs.push(Promise.resolve([{ name: "hub suites", ok: true, skip: true, detail: "pi binary not found" }]));
} else {
  if (wantIntegration) suite("int", runIntegration);
  if (wantE2E) {
    suite("e2e", async (ctx) => {
      const { runE2E } = await import("./e2e.mjs");
      return runE2E(ctx);
    });
  }
}
if (wantFirefox) {
  suite("ff", async (ctx) => {
    const { runFirefoxSmoke } = await import("./firefox-smoke.mjs");
    return runFirefoxSmoke(ctx);
  });
}
if (wantTermux) {
  suite("termux", async (ctx) => {
    const { runTermuxSmoke } = await import("./termux-smoke.mjs");
    return runTermuxSmoke(ctx);
  });
}
const results = (await Promise.all(jobs)).flat();

await llm.close();

// The suite must never write into the developer's real session store.
const leak = realStoreDiff(storeBefore);
results.push({ name: "ISO real session store untouched", ok: !leak, detail: leak });

log(`suites: ${suiteWalls.map(([t, ms]) => `${t}=${ms}ms`).join(" ")} · wall ${Date.now() - suiteStart}ms`);
const slowest = [...results].filter((r) => r.ms).sort((a, b) => b.ms - a.ms).slice(0, 12);
const failed = results.filter((r) => !r.ok && !r.skip);
const skipped = results.filter((r) => r.skip);
log("");
log(`total ${results.length} · passed ${results.length - failed.length - skipped.length} · failed ${failed.length} · skipped ${skipped.length}`);
log(`slowest before: ${slowest.map((r) => `${r.name.slice(0, 26)}=${r.ms}ms`).join(" ")}`);
for (const f of failed) log(`FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
