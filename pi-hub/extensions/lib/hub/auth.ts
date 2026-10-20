/**
 * auth — cookie sessions for browsers (ADR-006), Host/Origin allowlist
 * against DNS rebinding, per-IP backoff on both login and Basic. Never sends
 * WWW-Authenticate, so the native browser prompt cannot appear.
 */
import * as crypto from "node:crypto";
import type * as http from "node:http";

const COOKIE = "pi_hub_auth";
const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_TOKENS = 200;
const MAX_FAILURE_KEYS = 1000;
// Mirror the login slope so guessing loops cannot spin tight, but a single
// typo stays fast (same shape tau-web used for Basic).
const BASIC_FAILS_BEFORE_WAIT = 3;
const BASIC_BACKOFF_CAP_MS = 2000;
const BASIC_FAILS_BEFORE_LIMIT = 20;

export type AuthVerdict = "ok" | "denied" | "limited";

export class Auth {
  private user: string;
  private pass: string;
  private enabledFlag: boolean;
  private allowedHosts: string[];
  private allowAnyHost: boolean;
  private ownHosts: string[];
  private ttlMs: number;
  private tokens = new Map<string, { exp: number; at: number }>();
  private failures = new Map<string, { fails: number; until: number }>();

  constructor(
    user: string,
    pass: string,
    enabledFlag: boolean,
    allowedHosts: string[],
    allowAnyHost: boolean,
    ownHosts: string[] = [],
    ttlMs: number = DEFAULT_TTL_MS,
  ) {
    this.user = user;
    this.pass = pass;
    this.enabledFlag = enabledFlag;
    this.allowedHosts = allowedHosts.map((h) => h.toLowerCase());
    this.allowAnyHost = allowAnyHost;
    this.ownHosts = ownHosts.map((h) => h.toLowerCase());
    this.ttlMs = ttlMs;
  }

  get configured(): boolean {
    return !!(this.user && this.pass);
  }

  get enabled(): boolean {
    return this.configured && this.enabledFlag;
  }

  /** Length-hiding compare: equal-length digests, so credential length does
   *  not leak through the early-out the raw compare needed. */
  private equal(a: string, b: string): boolean {
    const da = crypto.createHash("sha256").update(a, "utf8").digest();
    const db = crypto.createHash("sha256").update(b, "utf8").digest();
    return crypto.timingSafeEqual(da, db);
  }

  /** Host header → lowercase hostname, or null when unparseable. Bracketed
   *  IPv6 (`[::1]:8292`) is unwrapped; userinfo/whitespace is rejected
   *  outright (a crafted `x@127.0.0.1` must not parse as loopback). */
  private requestHostname(req: http.IncomingMessage): string | null {
    const raw = String(req.headers.host || "").trim();
    if (!raw || /[@\s]/.test(raw)) return null;
    try {
      return new URL(`http://${raw}`).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    } catch {
      return null;
    }
  }

  hostAllowed(req: http.IncomingMessage): boolean {
    if (this.allowAnyHost) return true;
    const hostname = this.requestHostname(req);
    if (!hostname) return false;
    const origin = String(req.headers.origin || "");
    if (origin) {
      let oh: string;
      try {
        oh = new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
      } catch {
        return false;
      }
      if (!this.hostnameAllowed(oh)) return false;
    }
    return this.hostnameAllowed(hostname);
  }

  /**
   * Loopback, the hub's own bind address, and explicitly listed hosts only.
   * Notably NOT any-IPv4 and NOT `*.ts.net`: with a non-loopback bind the
   * old rules admitted every direct-IP client, and any tailnet's names.
   * Pin a tunnel hostname exactly in PI_HUB_ALLOWED_HOSTS instead.
   */
  private hostnameAllowed(host: string): boolean {
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (this.ownHosts.includes(host)) return true;
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
    const rec = this.tokens.get(token);
    if (!rec) return false;
    const now = Date.now();
    if (rec.exp < now) {
      this.tokens.delete(token);
      return false;
    }
    // Sliding refresh past half-life: active browsers keep their session
    // without cookie churn (no Set-Cookie rewrite needed).
    if (now - rec.at > this.ttlMs / 2) {
      rec.exp = now + this.ttlMs;
      this.tokens.set(token, rec);
    }
    return true;
  }

  private basicCredentials(req: http.IncomingMessage): [string, string] | null {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Basic ")) return null;
    try {
      const creds = Buffer.from(header.slice(6), "base64").toString("utf8");
      // Split on the FIRST colon: passwords may contain colons.
      const i = creds.indexOf(":");
      if (i < 0) return [creds, ""];
      return [creds.slice(0, i), creds.slice(i + 1)];
    } catch {
      return null;
    }
  }

  private ipOf(req: http.IncomingMessage): string {
    try {
      return req.socket.remoteAddress || "unknown";
    } catch {
      return "unknown";
    }
  }

  private basicBackoffMs(fails: number): number {
    if (fails <= BASIC_FAILS_BEFORE_WAIT) return 0;
    return Math.min(500 * (fails - BASIC_FAILS_BEFORE_WAIT), BASIC_BACKOFF_CAP_MS);
  }

  /**
   * Cookie (browsers) or Basic (scripts/curl), with per-IP Basic backoff.
   * "limited" past sustained guessing — callers map it to 429 (HTTP) or a
   * refused upgrade (WS), mirroring the login route.
   */
  async authenticateRequest(req: http.IncomingMessage): Promise<AuthVerdict> {
    if (!this.enabled) return "ok";
    this.prune();
    if (this.validToken(this.tokenFromCookie(req))) return "ok";
    const creds = this.basicCredentials(req);
    if (!creds) return "denied";
    const ip = this.ipOf(req);
    const seen = this.failures.get(ip);
    const fails = seen && seen.until >= Date.now() ? seen.fails : 0;
    const wait = this.basicBackoffMs(fails);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (this.equal(creds[0], this.user) && this.equal(creds[1], this.pass)) {
      this.clearFailures(ip);
      return "ok";
    }
    return this.recordFailure(ip) >= BASIC_FAILS_BEFORE_LIMIT ? "limited" : "denied";
  }

  private prune(): void {
    const now = Date.now();
    for (const [t, rec] of this.tokens) if (rec.exp < now) this.tokens.delete(t);
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

  /** Shared by the login route and Basic auth on purpose: both are guesses
   *  at the same credentials, so one budget covers both (a client that
   *  typos the login form must not get unlimited Basic attempts). Note the
   *  key is the socket peer — behind a tunnel that is one shared bucket. */
  recordFailure(ip: string): number {
    const now = Date.now();
    const f = this.failures.get(ip) || { fails: 0, until: 0 };
    if (f.until < now && f.fails > 0) f.fails = 0;
    f.fails += 1;
    f.until = now + 10 * 60 * 1000;
    if (!this.failures.has(ip) && this.failures.size >= MAX_FAILURE_KEYS) {
      const first = this.failures.keys().next().value;
      if (first !== undefined) this.failures.delete(first);
    }
    this.failures.set(ip, f);
    return f.fails;
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  /** Returns a Set-Cookie value on success, throws on bad credentials.
   *  `secure` adds the Secure flag when the login arrived over TLS. */
  login(user: string, pass: string, secure = false): string {
    if (this.equal(user || "", this.user) && this.equal(pass || "", this.pass)) {
      const token = crypto.randomBytes(24).toString("hex");
      const now = Date.now();
      this.tokens.set(token, { exp: now + this.ttlMs, at: now });
      this.prune();
      const maxAge = Math.floor(this.ttlMs / 1000);
      return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
    }
    throw new Error("invalid credentials");
  }

  logout(req: http.IncomingMessage): string {
    const token = this.tokenFromCookie(req);
    if (token) this.tokens.delete(token);
    return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
}
