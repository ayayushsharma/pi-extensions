// X3 — response hardening on the real hub: baseline security headers on
// every response class (S6) and no CORS grant on /api/health (S11).
// Auth is ON so the 401 path is exercised too. No browser.
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, TMP_DIR, ensureTmp } from "../helpers.mjs";

export const requires = ["pi"];
export const id = "X3";
export const title = "response hardening: security headers everywhere + health has no CORS";

const HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

function assertHeaders(res, label) {
  for (const [name, value] of Object.entries(HEADERS)) {
    assert(res.headers.get(name) === value, `${label}: ${name}: expected "${value}", got ${JSON.stringify(res.headers.get(name))}`);
  }
}

export async function run() {
  ensureTmp();
  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({
    port,
    extraEnv: {
      TAU_USER: "tau",
      TAU_PASS: "tau-e2e-headers",
      PI_CODING_AGENT_SESSION_DIR: path.join(TMP_DIR, `x3-${port}`),
    },
  });
  try {
    // Static shell (must stay reachable logged-out so the login overlay can load).
    // The hub role redirects / to /hub/; the redirect itself must carry the
    // baseline headers too.
    const root = await fetch(hub.url + "/", { redirect: "manual" });
    assert(root.status === 302, `root redirect 302, got ${root.status}`);
    assert(/\/hub\/?$/.test(root.headers.get("location") || ""), `root redirects to /hub/, got ${root.headers.get("location")}`);
    assertHeaders(root, "GET /");
    await root.text();

    const hubPage = await fetch(hub.url + "/hub/", { redirect: "manual" });
    assert(hubPage.status === 200, `hub shell 200, got ${hubPage.status}`);
    assertHeaders(hubPage, "GET /hub/");
    await hubPage.text();

    // Auth-exempt API.
    const health = await fetch(hub.url + "/api/health");
    assert(health.status === 200, `health 200, got ${health.status}`);
    assertHeaders(health, "GET /api/health");
    const healthJson = await health.json();
    assert(healthJson.authEnabled === true, "health reports authEnabled:true");

    // S11: a hostile Origin must not be echoed back on health.
    const crossOrigin = await fetch(hub.url + "/api/health", { headers: { Origin: "http://evil.example" } });
    assert(!crossOrigin.headers.get("access-control-allow-origin"), "health must not grant CORS");
    await crossOrigin.text();

    // Gated API: the 401 must carry the baseline headers too.
    const denied = await fetch(hub.url + "/api/sessions");
    assert(denied.status === 401, `gated API 401, got ${denied.status}`);
    assertHeaders(denied, "GET /api/sessions (401)");
    await denied.text();
  } finally {
    await hub.close();
  }
}
