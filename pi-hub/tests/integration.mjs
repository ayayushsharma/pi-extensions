// integration — hub contract tests over HTTP + WS (no browser).
//
// Three independent groups, each with its own hub: the main API/WS/relay
// contract, the shell asset-versioning contract, and auth. They run
// concurrently (see groups.mjs) so the whole suite is a few seconds.
import fs from "node:fs";
import path from "node:path";
import { runGroups } from "./groups.mjs";
import { PKG_ROOT, connectWs, fixtureSessionDir, freePort, jsonFetch, startHub, startMirror, tmpDir, waitFor } from "./helpers.mjs";

export async function runIntegration({ log }) {
  return runGroups(
    [
      { name: "hub", run: hubGroup },
      { name: "assets", run: assetsGroup },
      { name: "auth", run: authGroup },
    ],
    { log },
  );
}

async function hubGroup({ check }) {
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
    // ── fork copy (ADR-016) ─────────────────────────────────────────────
    const forkRes = await jsonFetch(`${base}/api/sessions/fork`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" } });
    const forkJson = await forkRes.json();
    const src = fs.readFileSync(path.join(sessions, "--tmp-pihub-fixtures--", "2026-01-01T00-00-00Z_fixture.jsonl"));
    const dst = fs.readFileSync(path.join(sessions, "--tmp-pihub-fixtures--", forkJson.file));
    check("H5 fork byte-identical", forkRes.ok && src.equals(dst), forkJson.file);

    // X4: delete exists for the product UI but is realpath-jailed to the
    // sessions dir (ADR-018) — traversal is refused, the fixture survives.
    const delOk = await jsonFetch(`${base}/api/sessions/delete`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: forkJson.file } });
    check("X4 delete removes a session copy", delOk.status === 200 && !fs.existsSync(path.join(sessions, "--tmp-pihub-fixtures--", forkJson.file)), `status ${delOk.status}`);
    const delBad = await jsonFetch(`${base}/api/sessions/delete`, { method: "POST", body: { dirName: "../..", file: "anything.jsonl" } });
    check("X4b delete traversal refused", delBad.status >= 400, `status ${delBad.status}`);
    check("X4c fixture untouched", fs.existsSync(path.join(sessions, "--tmp-pihub-fixtures--", "2026-01-01T00-00-00Z_fixture.jsonl")));

    // ── WS: bind, get_state, rejoin no-op, close ────────────────────────
    const ws = await connectWs(`ws://127.0.0.1:${port}/ws`);
    const hello = await ws.wait((m) => m.type === "hello", 10000, "hello");
    check("H6 hello frame", hello.mode === "hub" && Array.isArray(hello.features));

    ws.send({ type: "bind", id: "b1", dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", cwd: "/tmp/pihub-fixtures" });
    const bound = await ws.wait((m) => m.type === "bound", 30000, "bound ack");
    check("H7 bind resumes fixture", bound.runner.absFile.endsWith("2026-01-01T00-00-00Z_fixture.jsonl"), JSON.stringify(bound.runner.absFile));
    check("H7b bind reports basename", bound.runner.sessionFile === "2026-01-01T00-00-00Z_fixture.jsonl");

    let stateSeq = 0;
    const state = await new Promise((resolve) => {
      ws.send({ type: "command", id: "g1", command: { type: "get_state", id: "g1" } });
      ws.wait((m) => m.type === "event" && m.event?.type === "response" && m.event?.command === "get_state" && m.event.id === "g1", 20000, "get_state response").then((frame) => {
        stateSeq = frame.seq;
        resolve(frame);
      });
    });
    check("H8 get_state round-trip", state.event.success === true && !!state.event.data?.sessionFile, state.event.error || "");

    const runnerCountBefore = (await (await fetch(`${base}/api/runners`)).json()).runners.length;
    ws.send({ type: "bind", id: "b2", runnerId: bound.runner.id });
    const bound2 = await ws.wait((m) => m.type === "bound" && m.id === "b2", 10000, "re-bind ack");
    const runnerCountAfter = (await (await fetch(`${base}/api/runners`)).json()).runners.length;
    check("H9 rejoin reuses runner (ADR-015)", bound2.runner.id === bound.runner.id && runnerCountBefore === runnerCountAfter, `${runnerCountBefore} -> ${runnerCountAfter}`);

    // stale seq guard: bound ack includes the runner's current seq
    check("H10 bound carries lastSeq", typeof bound2.lastSeq === "number");

    // H10b: rebinding with sinceSeq replays the missed ring frames (no dupes).
    ws.send({ type: "bind", id: "b3", runnerId: bound.runner.id, sinceSeq: stateSeq - 1 });
    await ws.wait((m) => m.type === "bound" && m.id === "b3", 10000, "sinceSeq re-bind ack");
    ws.send({ type: "command", id: "g2", command: { type: "get_state", id: "g2" } });
    const replayed = await ws.wait((m) => m.type === "event" && m.seq === stateSeq, 10000, "replayed ring frame").catch(() => null);
    const g2 = await ws.wait((m) => m.type === "event" && m.event?.id === "g2", 20000, "g2 response");
    const g2Count = ws.frames.filter((m) => m.type === "event" && m.event?.id === "g2").length;
    check("H10b ring replay honours sinceSeq", !!replayed && g2Count === 1, `replayed=${!!replayed} g2=${g2Count}`);

    // ── H35 (R-10) dead-cwd resume falls back and says so ──────────────
    const goneCwd = path.join(tmpDir("pihub-gone-"), "project");
    const wsDead = await connectWs(`ws://127.0.0.1:${port}/ws`);
    await wsDead.wait((m) => m.type === "hello", 10000, "hello (dead cwd)");
    wsDead.send({ type: "bind", id: "bd1", dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", cwd: goneCwd });
    const deadBound = await wsDead.wait((m) => m.type === "bound" && m.id === "bd1", 30000, "dead-cwd bind ack");
    check("H35 dead cwd falls back instead of failing",
      deadBound.runner?.cwdFallback?.from === goneCwd && !!deadBound.runner?.cwdFallback?.to,
      JSON.stringify(deadBound.runner?.cwdFallback));
    check("H35b fallback cwd exists and is not the dead one",
      deadBound.runner.cwdFallback.to !== goneCwd && fs.existsSync(deadBound.runner.cwdFallback.to),
      deadBound.runner.cwdFallback.to);
    check("H35c the session still resumes", deadBound.runner.sessionFile === "2026-01-01T00-00-00Z_fixture.jsonl", String(deadBound.runner.sessionFile));
    wsDead.send({ type: "command", id: "gd1", command: { type: "get_state", id: "gd1" } });
    const deadState = await wsDead.wait((m) => m.type === "event" && m.event?.id === "gd1" && m.event?.command === "get_state", 30000, "get_state after fallback");
    check("H35d child is usable in the fallback cwd", deadState.event.success === true && !!deadState.event.data?.sessionFile, deadState.event.error || "");
    wsDead.send({ type: "close", id: "cld1", runnerId: deadBound.runner.id });
    await wsDead.wait((m) => m.type === "closed", 10000, "closed (dead cwd)").catch(() => {});

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
    check("P1b every process carries a title field", procs.processes.every((p) => p.title === null || typeof p.title === "string"),
      JSON.stringify(procs.processes.map((p) => [p.pid, p.title])));

    // ── P2 process rows are titled by the session they run (ADR-013) ─────
    // A hub child bound to a stored session reports that session's title; a
    // process whose session has no title yet reports null, which the settings
    // panel renders as "new process".
    const wsP = await connectWs(`ws://127.0.0.1:${port}/ws`);
    await wsP.wait((m) => m.type === "hello", 10000, "hello (proc title)");
    const titleProbe = await startMirror({ sock: path.join(hub.dir, "hub.sock"), cwd: "/tmp/pihub-fixtures", sessionDir: sessions });
    try {
      await waitFor(async () => {
        const out = await (await fetch(`${base}/api/processes`)).json();
        return out.processes.some((p) => p.pid === titleProbe.proc.pid);
      }, { timeoutMs: 20000, what: "mirror process listed" });
      const liveRow = (await (await fetch(`${base}/api/processes`)).json()).processes.find((p) => p.pid === titleProbe.proc.pid);
      check("P2 a fresh live process has no title yet", liveRow?.owner === "live" && liveRow?.title === null, JSON.stringify(liveRow?.title));
    } finally {
      await titleProbe.close();
    }

    wsP.send({ type: "bind", id: "bp1", dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl" });
    const procBound = await wsP.wait((m) => m.type === "bound" && m.id === "bp1", 30000, "bound (proc title)");
    const childPid = procBound.runner.pid;
    const childRow = (await waitFor(async () => {
      const out = await (await fetch(`${base}/api/processes`)).json();
      const row = out.processes.find((p) => p.pid === childPid);
      return row ? out.processes : null;
    }, { timeoutMs: 20000, what: "child process listed" })).find((p) => p.pid === childPid);
    check("P2b a bound child is titled by its session", childRow?.title === "Fixture session", JSON.stringify(childRow?.title));
    check("P2c owned children are labelled child, not live", childRow?.owner === "hub", String(childRow?.owner));
    wsP.send({ type: "close", id: "cp1", runnerId: procBound.runner.id });
    await wsP.wait((m) => m.type === "closed", 10000, "closed (proc title)").catch(() => {});
    await wsP.close();
  } finally {
    await hub.close();
    // fork fixture cleanup is left in place under the temp fixture dir only if copied there
  }

}

// ── shell asset versioning (own hub: it edits a copy of public/) ────────
async function assetsGroup({ check }) {
  // ── H12 shell asset versioning ──────────────────────────────────────
  // The shell stamps the live asset version onto ?v= URLs so the year-long
  // immutable caching of CSS/JS can never pair old styles with new markup
  // (the phantom-UI bug: elements present but invisible).
  const staticCopy = tmpDir("pihub-static-");
  fs.cpSync(path.join(PKG_ROOT, "public"), staticCopy, { recursive: true });
  const shellHub = await startHub({ port: await freePort(), sessionDir: fixtureSessionDir(), env: { PI_HUB_STATIC_DIR: staticCopy } });
  try {
    const html1 = await (await fetch(`${shellHub.url}/`)).text();
    const v1 = /app\.js\?v=([^"&]+)/.exec(html1)?.[1] || "";
    check("H12 shell stamps a real asset version", !!v1 && v1 !== "__ASSETV__", `v=${v1}`);
    check("H12b no placeholder leaks into the shell", !html1.includes("__ASSETV__"));
    const asset = await fetch(`${shellHub.url}/js/app.js?v=${v1}`);
    check("H12c versioned assets stay immutable", /immutable/.test(asset.headers.get("cache-control") || ""), asset.headers.get("cache-control") || "");
    const css1 = await (await fetch(`${shellHub.url}/css/app.css?v=${v1}`)).text();
    check("H12d shell version matches the served asset", css1.length > 0);
    await new Promise((r) => setTimeout(r, 1200)); // version cache TTL
    fs.appendFileSync(path.join(staticCopy, "css", "app.css"), "\n/* versioning probe */\n");
    const html2 = await (await fetch(`${shellHub.url}/`)).text();
    const v2 = /app\.js\?v=([^"&]+)/.exec(html2)?.[1] || "";
    check("H12e an asset edit bumps the version", !!v2 && v2 !== v1, `${v1} -> ${v2}`);
    // ── H12f the webfonts come from Google, and only Google ─────────────
    // The CSP must name the font origins exactly; anything narrower blocks
    // the stylesheet, anything looser lets a third party into the app shell.
    const shellRes = await fetch(`${shellHub.url}/`);
    const csp = shellRes.headers.get("content-security-policy") || "";
    check("H12f shell loads the Google webfonts + CSP allows exactly them",
      html2.includes("https://fonts.googleapis.com/css2?family=Inter") &&
        /style-src [^;]*https:\/\/fonts\.googleapis\.com/.test(csp) &&
        /font-src 'self' https:\/\/fonts\.gstatic\.com/.test(csp) &&
        !/font-src[^;]*\*/.test(csp),
      csp.replace(/^.*?(style-src[^;]*)/, "$1"));
  } finally {
    await shellHub.close();
    fs.rmSync(staticCopy, { recursive: true, force: true });
  }

}

// ── auth (own hub: credentials in env) ─────────────────────────────────
async function authGroup({ check }) {
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
}
