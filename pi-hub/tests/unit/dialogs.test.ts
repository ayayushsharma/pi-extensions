// Unit tests for the dialog broker: scoped delivery, owner cancellation,
// timeout and a hard cap. No websocket/child needed.
import { test } from "node:test";
import assert from "node:assert/strict";

const { DialogBroker } = await import("../../extensions/lib/hub/dialogs.ts");

function harness(opts = {}) {
  const frames = [];
  const mirror = [];
  const commands = [];
  const registry = {
    get: (id) => ({ command: (cmd) => commands.push({ id, cmd }) }),
  };
  const broker = new DialogBroker(
    {
      sendToRunner: (runnerId, frame, sendOpts) => frames.push({ runnerId, frame, opts: sendOpts }),
      registry,
      sendMirror: (pid, frame) => {
        mirror.push({ pid, frame });
        return true;
      },
    },
    opts,
  );
  return { broker, frames, mirror, commands };
}

const req = (id) => ({ type: "extension_ui_request", id, method: "confirm", title: "?", message: "?" });

test("headless dialogs go to the runner's viewers; mirror dialogs are driver-only", () => {
  const { broker, frames } = harness();
  broker.registerHeadless("hr1", req("a"));
  broker.registerMirror(42, "lr1", req("b"));
  assert.deepEqual(frames.map((f) => [f.runnerId, f.frame.request.id, f.opts]), [
    ["hr1", "a", { driverOnly: false }],
    ["lr1", "b", { driverOnly: true }],
  ]);
});

test("resolve answers the owner once and closes other viewers", () => {
  const { broker, frames, commands, mirror } = harness();
  broker.registerHeadless("hr1", req("a"));
  assert.equal(broker.resolve("a", { confirmed: true }), true);
  assert.equal(broker.resolve("a", { confirmed: false }), false, "second answer is ignored");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cmd.confirmed, true);
  assert.ok(frames.some((f) => f.frame.type === "dialog_cancelled" && f.frame.id === "a"));
  assert.equal(broker.pendingCount(), 0);
});

test("a mirror answer is relayed to its pid without broker types", () => {
  const { broker, mirror } = harness();
  broker.registerMirror(42, "lr1", req("b"));
  broker.resolve("b", { cancelled: true });
  assert.deepEqual(mirror[0].frame.response, { cancelled: true });
  assert.equal(mirror[0].frame.id, "b");
});

test("timeout cancels both the owner and the scoped modal", async () => {
  const { broker, frames, commands } = harness({ timeoutMs: 10 });
  broker.registerHeadless("hr1", req("slow"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(broker.pendingCount(), 0);
  assert.equal(commands[0].cmd.cancelled, true);
  assert.ok(frames.some((f) => f.frame.type === "dialog_cancelled" && f.frame.reason === "timed out"));
});

test("releaseRunner cancels only that runner's requests", () => {
  const { broker, commands } = harness();
  broker.registerHeadless("hr1", req("a"));
  broker.registerHeadless("hr2", req("b"));
  broker.releaseRunner("hr1");
  assert.equal(broker.pendingCount(), 1);
  assert.deepEqual(commands.map((c) => c.id), ["hr1"]);
  assert.equal(commands[0].cmd.cancelled, true);
});

test("pending requests are capped; the oldest is cancelled", () => {
  const { broker, commands, frames } = harness({ maxPending: 2 });
  broker.registerHeadless("hr1", req("a"));
  broker.registerHeadless("hr1", req("b"));
  broker.registerHeadless("hr1", req("c"));
  assert.equal(broker.pendingCount(), 2);
  assert.deepEqual(commands.map((c) => c.cmd.id), ["a"]);
  const cancelled = frames.filter((f) => f.frame.type === "dialog_cancelled").map((f) => f.frame.id);
  assert.deepEqual(cancelled, ["a"]);
  broker.resolve("b", { confirmed: true });
  broker.resolve("c", { confirmed: true });
});

test("answers are scoped to the bound runner; preview cannot answer a live dialog", () => {
  const { broker, commands } = harness();
  broker.registerHeadless("hr1", req("a"));
  broker.registerMirror(42, "lr1", req("b"));
  assert.equal(broker.resolve("a", { confirmed: true }, { runnerId: "hr2", isDriver: () => false }), false);
  assert.equal(broker.pendingCount(), 2, "foreign answer did not consume the request");
  assert.equal(broker.resolve("a", { confirmed: true }, { runnerId: "hr1", isDriver: () => false }), true);
  assert.equal(broker.resolve("b", { confirmed: true }, { runnerId: "lr1", isDriver: () => false }), false, "preview");
  assert.equal(broker.pendingCount(), 1);
  assert.equal(broker.resolve("b", { confirmed: true }, { runnerId: "lr1", isDriver: () => true }), true, "driver");
  assert.equal(commands[0].cmd.confirmed, true);
});
