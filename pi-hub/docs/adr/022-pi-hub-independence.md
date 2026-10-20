# ADR-022 — pi-hub is independent: own client, own wire, product-level parity

Status: **accepted** (2026-10-21). Supersedes ADR-019 §4 (wire compatibility)
and the tau-web-harness references in ADR-019 §5 / Consequences.

## Context

ADR-019 §4 kept tau-web's browser wire alive as aliases (`start_session` ≈
`bind`, `rpc_event` ≈ `event`, `tui_command`, `extension_ui_response`,
`/api/*` paths) so "tau-web's 31 H/X cases and clients port with minimal
edits", with the harness as an optional third gate (ADR-019 §5).

In practice none of that was built, and the two packages diverged on purpose:

- pi-hub ships **its own client** (`public/`), written against its own dialect
  (`bind` / `command` / `event` / `attach` / `detach` / `unbind` / `close`).
- pi-hub's routes differ where tau-web's were weak: `/api/files/list` (not
  `/api/files`), `/api/runners*`, `/api/server`, `/api/session-file-exists`,
  `/api/sessions/relocate`, `/api/sessions/export-file`; no `/api/rpc`,
  `/api/open`, `/api/sessions/export`, `/api/sessions/summaries`,
  `/api/projects/launch`.
- pi-hub's gate is its own suite (60 unit / 90 integration / 170 Playwright),
  which covers the same C1–C4 capabilities with a sandboxed store and a fake
  model — the reason the rewrite exists.
- Implementing the aliases now would freeze tau-web's warts into a second
  dialect forever, and re-running tau-web's harness would still need test-only
  edits (extension root, env names, cookie name, port).

Two other ADR-019 sub-decisions are also unimplemented and are now explicitly
deferred: self-hosted `highlight.js` + lazy KaTeX (ADR-019 §6) and the
`tests/cases.json` case registry + meta-test (§5).

## Decision

1. **pi-hub is an independent package.** Its browser client and wire dialect
   are canonical. There is **no compatibility layer** for tau-web:
   no `start_session` / `rpc_event` / `tui_command` / `close_session` /
   `list_sessions` aliases, no route aliases, no third-gate harness. ADR-019
   §4 is superseded; a future compatibility layer would need a new ADR.
2. **Parity is product-level, not wire- or pixel-level.** The four
   capabilities (C1–C4), the accepted ADR set 003–018, the security posture
   and the deployment shape are ported. tau-web browser features that were
   never ported are **deferred features**, not regressions — see the table
   below and `docs/code-review.md` §4 (M1–M5). They get implemented if and
   when they earn it.
3. **Deliberately dropped capabilities stay dropped** — they are not on any
   parity list: `/api/open` (host process launch), `/api/rpc` (arbitrary HTTP
   RPC), `set_auth`/`get_auth` (runtime auth toggle), the instance registry /
   zombie reaping, and the direct/hub-local browser channel (ADR-011).
4. **Coexistence is namespace-only.** pi-hub and tau-web can run on one
   machine because every surface differs (`PI_HUB_*`, own sock, own advert,
   own cookie, own port). They are **not** interchangeable, and neither can
   read the other's browser session.
5. **Rollback is a service swap**, not a protocol migration: stop pi-hub,
   start tau-web, log in again (different cookie). Session files are shared
   (same store format, ADR-016/017 semantics unchanged).

### Deferred tau-web features (owner: product, not a defect)

| ID | Feature | tau-web did | pi-hub today | Why deferred |
|---|---|---|---|---|
| M1 | Math rendering | KaTeX auto-render from CDN | raw LaTeX as text | must be vendored for the strict CSP; needs a bundle-size decision |
| M2 | Syntax highlighting | highlight.js (transcript + file viewer) | plain `<pre>` | same vendoring decision; copy button and the 64 KB fence cap already exist |
| M3 | Read-aloud (TTS) | `tts.js` (speechSynthesis, voice picker, auto-read) | absent (dictation **is** ported) | accessibility nicety, ~270 self-contained lines, no deps |
| M4 | PWA offline shell | `/sw.js` + registration + auth-recovery page | manifest only (`start_url: "/"`) | offline caching of an authenticated control plane needs its own threat review |
| M5 | Wire aliases / harness | n/a (tau-web's own) | none (this ADR) | only served the third-gate idea; superseded by pi-hub's own suites |

## Alternatives rejected

- **Implement ADR-019 §4 aliases anyway.** Two dialects to keep in sync, for a
  client nobody ships and a harness that still needs edits; the drift class
  the rewrite was meant to kill.
- **Keep calling tau-web's harness a "gate".** A gate that cannot run
  (`/api/files`, `start_session`, cookie/port names all differ) is worse than
  no gate: it reads green by never executing.
- **Declare feature parity complete.** Math/highlighting/TTS/PWA are visibly
  absent; silent omission is how docs start lying.

## Consequences

- `docs/adr/019` §4/§5/Consequences are annotated as superseded where they
  promise wire compatibility, the tau-web third gate, or self-hosted
  highlight/KaTeX.
- README gains a "Relationship to tau-web" section; `docs/testing.md` rows for
  code highlighting, math and PWA now describe what pi-hub actually does and
  mark the rest deferred; `docs/code-review.md` lists M1–M5 with this ADR.
- pi-hub's own gate (unit/integration/Playwright) is the only acceptance gate.
  `tests/cases.json` + meta-test remains our own open item (code-review D2),
  independent of tau-web.
- Picking up a deferred feature is a normal change: vendor the asset or add
  the module, pin it, and drop the "deferred" marker from the matrix. No ADR
  amendment needed unless it changes the wire or the security posture.
