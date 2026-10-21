// Unit tests for the WS backpressure contract (H5): lastSeq tracks DELIVERED
// frames only, so a drop is replayed from the ring instead of skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

const { WsHub } = await import("../../extensions/lib/hub/ws.ts");

const MAX_BUFFERED = 1024 * 1024;

function hubWithRunner(frames: any[]) {
  const runner = {
    id: "r1",
    lastSeq: () => frames.at(-1)?.seq ?? 0,
    replayFrom: (seq: number) => frames.filter((f) => f.seq > seq),
  };
  const registry = {
    onFrame() {},
    list: () => [],
    get: () => runner,
  };
  const hub = new WsHub({
    auth: { enabled: false },
    registry,
    dialogs: { registerHeadless() {} },
    version: "test",
    resolveSessionPath: () => "/x",
    defaultCwd: "/tmp",
  } as any);
  const sent: string[] = [];
  const sock = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(d: any) {
      sent.push(String(d));
    },
    on() {},
    close() {},
  };
  (hub as any).onConnection(sock as any);
  const client = [...(hub as any).clients][0];
  client.boundId = "r1";
  sent.length = 0; // drop the hello + runners frames
  return { hub, client, sock, sent };
}

const frame = (seq: number, type = "note") => ({ runnerId: "r1", seq, event: { type, n: seq } });

test("a backpressured drop does not advance lastSeq — the gap replays", () => {
  const frames = [frame(1), frame(2)];
  const { hub, client, sock, sent } = hubWithRunner(frames);
  sock.bufferedAmount = MAX_BUFFERED + 1; // slow consumer: frame 1 drops
  (hub as any).fanOut(frames[0]);
  assert.equal(client.lastSeq, 0, "dropped frame leaves lastSeq behind");
  assert.equal(sent.length, 0, "nothing reached the socket");
  sock.bufferedAmount = 0; // drain; frame 2 must pull the gap behind it
  (hub as any).fanOut(frames[1]);
  const got = sent.map((s) => JSON.parse(s));
  assert.deepEqual(
    got.map((g: any) => g.seq),
    [1, 2],
    "missed frame replayed from the ring, then the current one",
  );
  assert.equal(client.lastSeq, 2);
});

test("a healthy socket advances lastSeq exactly once per frame", () => {
  const frames = [frame(1), frame(2), frame(3)];
  const { hub, client, sent } = hubWithRunner(frames);
  for (const f of frames) (hub as any).fanOut(f);
  assert.equal(client.lastSeq, 3);
  assert.deepEqual(sent.map((s) => JSON.parse(s).seq), [1, 2, 3], "no replay without a gap");
});

test("an empty delta flushes the pending batch instead of skipping it (H9)", () => {
  const d1 = { runnerId: "r1", seq: 1, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } } };
  const d2 = { runnerId: "r1", seq: 2, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } } };
  const empty = { runnerId: "r1", seq: 3, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } } };
  // The ring only ever holds past frames: push as they fan out, or the mock
  // replays frames the real ring could not contain yet and double-buffers.
  const frames: any[] = [];
  const { hub, client, sent } = hubWithRunner(frames);
  frames.push(d1);
  (hub as any).fanOut(d1);
  frames.push(d2);
  (hub as any).fanOut(d2);
  frames.push(empty);
  (hub as any).fanOut(empty);
  const bodies = sent.map((s) => JSON.parse(s));
  const batch = bodies.find((b: any) => b.event?.assistantMessageEvent?.delta === "hello");
  assert.ok(batch, "pending batch delivered instead of skipped");
  assert.equal(client.lastSeq, 3, "empty frame advances past the flushed batch");
});

test("a dropped coalesced flush replays its deltas on the next frame", () => {
  const d1 = { runnerId: "r1", seq: 1, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } } };
  const d2 = { runnerId: "r1", seq: 2, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } } };
  const done = { runnerId: "r1", seq: 3, event: { type: "other" } };
  const { hub, client, sock, sent } = hubWithRunner([d1, d2, done]);
  (hub as any).fanOut(d1);
  (hub as any).fanOut(d2);
  assert.equal(client.lastSeq, 0, "buffered deltas are not deliveries yet");
  sock.bufferedAmount = MAX_BUFFERED + 1; // the coalesced flush drops
  (hub as any).fanOut(done);
  assert.equal(client.lastSeq, 0, "dropped flush leaves lastSeq behind");
  sock.bufferedAmount = 0;
  const more = { runnerId: "r1", seq: 4, event: { type: "other" } };
  (hub as any).fanOut(more);
  const bodies = sent.map((s) => JSON.parse(s));
  assert.ok(bodies.some((b: any) => b.event?.assistantMessageEvent?.delta === "hello"), "deltas replayed and re-coalesced");
  assert.equal(client.lastSeq, 4);
});
