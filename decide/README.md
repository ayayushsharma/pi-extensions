# pi-decide

Decision-tree analysis for Pi: forces exhaustive option analysis for open-ended problems (propose → evidence → score → prune/keep → verdict), resumable across sessions, compaction, and branches.

## Install

```bash
pi install ./decide
# or, once published:
# pi install npm:pi-decide
```

Dev iteration:

```bash
pi --extension ./decide/extensions/decide.ts
```

## Usage

```bash
/decide <problem>          # start a tree, e.g. /decide Choose a vector DB for Pi memory
/decide-list               # trees for this directory
/decide-status [treeId]    # progress + next step (works headless)
/decide-continue [treeId]  # resume an incomplete tree (re-triggers the agent)
/decide-tree [treeId]      # interactive TUI browser (picker → nodes → docs)
/decide-export <id> [path] # shareable markdown export (only explicit write into cwd)
```

The agent also gets a `decide` tool (`start`, `add-options`, `record-evidence`, `score`, `prune`, `verdict`, `status`, `list`) with guardrails: a verdict is refused while any option still lacks evidence.

## Storage

Central only, keyed by cwd — the project is never polluted during work:

```text
~/.pi/agent/decide/
├── index.json
└── projects/<slug>-<hash>/
    ├── index.json
    ├── <treeId>.json   # machine truth
    └── <treeId>.md     # human mirror
```

Branch-correct state rides in tool-result `details` (rebuilt from the session branch); durable progress log via `decide-step` session entries.

On `verdict`, one snapshot is auto-written to the tree's cwd:

```text
<slug>-decisions.md   # e.g. choose-vector-db-decisions.md
```

Set `DECIDE_NO_AUTO_WRITE=1` to disable the auto-snapshot (central only; share via `/decide-export`).

## Auto-nudge

A guarded `turn_end` handler keeps early-exiting (esp. smaller) models on the job. It requests one more turn **only** when all hold:

1. the turn completed normally and the runtime allows continuation,
2. a decide flow is in flight this session — armed by any `decide` tool call or by `/decide-continue` (otherwise zero behavior change),
3. the model stopped with a text-only message (turns that issued tool calls continue on their own),
4. the tree is still active on disk,
5. budget remains: max 3 nudges per unchanged tree state, max 12 per session. Any progress resets the per-state counter; a stuck tree gets a "final reminder" then silence.

Set `DECIDE_NO_NUDGE=1` to disable.

## Nested sub-decisions

Split a complex option into its own full tree: chat "create a sub-decision under o2 of <treeId>" (agent uses `start` with `parent: { treeId, optionId }`), or run `/decide-split <optionId> <problem>` on the active tree. Rules:

- One sub-decision per option; max depth 5; parent must be active.
- `status` shows `Sub-decisions:` with per-child progress; `list`, `/decide-tree`, and the markdown mirror mark children (`↳` / `→ <id> [status]`).
- `Next:` prioritizes open sub-decisions; `verdict` refuses while a sub-decision under a non-pruned option is active (pruning the option releases the block).
- A verdict snapshot includes each sub-decision's outcome.

## Reopening

Completed trees are frozen: evidence/scores/prune/add-options refuse with a pointer to `reopen` (re-running `verdict` stays allowed as an idempotent snapshot refresh). `reopen` flips the tree back to `active`, preserves the old verdict under `previousVerdicts` (shown struck-through in markdown), keeps everything else, and focuses the tree. Give a reason — via the tool's `text` or `/decide-reopen [treeId] [reason]` — so the next `Next:` step has context; the revised verdict overwrites the same snapshot file.

## TUI browser keys (`/decide-tree`)

`↑↓`/`jk` navigate · `enter` open tree / expand docs · `v` view doc contents (Shift+Enter where the terminal sends it; `v` again cycles multiple docs) · `backspace` back · `q` close. The viewer pages big files (up to 400 lines, 200 KiB cap, confined to the decision's cwd): `j`/`k` scroll, `space`/`b` or PgDn/PgUp page, `g`/`G` top/bottom, with a `lines X–Y of N` indicator.

## Notes

- Scope key is the exact cwd Pi runs in (monorepo subdirs are separate buckets by design; the repo root is recorded for display only).
- `/decide-continue` with no id resumes the most recent active tree.
- No `turn_end` auto-continuation in v1 by design (explicit resume, no loop risk).
- Never writes to stdout/stderr; diagnostics via `ctx.ui.notify`.
