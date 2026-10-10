# AGENTS.md — pi-extensions

Monorepo of [Pi](https://github.com/badlogic/pi-mono) packages (extensions + skills +
prompts + themes). Each top-level directory is an **independent pi package** with
its own `package.json`, versioning, and publish cycle. There is no root `package.json`
and no shared build — do not add one.

## Layout

```text
pi-extensions/
├── AGENTS.md               # this file — repo conventions (you are here)
├── tau-web/                # tau-web — unified Pi web UI (mirror + headless + uplink)
└── extension-template/     # scaffold for a new package — copy it, don't edit it
```

Each package follows the [Pi packages](https://github.com/badlogic/pi-mono#packages)
conventional layout:

```text
my-package/
├── package.json            # name, pi.extensions manifest, dependencies
├── extensions/             # TypeScript entry points loaded by Pi (via jiti, no build)
├── skills/ prompts/ themes/# optional resources (auto-discovered)
├── public/                 # optional static assets (package's own concern)
└── README.md
```

## Current packages

| Dir | npm | What |
|-----|-----|------|
| `tau-web/` | `tau-web` | Unified Pi web UI: live TUI mirror + headless backends + uplink proxy + cookie auth. Supersedes the retired `tau` package (removed). See `tau-web/README.md`. |
| `ctx-limit/` | `pi-ctx-limit` | Caps the model's effective context window at `min(manual, model)` so Pi's own auto-compaction triggers early and still continues the run, via `--context-size` / `ctxLimit` settings. See `ctx-limit/README.md`. |
| `extension-template/` | n/a (not published) | Minimal working package. Starting point for every new extension. |

## Creating a new extension

1. Copy the template: `cp -r extension-template <my-name>`.
2. Edit `<my-name>/package.json`: `name`, `description`, `repository`, and the
   `pi.extensions` entry-point list.
3. Implement in `<my-name>/extensions/`. Keep the default export factory thin —
   register tools/commands/events, defer servers/sockets/timers/watchers to
   `session_start` (or the command/tool that needs them).
4. Test with `pi --extension ./<my-name>/extensions/<file>.ts`, then as a package
   with `pi -e ./<my-name>` and `pi install ./<my-name>`.
5. Document in `<my-name>/README.md` (install, usage, config env vars).

Never restructure an existing package to fit the new one. Never add cross-package
imports or a shared workspace — installed packages load with separate module roots
and must not share dependency instances.

## Pi extension rules (must-follow)

Source of truth: pi docs in
`/data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
— `extensions.md` (API/lifecycle), `packages.md` (manifest/distribution),
`tui.md` (terminal UI), `rpc-extension-ui.md` (RPC UI limits). Examples in
`.../examples/extensions/`. Start from the smallest matching example.

- Export a default factory `(pi: ExtensionAPI) => void | Promise<void>`.
  Load with `pi --extension ./file.ts` (jiti — no compilation step).
- **Lifecycle:** no processes/sockets/watchers/timers in the factory. Start them
  on `session_start` (or on demand), release them in an idempotent
  `session_shutdown` handler. Code after `await ctx.reload()` must not reuse old
  runtime state.
- **Never write to stdout/stderr** from an extension — it corrupts the fullscreen
  TUI (especially under tmux). User-visible output goes via `ctx.ui.notify()` /
  `ctx.ui.setStatus()`; diagnostics go to a log file (see `tau-web/` `tauLog` pattern).
- **Modes:** extensions load in tui, rpc, json, and print modes. Guard
  terminal-only behavior with `ctx.mode === "tui"` / `ctx.hasUI`; keep tool and
  event behavior rendering-independent so non-interactive modes work.
- **Tools:** `pi.registerTool()` needs name, model-facing description, TypeBox
  params schema, `execute()` returning `{ content, details }`. Throw to fail.
  `details: undefined` when no structured details. Truncate large results and tell
  the model where the full output lives. File read-modify-write goes through
  `withFileMutationQueue()`.
- **Events:** handlers run in load/registration order; use each event's declared
  result type (not every return value has an effect). `turn_end` /
  `agent_before_settle` continuations must be guarded — unconditional
  `continue: true` loops. `tool_call` handler failure blocks the tool (fail-safe).
- **State:** branch-sensitive tool state → tool-result `details`; durable
  non-context data → `pi.appendEntry()`; model-visible content → `pi.sendMessage()`;
  cross-session data → external storage. Rebuild branch state from
  `ctx.sessionManager.getBranch()` on `session_start`, not from all file entries.

## Pi package rules (must-follow)

- `package.json` needs the `pi` manifest (`extensions`, optionally `skills`,
  `prompts`, `themes`; globs + exclusions allowed) and the `pi-package` keyword
  for gallery discovery. Paths are relative to the package root. See `packages.md`.
- Runtime deps imported by extensions go in `dependencies` (Pi installs them for
  npm/git sources). Host-provided modules (`@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) go in `peerDependencies: "*"` — never in
  `dependencies` (a physical copy breaks module mapping / duplicates registries).
- Local packages are not installed/modified — their `node_modules` is the author's
  responsibility. Run `npm install` inside the package dir during development.
- Narrowing which resources load from a package is done in settings
  (`+path`/`-path`/`!pattern`), not by editing the package manifest for local taste.

## Dev loop

```bash
# single file iteration
pi --extension ./<pkg>/extensions/<file>.ts

# whole package for one run (no settings change)
pi -e ./<pkg>

# install / update / remove
pi install ./<pkg>          # local path; npm: / git: for published
pi update --extensions
pi remove <source>
pi list                     # configured packages
```

- Extension `.ts` changes: clear the jiti cache then restart Pi
  (`rm -rf $TMPDIR/jiti` or `%LOCALAPPDATA%\Temp\jiti` on Windows).
- Static/browser assets (e.g. `tau-web/public/`): browser reload only, no Pi restart.
  Prefer the `TAU_STATIC_DIR=$(pwd)/public pi` override pattern for UI work.
- Verify with `npx tsc --noEmit` (if a tsconfig exists) or at minimum `node --check`
  on plain JS before committing. No shared lint config — match the package's
  existing style.

## Working in this repo

- Scope every change to one package directory (plus this file only if conventions
  genuinely change). Check `git status` — unrelated dirty trees (e.g. `tau-web/`
  mid-dev) are normal; don't touch them.
- Read the package's own `README.md` / `CLAUDE.md` / `.pi/AGENTS.md` before
  changing it — they override these repo-level defaults.
- Commit per package (`tau: ...`, `<pkg>: ...`). The template itself is never
  published and never takes a dependency on a real package.
- Security: extensions run in-process with full user permissions and can read
  prompts, files, credentials, session history. Review third-party extension code
  before `pi install`; review project package declarations before granting
  project trust. Don't bind `0.0.0.0`, don't add auth-less network listeners, and
  don't exfiltrate session content — see `tau`'s bind-address/auth notes as the
  cautionary example.
