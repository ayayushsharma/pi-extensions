# ADR-016: Fork by transcript copy

Status: accepted (2026-10-16, dialogue).

## Context

The session picker offers "Fork as new" so an older (often starred)
session can be continued as a separate conversation. Two shapes were
possible: pi's RPC `fork`, or copying the transcript on disk.

The RPC fork is an interactive-TUI primitive: it forks the currently
loaded session at an entry id and returns selected text from it. The
hub's children are one-file-per-backend, and a picker fork must work
for *any* on-disk session, usually with no live backend at all. Using
it would need a new spawn/identity protocol for no user-visible gain.

## Decision

`POST /api/sessions/fork {dirName, file}` copies the transcript
byte-for-byte to a fresh pi-style name (`<timestamp>_<uuid>.jsonl`) in
the same project directory. The client then binds the copy through the
ordinary resume path (ADR-015), so there is no new backend protocol
and no new spawn path to get wrong. Traversal-guarded like every
session-store route.

## Alternatives rejected

- RPC fork (above): only forks the live child's currently loaded
  session, and returns text rather than a bindable file.
- New session + transcript-as-prompt: lossy, and blows the context
  window with history the copy keeps for free.
- A real branch/rollback protocol: bigger design. This ADR does not
  preclude a future branch visualisation (ROADMAP); it just does not
  invent one to serve a picker button.

## Consequences

- The copy keeps the original session header id and every trailing
  entry; it is **not** a pi branch — no return-to-fork-point, no shared
  future. The fresh file **name** is the new identity (that is what
  `#session=` keys and session lists use).
- A fork is exactly as safe (and as concurrent) as resuming any file.
- H13 covers fork naming, byte-identity, and traversal refusal.
