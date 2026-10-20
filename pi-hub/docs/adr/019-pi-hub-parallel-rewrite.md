# ADR-019 — pi-hub: parallel rewrite around a Runner registry, Playwright-gated

Status: **proposed** (2026-10-18, dialogue). Continues tau-web ADR-001–018;
ADR-012 remains superseded by ADR-014. Not implemented yet.

## Context

tau-web works end to end, but its fork lineage keeps three costs that show
up as flakiness rather than missing features (see `docs/code-review.md`:

- **Three routing paths** — legacy direct ctx, headless child, relayed TUI —
  re-branched in the server command handler and in most client handlers.
  Drift produced B3 (zombie binding), B4 (dead fetch on New Session),
  B5 (reconnect wipes transcript), B6 ("No session" card), N1–N3.
- **Scattered client state** — ~60 module-level variables encode one attach
  state machine that no single place owns.
- **Dead legacy control plane** — `~/.pi/tau-instances`, zombie reaping,
  port bumping, sibling detection, per-TUI server remnants (~400 lines)
  that can only misbehave; B9 (hub.sock takeover races) came from it.

The four capabilities the product actually promises are hard to keep
reliable under that shape:

1. preview and drive a live running TUI (ADR-009/014),
2. resume a historical session (ADR-015/016),
3. create a brand-new session anywhere on the server,
4. view and add to an already-running headless session.

The host is a Galaxy F12 (3.7 GB RAM, LMK kills the whole Termux cgroup),
so memory, per-token WS traffic, and periodic polling are real constraints
(myserver AGENTS.md, RAM-OPTIMIZATIONS.md). `PI_HUB_MAX_HEADLESS=3` is the
operational cap there.

## Decision

Build **`pi-hub`** as a new, self-contained package (no imports from
tau-web; tau-web stays untouched and runnable) implementing the current
accepted ADR set — not the superseded ones — around one abstraction and
one test gate.

1. **Runner registry is the only switchboard.** A `Runner` (`headless`
   child or `live` TUI) exposes identity/status/history/command/events. The
   registry enforces: one process per session file; same-file bind is a
   no-op (ADR-015) and never `switch_session`s a running agent; bind acks
   only after readiness with honest failures (fixes B3); bounded pool and
   event ring buffer.

   *Amendment (2026-10-21):* "one process per session file" scopes to
   hub-spawned **headless** children. Live TUIs are announced, not spawned —
   two TUIs may legitimately share a file — so live runners are keyed by
   pid (one runner per announcing process); collapsing them by file orphans
   a relay. A plain bind to a live-owned file is refused (attach instead,
   ADR-014 single driver); resumes still converge on the live TUI via the
   client, which picks the most recently announced owner.
2. **One envelope, push not poll.** Every runner emits the same
   `event {runnerId, seq, event}` stream (ADR-004 generalized); registry
   changes are pushed (`runner_added/status/removed`); the client keeps a
   single state machine for preview→drive→detach→dead and for
   headless-viewing. No periodic session-store polling.
3. **The direct/hub-local channel is dropped.** The hub's own pi session is
   never a browser session (ADR-011); every browser session is a headless
   child or a relayed live TUI. This removes a whole routing branch from
   server and client.
4. **Keep the browser wire compatible where stable** (`start_session`
   aliases `bind`, `rpc_event` aliases `event`, `tui_command`,
   `extension_ui_response`, `/api/*` paths) so tau-web's 31 H/X cases and
   clients port with minimal edits.
5. **Playwright is the acceptance gate, with a cross-platform fallback**
   (ADR-020). `@playwright/test` with system Chrome
   (`channel: "chrome"`, cached-chromium fallback), projects `stub`,
   `phone`, `real` (`@real`), `adversarial`; on Termux the same spec
   functions run through system Firefox + geckodriver +
   selenium-webdriver (and a zero-dep `firefox --headless` CLI smoke),
   with Playwright-only cases declared and skipped by reason.
   `docs/testing.md` defines C1–C4 plus A/X/R/P/U/CP/D case matrices; a
   case registry (`tests/cases.json`) plus a meta-test forbids
   missing/silently-skipped cases.
6. **Security posture is ported and the review findings closed by
   construction:** child env credential scrubbing (S2), DOM-built
   rendering with validated image blocks (S1/B1), placeholder-safe
   markdown (B2), realpath/fd jailed files (S4), body caps (S5),
   self-hosted assets + strict CSP (S6), generated export names (S3),
   bounded maps (S9), WS payload/backpressure caps (S10). No delete/rename
   file mutations (ADR-018).
7. **Namespaced coexistence during the parallel build:** `PI_HUB_*` env,
   `PI_HUB_DISABLED`, `~/.pi/pi-hub/hub.sock`, `pi_hub_auth` cookie, dev
   port 8292 → 12045 at flip; children get `PI_HUB_DISABLED=1` and
   `TAU_DISABLED=1`. Web shell served at `/` (`/hub/` → 302), replacing
   tau-web's `/` → `/hub/`.
8. **Deployment mirrors myserver's runit pattern:** `sleep infinity |`
   stdin, `PI_HUB_PI_BIN=~/scripts/pi-node.sh` (no LD_PRELOAD under runsv),
   loopback bind + `PI_HUB_ALLOWED_HOSTS`, creds in mode-600 `~/.env`.

## Alternatives rejected

- **Keep patching tau-web in place:** the three-path structure is the bug
  factory; each fix reopens another branch (B3–B6 were all "a path that
  forgot to update state").
- **Big-bang replace tau-web:** the phone depends on it daily; the
  strangled parallel package keeps a working fallback and a rollback
  (`sv down pi-hub; sv up tau-web`) until the full suite is green.
- **Keep the direct/hub-local channel:** it exists because the old SDK web
  UI drove the server's own session; the hub product never wanted that,
  and ADR-011 already says the hub is not a session.
- **A React/Svelte client or server framework:** violates ADR-005 and the
  memory budget; vanilla + a ~200-line store is enough at this scale.
- **Downloaded Playwright browsers everywhere:** Termux can't host them;
  system Chrome with graceful SKIP keeps the suite usable on the phone's
  network without weakening the CI gate (`PI_HUB_STRICT=1`).

## Consequences

- All four capabilities share one registry and one event stream, so a fix
  lands once; `docs/testing.md` pins each capability with explicit
  failure semantics (no silent drops, no zombie binds, no blanked
  transcripts).
- tau-web's 31 H/X cases can run against pi-hub as an optional third gate
  by parameterizing the extension root (test-only edit); the Playwright
  suite is the primary gate.
- pi-hub owns a new ADR series from 019; ADR-001–018 remain the lineage
  and must not be re-litigated by the rewrite (e.g. ADR-015's no-re-switch
  is a registry invariant with a counter test).
- The flip is a service swap plus removing tau-web from
  `~/.pi/agent/settings.json`; both packages may load in one process
  meanwhile because every namespace and socket path differs.
- Open sub-decisions recorded for review: self-hosted highlight.js +
  lazy KaTeX (adopted above for CSP/snappiness), `@playwright/test`
  devDependency, and the optional tau-web-harness third gate.
