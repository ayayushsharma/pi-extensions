/**
 * routes/sessions — session store, files (jails), picker endpoints.
 */
import * as fs from "node:fs";
import type { HubConfig } from "../../env.js";
import {
  forkSession,
  listSessionDirs,
  readWindow,
  renameSession,
  resolveSessionPath,
  sessionsDir,
} from "../../store/sessions.js";
import { browseRoots, listDir, makeDir, readContent, readPreview } from "../../store/files.js";
import { BODY_SMALL, readJson, sendError, sendJson, type Route } from "../http.js";

export interface SessionDeps {
  config: HubConfig;
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
      path: "/api/projects",
      auth: true,
      handler: ({ res }) => {
        const projects = listSessionDirs().map((p) => ({
          dirName: p.dirName,
          cwd: p.sessions.find((s) => s.cwd)?.cwd || null,
          sessionCount: p.sessions.length,
          lastActive: Math.max(...p.sessions.map((s) => s.mtime)),
        }));
        return sendJson(res, 200, { projects, roots: browseRoots(deps.config) });
      },
    },
    {
      method: "GET",
      path: "/api/sessions/:dirName/:file",
      auth: true,
      handler: ({ res, url, params }) => {
        const abs = sessionAbs(params.dirName, params.file);
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const before = url.searchParams.get("before");
        const win = readWindow(abs, limit, before);
        return sendJson(res, 200, { file: params.file, dirName: params.dirName, ...win });
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
      method: "POST",
      path: "/api/sessions/delete",
      auth: true,
      handler: () => {
        throw Object.assign(new Error("file mutations are limited to mkdir (ADR-018)"), { status: 405 });
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
