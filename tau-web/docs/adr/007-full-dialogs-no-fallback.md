# ADR-007 — Full web dialogs, failures always surfaced, no fallbacks

Status: accepted (2026-10-09, dialogue: "no MVPs, need web dialogues", "no fallbacks")

## Context
Pi `extension_ui_request` can pause a run: `select`, `confirm`, `input`, `editor`, plus fire-and-forget `notify`. TUI renders native dialogs; current web UI only renders `notify`, so runs hang silently. User requires full features, no MVP cut, no `ttyd` fallback door; UI must always report failure.

## Decision
Build full web dialogs in v1 (`public/dialogs.js` extended): modal for `select` (list + keyboard), `confirm` (explicit buttons), `input` (text + submit/cancel), `editor` (textarea, large). Every dialog has timeout-free wait state, cancel → `extension_ui_response` with cancel flag, abort-run button, and error surfacing (no silent hang, no orphan spinner). `notify` renders as system entry with error/warning prefix (as pi-web does today).

## Alternatives rejected
"Needs TUI" banner placeholder; `ttyd`+`tmux` fallback (not wired).

## Consequences
- Correlate by request `id`; dialog queue one-at-a-time per session, matching Pi semantics.
- P2 scope grows (dialogs are P2, not stretch); harness must cover all five methods.
