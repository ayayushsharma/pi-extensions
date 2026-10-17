// X2 — request hardening on the real hub: JSON body caps (S5) and the
// client-error beacon rate limit (S7). No browser, no headless child.
import path from "node:path";
import { bootRealHub } from "../hub-real.mjs";
import { assert, assertPortFree, basePort, TMP_DIR, ensureTmp, postJson, fetchJson } from "../helpers.mjs";

export const requires = ["pi"];
export const id = "X2";
export const title = "request hardening: 256 KiB JSON cap + beacon 429";

export async function run() {
  ensureTmp();
  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({
    port,
    extraEnv: { PI_CODING_AGENT_SESSION_DIR: path.join(TMP_DIR, `x2-${port}`) },
  });
  try {
    // S5: /api/files/mkdir uses the 256 KiB JSON cap. 300 KiB must be
    // rejected with 413 *before* any filesystem work happens.
    const big = "x".repeat(300 * 1024);
    const res = await fetch(`${hub.url}/api/files/mkdir`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/tau-e2e-x2", pad: big }),
      redirect: "manual",
    });
    await res.text();
    assert(res.status === 413, `oversize JSON 413, got ${res.status}`);

    // Server still healthy after the rejected body (connection torn down
    // cleanly, no crash).
    const health = await fetchJson(`${hub.url}/api/health`);
    assert(health.res.status === 200 && health.json?.status === "ok", `hub healthy after 413, got ${health.res.status}`);

    // S7: the unauthenticated client-error beacon allows 20/min per IP;
    // the 21st in the same window must be 429.
    const statuses = [];
    for (let i = 0; i < 21; i++) {
      const r = await postJson(`${hub.url}/api/client-error`, { message: `tau-e2e-beacon-${i}` });
      statuses.push(r.status);
    }
    assert(statuses.slice(0, 20).every((s) => s === 204), `first 20 beacons 204, got ${statuses.join(",")}`);
    assert(statuses[20] === 429, `21st beacon 429, got ${statuses[20]}`);

    // And the beacon limit must not lock out regular API traffic.
    const list = await fetchJson(`${hub.url}/api/sessions`);
    assert(list.res.status === 200, `sessions API unaffected by beacon limit, got ${list.res.status}`);
  } finally {
    await hub.close();
  }
}
