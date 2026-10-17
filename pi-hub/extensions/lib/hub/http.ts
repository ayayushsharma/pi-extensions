/**
 * http — server, table-driven router, JSON/body helpers, static files with
 * ETag/immutable caching, security headers. Guards are explicit per route.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { Auth } from "./auth.js";

export interface RouteReq {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (r: RouteReq) => Promise<void> | void;

export interface Route {
  method: string;
  path: string;
  /** true = authenticated required; false = public (health, login, static) */
  auth: boolean;
  handler: RouteHandler;
}

export interface HttpOptions {
  auth: Auth;
  routes: Route[];
  staticDir: string;
}

const BODY_DEFAULT = 300 * 1024;
export const BODY_LOGIN = 10 * 1024;
export const BODY_SMALL = 4 * 1024;

export function securityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(data);
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

export function readJson(req: http.IncomingMessage, maxBytes = BODY_DEFAULT): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", () => reject(Object.assign(new Error("read error"), { status: 400 })));
  });
}

function compile(pattern: string): (p: string) => Record<string, string> | null {
  const parts = pattern.split("/").filter(Boolean);
  return (urlPath: string) => {
    const got = urlPath.split("/").filter(Boolean);
    if (got.length !== parts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(got[i]);
      else if (p !== got[i]) return null;
    }
    return params;
  };
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function createHttpServer(opts: HttpOptions): http.Server {
  const routes = opts.routes.map((r) => ({ ...r, match: compile(r.path) }));
  const root = path.resolve(opts.staticDir);

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (rel.includes("\0") || rel.split("/").includes("..")) return false;
    let file = path.join(root, rel);
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      const realRoot = fs.realpathSync(root);
      const real = fs.realpathSync(file);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return false;
      const st = fs.statSync(real);
      if (!st.isFile()) return false;
      const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return true;
      }
      const immutable = url.searchParams.has("v");
      res.writeHead(200, {
        "Content-Type": STATIC_MIME[path.extname(real).toLowerCase()] || "application/octet-stream",
        "Content-Length": st.size,
        ETag: etag,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      if (req.method === "HEAD") return res.end(), true;
      fs.createReadStream(real).pipe(res);
      return true;
    } catch {
      return false;
    }
  };

  return http.createServer(async (req, res) => {
    securityHeaders(res);
    let url: URL;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      return sendError(res, 400, "bad request");
    }
    const p = url.pathname;
    if (!opts.auth.hostAllowed(req)) return sendError(res, 403, "host not allowed");
    if (p === "/" || p === "/index.html") {
      if (serveStatic(req, res, new URL("/index.html" + url.search, url))) return;
    }
    if (p === "/hub" || p === "/hub/") {
      res.writeHead(302, { Location: "/" + url.search.replace(/^\?/, "") });
      return res.end();
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const params = r.match(p);
      if (!params) continue;
      if (r.auth && !opts.auth.authenticate(req)) return sendError(res, 401, "authentication required");
      try {
        await r.handler({ req, res, url, params });
      } catch (e: any) {
        const status = Number(e?.status) || 500;
        if (!res.headersSent) sendError(res, status, e?.message || "internal error");
      }
      return;
    }
    if (serveStatic(req, res, url)) return;
    return sendError(res, 404, "not found");
  });
}
