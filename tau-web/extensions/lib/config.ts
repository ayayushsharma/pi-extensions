/**
 * config — role resolution for tau-web (ADR-010).
 *
 * One package, two roles:
 *   hub    — control plane. Runs headless (`pi -e tau-web --mode rpc`),
 *            owns the session switchboard, serves the browser port.
 *   mirror — data plane. A live TUI. Serves its own session and dials the
 *            hub over the private socket so browsers can drive it.
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
