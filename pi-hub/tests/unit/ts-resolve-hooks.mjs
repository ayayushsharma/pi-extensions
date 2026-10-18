/**
 * Resolve `./foo.js` to `./foo.ts` when the JS file does not exist, so unit
 * tests can import the extension sources directly (they are written with the
 * conventional `.js` specifiers that jiti/tsc resolve, Node does not).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const rel = specifier.startsWith(".") || specifier.startsWith("/");
    if (err?.code === "ERR_MODULE_NOT_FOUND" && rel && specifier.endsWith(".js")) {
      const url = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL ?? import.meta.url);
      if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    throw err;
  }
}
