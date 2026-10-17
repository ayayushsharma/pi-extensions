// D5 — auth on: login → WS works; no cookie → 401 + inline overlay;
// logout revokes.
import { WebSocket } from "ws";
import { startHubStub } from "../hub-stub.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, fetchJson, PUBLIC_DIR } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "D5";
export const title = "auth: 401 + overlay, login → WS, logout revokes";

const USER = "e2e-user";
const PASS = "e2e-pass-123";

export async function run() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({ port, staticDir: PUBLIC_DIR, auth: { user: USER, pass: PASS } });
  const browser = await launchBrowser();
  try {
    // No cookie → 401 on /api/* (never WWW-Authenticate).
    const anon = await fetch(`${hub.url}/api/sessions`);
    assert(anon.status === 401, `anon /api/sessions: ${anon.status}, want 401`);
    assert(!anon.headers.get("www-authenticate"), "WWW-Authenticate must never be sent");

    // Browser: inline login overlay appears (fetch wrapper raises it on 401).
    const page = await browser.newPage();
    try {
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(
        `!document.querySelector("#login-overlay")?.classList?.contains("hidden") ? true : null`,
        { timeout: 10000 },
      );

      // Login via the real form path.
      const loginRes = await fetch(`${hub.url}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: USER, pass: PASS }),
      });
      assert(loginRes.status === 200, `login: ${loginRes.status}`);
      const cookie = loginRes.headers.get("set-cookie") || "";
      assert(/tau_auth=/.test(cookie) && /HttpOnly/.test(cookie), `login cookie malformed: ${cookie}`);
      const token = (cookie.match(/tau_auth=([^;]+)/) || [])[1];
      assert(token, "no token minted");

      // Cookie → WS works.
      const authed = await fetchJson(`${hub.url}/api/sessions`, { headers: { Cookie: `tau_auth=${token}` } });
      assert(authed.res.status === 200, `authed sessions: ${authed.res.status}`);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `tau_auth=${token}` } });
      await new Promise((res, rej) => {
        ws.on("open", res);
        ws.on("error", rej);
        setTimeout(() => rej(new Error("authed ws timeout")), 8000);
      });
      ws.close();

      // Wrong password → 401, no cookie.
      const bad = await fetch(`${hub.url}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: USER, pass: "wrong" }),
      });
      assert(bad.status === 401, `bad login: ${bad.status}, want 401`);

      // Logout revokes.
      const out = await fetch(`${hub.url}/api/logout`, { method: "POST", headers: { Cookie: `tau_auth=${token}` } });
      assert(out.status === 200, `logout: ${out.status}`);
      const after = await fetch(`${hub.url}/api/sessions`, { headers: { Cookie: `tau_auth=${token}` } });
      assert(after.status === 401, `revoked token still works: ${after.status}`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("d5-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}
