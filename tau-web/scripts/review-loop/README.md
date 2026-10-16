# Review-fix loop (coder ↔ reviewer)

Deterministic orchestration for fixing the findings in
`docs/code-review.md` with two separate `pi` agents per iteration:

| Role | Model | Thinking | Context cap |
|---|---|---|---|
| coder | `opencode-go/muse-spark-1.3-contributor` | `xhigh` | 256k (`--context-size 262144`) |
| reviewer | `opencode-go/deepseek-v4.1-flash` | `max` | 256k (same flag) |

Each agent is a full `pi --print` run in this package (`--no-session`,
`--no-mcp`, `--no-extensions` + only `ctx-limit`, project `AGENTS.md`
trusted). The two talk only through files:

```text
docs/review-loop/
  coder-comments<NN>.md      # coder: what changed, evidence, risks
  reviewer-comments<NN>.md   # reviewer: VERDICT + evidence + issues
  logs/                      # ignored: full stdout/stderr per run
  prompts/                   # ignored: the exact prompt sent per run
  state.json                 # ignored: resume state + verdicts
```

`<NN>` is the zero-padded task number (`T1` → `01`). The reviewer's
last line must be one of:

```text
VERDICT: PASS
VERDICT: PASS-WITH-NITS
VERDICT: FAIL
```

A FAIL gets one more coder round (default `--rounds 2`) with the
reviewer comments attached; after that the task is recorded as failed
and the loop moves on (`--stop-on-fail` to abort instead).

## Tasks

`tasks.json` is the ordered work list (T1…T13) generated from the review:
XSS + markdown crash, headless-child hardening, session view state,
reconnect wipe, hub-sock/duplicate cleanup, realpath jails, request-body
caps, security headers, auth lifecycle, leaks/backpressure, session
caching, windowed transfer + coalescing, mobile banner. Every task
carries its requirements, acceptance criteria, `ux` note and tests.

## Run

```bash
cd tau-web

# list tasks
python3 scripts/review-loop/fix_loop.py --list

# inspect generated prompt without calling a model
python3 scripts/review-loop/fix_loop.py --only T1 --dry-run

# one task, commits on pass
python3 scripts/review-loop/fix_loop.py --only T1 --commit --branch code-review-fixes

# everything (resumes: passed tasks are skipped)
python3 scripts/review-loop/fix_loop.py --commit --branch code-review-fixes

# redo a task / force a different ordering
python3 scripts/review-loop/fix_loop.py --only T4 --force
python3 scripts/review-loop/fix_loop.py --from T6 --skip T8
```

Useful flags: `--rounds N`, `--timeout-coder`, `--timeout-reviewer`,
`--ctx`, `--coder-model`, `--coder-thinking`, `--reviewer-model`,
`--reviewer-thinking`, `--out-dir`, `--pi`.

## Commit / branch behaviour

With `--commit`, the loop creates/checks out `--branch` (default: uses
the current branch), commits any pre-existing dirty tree as
`review-loop: baseline`, then commits each passing task as
`tau-web: fix <findings> — <title> (review-loop <id>)`. Failed tasks are
left uncommitted so you can inspect or discard them. Without `--commit`
everything stays in the working tree.

## UX verification

For tasks that change the UI, the reviewer prompt tells it to run
`scripts/review-loop/deep_ui.py` when a Playwright python is available
(the uv tool install works: `~/.local/share/uv/tools/playwright/bin/python`).
That script boots a real hub on a random port, walks login → new session
→ real model round-trip → reload → settings → palette → file viewer →
live preview → mobile 390px, fails on any page error, and writes a JSON
report plus screenshots to `TAU_REVIEW_OUT` (default `/tmp/tau-review`).

## Notes

- Logs are gitignored; `state.json` is gitignored. The comments files are
  committed, so each iteration's conversation is in git history.
- The loop never edits other packages and never commits to `main`.
- Long runs: start it under `nohup` and tail
  `docs/review-loop/logs/console-*.log`; the state file makes a restart
  resume cleanly.
