/**
 * sandbox — every pi process a test starts runs inside this directory tree.
 *
 * Why: pi resolves its agent dir from $PI_CODING_AGENT_DIR (settings, auth,
 * packages, logs) and its session store from $PI_CODING_AGENT_SESSION_DIR.
 * A test that forgets either one writes into the developer's real store —
 * that is how "test sessions" end up in the product UI. Nothing here ever
 * touches ~/.pi/agent, and `assertRealStoreUntouched()` proves it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REAL_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
export const REAL_SESSIONS_DIR = path.join(REAL_AGENT_DIR, "sessions");

/** Settings + models.json that point pi at the in-process fake LLM. */
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function writeAgentConfig(agentDir, llmUrl) {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          fake: {
            baseUrl: `${llmUrl}/v1`,
            api: "openai-completions",
            apiKey: "fake-key",
            // A fixed catalog so model/thinking tests never depend on the
            // developer's real providers: one plain model, one that offers
            // every thinking level, one that offers none of the extremes.
            models: [
              { id: "fake-haiku", name: "Fake Haiku", reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, cost: COST, contextWindow: 200000, maxTokens: 8192, input: ["text"] },
              { id: "fake-spark", name: "Fake Spark", reasoning: true, thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }, cost: COST, contextWindow: 200000, maxTokens: 8192, input: ["text"] },
              { id: "fake-plain", name: "Fake Plain", reasoning: false, cost: COST, contextWindow: 128000, maxTokens: 4096, input: ["text"] },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", defaultThinkingLevel: "off", hideThinkingBlock: true }, null, 2),
  );
}

let current = null;

/**
 * One sandbox per test process. `llmUrl` is required for prompts to work:
 * without it pi would try a real provider (and, with no auth in the sandbox,
 * at least fail fast instead of spending money).
 */
export function sandbox({ llmUrl } = {}) {
  const want = llmUrl ?? process.env.PI_HUB_TEST_LLM_URL ?? "";
  if (current) {
    if (want && current.llmUrl !== want) {
      writeAgentConfig(current.agentDir, want);
      current.llmUrl = want;
    }
    return current;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-sbx-"));
  const agentDir = path.join(root, "agent");
  const sessionsDir = path.join(root, "sessions");
  const cwd = path.join(root, "cwd");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  writeAgentConfig(agentDir, want || "http://127.0.0.1:9");
  current = {
    root,
    agentDir,
    sessionsDir,
    cwd,
    llmUrl: want,
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
  return current;
}

/** path → "mtime:size" for every file under dir (missing dir = empty). */
export function snapshotTree(dir) {
  const out = new Map();
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out.set(p, "dir");
        walk(p);
      } else {
        try {
          const st = fs.statSync(p);
          out.set(p, `${st.mtimeMs}:${st.size}`);
        } catch {}
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Fail loudly when a test wrote into the developer's real agent dir.
 * Returns a human-readable diff ("" when clean).
 */
export function diffRealStore(before) {
  const after = snapshotTree(REAL_SESSIONS_DIR);
  const added = [...after.keys()].filter((k) => !before.has(k) && after.get(k) !== "dir");
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  if (!added.length && !changed.length) return "";
  return [
    added.length ? `new files: ${added.slice(0, 5).map((p) => path.relative(REAL_SESSIONS_DIR, p)).join(", ")}${added.length > 5 ? ` (+${added.length - 5})` : ""}` : "",
    changed.length ? `modified: ${changed.slice(0, 5).map((p) => path.relative(REAL_SESSIONS_DIR, p)).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
