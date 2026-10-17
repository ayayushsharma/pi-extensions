/**
 * pi-hub — one package, two roles.
 *
 *   hub    (`pi -e pi-hub --mode rpc`): HTTP+WS control plane, runner
 *          registry (headless children), hub.sock relay for live TUIs.
 *   mirror (any interactive pi): dials hub.sock, forwards events, executes
 *          drive commands. Serves nothing (ADR-011).
 *
 * Headless children run with PI_HUB_DISABLED=1 + TAU_DISABLED=1 and resolve
 * to an inert role.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./lib/env.js";
import { hubLog, hubDebug, initLog } from "./lib/log.js";
import { resolveRole, isDisabled } from "./lib/role.js";
import { Hub } from "./lib/hub/hub.js";
import { Mirror } from "./lib/mirror/mirror.js";
import { MIRROR_EVENTS, normalizePiEvent } from "./lib/protocol.js";

export default function piHub(pi: ExtensionAPI): void {
  const config = loadConfig();
  initLog(config.logFile, config.debug);

  let hub: Hub | null = null;
  let mirror: Mirror | null = null;
  let latestCtx: any = null;

  const disabled = isDisabled(config.disabled, config.role);
  const role = resolveRole(undefined, config.role);
  hubLog(`loaded (role=${disabled ? "disabled" : role}, port=${config.port}, sock=${config.sockPath})`);

  const liveCtx = (): any => {
    if (!latestCtx) return null;
    try {
      void latestCtx.sessionManager.getSessionFile();
      return latestCtx;
    } catch {
      latestCtx = null;
      return null;
    }
  };

  pi.on("session_start", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (disabled) return;
    const current = resolveRole(ctx, config.role);
    if (current === "hub") {
      if (!hub) {
        hub = new Hub(config, ctx);
        try {
          const info = await hub.start();
          hubLog(`hub ready on port ${info.port}`);
        } catch (e) {
          hubLog(`hub failed to start: ${(e as Error).message}`);
          hub = null;
        }
      }
      return;
    }
    if (mirror) {
      mirror.wrapDialogs(ctx);
      mirror.announce?.();
      return;
    }
    mirror = new Mirror(config, pi, liveCtx);
    mirror.start();
    mirror.wrapDialogs(ctx);
    hubLog(`mirror dialing ${config.sockPath} (reason=${event?.reason || "startup"})`);
  });

  pi.on("session_info_changed", async () => {
    if (disabled) return;
    mirror?.announce();
  });

  for (const eventType of MIRROR_EVENTS) {
    pi.on(eventType as any, async (event: any, ctx: any) => {
      latestCtx = ctx;
      if (disabled || !mirror) return;
      mirror.pushEvent(normalizePiEvent(eventType, event));
      if (eventType === "agent_start" || eventType === "agent_end" || eventType === "model_select") {
        mirror.pushStatus();
      }
    });
  }

  for (const levelEvent of ["thinking_level_select", "session_info_changed"] as const) {
    pi.on(levelEvent as any, async () => {
      if (!disabled) mirror?.pushStatus();
    });
  }

  pi.on("session_shutdown", async () => {
    hubDebug("session shutdown");
    try {
      hub?.stop();
    } catch (e) {
      hubLog("hub stop failed:", String(e));
    }
    hub = null;
    try {
      mirror?.stop();
    } catch {}
    mirror = null;
    latestCtx = null;
  });
}
