/**
 * routes/sessions — session store, files (jails), picker endpoints.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HubConfig } from "../../env.js";
import {
  deleteSession,
  forkSession,
  relocateSession,
  listSessionDirs,
  readWindow,
  renameSession,
  resolveSessionPath,
  searchSessions,
  sessionsDir,
} from "../../store/sessions.js";
import type { RunnerRegistry } from "../../runners/registry.js";
import { browseRoots, jailPath, listDir, makeDir, readContent, readPreview } from "../../store/files.js";
import { gitInfo } from "../../store/git.js";
import { BODY_SMALL, createRateLimiter, readJson, sendError, sendJson, type Route } from "../http.js";

/**
 * Per-IP throttle for the full-text scan: one query is fast, a flood is
 * not. Generous on purpose (sidebar filter + picker share it) — 120/min,
 * then 429.
 */
const searchAllowed = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

export interface SessionDeps {
  config: HubConfig;
  /** the hub's own working directory — the R-10 fallback target (H35) */
  defaultCwd?: string;
  registry?: RunnerRegistry;
}

function sessionAbs(dirName: string, file: string): string {
  return resolveSessionPath(dirName, file);
}

export function sessionRoutes(deps: SessionDeps): Route[] {
  return [
    {
      method: "GET",
      path: "/api/sessions",
      auth: true,
      handler: ({ res }) => {
        const projects = listSessionDirs().map((p) => ({
          dirName: p.dirName,
          cwd: p.sessions.find((s) => s.cwd)?.cwd || null,
          mtime: Math.max(...p.sessions.map((s) => s.mtime)),
          sessions: p.sessions,
        }));
        return sendJson(res, 200, { projects, sessionsDir: sessionsDir() });
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:dirName/:file",
      auth: true,
      handler: ({ res, url, params }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const before = url.searchParams.get("before");
        try {
          const abs = sessionAbs(params.dirName, params.file);
          const win = readWindow(abs, limit, before);
          return sendJson(res, 200, { file: params.file, dirName: params.dirName, ...win });
        } catch (e: any) {
          // Fresh sessions are created lazily: first paint gets an empty window.
          const msg = String(e?.message || e);
          if (msg.includes("not found") || msg.includes("ENOENT")) {
            return sendJson(res, 200, {
              file: params.file,
              dirName: params.dirName,
              entries: [],
              meta: { cwd: null, model: null, thinkingLevel: null, sessionName: null, total: 0, firstId: null, cost: 0, tokens: 0 },
            });
          }
          throw e;
        }
      },
    },
    {
      // Download an HTML export produced by the child's export_html command.
      // Jailed to the session store or the OS temp dir; HTML only.
      method: "GET",
      path: "/api/sessions/export-file",
      auth: true,
      handler: ({ res, url }) => {
        const raw = url.searchParams.get("path") || "";
        let real = "";
        try {
          real = fs.realpathSync(raw);
        } catch {
          throw Object.assign(new Error("export not found"), { status: 404 });
        }
        if (!real.endsWith(".html")) throw Object.assign(new Error("only .html exports can be downloaded"), { status: 400 });
        const roots = [path.resolve(sessionsDir()), path.resolve(os.tmpdir())];
        const ok = roots.some((r) => real === r || real.startsWith(r + path.sep));
        if (!ok) throw Object.assign(new Error("export path outside allowed roots"), { status: 403 });
        // Stream, never buffer: an export can be tens of MB and this route
        // must not grow hub RSS per download. Oversized exports are refused.
        const st = fs.statSync(real);
        if (!st.isFile() || st.size > 32 * 1024 * 1024) {
          throw Object.assign(new Error("export too large"), { status: 413 });
        }
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename="${path.basename(real)}"`,
          "cache-control": "no-store",
          "content-length": st.size,
        });
        fs.createReadStream(real).on("error", () => {
          try {
            res.destroy();
          } catch {}
        }).pipe(res);
      },
    },
    {
      // Full-text session search for the sidebar (bounded hit list).
      method: "GET",
      path: "/api/search",
      auth: true,
      handler: ({ req, res, url }) => {
        const ip = req.socket.remoteAddress || "unknown";
        if (!searchAllowed(ip)) return sendError(res, 429, "search rate limit exceeded");
        const q = url.searchParams.get("q") || "";
        return sendJson(res, 200, { query: q, hits: searchSessions(q, 30) });
      },
    },
    {
      method: "POST",
      path: "/api/sessions/fork",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        if (!body.dirName || !body.file) return sendError(res, 400, "dirName and file required");
        const out = forkSession(String(body.dirName), String(body.file));
        return sendJson(res, 200, out);
      },
    },
    {
      // R-10: continue a session in a folder that exists. Copies the file with
      // a rewritten cwd header (never edits the original). The target is
      // jailed to the browse roots plus the hub's own cwd (ADR-017): without
      // this any caller could point a session at /etc and turn the
      // session-cwd viewer into a reader for it. The hub cwd stays allowed
      // because it is the silent-fallback target too (H35) — refusing it
      // here while binding into it there would be incoherent. The UI
      // confirms before calling (R-10 flow).
      method: "POST",
      path: "/api/sessions/relocate",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        if (!body.dirName || !body.file || !body.cwd) return sendError(res, 400, "dirName, file and cwd required");
        const roots = [...browseRoots(deps.config)];
        if (deps.defaultCwd) roots.push(path.resolve(deps.defaultCwd));
        let target: string;
        try {
          target = jailPath(String(body.cwd), [...new Set(roots)]);
        } catch (e: any) {
          return sendError(res, e?.status || 403, e?.message || "target cwd not allowed");
        }
        return sendJson(res, 200, relocateSession(String(body.dirName), String(body.file), target));
      },
    },
    {
      method: "POST",
      path: "/api/sessions/rename",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        if (!body.dirName || !body.file) return sendError(res, 400, "dirName and file required");
        renameSession(String(body.dirName), String(body.file), String(body.name || ""));
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      // Session delete is the one file *removal* the product needs. It is
      // jailed to the session store (realpath under SESSIONS_DIR) and refuses
      // files owned by a running backend so no writer ever races the unlink.
      method: "POST",
      path: "/api/sessions/delete",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        if (!body.dirName || !body.file) return sendError(res, 400, "dirName and file required");
        const abs = sessionAbs(String(body.dirName), String(body.file));
        const owner = deps.registry?.getByFile(abs);
        if (owner && !owner.isDead) {
          throw Object.assign(
            new Error(owner.kind === "live" ? "Session is owned by a live TUI — close it there first" : "Session has a running backend — close it first"),
            { status: 409 },
          );
        }
        deleteSession(String(body.dirName), String(body.file));
        return sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      path: "/api/files/list",
      auth: true,
      handler: ({ res, url }) => {
        const out = listDir(url.searchParams.get("path") || "~", deps.config);
        return sendJson(res, 200, { ...out, roots: browseRoots(deps.config) });
      },
    },
    {
      method: "GET",
      path: "/api/git",
      auth: true,
      handler: ({ res, url }) => {
        // Same jail as the file panel: only directories the hub already
        // exposes may be probed for a branch.
        const raw = url.searchParams.get("cwd") || "~";
        const cwd = jailPath(raw, browseRoots(deps.config));
        return sendJson(res, 200, gitInfo(cwd));
      },
    },
    {
      method: "GET",
      path: "/api/files/content",
      auth: true,
      handler: ({ res, url }) => {
        const p = url.searchParams.get("path");
        if (!p) return sendError(res, 400, "path required");
        const session = url.searchParams.get("session");
        let abs: string | null = null;
        if (session && session.includes("/")) {
          const [dirName, file] = session.split("/");
          abs = sessionAbs(dirName, file);
        }
        const content = readContent(p, deps.config, abs);
        return sendJson(res, 200, content);
      },
    },
    {
      method: "GET",
      path: "/api/files/preview",
      auth: true,
      handler: ({ res, url }) => {
        const p = url.searchParams.get("path");
        if (!p) return sendError(res, 400, "path required");
        const session = url.searchParams.get("session");
        let abs: string | null = null;
        if (session && session.includes("/")) {
          const [dirName, file] = session.split("/");
          abs = sessionAbs(dirName, file);
        }
        try {
          const out = readPreview(p, deps.config, abs);
          res.writeHead(200, { "Content-Type": out.mime, "Cache-Control": "private, max-age=60" });
          res.end(out.buffer);
        } catch (e: any) {
          return sendError(res, e?.message === "unsupported preview type" ? 415 : 404, e?.message || "preview failed");
        }
      },
    },
    {
      method: "POST",
      path: "/api/files/mkdir",
      auth: true,
      handler: async ({ req, res }) => {
        const body = await readJson(req, BODY_SMALL);
        if (!body.path) return sendError(res, 400, "path required");
        try {
          const out = makeDir(String(body.path), deps.config);
          return sendJson(res, 200, { ok: true, path: out });
        } catch (e: any) {
          if (e?.code === "EEXIST") return sendError(res, 409, "already exists");
          return sendError(res, 400, e?.message || "mkdir failed");
        }
      },
    },
    {
      method: "GET",
      path: "/api/file/download",
      auth: true,
      handler: ({ res, url }) => {
        const p = url.searchParams.get("path");
        if (!p) return sendError(res, 400, "path required");
        const content = readContent(p, deps.config, null);
        if (content.text === null) return sendError(res, 415, "binary file");
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(content.path.split("/").pop() || "file")}"`,
        });
        return res.end(content.text);
      },
    },
    {
      method: "GET",
      path: "/api/session-file-exists",
      auth: true,
      handler: ({ res, url }) => {
        const dirName = url.searchParams.get("dirName") || "";
        const file = url.searchParams.get("file") || "";
        try {
          const abs = sessionAbs(dirName, file);
          fs.statSync(abs);
          return sendJson(res, 200, { exists: true });
        } catch {
          return sendJson(res, 200, { exists: false });
        }
      },
    },
  ];
}
