// Unit tests for the headless child env (S2 + topology): secrets never reach
// the child, and topology knobs cannot turn a child into a nested hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildHeadlessChildEnv, assertValidCwd } = await import("../../extensions/lib/runners/headless.ts");

test("child env scrubs secrets but keeps the rest", () => {
  process.env.PI_HUB_USER = "u";
  process.env.PI_HUB_PASS = "p";
  process.env.PI_HUB_AUTH_TOKEN_TTL_MS = "1";
  process.env.TAU_USER = "t";
  process.env.PI_HUB_DEBUG = "1";
  try {
    const env = buildHeadlessChildEnv({ EXTRA_KEEP: "yes" });
    assert.equal(env.PI_HUB_USER, undefined);
    assert.equal(env.PI_HUB_PASS, undefined);
    assert.equal(env.PI_HUB_AUTH_TOKEN_TTL_MS, undefined);
    assert.equal(env.TAU_USER, undefined);
    assert.equal(env.EXTRA_KEEP, "yes");
    assert.equal(env.PI_HUB_DEBUG, "1", "non-auth vars pass through");
    assert.equal(env.PI_HUB_DISABLED, "1");
    assert.equal(env.TAU_DISABLED, "1");
  } finally {
    delete process.env.PI_HUB_USER;
    delete process.env.PI_HUB_PASS;
    delete process.env.PI_HUB_AUTH_TOKEN_TTL_MS;
    delete process.env.TAU_USER;
    delete process.env.PI_HUB_DEBUG;
  }
});

test("child env scrubs topology so no nested hub can resolve", () => {
  process.env.PI_HUB_ROLE = "hub";
  process.env.PI_HUB_FORCE_ROLE = "hub";
  process.env.PI_HUB_SOCK = "/tmp/parent.sock";
  process.env.PI_HUB_DIR = "/tmp/parent";
  process.env.PI_HUB_ADVERT_FILE = "/tmp/parent.json";
  process.env.PI_HUB_PORT = "8292";
  process.env.PI_HUB_HOST = "127.0.0.1";
  process.env.TAU_ROLE = "hub";
  try {
    const env = buildHeadlessChildEnv();
    for (const k of [
      "PI_HUB_ROLE",
      "PI_HUB_FORCE_ROLE",
      "PI_HUB_SOCK",
      "PI_HUB_DIR",
      "PI_HUB_ADVERT_FILE",
      "PI_HUB_PORT",
      "PI_HUB_HOST",
      "TAU_ROLE",
    ]) {
      assert.equal(env[k], undefined, `${k} scrubbed`);
    }
  } finally {
    delete process.env.PI_HUB_ROLE;
    delete process.env.PI_HUB_FORCE_ROLE;
    delete process.env.PI_HUB_SOCK;
    delete process.env.PI_HUB_DIR;
    delete process.env.PI_HUB_ADVERT_FILE;
    delete process.env.PI_HUB_PORT;
    delete process.env.PI_HUB_HOST;
    delete process.env.TAU_ROLE;
  }
});

test("assertValidCwd rejects missing paths and files", () => {
  assert.throws(() => assertValidCwd(path.join(os.tmpdir(), "pihub-no-such-dir")), /invalid cwd/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pihub-unit-")), "f");
  fs.writeFileSync(file, "x");
  assert.throws(() => assertValidCwd(file), /not a directory/);
  assert.doesNotThrow(() => assertValidCwd(os.tmpdir()));
});
