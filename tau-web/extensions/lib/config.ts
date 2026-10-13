/**
 * config — role resolution for tau-web (ADR-012).
 *
 * One package, two roles:
 *   hub    — the daemon. Runs headless (`pi -e tau-web --mode rpc`),
 *            owns sessions via headless children, serves the only
 *            browser port. There is no flow from the Hub to a live TUI.
 *   mirror — inert. Any other process (live TUI, headless child) resolves
 *            here and starts nothing: no server, no dial-out.
 *
 * Role is inferred from the pi mode: rpc has no terminal UI, so it is the
 * hub; everything interactive is a mirror. TAU_ROLE forces a role for
 * development and tests.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type TauRole = "hub" | "mirror";

export function resolveRole(ctx?: ExtensionContext | null): TauRole {
  const forced = process.env.TAU_ROLE;
  if (forced === "hub" || forced === "mirror") return forced;
  // ctx.mode is the authoritative signal ("tui" | "rpc" | "json" | "print").
  // Only rpc is a long-lived, UI-less server; json/print are one-shot.
  const mode = (ctx as any)?.mode;
  if (mode === "rpc") return "hub";
  // Defensive fallback for callers without a ctx (early boot, tests).
  if (process.argv.includes("--mode") && process.argv.includes("rpc")) return "hub";
  return "mirror";
}
