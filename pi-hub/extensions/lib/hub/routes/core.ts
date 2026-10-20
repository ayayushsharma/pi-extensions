/**
 * routes/core — health, auth, runners, processes, client beacon.
 */
import * as os from "node:os";
import { hubLog } from "../../log.js";
import { scanPiProcesses, killLivePiProcess, ProcessKillError } from "../../processes.js";
import { titleForSessionFile } from "../../store/sessions.js";
import type { RunnerInfo } from "../../runners/runner.js";
import type { HubConfig } from "../../env.js";
import type { Auth } from "../auth.js";
import type { RunnerRegistry } from "../../runners/registry.js";
import type { WsHub } from "../ws.js";
import { BODY_LOGIN, BODY_SMALL, createRateLimiter, readJson, sendError, sendJson, type Route } from "../http.js";

/** Beacon flood guard (S7): 20 reports/min per IP, then 429 unlogged. */
const clientErrorAllowed = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CoreDeps {
  config: HubConfig;
  auth: Auth;
  registry: RunnerRegistry;
  wsHub: WsHub;
  startedAt: number;
  /** the hub's own working directory — the fallback for R-10 resumes */
  defaultCwd?: string;
}

/** The title a process row should show: the live runner's own name, else the
 *  session file's title from the store. Unknown/untitled => null ("new process"). */
function processTitle(info?: RunnerInfo): string | null {
  if (!info) return null;
  if (info.title) return info.title;
  return info.absFile ? titleForSessionFile(info.absFile) : null;
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
          // Secure flag only over TLS (loopback stays plain HTTP; a TLS
          // terminator sets X-Forwarded-Proto or the socket is encrypted).
          const secure =
            !!(req.socket as any)?.encrypted ||
            String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
          const cookie = auth.login(String(body.user || ""), String(body.pass || ""), secure);
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
        const ip = req.socket?.remoteAddress || "unknown";
        if (!clientErrorAllowed(ip)) {
          res.writeHead(429);
          res.end();
          return;
        }
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
        const byPid = new Map<number, RunnerInfo>();
        for (const r of registry.list()) {
          const info = r.info();
          if (r.kind === "headless" && info.pid) childPids.add(info.pid);
          if (info.pid) byPid.set(info.pid, info);
        }
        const scan = scanPiProcesses(childPids);
        // Title the rows by the session each process is working on, so the
        // panel reads "Refactor the parser" instead of a bare `pi` argv.
        for (const p of scan.processes) p.title = processTitle(byPid.get(p.pid));
        return sendJson(res, 200, scan);
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
          cwd: deps.defaultCwd || process.cwd(),
        }),
    },
  ];
}
