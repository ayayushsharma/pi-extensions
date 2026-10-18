/**
 * groups — run independent test groups with a configurable concurrency level.
 *
 * Every group owns its own hub, browser, ports and temp dirs, so groups can
 * run at the same time without sharing state. Parallelism is a knob:
 *
 *   --jobs N | -j N      run up to N groups at once (default: min(4, cpus))
 *   --serial | -j 1      one group at a time (deterministic logs/timings)
 *   PI_HUB_JOBS=N        same, via environment
 *
 * Groups record `ms` only when running serially; under parallelism the
 * wall-clock of the whole group is reported instead (per-check deltas would
 * only measure the scheduler).
 */

import os from "node:os";

export function jobLimit(argv = process.argv.slice(2)) {
  // --jobs N / -j N / -jN / --jobs=N
  const attached = argv.map((a) => /^-j(\d+)$/.exec(a) || /^--jobs=(\d+)$/.exec(a)).find(Boolean);
  const flagIndex = Math.max(argv.indexOf("--jobs"), argv.indexOf("-j"));
  let n = NaN;
  if (attached) n = Number(attached[1]);
  else if (flagIndex >= 0 && argv[flagIndex + 1] !== undefined) n = Number(argv[flagIndex + 1]);
  if (argv.includes("--serial")) n = 1;
  if (!Number.isFinite(n)) n = Number(process.env.PI_HUB_JOBS);
  if (!Number.isFinite(n) || n < 1) {
    // Phone-class hosts starve above ~4 concurrent hubs; faster boxes can ask
    // for more with --jobs. Measured on the dev phone: -j4 ≈ 13s for 11 UI
    // groups, -j8 ≈ 80s (timeouts), -j1 ≈ 26s.
    const cpus = Math.max(1, os.availableParallelism?.() || os.cpus().length || 4);
    n = Math.min(4, cpus);
  }
  return Math.floor(n);
}

export async function runGroups(groups, { jobs = jobLimit(), log = () => {} } = {}) {
  const results = [];
  const serial = jobs === 1;
  const queue = [...groups];
  const started = Date.now();

  const runOne = async (group) => {
    const t0 = Date.now();
    const emit = (line) => log(`[${group.name}] ${line}`);
    const groupResults = [];
    let lastAt = Date.now();
    const check = (name, cond, detail = "") => {
      const now = Date.now();
      groupResults.push({ name, ok: !!cond, detail, ms: now - lastAt });
      lastAt = now;
      emit(`${cond ? "PASS" : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}${serial ? ` [+${now - t0}ms]` : ""}`);
    };
    try {
      await group.run({ check, log: emit });
    } catch (e) {
      groupResults.push({ name: `${group.name} crashed`, ok: false, detail: e?.message || String(e) });
      emit(`CRASH ${e?.stack || e}`);
    }
    const wall = Date.now() - t0;
    emit(`──── ${group.name} done in ${wall}ms`);
    results.push(...groupResults, { name: `${group.name} wall`, wallMs: wall, ok: true, silent: true });
    return groupResults;
  };

  const workers = Array.from({ length: Math.max(1, Math.min(jobs, groups.length)) }, async () => {
    while (queue.length) {
      const g = queue.shift();
      if (g) await runOne(g);
    }
  });
  await Promise.all(workers);
  log(`──── ${groups.length} groups in ${Date.now() - started}ms (jobs=${Math.max(1, Math.min(jobs, groups.length))})`);
  return results;
}
