/**
 * role — hub (`pi --mode rpc`) vs mirror (interactive TUI, dials hub.sock).
 * PI_HUB_ROLE forces a role for development and tests.
 */
import type { HubRole } from "./env.js";

export function resolveRole(ctx?: any, forced?: HubRole | null): HubRole {
  if (forced) return forced;
  const mode = ctx?.mode;
  if (mode === "rpc") return "hub";
  if (process.argv.includes("--mode") && process.argv.includes("rpc")) return "hub";
  return "mirror";
}

/** True when the extension should not start anything (headless children). */
export function isDisabled(disabled: boolean, forced?: HubRole | null): boolean {
  return disabled && !forced;
}
