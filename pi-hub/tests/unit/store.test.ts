// Unit tests for the session store — the on-disk contract every view reads.
// Fast (temp dirs only, no hub/child/browser) and stable: these assertions are
// about the JSONL format and the API shape, not about UI details.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store resolves its root once, at import time.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-unit-store-"));
process.env.PI_CODING_AGENT_SESSION_DIR = ROOT;
process.env.PI_CODING_AGENT_DIR = path.join(ROOT, "agent");

const store = await import("../../extensions/lib/store/sessions.ts");

const PROJECT = "--tmp-unit-project--";
const FILE = "2026-01-01T00-00-00Z_unit.jsonl";
const CWD = "/tmp/unit-project";

function writeSession({ dirName = PROJECT, file = FILE, cwd = CWD, entries = [] } = {}) {
  const dir = path.join(ROOT, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const header = { type: "session", version: 3, id: "unit-1", timestamp: "2026-01-01T00:00:00.000Z", cwd };
  const lines = [header, ...entries].map((e) => JSON.stringify(e));
  fs.writeFileSync(path.join(dir, file), `${lines.join("\n")}\n`);
  return path.join(dir, file);
}

const userMessage = (text, id = `u${Math.random().toString(16).slice(2, 8)}`) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role: "user", content: [{ type: "text", text }] },
});

test("sessionsDir honours PI_CODING_AGENT_SESSION_DIR", () => {
  assert.equal(store.sessionsDir(), path.resolve(ROOT));
});

test("listSessions reports header cwd, title and cwdExists", () => {
  fs.mkdirSync(CWD, { recursive: true });
  writeSession({ entries: [{ type: "session_info", id: "s1", parentId: null, timestamp: "2026-01-01T00:00:00.500Z", name: "Unit session" }, userMessage("hello there")] });
  const [summary] = store.listSessions(PROJECT);
  assert.equal(summary.title, "Unit session", "session_info wins over the first prompt");
  assert.equal(summary.cwd, CWD);
  assert.equal(summary.cwdExists, true);
  assert.equal(summary.messageCount, 1);
});

test("cwdExists is false when the recorded folder vanished (R-10)", () => {
  const gone = path.join(ROOT, "no-such-project");
  writeSession({ dirName: "--tmp-unit-gone--", file: "gone.jsonl", cwd: gone, entries: [userMessage("orphan")] });
  const [summary] = store.listSessions("--tmp-unit-gone--");
  assert.equal(summary.cwdExists, false);
});

test("readWindow returns the tail, then pages backwards without overlap", () => {
  const entries = Array.from({ length: 12 }, (_, i) => userMessage(`line-${i}`, `m${i}`));
  // Own project dir: the fixture above must keep its own history intact.
  const winFile = writeSession({ dirName: "--tmp-unit-window--", file: "window.jsonl", entries });
  const win = store.readWindow(winFile, 5, null);
  assert.equal(win.entries.length, 5);
  assert.equal(win.entries.at(-1).id, "m11", "tail first");
  assert.equal(win.meta.total, 13, "12 messages + header");
  const older = store.readWindow(winFile, 5, win.entries[0].id);
  assert.ok(older.entries.length > 0);
  assert.ok(!older.entries.some((e) => e.id === win.entries[0].id), "no overlap at the seam");
});

test("forkSession copies bytes and leaves the original alone", () => {
  const src = path.join(ROOT, PROJECT, FILE);
  const before = fs.readFileSync(src);
  const { file } = store.forkSession(PROJECT, FILE);
  assert.notEqual(file, FILE);
  assert.ok(fs.readFileSync(path.join(ROOT, PROJECT, file)).equals(before));
  assert.ok(fs.readFileSync(src).equals(before));
});

test("readWindow stays incremental when a session grows (and totals follow)", () => {
  const dir = "--tmp-unit-incremental--";
  const file = writeSession({ dirName: dir, file: "grow.jsonl", entries: [userMessage("first", "g0")] });
  const a = store.readWindow(file, 10, null);
  const scans = store.sessionStoreStats.fullScans;
  const bytes = store.sessionStoreStats.incrementalBytes;
  assert.equal(a.entries.at(-1).id, "g0");
  assert.equal(a.meta.total, 2);

  const added = [
    userMessage("second", "g1"),
    { type: "message", id: "g2", parentId: "g1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { totalTokens: 42, cost: { total: 0.5 } } } },
  ];
  const raw = added.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(file, raw);

  const b = store.readWindow(file, 10, null);
  assert.equal(store.sessionStoreStats.fullScans, scans, "no full re-scan for an append");
  assert.equal(store.sessionStoreStats.incrementalBytes - bytes, raw.length, "only the appended bytes are read");
  assert.equal(b.entries.at(-1).id, "g2");
  assert.equal(b.meta.total, 4);
  assert.equal(b.meta.tokens, 42);
  assert.equal(b.meta.cost, 0.5);

  const [summary] = store.listSessions(dir);
  assert.equal(summary.entryCount, 4);
  assert.equal(summary.tokens, 42);
  assert.equal(summary.cost, 0.5);

  // An unchanged listing re-reads nothing.
  const before = store.sessionStoreStats.incrementalBytes;
  store.listSessions(dir);
  assert.equal(store.sessionStoreStats.incrementalBytes, before);
});

test("an unterminated trailing line is not counted until it is complete", () => {
  const dir = "--tmp-unit-partial--";
  const file = writeSession({ dirName: dir, file: "partial.jsonl", entries: [userMessage("one", "p0")] });
  assert.equal(store.readWindow(file, 10, null).meta.total, 2);
  const extra = JSON.stringify(userMessage("two", "p1"));
  fs.appendFileSync(file, extra); // no newline yet: a writer is mid-line
  assert.equal(store.readWindow(file, 10, null).meta.total, 2, "partial line ignored");
  fs.appendFileSync(file, "\n");
  assert.equal(store.readWindow(file, 10, null).meta.total, 3);
  assert.equal(store.readWindow(file, 10, null).entries.at(-1).id, "p1");
});

test("truncate/rewrite is detected and rebuilt, not served stale", () => {
  const dir = "--tmp-unit-rewrite--";
  const file = writeSession({ dirName: dir, file: "rewrite.jsonl", entries: Array.from({ length: 8 }, (_, i) => userMessage(`old-${i}`, `r${i}`)) });
  assert.equal(store.readWindow(file, 20, null).meta.total, 9);
  // Same inode, smaller: a truncate + rewrite (e.g. export/relocate tooling).
  writeSession({ dirName: dir, file: "rewrite.jsonl", entries: [userMessage("new text", "n0")] });
  const win = store.readWindow(file, 20, null);
  assert.equal(win.meta.total, 2);
  assert.deepEqual(win.entries.map((e) => e.id), ["unit-1", "n0"]);
  assert.equal(store.listSessions(dir)[0].title, "new text");
});

test("paging older than the offset ring still returns the right window", () => {
  const dir = "--tmp-unit-deep--";
  const total = 4200; // > OFFSET_RING (4096)
  const entries = Array.from({ length: total }, (_, i) => userMessage(`deep-${i}`, `d${i}`));
  const file = writeSession({ dirName: dir, file: "deep.jsonl", entries });
  const tail = store.readWindow(file, 5, null);
  assert.equal(tail.entries.at(-1).id, `d${total - 1}`);
  // The ring keeps the last 4096 lines (d104… on), so d100 is out of reach and
  // the streaming fallback has to find it.
  const older = store.readWindow(file, 5, "d100");
  assert.deepEqual(older.entries.map((e) => e.id), ["d95", "d96", "d97", "d98", "d99"]);
  assert.equal(store.windowInfo(file).total, total + 1);
});


test("relocateSession rewrites the cwd header only (R-10)", () => {
  const target = fs.mkdtempSync(path.join(ROOT, "relocated-"));
  const src = path.join(ROOT, PROJECT, FILE);
  const original = fs.readFileSync(src, "utf8");
  const out = store.relocateSession(PROJECT, FILE, target);
  const copied = fs.readFileSync(path.join(ROOT, out.dirName, out.file), "utf8");
  const [header] = copied.split("\n");
  assert.equal(JSON.parse(header).cwd, path.resolve(target));
  assert.equal(fs.readFileSync(src, "utf8"), original, "original file untouched");
  assert.equal(store.sessionCwd(path.join(ROOT, out.dirName, out.file)), path.resolve(target));
  // every non-header line survives verbatim
  assert.deepEqual(copied.split("\n").slice(1), original.split("\n").slice(1));
});

test("relocateSession refuses a target that does not exist", () => {
  assert.throws(() => store.relocateSession(PROJECT, FILE, path.join(ROOT, "definitely-missing")));
});

test("renameSession appends session_info and the list picks it up", () => {
  store.renameSession(PROJECT, FILE, "Renamed unit session");
  const [summary] = store.listSessions(PROJECT);
  assert.equal(summary.title, "Renamed unit session");
  assert.equal(summary.sessionName, "Renamed unit session");
});

test("searchSessions finds message text inside the store", () => {
  const hits = store.searchSessions("hello there");
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.filePath.startsWith(path.resolve(ROOT))), "never escapes the store");
});

test("searchSessions skips oversized files instead of re-reading them per query", () => {
  const token = ` capacitance-${Math.random().toString(16).slice(2, 10)}`;
  const big = path.join(ROOT, PROJECT, "2026-01-01T00-00-01Z_big.jsonl");
  const filler = `{"type":"message","id":"x","message":{"role":"user","content":"pad"}}\n`;
  const fd = fs.openSync(big, "w");
  fs.writeSync(fd, `{"type":"session","id":"b","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${CWD}"}\n`);
  fs.writeSync(fd, `{"type":"message","id":"hit","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"${token}"}}\n`);
  const pad = "x".repeat(1024 * 1024);
  while (fs.fstatSync(fd).size <= store.SEARCH_FILE_CAP) fs.writeSync(fd, filler.replace("pad", pad));
  fs.closeSync(fd);
  assert.ok(fs.statSync(big).size > store.SEARCH_FILE_CAP);
  const hits = store.searchSessions(token.trim());
  assert.ok(!hits.some((h) => h.file === "2026-01-01T00-00-01Z_big.jsonl"), "over-cap file skipped");
  fs.unlinkSync(big);
});

test("validateExportPath keeps exports inside the session store (S3)", () => {
  const inside = path.join(ROOT, PROJECT, "out.html");
  assert.equal(store.validateExportPath(inside), path.resolve(inside));
  assert.throws(() => store.validateExportPath("/etc/evil.html"), /session store/);
  assert.throws(() => store.validateExportPath(path.join(ROOT, "..", "escape.html")), /session store/);
  // Symlink creation needs a POSIX host (or Windows developer mode); the
  // prefix jail above still holds everywhere.
  if (process.platform !== "win32") {
    const link = path.join(ROOT, PROJECT, "sneaky");
    try {
      fs.symlinkSync(os.tmpdir(), link);
      assert.throws(() => store.validateExportPath(path.join(link, "out.html")), /session store/, "symlinked parent cannot redirect outside");
    } finally {
      try { fs.unlinkSync(link); } catch {}
    }
  }
});

test("resolveSessionPath jails paths to the sessions dir", () => {
  assert.throws(() => store.resolveSessionPath(PROJECT, "../../etc/passwd"));
  assert.throws(() => store.resolveSessionPath("../..", FILE));
  assert.ok(store.resolveSessionPath(PROJECT, FILE).startsWith(path.resolve(ROOT)));
});

test("deleteSession removes only files inside the store", () => {
  const { file } = store.forkSession(PROJECT, FILE);
  store.deleteSession(PROJECT, file);
  assert.ok(!fs.existsSync(path.join(ROOT, PROJECT, file)));
  assert.ok(fs.existsSync(path.join(ROOT, PROJECT, FILE)), "the original survives");
  assert.throws(() => store.deleteSession("../..", "anything.jsonl"));
});

test("findSessionByBasename locates a session across projects", () => {
  const found = store.findSessionByBasename(FILE);
  assert.equal(found?.dirName, PROJECT);
  assert.equal(store.findSessionByBasename("nope.jsonl"), null);
});

test("titleForSessionFile resolves real titles and hides stem placeholders", () => {
  // A prompt-less session keeps its filename as the placeholder title: callers
  // must see "no title" (the UI says "new process"), never the .jsonl stem.
  const bareDir = "--tmp-unit-bare--";
  const bare = writeSession({ dirName: bareDir, file: "2026-02-02T00-00-00Z_bare.jsonl", cwd: CWD });
  assert.equal(store.titleForSessionFile(bare), null, "stem placeholder is not a title");

  const named = writeSession({
    dirName: "--tmp-unit-named--",
    file: "2026-02-02T00-00-00Z_named.jsonl",
    cwd: CWD,
    entries: [{ type: "session_info", id: "s2", parentId: null, timestamp: "2026-01-01T00:00:00.500Z", name: "Named unit session" }],
  });
  assert.equal(store.titleForSessionFile(named), "Named unit session");

  const prompted = writeSession({
    dirName: "--tmp-unit-prompted--",
    file: "2026-02-02T00-00-00Z_prompted.jsonl",
    cwd: CWD,
    entries: [userMessage("please summarise the logs")],
  });
  assert.equal(store.titleForSessionFile(prompted), "please summarise the logs");

  assert.equal(store.titleForSessionFile(""), null);
  assert.equal(store.titleForSessionFile("/tmp/not-in-store.jsonl"), null);
  // A same-named file outside the store must not borrow an in-store title.
  const elsewhere = path.join(os.tmpdir(), "pihub-unit-elsewhere", path.basename(named));
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.copyFileSync(named, elsewhere);
  assert.equal(store.titleForSessionFile(elsewhere), null);
});
