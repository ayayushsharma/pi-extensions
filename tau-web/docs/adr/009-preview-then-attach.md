# ADR-009: Preview-then-attach for live TUI sessions

## Status

Accepted (2026-10-09).

## Context

Selecting a live session used to attach immediately. Two problems:

1. **Blind attach.** One tap on a green Live row silently wired the uplink and
   started proxying prompts into someone's terminal. The user had no chance to
   see which session, when it was last active, or back out.
2. **Legacy WS re-point.** The old `switchSession` branch found a live instance
   owning the selected session and re-pointed the browser WebSocket directly at
   that TUI's port (`ws://host:<tui-port>/ws`), bypassing the unified server, its
   auth, and the uplink proxy. Sessions that were live sometimes showed a red
   "disconnected" dot because the raw connection was rejected.

## Decision

Attaching is **two-phase and explicit** — preview first, drive on confirm:

1. **Attach** (Live row or sidebar) loads that session's history read-only and
   shows a banner: `Previewing live session on :12045 · last active 3m ago`
   with **Attach & Drive** and **Cancel**. Input is disabled with
   `Previewing live session — attach to drive`.
2. **Attach & Drive** sends `uplink_attach`; on ack the banner flips to
   `Live · driving :12045` + **Detach** and the input unlocks. The banner notes
   the TUI is also attached so concurrent typing is an accepted (warn-only) risk.
3. **Failure** keeps the banner in an error state (Retry + Continue headless),
   never a silent no-op.
4. **Detach** freezes the view on that session (input read-only,
   `Detached — view is frozen`), with **Attach again** to resume; navigating to
   another session dismisses it.
5. The browser WebSocket **never** re-points at another instance. Driving a live
   TUI always goes through the uplink proxy, so one connection keeps the unified
   envelope, epoch guards, dialogs, and auth. The legacy branch is deleted.

Preview is a static snapshot of the history (no file tailing); the live stream
starts on attach.

## Consequences

- One extra explicit step, but no accidental hijacking of a terminal session.
- Attach state (`uplinkActive`, `uplinkPreview`, `uplinkLastDetached`) has one
  banner plus one button per affordance in both the Live section and the sidebar;
  all views reflect the same state (ADR-008).
- After detach, prompt routing stays on the bound headless backend: the frozen
  view is never written to by a stray prompt.
- `switchSession` gains an `opts.preview` flag that suppresses `bindHeadless` so
  previewing cannot move a running backend.
- Server-side: an initial upstream `mirror_sync` (pushed on connect) suppresses
  the explicit `mirror_sync_request`, avoiding a double history re-render.
