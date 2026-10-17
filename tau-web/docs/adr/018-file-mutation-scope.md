# ADR-018: File-API mutation surface — mkdir yes, delete never

Status: accepted (2026-10-16, dialogue).

## Context

The session picker browses directories and needed "New folder"; the
obvious follow-ups are rename and delete. This is a security boundary,
not a backlog item: the hub is reachable over the tunnel, and a
recursive `rm` behind it is one mis-tap away from lost work. The rule
had to be set explicitly rather than left implicit in the UI.

## Decision

The file APIs expose exactly **one** mutation:

- `POST /api/files/mkdir` — single level (the parent must exist),
  jailed under the realpath'd `$HOME`, 409 on an existing target, no
  recursive flag.

There is no delete, rename, write, or recursive variant — not hidden
behind auth, not admin-gated, absent from the server. Session
transcript deletion is a different, pre-existing surface and stays
where it was; this ADR is about the file tree the picker browses.

## Alternatives rejected

- Recursive delete behind type-to-confirm: still exposes recursive rm
  to the tunnel, and confirmation fatigue makes it weaker than it
  looks.
- Empty-directory-only delete: any deletion endpoint is the footgun;
  "only empty" is one race away from being recursive.
- Nested `a/b/c` creation: deferred until a real need; single level
  keeps the jail check obvious.

## Consequences

- Removing a directory requires the TUI or a shell. The picker knows
  this; it is a deliberate missing feature, not a to-do.
- Any future mutation (delete/rename/write) needs a new decision and
  must bring jail tests of its own (X1 covers the current mkdir jail).
- H13 covers mkdir creation and HOME-escape refusal.
