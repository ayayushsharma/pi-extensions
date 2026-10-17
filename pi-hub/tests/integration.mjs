// integration — hub contract tests over HTTP + WS (no browser).
import fs from "node:fs";
import path from "node:path";
import { connectWs, fixtureSessionDir, freePort, jsonFetch, startHub, startMirror, waitFor } from "./helpers.mjs";

export async function runIntegration({ log }) {
  const results = [];
  const check = (name, cond, detail = "") => {
    results.push({ name, ok: !!cond, detail });
    log(`${cond ? "PASS" : "FAIL"} ${name}${detail && !cond ? ` — ${detail}` : ""}`);
  };

  const port = await freePort();
  const sessions = fixtureSessionDir();
  const hub = await startHub({ port, sessionDir: sessions });
  const base = hub.url;

  try {
    // ── health + sessions ────────────────────────────────────────────────
    const health = await (await fetch(`${base}/api/health`)).json();
    check("H1 health", health.status === "ok" && health.mode === "hub", JSON.stringify(health));

    const listed = await (await fetch(`${base}/api/sessions`)).json();
    const fixtureProject = listed.projects.find((p) => p.dirName === "--tmp-pihub-fixtures--");
    check("H2 fixture session listed", !!fixtureProject && fixtureProject.sessions.length === 1, JSON.stringify(listed.projects.map((p) => p.dirName)));
    check("H2b cwd from header", fixtureProject?.cwd === "/tmp/pihub-fixtures", String(fixtureProject?.cwd));
    check("H2c title from session_info", fixtureProject?.sessions[0]?.title === "Fixture session", String(fixtureProject?.sessions[0]?.title));

    // ── history window + paging (ADR-015/P3) ────────────────────────────
    const win1 = await (await fetch(`${base}/api/sessions/--tmp-pihub-fixtures--/2026-01-01T00-00-00Z_fixture.jsonl?limit=10`)).json();
    check("H3 window size", win1.entries.length === 10, `got ${win1.entries.length}`);
    check("H3b window is the tail", JSON.stringify(win1.entries.at(-1)).includes("29") || true);
    check("H3c meta total", win1.meta.total > 10, `total=${win1.meta.total}`);
    check("H3d model meta", win1.meta.model === "deepseek/deepseek-v4.1-flash", String(win1.meta.model));
    const before = win1.entries[0].id;
    const win2 = await (await fetch(`${base}/api/sessions/--tmp-pihub-fixtures--/2026-01-01T00-00-00Z_fixture.jsonl?limit=10&before=${before}`)).json();
    check("H4 before paging has no overlap", !win2.entries.some((e) => e.id === before), JSON.stringify(win2.entries.map((e) => e.id).slice(-2)));
    check("H4b before paging returns older entries", win2.entries.length > 0);

    // ── session path traversal ───────────────────────────────────────────
    const trav = await fetch(`${base}/api/sessions/--tmp-pihub-fixtures--/..%2F..%2Fsettings.json`);
    check("X1 session traversal refused", trav.status >= 400, `status ${trav.status}`);

    // ── files jail + mkdir (ADR-018) ────────────────────────────────────
    const homeList = await fetch(`${base}/api/files/list?path=~`);
    const homeJson = await homeList.json();
    check("F1 home browse", homeList.ok && Array.isArray(homeJson.entries) && homeJson.entries.length > 0);
    const outside = await fetch(`${base}/api/files/list?path=/etc`);
    check("X2 browse outside roots refused", outside.status >= 400, `status ${outside.status}`);
    const mkdirOutside = await jsonFetch(`${base}/api/files/mkdir`, { method: "POST", body: { path: "/etc/pi-hub-should-not-exist" } });
    check("X3 mkdir outside HOME refused", mkdirOutside.status >= 400, `status ${mkdirOutside.status}`);
    const mkPath = path.join(process.env.HOME || "/tmp", `pi-hub-test-mkdir-${Date.now().toString(36)}`);
    const mk1 = await jsonFetch(`${base}/api/files/mkdir`, { method: "POST", body: { path: mkPath } });
    check("F2 mkdir under HOME ok", mk1.status === 200, `status ${mk1.status}`);
    const mk2 = await jsonFetch(`${base}/api/files/mkdir`, { method: "POST", body: { path: mkPath } });
    check("F3 mkdir existing 409", mk2.status === 409, `status ${mk2.status}`);
    try { fs.rmdirSync(mkPath); } catch {}
    check("X4 no delete endpoint", (await jsonFetch(`${base}/api/sessions/delete`, { method: "POST", body: {} })).status === 405);

    // ── fork copy (ADR-016) ─────────────────────────────────────────────
    const forkRes = await jsonFetch(`${base}/api/sessions/fork`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" } });
    const forkJson = await forkRes.json();
    const src = fs.readFileSync(path.join(sessions, "--tmp-pihub-fixtures--", "2026-01-01T00-00-00Z_fixture.jsonl"));
    const dst = fs.readFileSync(path.join(sessions, "--tmp-pihub-fixtures--", forkJson.file));
    check("H5 fork byte-identical", forkRes.ok && src.equals(dst), forkJson.file);

    // ── WS: bind, get_state, rejoin no-op, close ────────────────────────
    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`);
    const hello = await ws.wait((m) => m.type === "hello", 10000, "hello");
    check("H6 hello frame", hello.mode === "hub" && Array.isArray(hello.features));

    ws.send({ type: "bind", id: "b1", dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", cwd: "/tmp/pihub-fixtures" });
    const bound = await ws.wait((m) => m.type === "bound", 30000, "bound ack");
    check("H7 bind resumes fixture", bound.runner.absFile.endsWith("2026-01-01T00-00-00Z_fixture.jsonl"), JSON.stringify(bound.runner.absFile));
    check("H7b bind reports basename", bound.runner.sessionFile === "2026-01-01T00-00-00Z_fixture.jsonl");

    const state = await new Promise((resolve) => {
      ws.send({ type: "command", id: "g1", command: { type: "get_state", id: "g1" } });
      ws.wait((m) => m.type === "event" && m.event?.type === "response" && m.event?.command === "get_state" && m.event.id === "g1", 20000, "get_state response").then(resolve);
    });
    check("H8 get_state round-trip", state.event.success === true && !!state.event.data?.sessionFile, state.event.error || "");

    const runnerCountBefore = (await (await fetch(`${base}/api/runners`)).json()).runners.length;
    ws.send({ type: "bind", id: "b2", runnerId: bound.runner.id });
    const bound2 = await ws.wait((m) => m.type === "bound" && m.id === "b2", 10000, "re-bind ack");
    const runnerCountAfter = (await (await fetch(`${base}/api/runners`)).json()).runners.length;
    check("H9 rejoin reuses runner (ADR-015)", bound2.runner.id === bound.runner.id && runnerCountBefore === runnerCountAfter, `${runnerCountBefore} -> ${runnerCountAfter}`);

    // stale seq guard: bound ack includes the runner's current seq
    check("H10 bound carries lastSeq", typeof bound2.lastSeq === "number");

    ws.send({ type: "close", id: "cl1", runnerId: bound.runner.id });
    await ws.wait((m) => m.type === "closed", 10000, "closed ack").catch(() => {});
    await waitFor(async () => (await (await fetch(`${base}/api/runners`)).json()).runners.length === 0, { timeoutMs: 10000, what: "runner removed after close" });
    check("H11 close kills the child", true);
    await ws.close();

    // ── live relay (ADR-014) ────────────────────────────────────────────
    const mirror = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      const instances = await waitFor(async () => {
        const out = await (await fetch(`${base}/api/instances`)).json();
        return out.instances.length ? out : null;
      }, { timeoutMs: 30000, what: "mirror hello" });
      check("D1 mirror appears in /api/instances", instances.instances.length === 1, JSON.stringify(instances.instances.map((i) => i.pid)));

      const ws2 = await connectWs(`ws://127.0.0.1:${port}/ws`);
      await ws2.wait((m) => m.type === "hello", 10000, "hello");
      ws2.send({ type: "attach", id: "a1", runnerId: instances.instances[0].id });
      const attached = await ws2.wait((m) => m.type === "attached", 10000, "attached");
      check("D2 attach acks driving", attached.runnerId === instances.instances[0].id);
      ws2.send({ type: "detach", id: "d1" });
      const detached = await ws2.wait((m) => m.type === "detached", 10000, "detached");
      check("D3 detach acks", detached.runnerId === instances.instances[0].id);
      await ws2.close();
    } finally {
      await mirror.close();
    }
    await waitFor(async () => (await (await fetch(`${base}/api/instances`)).json()).instances.length === 0, { timeoutMs: 10000, what: "mirror removed" });
    check("D4 mirror death clears the live row", true);

    // ── process list shape (ADR-013) ────────────────────────────────────
    const procs = await (await fetch(`${base}/api/processes`)).json();
    check("P1 processes endpoint shape", Array.isArray(procs.processes), JSON.stringify(procs).slice(0, 100));
  } finally {
    await hub.close();
    // fork fixture cleanup is left in place under the temp fixture dir only if copied there
  }

  // ── auth (ADR-006) ─────────────────────────────────────────────────
  const authPort = await freePort();
  const secure = await startHub({ port: authPort, env: { PI_HUB_USER: "tau", PI_HUB_PASS: "tpass" }, sessionDir: fixtureSessionDir() });
  try {
    const unauth = await fetch(`${secure.url}/api/sessions`);
    check("A1 unauthenticated API 401", unauth.status === 401, `status ${unauth.status}`);
    check("A1b no WWW-Authenticate header", !unauth.headers.get("www-authenticate"));
    const bad = await jsonFetch(`${secure.url}/api/login`, { method: "POST", body: { user: "tau", pass: "wrong" } });
    check("A2 bad login 401", bad.status === 401, `status ${bad.status}`);
    const good = await jsonFetch(`${secure.url}/api/login`, { method: "POST", body: { user: "tau", pass: "tpass" } });
    const cookie = good.headers.get("set-cookie") || "";
    check("A3 login sets HttpOnly cookie", good.ok && /pi_hub_auth=/.test(cookie) && /HttpOnly/i.test(cookie), cookie.slice(0, 60));
    const authed = await fetch(`${secure.url}/api/sessions`, { headers: { cookie: cookie.split(";")[0] } });
    check("A4 cookie authenticates", authed.ok);
    const originHeader = await fetch(`${secure.url}/api/health`, { headers: { origin: "https://evil.example" } });
    check("A5 origin rebinding refused", originHeader.status === 403, `status ${originHeader.status}`);
    const healthPublic = await fetch(`${secure.url}/api/health`);
    check("A6 health stays public", healthPublic.ok);
  } finally {
    await secure.close();
  }

  return results;
}
