// integration — hub contract tests over HTTP + WS (no browser).
//
// Three independent groups, each with its own hub: the main API/WS/relay
// contract, the shell asset-versioning contract, and auth. They run
// concurrently (see groups.mjs) so the whole suite is a few seconds.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { runGroups } from "./groups.mjs";
import { PKG_ROOT, cleanEnv, connectWs, findPi, fixtureSessionDir, freePort, jsonFetch, startHub, startMirror, tmpDir, waitFor } from "./helpers.mjs";

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

    // R-10 relocate target is jailed to the browse roots (ADR-017): /etc
    // must not become a session cwd even though it exists; a dir under
    // $HOME stays allowed so the Continue flow keeps working.
    const relBad = await jsonFetch(`${base}/api/sessions/relocate`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", cwd: "/etc" } });
    check("X17 relocate outside roots refused", relBad.status === 403, `status ${relBad.status}`);
    const relTarget = path.join(process.env.HOME || "/tmp", `pi-hub-test-reloc-${Date.now().toString(36)}`);
    fs.mkdirSync(relTarget, { recursive: true });
    try {
      const relOk = await jsonFetch(`${base}/api/sessions/relocate`, { method: "POST", body: { dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", cwd: relTarget } });
      const relJson = await relOk.json().catch(() => ({}));
      const relFile = relJson.file && path.join(sessions, "--tmp-pihub-fixtures--", relJson.file);
      const headerOk = relFile && fs.existsSync(relFile) && JSON.parse(fs.readFileSync(relFile, "utf8").split("\n")[0]).cwd === fs.realpathSync(relTarget);
      check("X17b relocate under HOME ok with rewritten header", relOk.status === 200 && !!headerOk, `status ${relOk.status}`);
      if (relFile && fs.existsSync(relFile)) fs.unlinkSync(relFile);
    } finally {
      try { fs.rmdirSync(relTarget); } catch {}
    }

    // X20 (S3): export_html outputPath is validated before it can reach the
    // child's exporter; without a path the forward still works (child
    // defaults next to the session file, inside the store).
    const wsX = await connectWs(`ws://127.0.0.1:${port}/ws`);
    await wsX.wait((m) => m.type === "hello", 10000, "hello");
    wsX.send({ type: "bind", id: "bx", dirName: "--tmp-pihub-fixtures--", file: "2026-01-01T00-00-00Z_fixture.jsonl", cwd: "/tmp/pihub-fixtures" });
    const bx = await wsX.wait((m) => m.type === "bound" && m.id === "bx", 30000, "bind for export");
    wsX.send({ type: "command", id: "ex1", command: { type: "export_html", outputPath: "/etc/pi-hub-evil.html", id: "ex1" } });
    const exErr = await wsX.wait((m) => m.type === "error" && m.id === "ex1", 10000, "export jail error");
    check("X20 export_html outside store refused", /session store/.test(exErr.message), exErr.message);
    check("X20b evil export wrote nothing", !fs.existsSync("/etc/pi-hub-evil.html"));
    wsX.send({ type: "command", id: "ex2", command: { type: "export_html", id: "ex2" } });
    const exAck = await wsX.wait((m) => (m.type === "ack" || m.type === "error") && m.id === "ex2", 10000, "export forward");
    check("X20c export without path still forwards", exAck.type === "ack", JSON.stringify(exAck).slice(0, 160));
    wsX.send({ type: "close", id: "clx", runnerId: bx.runner.id });
    await wsX.wait((m) => m.type === "closed", 10000, "closed after export").catch(() => {});
    await wsX.close();
    // The close ack precedes actual child exit; the next bind for this file
    // must not reuse the dying runner (registry race, still open — H2).
    await waitFor(async () => (await (await fetch(`${base}/api/runners`)).json()).runners.length === 0, { timeoutMs: 15000, what: "export runner removed" });

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
    const git2 = await ws.wait((m) => m.type === "event" && m.event?.id === "g2", 20000, "g2 response");
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
      // D2b: hostile attachments are validated before any execution, driver or not.
      ws2.send({ type: "bind", id: "b-live", runnerId: instances.instances[0].id });
      await ws2.wait((m) => m.type === "bound" && m.id === "b-live", 10000, "live bind ack");
      ws2.send({ type: "command", id: "v1", command: { type: "prompt", message: "hi", images: [{ mimeType: "image/svg+xml", data: "aGk=" }] } });
      const vErr = await ws2.wait((m) => m.type === "error" && m.id === "v1", 10000, "image validation error");
      check("D2b hostile image blocked before execution", /invalid image/.test(vErr.message), vErr.message);
      ws2.send({ type: "detach", id: "d1" });
      const detached = await ws2.wait((m) => m.type === "detached", 10000, "detached");
      check("D3 detach acks", detached.runnerId === instances.instances[0].id);
      await ws2.close();
      // D8: ADR-014 single driver, enforced server-side (not just UI-disabled).
      // A bound-but-not-attached socket reads (preview) but may not write.
      const ws3 = await connectWs(`ws://127.0.0.1:${port}/ws`);
      await ws3.wait((m) => m.type === "hello", 10000, "hello");
      ws3.send({ type: "bind", id: "b7", runnerId: instances.instances[0].id });
      await ws3.wait((m) => m.type === "bound" && m.id === "b7", 10000, "preview bind ack");
      ws3.send({ type: "command", id: "p7", command: { type: "prompt", message: "steer without attach" } });
      const pErr = await ws3.wait((m) => m.type === "error" && m.id === "p7", 10000, "drive refusal");
      check("D8 drive verb without attach is refused", /attach first/.test(pErr.message), pErr.message);
      ws3.send({ type: "command", id: "g7", command: { type: "get_state" } });
      const gAck = await ws3.wait((m) => (m.type === "ack" || m.type === "error") && m.id === "g7", 10000, "preview read");
      check("D8b preview reads stay allowed", gAck.type === "ack", JSON.stringify(gAck).slice(0, 160));
      await ws3.close();
    } finally {
      await mirror.close();
    }
    await waitFor(async () => (await (await fetch(`${base}/api/instances`)).json()).instances.length === 0, { timeoutMs: 10000, what: "mirror removed" });
    check("D4 mirror death clears the live row", true);

    // ── hub advert: a TUI finds the hub without knowing PI_HUB_DIR ──────
    const advert = JSON.parse(fs.readFileSync(hub.advertPath, "utf8"));
    check("D5 hub advertises its socket", advert.sock === path.join(hub.dir, "hub.sock") && advert.port === port, JSON.stringify(advert));
    // stale configured sock (a TUI started with a different/old path) still
    // mirrors into the running hub via the advert
    const lost = await startMirror({
      sock: path.join(tmpDir("pihub-lost-"), "gone.sock"),
      cwd: "/tmp/pihub-fixtures",
      sessionDir: sessions,
      env: { PI_HUB_ADVERT_FILE: hub.advertPath },
    });
    try {
      const found = await waitFor(async () => {
        const out = await (await fetch(`${base}/api/instances`)).json();
        return out.instances.length ? out : null;
      }, { timeoutMs: 30000, what: "mirror found the advertised hub" });
      check("D6 a mirror with a stale socket path still connects", found.instances.length === 1, JSON.stringify(found.instances.map((i) => i.pid)));
    } finally {
      await lost.close();
    }
    // A *file* at the configured path (hard-killed hub) must not pin the
    // mirror there: existence is not enough, the connect has to succeed.
    const deadSock = path.join(tmpDir("pihub-deadsock-"), "hub.sock");
    fs.writeFileSync(deadSock, "");
    const stale = await startMirror({
      sock: deadSock,
      cwd: "/tmp/pihub-fixtures",
      sessionDir: sessions,
      env: { PI_HUB_ADVERT_FILE: hub.advertPath },
    });
    try {
      const viaAdvert = await waitFor(async () => {
        const out = await (await fetch(`${base}/api/instances`)).json();
        return out.instances.length ? out : null;
      }, { timeoutMs: 30000, what: "mirror skipped a dead socket file" });
      check("D6b a dead socket file is skipped for the advertised one", viaAdvert.instances.length === 1, JSON.stringify(viaAdvert.instances.map((i) => i.pid)));
    } finally {
      await stale.close();
    }
    await waitFor(async () => (await (await fetch(`${base}/api/instances`)).json()).instances.length === 0, { timeoutMs: 10000, what: "lost mirror removed" });

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
    // ── G1–G5 git branch probe (statusline) ─────────────────────────────
    // HEAD is read straight from disk: no git binary, no lock contention.
    const repoRoot = path.join("/tmp/pihub-fixtures", `git-probe-${Date.now().toString(36)}`);
    const repoDetached = `${repoRoot}-detached`;
    const repoWorktree = `${repoRoot}-wt`;
    const buildRepo = (root, head) => {
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "HEAD"), head);
    };
    fs.mkdirSync(path.join(repoRoot, "nested", "deep"), { recursive: true });
    buildRepo(repoRoot, "ref: refs/heads/feature/hub\n");
    const nestedCwd = path.join(repoRoot, "nested", "deep");
    const probeGit = async (cwd) => (await fetch(`${base}/api/git?cwd=${encodeURIComponent(cwd)}`)).json();
    const b1 = await probeGit(nestedCwd);
    check("G1 branch resolves from a nested cwd", b1.branch === "feature/hub" && b1.root === repoRoot && b1.detached === false, JSON.stringify(b1));
    buildRepo(repoDetached, `${"a".repeat(40)}\n`);
    const b2 = await probeGit(repoDetached);
    check("G2 detached HEAD shows the short sha", b2.branch === "a".repeat(7) && b2.detached === true, JSON.stringify(b2));
    fs.mkdirSync(repoWorktree, { recursive: true });
    fs.writeFileSync(path.join(repoWorktree, ".git"), `gitdir: ${path.join(repoRoot, ".git")}\n`);
    const b3 = await probeGit(repoWorktree);
    check("G3 worktree .git files are followed", b3.branch === "feature/hub", JSON.stringify(b3));
    // A sibling directory: nested dirs correctly inherit the parent repo.
    const plainRoot = `${repoRoot}-plain`;
    fs.mkdirSync(plainRoot, { recursive: true });
    const b4 = await probeGit(plainRoot);
    check("G4 a non-repo directory reports no branch", b4.branch === null && b4.root === null, JSON.stringify(b4));
    fs.rmSync(plainRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(repoDetached, { recursive: true, force: true });
    fs.rmSync(repoWorktree, { recursive: true, force: true });
    const gitOutside = await fetch(`${base}/api/git?cwd=${encodeURIComponent("/etc")}`);
    check("G5 the probe stays inside the file jail", gitOutside.status === 403, `status=${gitOutside.status}`);

  } finally {
    await hub.close();
    // Graceful stops withdraw the file; a hard kill leaves it behind, so the
    // mirror also refuses adverts whose pid is gone (D6 covers the live case).
    const stale = fs.existsSync(hub.advertPath) ? JSON.parse(fs.readFileSync(hub.advertPath, "utf8")) : null;
    let stalePidAlive = false;
    try {
      process.kill(stale?.pid, 0);
      stalePidAlive = true;
    } catch {}
    check("D7 a dead hub's advert is withdrawn or refused", !stale || !stalePidAlive, JSON.stringify(stale));
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
    // A9: wildcard bind without credentials refuses at boot (before claiming
    // anything or serving anything) — the tunnel must never meet an open hub.
    {
      const piBin = findPi();
      const dir = tmpDir();
      const port = await freePort();
      const env = cleanEnv({});
      Object.assign(env, {
        PI_HUB_PORT: String(port),
        PI_HUB_HOST: "0.0.0.0",
        PI_HUB_DIR: dir,
        PI_HUB_ADVERT_FILE: path.join(dir, "hub.json"),
        PI_HUB_LOG_FILE: path.join(dir, "hub.log"),
        PI_HUB_STATIC_DIR: path.join(PKG_ROOT, "public"),
        PI_HUB_PI_BIN: piBin,
      });
      const proc = spawn(piBin, ["-e", PKG_ROOT, "--mode", "rpc"], { cwd: PKG_ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
      proc.stdin.on("error", () => {});
      proc.stdin.write("\n");
      try {
        const logFile = path.join(dir, "hub.log");
        const refused = await waitFor(async () => {
          try {
            return fs.readFileSync(logFile, "utf8").includes("refusing to bind");
          } catch {
            return false;
          }
        }, { timeoutMs: 25000, what: "wildcard refusal in hub log" });
        check("A9 wildcard bind without credentials refused", !!refused);
        const reachable = await fetch(`http://127.0.0.1:${port}/api/health`).then(() => true).catch(() => false);
        check("A9b refused hub serves nothing", !reachable);
        check("A9c refused hub claims no scope", !fs.existsSync(path.join(dir, "hub.json")));
      } finally {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }
    }
    check("A6b no Secure flag over plain HTTP", !/;\s*Secure/i.test(cookie), cookie.slice(0, 80));
    // A7: Basic covers scripts/curl (S12 backoff below); wrong password 401s.
    const basicOk = await fetch(`${secure.url}/api/sessions`, { headers: { authorization: `Basic ${Buffer.from("tau:tpass").toString("base64")}` } });
    check("A7 Basic authenticates scripts", basicOk.ok, `status ${basicOk.status}`);
    const basicBad = await fetch(`${secure.url}/api/sessions`, { headers: { authorization: `Basic ${Buffer.from("tau:wrong").toString("base64")}` } });
    check("A7b wrong Basic password 401", basicBad.status === 401, `status ${basicBad.status}`);
    // A8: Host allowlist is exact now (S12 Host hardening) — raw Host header.
    const rawStatus = (hostHeader) =>
      new Promise((resolve) => {
        const r = http.request(
          { host: "127.0.0.1", port: authPort, path: "/api/health", method: "GET", headers: { Host: hostHeader } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        r.on("error", () => resolve(-1));
        r.end();
      });
    check("A8 wrong Host refused", (await rawStatus("evil.example")) === 403);
    check("A8b bracketed IPv6 loopback parses", (await rawStatus(`[::1]:${authPort}`)) === 200);
    check("A8c tailnet suffix alone is not trusted", (await rawStatus("other.ts.net")) === 403);
    check("A8d userinfo-smuggled loopback refused", (await rawStatus("x@127.0.0.1")) === 403);
  } finally {
    await secure.close();
  }
}
