// clear-jiti.mjs — clear pi's jiti transform cache, cross-platform.
// Usage: node clear-jiti.mjs
// Run this after editing extension .ts files, then restart Pi.
// (A running Pi holds the old transform in memory; clearing alone is not enough.)
//
// jiti (bundled with pi) caches transformed TS under:
//   <tmpdir>/jiti          — CJS transform cache  ($TMPDIR/jiti on Termux/Linux,
//                            %LOCALAPPDATA%\Temp\jiti on Windows)
//   <tmpdir>/jiti-esm      — ESM loader cache
//   node_modules/.cache/jiti — only when such a dir already exists
// os.tmpdir() resolves all of the above per-platform (it honours $TMPDIR on
// POSIX and maps to the user Temp dir on Windows), so there is no OS switch
// in this script. Pure node:fs/os/path — no dependencies.

import { rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, parse } from "node:path";

const targets = [join(tmpdir(), "jiti"), join(tmpdir(), "jiti-esm")];

// jiti also uses node_modules/.cache/jiti when the dir already exists —
// sweep upward from the repo root so per-package caches are caught too.
let dir = resolve(process.argv[1] ? dirname(process.argv[1]) : process.cwd());
for (;;) {
  targets.push(join(dir, "node_modules", ".cache", "jiti"));
  const parent = dirname(dir);
  if (parent === dir || parent === parse(dir).root) break;
  dir = parent;
}

let cleared = 0;
for (const target of new Set(targets)) {
  if (!existsSync(target)) continue;
  try {
    const entries = readdirSync(target).length;
    rmSync(target, { recursive: true, force: true });
    cleared++;
    console.log(`cleared ${target} (${entries} entries)`);
  } catch (err) {
    console.error(`FAILED ${target}: ${err?.message || err}`);
    process.exitCode = 1;
  }
}
if (!cleared) console.log("nothing to clear — no jiti cache found");
else console.log("done — restart Pi to pick up extension changes");
