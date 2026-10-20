// Unit tests for drive consent (PI_HUB_DRIVE_CONFIRM): the relay asks the
// TUI and fails closed on deny/timeout/disconnect. Fake socket server only.
import { test } from "node:test";
import assert from "node:assert/strict";

const { Relay } = await import("../../extensions/lib/hub/relay.ts");

function harness() {
  const sent = [];
  const handlers = new Map();
  const server = {
    on: (ev, cb) => handlers.set(ev, cb),
    sendToPid: (pid, frame) => {
      sent.push({ pid, frame });
      return pid !== -1;
    },
  };
  const registry = { addLive: () => ({}), getByPid: () => undefined, removeLive: () => {} };
  const relay = new Relay({ server, registry, dialogs: {} });
  relay.start();
  const frame = handlers.get("frame");
  return { relay, sent, frame, reply: () => {} };
}

test("drive_confirm_reply true resolves true", async () => {
  const { relay, sent, frame, reply } = harness();
  const p = relay.requestDriveConfirm(123, 1000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].frame.type, "drive_confirm");
  const id = sent[0].frame.id;
  frame({ type: "drive_confirm_reply", id, confirmed: true }, reply);
  assert.equal(await p, true);
});

test("deny resolves false and unrelated ids are ignored", async () => {
  const { relay, sent, frame, reply } = harness();
  const p = relay.requestDriveConfirm(123, 1000);
  const id = sent[0].frame.id;
  frame({ type: "drive_confirm_reply", id: "other", confirmed: true }, reply);
  frame({ type: "drive_confirm_reply", id, confirmed: false }, reply);
  assert.equal(await p, false);
});

test("no answer resolves false after the timeout", async () => {
  const { relay } = harness();
  assert.equal(await relay.requestDriveConfirm(123, 30), false);
  assert.equal(relay.pendingConfirmCount(), 0, "waiter released");
});

test("disconnected pid resolves false immediately", async () => {
  const { relay, sent } = harness();
  assert.equal(await relay.requestDriveConfirm(-1, 1000), false);
  assert.equal(sent.length, 1, "request still sent before the failure surfaced");
  assert.equal(relay.pendingConfirmCount(), 0, "waiter released");
});
