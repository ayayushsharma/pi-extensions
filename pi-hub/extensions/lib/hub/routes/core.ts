/**
 * routes/core — health, auth, runners, processes, client beacon.
 */
import * as os from "node:os";
import { hubLog } from "../../log.js";
import { scanPiProcesses, killLivePiProcess, ProcessKillError } from "../../processes.js";
import type { HubConfig } from "../../env.js";
import type { Auth } from "../auth.js";
import type { RunnerRegistry } from "../../runners/registry.js";
import type { WsHub } from "../ws.js";
import { BODY_LOGIN, BODY_SMALL, readJson, sendError, sendJson, type Route } from "../http.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CoreDeps {
  config: HubConfig;
  auth: Auth;
  registry: RunnerRegistry;
  wsHub: WsHub;
  startedAt: number;
}

export function coreRoutes(deps: CoreDeps): Route[] {
  const { config, auth, registry } = deps;
  return [
    {
      method: "GET",
      path: "/api/health",
      auth: false,
      handler: ({ res }) =>
        sendJson(res, 200, {
          status: "ok",
          version: config.version,
          mode: "hub",
          pid: process.pid,
          uptime: Math.round((Date.now() - deps.startedAt) / 1000),
          runners: registry.list().length,
        }),
    },
    {
      method: "POST",
      path: "/api/login",
      auth: false,
      handler: async ({ req, res }) => {
        const ip = req.socket.remoteAddress || "unknown";
        const backoff = auth.backoffMs(ip);
        if (backoff) await sleep(backoff);
        let body: any;
        try {
          body = await readJson(req, BODY_LOGIN);
        } catch (e: any) {
          return sendError(res, e?.status || 400, e?.message || "bad request");
        }
        try {
          const cookie = auth.login(String(body.user || ""), String(body.pass || ""));
          auth.clearFailures(ip);
          res.setHeader("Set-Cookie", cookie);
          return sendJson(res, 200, { ok: true });
        } catch {
          const fails = auth.recordFailure(ip);
          hubLog(`login failed from ${ip} (${fails})`);
          return sendError(res, fails >= 20 ? 429 : 401, "invalid credentials");
        }
      },
    },
    {
      method: "POST",
      path: "/api/logout",
      auth: false,
      handler: ({ req, res }) => {
        res.setHeader("Set-Cookie", auth.logout(req));
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: "/api/client-error",
      auth: true,
      handler: async ({ req, res }) => {
        try {
          const body = await readJson(req, BODY_SMALL);
          hubLog(`client error: ${String(body.message || "").slice(0, 300)}`);
        } catch {}
        res.writeHead(204);
        res.end();
      },
    },
    {
      method: "GET",
      path: "/api/runners",
      auth: true,
      handler: ({ res }) => sendJson(res, 200, { runners: registry.list().map((r) => r.info()) }),
    },
    {
      method: "GET",
      path: "/api/instances",
      auth: true,
      handler: ({ res }) =>
        sendJson(res, 200, {
          instances: registry.list().filter((r) => r.kind === "live").map((r) => r.info()),
        }),
    },
    {
      method: "GET",
      path: "/api/headless/status",
      auth: true,
      handler: ({ res }) =>
        sendJson(res, 200, {
          runners: registry.list().filter((r) => r.kind === "headless").map((r) => r.info()),
        }),
    },
    {
      method: "POST",
      path: "/api/runners/close",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        if (!body.runnerId || !registry.closeById(String(body.runnerId))) {
          return sendError(res, 404, "runner not found");
        }
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      path: "/api/processes",
      auth: true,
      handler: ({ res }) => {
        const childPids = new Set<number>();
        for (const r of registry.list()) if (r.kind === "headless" && r.pid) childPids.add(r.pid);
        return sendJson(res, 200, scanPiProcesses(childPids));
      },
    },
    {
      method: "POST",
      path: "/api/processes/kill",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        const pid = Number(body.pid);
        const childPids = new Set<number>();
        for (const r of registry.list()) if (r.kind === "headless" && r.pid) childPids.add(r.pid);
        if (childPids.has(pid)) {
          if (!registry.closeByPid(pid)) return sendError(res, 404, "runner not found");
          return sendJson(res, 200, { ok: true, owner: "hub" });
        }
        try {
          await killLivePiProcess(pid, childPids);
          return sendJson(res, 200, { ok: true, owner: "live" });
        } catch (e: any) {
          const status = e instanceof ProcessKillError ? e.status : 500;
          return sendError(res, status, e?.message || "kill failed");
        }
      },
    },
    {
      method: "GET",
      path: "/api/server",
      auth: true,
      handler: ({ res }) =>
        sendJson(res, 200, {
          version: config.version,
          pid: process.pid,
          uptime: Math.round((Date.now() - deps.startedAt) / 1000),
          host: os.hostname(),
          platform: `${os.platform()} ${os.arch()}`,
          auth: auth.enabled,
          maxHeadless: config.maxHeadless,
        }),
    },
  ];
}
