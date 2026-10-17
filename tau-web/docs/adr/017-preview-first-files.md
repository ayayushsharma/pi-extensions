# ADR-017: Files attach preview-first; the explorer never feeds the prompt

Status: accepted (2026-10-16, dialogue).

## Context

The file browser used to insert a file's path into the composer on
click or drag — blind context: the agent could receive a file the user
had never seen, and the tree made that the default action of a row.
ADR-009 established preview-then-attach for live TUIs; files deserve
the same rule, and it is a policy about context, not a UI preference.

## Decision

Clicking a file opens the read-only viewer; the only way a file reaches
the prompt is the viewer's **Add to prompt**, which feeds the
pre-existing `pendingFilePaths` chip pipeline (image files render a
thumbnail from `/api/file/preview`). `insertPath`, drag-and-drop
(`draggable`, drop targets) and their listeners are removed. The
viewer's content is jailed server-side to the viewed session's cwd: the
file path is client-supplied, but the jail root is resolved from the
session file, never from the client.

## Alternatives rejected

- Keep drag-drop and click-insert with a preview tooltip: the file
  still enters context unseen.
- A confirm dialog per insertion: friction without showing the content
  it asks about.
- Paste the path manually: no discovery, and the tree stops being a
  browser.

## Consequences

- Tree → content → attach is two deliberate steps. There is no
  single-gesture insert to trigger by accident (or by a stray drag).
- The explorer becomes read-only discovery; the file-mutation surface
  is ADR-018's (one mkdir, no delete).
- Viewer and attach are the same on desktop and phone (tap opens the
  viewer). H12 covers the jail's inside/outside/unknown/binary/256 KiB
  cases.
