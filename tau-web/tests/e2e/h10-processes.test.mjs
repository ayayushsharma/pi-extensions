// H10 — live process visibility + on-demand kill (ADR-013).
// Stub (default, CI): fixture rows render in Settings → Server, kill
// removes a row, refusals (400 bad pid, 404 stale pid) surface inline.
// With TEST_REAL_HUB=1 the real scanner lists an `exec -a pi sleep`
// double and the real killer reaps it.
import { spawn } from "node:child_process";
import { startHubStub } from "../hub-stub.mjs";
import { bootRealHub } from "../hub-real.mjs";
import { launchBrowser } from "../browser.mjs";
import { assert, assertPortFree, basePort, PUBLIC_DIR, fetchJson, waitFor } from "../helpers.mjs";

export const requires = ["browser"];
export const id = "H10";
export const title = "live pi processes list + kill (stub UI, real scan/kill)";

async function postKill(url, pid) {
  return fetchJson(`${url}/api/processes/kill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid }),
  });
}

async function runStub() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await startHubStub({
    port,
    staticDir: PUBLIC_DIR,
    processes: [
      { pid: 424242, argv: ["pi"], cwd: "/tmp/e2e-proj", rssKb: 2048, ageSec: 3700, owner: "live", sessionHint: null },
      { pid: 424243, argv: ["pi", "--mode", "rpc"], cwd: "/tmp/e2e-hub", rssKb: 4096, ageSec: 60, owner: "hub", sessionHint: null },
    ],
  });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    try {
      await page.goto(`${hub.url}/hub/`);
      await page.waitForFunction(`!!document.querySelector("#status-indicator") ? true : null`, { timeout: 15000 });
      await page.click("#settings-btn");
      await page.click(`#settings-tabs .settings-tab[data-tab="server"]`);
      await page.waitForFunction(`document.querySelectorAll("#proc-list .proc-row").length === 2 ? true : null`, { timeout: 15000 });
      const meta = await page.evaluate(`(() => [...document.querySelectorAll("#proc-list .proc-row")].map(r => r.textContent).join("\\n"))()`);
      assert(/424242/.test(meta) && /424243/.test(meta), `rows show both pids: ${meta.slice(0, 300)}`);
      assert(/terminal/.test(meta) && /hub backend/.test(meta), `owner tags render: ${meta.slice(0, 300)}`);
      // Kill the live row (confirm stubbed — native dialogs hang CDP).
      await page.evaluate(`(() => { window.confirm = () => true; })()`);
      await page.click(`#proc-list .proc-row[data-pid="424242"] .proc-kill`);
      await page.waitForFunction(`document.querySelectorAll("#proc-list .proc-row").length === 1 ? true : null`, { timeout: 15000 });
      const rest = await page.evaluate(`(() => document.querySelector("#proc-list").textContent)()`);
      assert(!/424242/.test(rest) && /424243/.test(rest), `only the hub row remains: ${rest.slice(0, 200)}`);
      // Refusals surface as HTTP errors (inline error box on the UI path).
      const bad = await postKill(hub.url, 1);
      assert(bad.res.status === 400, `pid 1 refused with 400, got ${bad.res.status}`);
      const stale = await postKill(hub.url, 99999943);
      assert(stale.res.status === 404, `stale pid refused with 404, got ${stale.res.status}`);
      const self = await postKill(hub.url, process.pid);
      assert(self.res.status === 400, `hub-self pid refused with 400, got ${self.res.status}`);
      page.assertNoPageErrors();
    } catch (e) {
      await page.screenshot("h10-fail");
      throw e;
    } finally {
      page.close();
    }
  } finally {
    await browser.close();
    await hub.close();
  }
}

async function runReal() {
  const port = await basePort();
  await assertPortFree(port);
  const hub = await bootRealHub({ port });
  // A live-terminal stand-in: kernel argv[0] is exactly `pi`.
  const dbl = spawn("bash", ["-c", "exec -a pi sleep 120"], { stdio: "ignore", detached: true });
  dbl.unref();
  try {
    const found = await waitFor(async () => {
      const { json } = await fetchJson(`${hub.url}/api/processes`);
      const hit = json?.processes?.find((p) => p.pid === dbl.pid);
      return hit || null;
    }, { timeout: 15000, label: "scanner lists the pi double" });
    assert(found.owner === "live", `double labeled live: ${JSON.stringify(found)}`);
    assert(found.argv?.[0] === "pi", `double argv fingerprinted: ${JSON.stringify(found.argv)}`);
    const killed = await postKill(hub.url, dbl.pid);
    assert(killed.res.status === 200 && killed.json?.ok === true && killed.json?.exited === true,
      `kill reaps the double: ${killed.text.slice(0, 200)}`);
    await waitFor(async () => {
      try { process.kill(dbl.pid, 0); return null; } catch { return true; }
    }, { timeout: 10000, label: "double process dead" });
    const { json } = await fetchJson(`${hub.url}/api/processes`);
    assert(!json?.processes?.some((p) => p.pid === dbl.pid), "double gone from the list after kill");
    const gone = await postKill(hub.url, dbl.pid);
    assert(gone.res.status === 404, `re-kill 404s, got ${gone.res.status}`);
    const bad = await postKill(hub.url, 1);
    assert(bad.res.status === 400, `pid 1 refused with 400, got ${bad.res.status}`);
  } finally {
    try { process.kill(dbl.pid, "SIGKILL"); } catch {}
    await hub.close();
  }
}

export async function run() {
  if (process.env.TEST_REAL_HUB === "1") await runReal();
  else await runStub();
}
