// Unit tests for the mirror's drive-command vocabulary (ADR-014): the new
// status/history verbs and image-bearing prompts. The Mirror never dials in
// these tests — execute() is driven through a faked socket client.
import { test } from "node:test";
import assert from "node:assert/strict";

const { Mirror } = await import("../../extensions/lib/mirror/mirror.ts");

function harness({ ctx = {}, pi = {} } = {}) {
  const config: any = { sockPath: "/tmp/never.sock", advertPath: "/tmp/never.json" };
  const mirror: any = new Mirror(config, pi, () => ctx);
  const frames: any[] = [];
  // Capture replies: pushEvent drops them while disconnected, so pose as a
  // connected client and record what would go down the socket.
  mirror.client = { connected: true, send: (f: any) => frames.push(f) };
  const execute = (command: any) => {
    frames.length = 0;
    mirror.execute(command);
    return frames;
  };
  const responses = () => frames.filter((f) => f?.type === "event").map((f) => f.event);
  return { mirror, execute, responses };
}

const entriesCtx = () => ({
  isIdle: () => true,
  getContextUsage: () => ({ tokens: 42, contextWindow: 100, percent: 42 }),
  sessionManager: {
    getEntries: () => [{ id: "e1", type: "message", message: { role: "user", content: "hi" } }],
    getSessionFile: () => "/tmp/s.jsonl",
  },
});

test("get_messages returns history entries", () => {
  const { execute, responses } = harness({ ctx: entriesCtx() });
  execute({ type: "get_messages", id: "m1" });
  const r = responses().find((e) => e?.id === "m1");
  assert.equal(r?.success, true);
  assert.equal(r?.data?.entries?.length, 1);
});

test("get_messages without a context is an honest error", () => {
  const { execute, responses } = harness({ ctx: null });
  execute({ type: "get_messages", id: "m2" });
  const r = responses().find((e) => e?.id === "m2");
  assert.equal(r?.success, false);
});

test("get_session_stats counts roles like tau-web did", () => {
  const { execute, responses } = harness({ ctx: entriesCtx() });
  execute({ type: "get_session_stats", id: "s1" });
  const r = responses().find((e) => e?.id === "s1");
  assert.equal(r?.success, true);
  assert.equal(r?.data?.userMessages, 1);
  assert.equal(r?.data?.totalMessages, 1);
  assert.equal(r?.data?.tokens?.total, 42);
});

test("get_available_thinking_levels uses the runtime when present, else errors", () => {
  const withLevels = harness({ ctx: { session: { getAvailableThinkingLevels: () => ["low", "medium"] } } });
  withLevels.execute({ type: "get_available_thinking_levels", id: "t1" });
  const ok = withLevels.responses().find((e) => e?.id === "t1");
  assert.equal(ok?.success, true);
  assert.deepEqual(ok?.data?.levels, ["low", "medium"]);

  const without = harness({ ctx: entriesCtx() });
  without.execute({ type: "get_available_thinking_levels", id: "t2" });
  const err = without.responses().find((e) => e?.id === "t2");
  assert.equal(err?.success, false, "client falls back to its static list");
});

test("clear_queue is an honest error (queue stays in the TUI, nothing lost)", () => {
  const { execute, responses } = harness({ ctx: entriesCtx() });
  execute({ type: "clear_queue", id: "c1" });
  const r = responses().find((e) => e?.id === "c1");
  assert.equal(r?.success, false);
  assert.match(r?.error || "", /TUI/);
});

test("prompt carries validated images as content blocks", () => {
  const sent: any[] = [];
  const pi = { sendUserMessage: (c: any) => sent.push(c) };
  const { execute } = harness({ ctx: entriesCtx(), pi });
  execute({ type: "prompt", id: "p1", message: "look", images: [{ mimeType: "image/png", data: "aGVsbG8=" }] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0]?.type, "text");
  assert.equal(sent[0][1]?.type, "image");
  assert.equal(sent[0][1]?.mimeType, "image/png");
});

test("prompt without images still sends plain text", () => {
  const sent: any[] = [];
  const pi = { sendUserMessage: (c: any) => sent.push(c) };
  const { execute } = harness({ ctx: entriesCtx(), pi });
  execute({ type: "prompt", id: "p2", message: "plain" });
  assert.equal(sent[0], "plain");
});

async function driveConfirmReply(ctx: any, id: string) {
  const { Mirror: MirrorClass } = await import("../../extensions/lib/mirror/mirror.ts");
  const mirror: any = new MirrorClass({ sockPath: "/tmp/never.sock", advertPath: "/tmp/never.json" }, {}, () => ctx);
  const frames: any[] = [];
  mirror.client = { connected: true, send: (f: any) => frames.push(f) };
  mirror.onFrame({ type: "drive_confirm", id });
  for (let i = 0; i < 100 && !frames.some((f) => f?.id === id); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return frames.find((f) => f?.id === id);
}

test("drive_confirm asks the native TUI confirm and relays the answer", async () => {
  let asked = "";
  const r = await driveConfirmReply(
    { ui: { confirm: async (t: string) => { asked = t; return true; } } },
    "k1",
  );
  assert.ok(asked.length > 0, "TUI user asked on their own terminal");
  assert.equal(r?.type, "drive_confirm_reply");
  assert.equal(r?.confirmed, true);
});

test("drive_confirm denies without a UI to ask", async () => {
  const r = await driveConfirmReply({}, "k2");
  assert.equal(r?.type, "drive_confirm_reply");
  assert.equal(r?.confirmed, false, "fail-closed with no confirm surface");
});
