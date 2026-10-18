// Unit tests for the pure wire helpers (no hub, no child, no browser).
// Run: npm run test:unit   (Node's native type stripping imports the .ts lib)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidMessageImage,
  normalizePiEvent,
  sessionKey,
  streamDelta,
  isRpcCommand,
  RPC_COMMANDS,
  randId,
} from "../../extensions/lib/protocol.ts";

test("isValidMessageImage accepts a bounded, well-formed image", () => {
  assert.equal(isValidMessageImage({ mimeType: "image/png", data: "aGVsbG8=" }), true);
  assert.equal(isValidMessageImage({ mimeType: "image/webp", data: "AAA=" }), true);
});

test("isValidMessageImage rejects unsafe payloads", () => {
  assert.equal(isValidMessageImage(null), false);
  assert.equal(isValidMessageImage({ mimeType: "image/svg+xml", data: "aGk=" }), false, "svg is not an allowed mime");
  assert.equal(isValidMessageImage({ mimeType: "image/png", data: "" }), false, "empty data");
  assert.equal(isValidMessageImage({ mimeType: "image/png", data: "not base64!" }), false, "non-base64 charset");
  assert.equal(isValidMessageImage({ mimeType: "image/png", data: "a".repeat(8 * 1024 * 1024 + 4) }), false, "oversized");
});

test("normalizePiEvent folds compaction events into the UI pair", () => {
  assert.deepEqual(normalizePiEvent("session_before_compact", { reason: "threshold" }), {
    type: "compaction_start",
    reason: "threshold",
    willRetry: undefined,
  });
  const end = normalizePiEvent("session_compact", { compactionEntry: { summary: "S", tokensBefore: 10 } });
  assert.equal(end.type, "compaction_end");
  assert.equal(end.summary, "S");
  assert.equal(end.tokensBefore, 10);
  const failed = normalizePiEvent("session_compact_failed", { errorMessage: "nope", aborted: false });
  assert.equal(failed.type, "compaction_end");
  assert.equal(failed.errorMessage, "nope");
  assert.deepEqual(normalizePiEvent("agent_start", { a: 1 }), { type: "agent_start", a: 1 }, "other events pass through");
});

test("streamDelta extracts only text/thinking deltas", () => {
  const frame = (inner) => ({ runnerId: "r", seq: 1, event: { type: "message_update", assistantMessageEvent: inner } });
  assert.deepEqual(streamDelta(frame({ type: "text_delta", delta: "hi" })), { kind: "text", delta: "hi" });
  assert.deepEqual(streamDelta(frame({ type: "thinking_delta", delta: "hmm" })), { kind: "thinking", delta: "hmm" });
  assert.equal(streamDelta(frame({ type: "tool_delta", delta: "x" })), null);
  assert.equal(streamDelta({ event: { type: "agent_start" } }), null);
  assert.equal(streamDelta(null), null);
});

test("sessionKey and randId stay filesystem-free and unique", () => {
  assert.equal(sessionKey("/a/b/sess.jsonl"), "sess.jsonl");
  assert.equal(sessionKey("C:\\Users\\x\\sess.jsonl"), "sess.jsonl");
  assert.equal(sessionKey(null), "scratch");
  const a = randId("hr");
  const b = randId("hr");
  assert.match(a, /^hr-/);
  assert.notEqual(a, b);
});

test("isRpcCommand gates the browser command vocabulary", () => {
  assert.equal(isRpcCommand({ type: "prompt" }), true);
  assert.equal(isRpcCommand({ type: "get_available_thinking_levels" }), true);
  assert.equal(isRpcCommand({ type: "rm -rf" }), false);
  assert.equal(isRpcCommand({ type: 42 }), false);
  assert.equal(isRpcCommand(null), false);
  for (const forbidden of ["shutdown", "exec", "eval"]) assert.equal(RPC_COMMANDS.has(forbidden), false);
});
