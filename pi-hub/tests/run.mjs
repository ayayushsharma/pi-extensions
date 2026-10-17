// run.mjs — pi-hub test runner. `node tests/run.mjs [--integration|--e2e] [--strict]`
import { findPi } from "./helpers.mjs";
import { runIntegration } from "./integration.mjs";
import { runE2E } from "./e2e.mjs";
import { runFirefoxSmoke } from "./firefox-smoke.mjs";

const args = process.argv.slice(2);
const wantIntegration = !args.includes("--e2e") || args.includes("--integration");
const wantE2E = args.includes("--e2e") || args.includes("--all");
const wantFirefox = args.includes("--firefox") || args.includes("--all");
const strict = args.includes("--strict");

const log = (line) => process.stdout.write(`${line}\n`);

const pi = findPi();
if (!pi) {
  log("pi binary not found — skipping integration/e2e (set PI_BIN or install pi)");
  process.exit(0);
}

let results = [];
if (wantIntegration) {
  log("── integration ──");
  results = results.concat(await runIntegration({ log }));
}
if (wantE2E || args.includes("--all")) {
  log("── e2e (Playwright) ──");
  results = results.concat(await runE2E({ log }));
}
if (wantFirefox) {
  log("── firefox smoke (cross-platform CLI backend) ──");
  results = results.concat(await runFirefoxSmoke({ log }));
}

const failed = results.filter((r) => !r.ok && !r.skip);
const skipped = results.filter((r) => r.skip);
log("");
log(`total ${results.length} · passed ${results.length - failed.length - skipped.length} · failed ${failed.length} · skipped ${skipped.length}`);
for (const f of failed) log(`FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failed.length || (strict && skipped.length) ? 1 : 0);
