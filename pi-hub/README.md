# pi-hub

One port, one UI, every Pi session. pi-hub is a **control plane** for Pi:
a hub process (`pi -e pi-hub --mode rpc`) that serves a browser UI and
drives sessions through a single **Runner** abstraction, while live TUIs
dial in over a unix socket and are relayed, never dual-written.

Built as a parallel package to `tau-web` (ADR-019): same job, one runner
registry instead of three routing paths, push instead of polling, and a
Playwright + Firefox test gate.

## The four capabilities

| Capability | How it works |
|---|---|
| **Preview & drive a live TUI** (C1) | TUIs dial `~/.pi/pi-hub/hub.sock`; the hub lists them, the browser previews read-only history with a banner, then **Attach & Drive** relays prompts into the terminal. Detach freezes the view; a dead TUI offers *continue headless* on the same file. One driver at a time — a second browser gets `driver_busy` and an explicit takeover. |
| **Resume a historical session** (C2) | The picker lists the on-disk store; `bind` resumes with exactly one `switch_session`. Rejoining the loaded file is a **no-op** (pi cancels runs on re-switch), and windowed history paints before the stream attaches. Fork copies the transcript byte-for-byte. |
| **New session anywhere** (C3) | Browse the server filesystem (or type a path), validate the cwd, spawn a `pi --mode rpc` child; the bind ack resolves only when the child is ready, so a bad cwd or bad binary is an honest error, never a zombie binding. |
| **View & add to running headless** (C4) | Running children are pushed to every browser with pid/model/working state; opening one binds the **same child** (no respawn), and steering/queueing/abort works from any viewer. Pool cap (`PI_HUB_MAX_HEADLESS`) evicts idle sessions only. |

## Web UI (clean-room client)

`public/` is pi-hub's own client, built on the native WS dialect (no
tau-web code is copied or imported). It matches tau-web's visual language and
UX while fixing known rough edges:

- **Tab bar + home**: one tab per open session, dot states (live/working),
  `Ctrl+T` instant new session, `Ctrl+K` picker, `Ctrl+Shift+P` home.
- **Sidebar**: current-session card with live state, *currently running tabs*,
  *running terminals* (Drive/Detach inline), project-grouped sessions with
  client-side filter plus full-text fallback (`GET /api/search`), favourites,
  and a context menu (favourite, rename, fork, export HTML, copy path, delete).
- **Transcript**: DOM-built markdown (no `innerHTML` for model output),
  collapsible thinking blocks, tool cards with status/diff/copy, usage and cost
  lines, windowed history with *load earlier*, and a *jump to latest* control
  when scrolled away.
- **Composer**: slash palette, steer/queue pills while working, image
  attachments, model + thinking menus, abort, optional Web Speech input, and a
  statusline with cwd, tokens, cost and context %.
- **Server surfaces**: preview/drive banner, file panel jailed to the session
  cwd (up-button disables at the boundary), settings (themes, display prefs,
  server info, process list with kill), extension-UI dialogs, toasts, login
  overlay, and a mobile drawer that closes on session pick.

Picker starter prompts are sent after the fresh bind (tau-web dropped them);
rename/delete/fork/export all round-trip through the backend (delete refuses a
session owned by a running backend until it is closed).

Testability hooks: `body[data-ready="1"]` when booted, `window.__errs[]` for
client errors, and stable `data-*` attributes (`data-session-file`,
`data-runner-id`, `data-runner-kind`, `data-tab-key`, `data-view`).

## Run

```bash
cd pi-hub && npm install

# hub (dev port)
PI_HUB_PORT=8292 PI_HUB_HOST=127.0.0.1 PI_HUB_PI_BIN="$(command -v pi)" \
  pi -e . --mode rpc

# any interactive pi process with the package loaded becomes a live mirror:
pi -e .
```

`.ts` changes need a jiti cache clear + `/reload`; `public/` changes are a
browser reload (bump `?v=` in `public/index.html` when editing JS/CSS).

Auth: set `PI_HUB_USER` / `PI_HUB_PASS` (or `piHub.user/pass` in
`~/.pi/agent/settings.json`). The shell is public so the login overlay can
render; `/api/*` and `/ws` require the HttpOnly `pi_hub_auth` cookie.
`PI_HUB_ALLOWED_HOSTS` pins tunnel hostnames; Host/Origin are checked on
every request.

## Config (`PI_HUB_*` env, then the `piHub` settings block)

| Var | Default | Purpose |
|---|---|---|
| `PI_HUB_PORT` / `PI_HUB_HOST` | `8292` / `127.0.0.1` | browser port + bind (loopback by default) |
| `PI_HUB_USER` / `PI_HUB_PASS` | — | cookie auth; never exposed to children |
| `PI_HUB_PI_BIN` | `pi` | binary spawned for headless runners |
| `PI_HUB_MAX_HEADLESS` | `0` (unlimited) | cap concurrent children; LRU-evicts idle only |
| `PI_HUB_TTL_MS` | `0` (never) | opt-in idle reap (persistent by default) |
| `PI_HUB_SOCK` / `PI_HUB_DIR` | `~/.pi/pi-hub/hub.sock` | mirror transport |
| `PI_HUB_FS_ROOTS` | — | extra `:`-separated browse roots |
| `PI_HUB_STATIC_DIR` | bundled `public/` | UI override for development |
| `PI_HUB_DISABLED` / `PI_HUB_ROLE` | — / inferred | inert role; force `hub\|mirror` |
| `PI_HUB_ALLOWED_HOSTS` / `PI_HUB_ALLOW_ANY_HOST` | — | DNS-rebinding allowlist |
| `PI_HUB_LOG_FILE` / `PI_HUB_DEBUG` | `~/.pi/pi-hub/pi-hub.log` | file-only logging (never stdout) |

Deprecation-free coexistence with an installed `tau-web`: pi-hub only reads
`PI_HUB_*`, uses its own socket and cookie, and spawns children with both
`PI_HUB_DISABLED=1` and `TAU_DISABLED=1`.

## Tests

```bash
node tests/run.mjs              # HTTP/WS integration (real pi, fixture store)
node tests/run.mjs --e2e        # + Playwright (system Chrome) browser flows
PI_HUB_E2E_PROMPT=1 node tests/run.mjs --e2e   # + one real model round-trip
node tests/run.mjs --all        # + Firefox CLI smoke (cross-platform, ADR-020)
```

Current: **37 integration + 19 Playwright checks green**; the Firefox CLI
smoke SKIPs on hosts whose system Firefox cannot render headless (it is the
Termux/Android backend — Playwright's bundled Chromium cannot run there).

The fixture store (`tests/fixtures/sessions/`) is copied to a temp dir per
run, so tests never touch real sessions. Hubs and mirrors are killed by
parent PID; every browser case fails on a page error or a non-empty
`window.__errs`.

## Security

- Cookie-session auth, HttpOnly + SameSite=Lax, login backoff, no
  `WWW-Authenticate` (no native browser prompt), token TTL.
- Child env is scrubbed of `PI_HUB_USER/PASS/AUTH*` (and `TAU_*`).
- File APIs are realpath-jailed: the viewer is jailed to the viewed
  session's cwd (ADR-017), browsing to configured roots, and the **only**
  mutation is a single-level `mkdir` under `$HOME` (ADR-018) — no delete,
  no rename, no write.
- Strict CSP, `nosniff`, frame denial; markdown/transcripts are built with
  DOM APIs (no `innerHTML`), images are mime/base64 validated.
- Live TUIs are driven only through the relay; the hub never injects into a
  foreign process except through an explicit attach or the process-kill
  switch (ADR-013/014).

## Docs

- `docs/PLAN.md` — architecture, budgets, phases.
- `docs/testing.md` — case matrix, cross-platform drivers.
- `docs/adr/019` — parallel rewrite decision; `docs/adr/020` — browser
  driver strategy.
