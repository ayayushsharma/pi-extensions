/**
 * auth — cookie sessions for browsers (ADR-006), Host/Origin allowlist
 * against DNS rebinding, per-IP login backoff. Never sends
 * WWW-Authenticate, so the native browser prompt cannot appear.
 */
import * as crypto from "node:crypto";
import type * as http from "node:http";

const COOKIE = "pi_hub_auth";
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_TOKENS = 200;

export class Auth {
  private tokens = new Map<string, number>();
  private failures = new Map<string, { fails: number; until: number }>();

  constructor(
    private user: string,
    private pass: string,
    private enabledFlag: boolean,
    private allowedHosts: string[],
    private allowAnyHost: boolean,
    private ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  get configured(): boolean {
    return !!(this.user && this.pass);
  }

  get enabled(): boolean {
    return this.configured && this.enabledFlag;
  }

  private equal(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  hostAllowed(req: http.IncomingMessage): boolean {
    if (this.allowAnyHost) return true;
    const hostHeader = String(req.headers.host || "");
    const hostname = hostHeader.replace(/^\[|\]$/g, "").split(":")[0];
    if (!hostname) return false;
    const origin = String(req.headers.origin || "");
    if (origin) {
      try {
        const oh = new URL(origin).hostname;
        if (!this.hostnameAllowed(oh)) return false;
      } catch {
        return false;
      }
    }
    return this.hostnameAllowed(hostname);
  }

  private hostnameAllowed(host: string): boolean {
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
    if (host.endsWith(".ts.net")) return true;
    return this.allowedHosts.includes(host);
  }

  private tokenFromCookie(req: http.IncomingMessage): string | null {
    const raw = req.headers.cookie || "";
    for (const part of String(raw).split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return null;
  }

  validToken(token: string | null): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  /** Cookie (browsers) or Basic (scripts/curl). */
  authenticate(req: http.IncomingMessage): boolean {
    if (!this.enabled) return true;
    this.prune();
    if (this.validToken(this.tokenFromCookie(req))) return true;
    const header = String(req.headers.authorization || "");
    if (header.startsWith("Basic ")) {
      try {
        const [u, p] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
        return this.equal(u || "", this.user) && this.equal(p || "", this.pass);
      } catch {
        return false;
      }
    }
    return false;
  }

  private prune(): void {
    const now = Date.now();
    if (this.tokens.size <= MAX_TOKENS) return;
    for (const [t, exp] of this.tokens) if (exp < now) this.tokens.delete(t);
    while (this.tokens.size > MAX_TOKENS) {
      const first = this.tokens.keys().next().value;
      if (first === undefined) break;
      this.tokens.delete(first);
    }
  }

  backoffMs(ip: string): number {
    const f = this.failures.get(ip);
    if (!f || f.until < Date.now()) return 0;
    return Math.min(500 * f.fails, 5000);
  }

  recordFailure(ip: string): number {
    const now = Date.now();
    const f = this.failures.get(ip) || { fails: 0, until: 0 };
    if (f.until < now && f.fails > 0) f.fails = 0;
    f.fails += 1;
    f.until = now + 10 * 60 * 1000;
    this.failures.set(ip, f);
    return f.fails;
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  /** Returns a Set-Cookie value on success, throws on bad credentials. */
  login(user: string, pass: string): string {
    if (this.equal(user || "", this.user) && this.equal(pass || "", this.pass)) {
      const token = crypto.randomBytes(24).toString("hex");
      this.tokens.set(token, Date.now() + this.ttlMs);
      const maxAge = Math.floor(this.ttlMs / 1000);
      return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
    }
    throw new Error("invalid credentials");
  }

  logout(req: http.IncomingMessage): string {
    const token = this.tokenFromCookie(req);
    if (token) this.tokens.delete(token);
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  wsAuthenticated(req: http.IncomingMessage): boolean {
    return this.hostAllowed(req) && this.authenticate(req);
  }
}
