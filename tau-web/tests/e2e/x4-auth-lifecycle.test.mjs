// X4 — auth lifecycle on the real hub: login body cap (S5), Basic-auth
// backoff (S12), cookie token expiry (S13), and re-auth before set_auth (S8).
// A throwaway PI_CODING_AGENT_DIR keeps saveTauSetting() away from real
// settings.json. No browser.
import fs from "node:fs";
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import {
  assert, assertPortFree, basePort, TMP_DIR, ensureTmp,
  sleep, postJson, fetchJson,
} from "../helpers.mjs";

export const requires = ["pi"];
export const id = "X4";
export const title = "auth lifecycle: login cap, backoff, cookie expiry, re-auth set_auth";

const USER = "tau";
const PASS = "tau-e2e-auth";
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function cookieOf(res) {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/tau_auth=([^;]+)/);
  return m ? m[1] : null;
}

export async function run() {
  ensureTmp();
  // HOME must be a throwaway: saveTauSetting() (set_auth happy path) writes
  // to $HOME/.pi/agent/settings.json regardless of PI_CODING_AGENT_DIR, so a
  // real HOME would get authEnabled:false persisted into it.
  const dir = fs.mkdtempSync(path.join(TMP_DIR, "x4-"));
  const fakeHome = path.join(dir, "home");
  const fakeAgent = path.join(fakeHome, ".pi", "agent");
  fs.mkdirSync(fakeAgent, { recursive: true });
  // saveTauSetting() only updates an existing file (readFileSync throws
  // otherwise and the error is swallowed), so seed one.
  fs.writeFileSync(path.join(fakeAgent, "settings.json"), JSON.stringify({ tau: { authEnabled: true } }, null, 2));
  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({
    port,
    extraEnv: {
      HOME: fakeHome,
      TAU_USER: USER,
      TAU_PASS: PASS,
      TAU_AUTH_TOKEN_TTL_MS: "400",
      PI_CODING_AGENT_DIR: fakeAgent,
      PI_CODING_AGENT_SESSION_DIR: path.join(dir, "sessions"),
    },
  });
  try {
    // S5: the login body cap (64 KiB) rejects an oversize body with 413.
    const oversize = await fetch(`${hub.url}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: USER, pass: PASS, pad: "x".repeat(70 * 1024) }),
      redirect: "manual",
    });
    await oversize.text();
    assert(oversize.status === 413, `oversize login 413, got ${oversize.status}`);

    // S12: Basic failures are throttled after the 3rd typo. The 4th must
    // wait ~500ms before the 401 instead of answering at wire speed.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${hub.url}/api/sessions`, { headers: { authorization: basic(USER, `wrong-${i}`) } });
      assert(r.status === 401, `wrong Basic #${i + 1} 401, got ${r.status}`);
      await r.text();
    }
    const t0 = Date.now();
    const slow = await fetch(`${hub.url}/api/sessions`, { headers: { authorization: basic(USER, "wrong-4") } });
    const elapsed = Date.now() - t0;
    assert(slow.status === 401, `4th wrong Basic 401, got ${slow.status}`);
    await slow.text();
    assert(elapsed >= 350, `4th wrong Basic backed off, took ${elapsed}ms`);

    // Login with the real password mints an HttpOnly cookie.
    const login = await postJson(`${hub.url}/api/login`, { user: USER, pass: PASS });
    assert(login.status === 200, `login 200, got ${login.status} ${login.text.slice(0, 80)}`);
    const setCookie = login.headers.get("set-cookie") || "";
    assert(/tau_auth=/.test(setCookie), "login set tau_auth cookie");
    assert(/HttpOnly/i.test(setCookie), `cookie HttpOnly, got ${setCookie}`);
    assert(/SameSite=Lax/i.test(setCookie), `cookie SameSite=Lax, got ${setCookie}`);
    assert(/Max-Age=\d+/i.test(setCookie), `cookie Max-Age, got ${setCookie}`);
    const token = cookieOf(login);

    // Cookie and Basic both open the gated API.
    const withCookie = await fetchJson(`${hub.url}/api/sessions`, { headers: { cookie: `tau_auth=${token}` } });
    assert(withCookie.res.status === 200, `cookie auth 200, got ${withCookie.res.status}`);
    const withBasic = await fetchJson(`${hub.url}/api/sessions`, { headers: { authorization: basic(USER, PASS) } });
    assert(withBasic.res.status === 200, `Basic auth 200, got ${withBasic.res.status}`);

    // S13: TAU_AUTH_TOKEN_TTL_MS=400ms — the cookie must stop working.
    await sleep(700);
    const expired = await fetchJson(`${hub.url}/api/sessions`, { headers: { cookie: `tau_auth=${token}` } });
    assert(expired.res.status === 401, `expired cookie 401, got ${expired.res.status}`);
    const relogin = await postJson(`${hub.url}/api/login`, { user: USER, pass: PASS });
    assert(relogin.status === 200, `re-login 200, got ${relogin.status}`);
    const fresh = cookieOf(relogin);
    assert(fresh && fresh !== token, "re-login mints a new token");

    // S8: set_auth requires the password even on an authenticated session.
    // Server-level commands go through /api/rpc (app.js rpcCommand), and the
    // reply is a plain {type:"response"} object.
    const rpc = (cmd) => postJson(`${hub.url}/api/rpc`, cmd, { headers: { cookie: `tau_auth=${fresh}` } });
    const noPass = await rpc({ type: "set_auth", enabled: false });
    assert(noPass.json?.success === false && /Invalid password/.test(noPass.json?.error || ""), `set_auth without pass refused, got ${JSON.stringify(noPass.json).slice(0, 120)}`);
    const wrongPass = await rpc({ type: "set_auth", enabled: false, pass: "nope" });
    assert(wrongPass.json?.success === false, `set_auth wrong pass refused, got ${JSON.stringify(wrongPass.json).slice(0, 120)}`);
    const state = await rpc({ type: "get_auth" });
    assert(state.json?.data?.enabled === true, "auth still enabled after refused set_auth");

    const ok = await rpc({ type: "set_auth", enabled: false, pass: PASS });
    assert(ok.json?.success === true && ok.json?.data?.enabled === false, `set_auth with pass succeeds, got ${JSON.stringify(ok.json).slice(0, 120)}`);
    const open = await fetchJson(`${hub.url}/api/sessions`);
    assert(open.res.status === 200, `API open after auth disabled, got ${open.res.status}`);
    // The write went to the throwaway HOME, never the caller's real one.
    const written = JSON.parse(fs.readFileSync(path.join(fakeAgent, "settings.json"), "utf8"));
    assert(written?.tau?.authEnabled === false, `set_auth persisted to the test HOME, got ${JSON.stringify(written?.tau)}`);
  } finally {
    await hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
