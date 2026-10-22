// Unit tests for Auth: Host/Origin gates, backoff math, token lifecycle,
// cookie flags. Fake request shapes only — no sockets, no hub.
import { test } from "node:test";
import assert from "node:assert/strict";

const { Auth, clientIp } = await import("../../extensions/lib/hub/auth.ts");

const req = (headers: Record<string, string> = {}, ip = "9.9.9.9"): any => ({
  headers,
  socket: { remoteAddress: ip },
});
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

const auth = (opts: { allowed?: string[]; anyHost?: boolean; own?: string[]; ttl?: number; proxy?: boolean } = {}) =>
  new Auth("u", "p", true, opts.allowed || [], opts.anyHost || false, opts.own || [], opts.ttl, opts.proxy);

test("login mints HttpOnly cookies, Secure only over TLS", () => {
  const a = auth();
  const plain = a.login("u", "p", false);
  assert.match(plain, /pi_hub_auth=/);
  assert.match(plain, /HttpOnly/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(a.login("u", "p", true), /;\ Secure/);
  assert.throws(() => a.login("u", "wrong"), /invalid credentials/);
});

test("cookie token validates, unknown and expired do not", async () => {
  const a = auth({ ttl: 60 });
  const token = a.login("u", "p").split(";")[0].split("=")[1];
  assert.equal(a.validToken(token), true);
  assert.equal(a.validToken("nope"), false);
  assert.equal(a.validToken(null), false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(a.validToken(token), false, "expired token dies");
});

test("sliding refresh keeps active sessions without cookie churn", async () => {
  const a = auth({ ttl: 400 });
  const token = a.login("u", "p").split(";")[0].split("=")[1];
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(a.validToken(token), true, "past half-life, still valid");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(a.validToken(token), true, "expiry slid forward on use");
});

test("token map stays capped", () => {
  const a = auth({ ttl: 30 * 24 * 3600 * 1000 });
  for (let i = 0; i < 210; i++) a.login("u", "p");
  assert.ok((a as any).tokens.size <= 200, `size ${(a as any).tokens.size}`);
});

test("Host allowlist: loopback, own host and exact pins pass", () => {
  const a = auth({ allowed: ["pi.example.ts.net"], own: ["192.168.1.50"] });
  for (const host of ["127.0.0.1:8292", "localhost:8292", "[::1]:8292", "192.168.1.50:8292", "pi.example.ts.net"]) {
    assert.equal(a.hostAllowed(req({ host })), true, host);
  }
});

test("Host denylist: any-IPv4, suffixes, smuggled and empty hosts fail", () => {
  const a = auth({ allowed: ["pi.example.ts.net"], own: ["192.168.1.50"] });
  for (const host of ["192.168.1.5:8292", "10.0.0.8", "evil.ts.net", "evil.example", "x@127.0.0.1", "", "127.0.0.1:badport"]) {
    assert.equal(a.hostAllowed(req({ host })), false, JSON.stringify(host));
  }
  assert.equal(a.hostAllowed(req({ host: "127.0.0.1", origin: "https://evil.example" })), false, "evil Origin");
  assert.equal(a.hostAllowed(req({ host: "127.0.0.1", origin: "http://localhost:8292" })), true, "good Origin");
  assert.equal(auth({ anyHost: true }).hostAllowed(req({ host: "anything.example" })), true, "allow-any bypass");
});

test("Basic authenticates scripts, keeps colon passwords, backs off", async () => {
  const a = auth();
  assert.equal(await a.authenticateRequest(req({ authorization: basic("u", "p") }, "10.1.1.1")), "ok");
  assert.equal(await a.authenticateRequest(req({}, "10.1.1.2")), "denied", "no credentials");
  assert.equal(await a.authenticateRequest(req({ authorization: basic("u", "wrong") }, "10.1.1.3")), "denied");

  const colon = new Auth("u", "p:a:ss", true, [], false);
  assert.equal(await colon.authenticateRequest(req({ authorization: basic("u", "p:a:ss") }, "10.1.1.4")), "ok", "colon password intact");

  // Six rapid failures: waits kick in after the third (500 + 1000ms ≥ 1s).
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    assert.equal(await a.authenticateRequest(req({ authorization: basic("u", "no") }, "10.1.1.9")), "denied");
  }
  assert.ok(Date.now() - t0 >= 1000, `backoff slept (${Date.now() - t0}ms)`);
});

test("failure map is capped", () => {
  const a = auth();
  for (let i = 0; i < 1010; i++) a.recordFailure(`10.9.${i >> 8}.${i & 255}`);
  assert.ok((a as any).failures.size <= 1000, `size ${(a as any).failures.size}`);
});

test("clientIp trusts X-Forwarded-For only from a loopback proxy, opt-in (H6)", () => {
  const xff = { "x-forwarded-for": "203.0.113.5, 10.0.0.2" };
  assert.equal(clientIp(req(xff, "127.0.0.1")), "127.0.0.1", "default: never trust the header");
  assert.equal(clientIp(req(xff, "127.0.0.1"), true), "203.0.113.5", "loopback tunnel: first hop");
  assert.equal(clientIp(req(xff, "::1"), true), "203.0.113.5");
  assert.equal(clientIp(req(xff, "10.0.0.9"), true), "10.0.0.9", "non-loopback peer cannot spoof");
  assert.equal(clientIp(req({ "x-forwarded-for": "not-an-ip" }, "127.0.0.1"), true), "127.0.0.1");
  assert.equal(clientIp(req({ "x-forwarded-for": "[2001:db8::1]" }, "127.0.0.1"), true), "2001:db8::1");
  const a = auth({ proxy: true });
  assert.equal(a.clientIp(req(xff, "127.0.0.1")), "203.0.113.5", "the Auth instance uses the same key");
});
