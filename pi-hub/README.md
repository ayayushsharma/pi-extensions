# pi-hub

One port, one UI, every Pi session. pi-hub is a **control plane** for Pi:
a hub process (`pi -e pi-hub --mode rpc`) that serves a browser UI and
drives sessions through a single **Runner** abstraction, while live TUIs
dial in over a unix socket and are relayed, never dual-written.

Built as a parallel package to `tau-web` (ADR-019) and now **independent**
of it (ADR-022): own client, own wire dialect, own suites. Same job — one
runner registry instead of three routing paths, push instead of polling,
and a Playwright + Firefox test gate.

## Relationship to tau-web (ADR-022)

pi-hub is a replacement at the **product** level, not at the wire level. It
speaks its own WS dialect (`bind`/`command`/`event`) and its own route names;
there is no `start_session`/`rpc_event`/`tui_command` compatibility layer and
tau-web's browser harness is not a gate here. The two packages coexist on one
machine only through namespacing (`PI_HUB_*`, own socket, own advert, own
cookie, own port) — they cannot read each other's browser session. Rollback
is a service swap (`sv down pi-hub; sv up tau-web`) plus a re-login; session
files are shared.

Deliberately **not** ported (deferred, not defects — see ADR-022 and
`docs/code-review.md` M1–M5): math rendering (KaTeX), syntax highlighting,
read-aloud TTS, and the PWA offline service worker. Dropped on purpose:
`/api/open` (host process launch), `/api/rpc` (arbitrary HTTP RPC),
`set_auth`/`get_auth`, and the instance registry / zombie reaping.

## The four capabilities

| Capability | How it works |
|---|---|
| **Preview & drive a live TUI** (C1) | Any interactive pi with the package loaded dials the hub socket and appears under **Live terminals**; the browser previews read-only history with a banner, then **Drive** relays prompts into the terminal. Detach freezes the view; a dead TUI offers *continue headless* on the same file. One driver at a time — a second browser gets `driver_busy` and an explicit takeover. A TUI finds the hub by its own `PI_HUB_SOCK`/`piHub.sock` if set, else via the hub's advert file `~/.pi/agent/pi-hub/hub.json` (so a dev hub with a custom `PI_HUB_DIR` still works). |
| **Resume a historical session** (C2) | The picker lists the on-disk store; `bind` resumes with exactly one `switch_session`. Rejoining the loaded file is a **no-op** (pi cancels runs on re-switch), and windowed history paints before the stream attaches. Fork copies the transcript byte-for-byte. |
| **New session anywhere** (C3) | Browse the server filesystem (or type a path), validate the cwd, spawn a `pi --mode rpc` child; the bind ack resolves only when the child is ready, so a bad cwd or bad binary is an honest error, never a zombie binding. |
| **View & add to running headless** (C4) | Running children are pushed to every browser with pid/model/working state; opening one binds the **same child** (no respawn), and steering/queueing/abort works from any viewer. Pool cap (`PI_HUB_MAX_HEADLESS`) evicts idle sessions only. |

## Web UI (clean-room client)

`public/` is pi-hub's own client, built on the native WS dialect (no
tau-web code is copied or imported). It matches tau-web's visual language and
UX while fixing known rough edges:

- **Tab bar + home**: one tab per open session, dot states (live/working),
  `Ctrl+K` picker, `Ctrl+Shift+P` home. Home tears the view down (no bound
  runner, no `#s=` hash, composer hidden) — the strip itself is hidden on
  phones (≤520px), where the sidebar + titlebar carry session identity.
- **Sidebar**: current-session card with live state, *currently running tabs*,
  *running terminals* (Drive/Detach inline), project-grouped sessions with
  client-side filter plus full-text fallback (`GET /api/search`), favourites,
  and a context menu (favourite, rename, fork, export HTML, copy path, delete).
- **Transcript**: DOM-built markdown (no `innerHTML` for model output),
  collapsible thinking blocks, tool cards with **Input above Output** (edit
  diffs stay visible beside the result) plus status/copy, usage and cost lines,
  windowed history with *load earlier*, a 300-node DOM cap with a
  "N hidden" way back for long live runs, and a *jump to latest* control when
  scrolled away.
- **Composer**: slash palette, steer/queue pills while working (the pill
  echoes on ack — headless pi reports `queue_update`, the live mirror forwards
  no queue state — and clears when the text is delivered), image
  attachments, model + thinking menus, abort, optional Web Speech input, and a
  statusline with cwd, tokens, cost and context %.
- **Server surfaces**: preview/drive banner (a slim one-liner with a bold
  lead — `Driving` / `Preview` — that wraps instead of clipping), file panel
  jailed to the session
  cwd (up-button disables at the boundary), settings (side-rail sheet: twelve
  light/dark themes with palette previews — **Clean is the default** — chat
  prefs, server + process list,
  server info, process list with kill), extension-UI dialogs, toasts, login
  overlay, and a mobile drawer that closes on session pick.

Picker starter prompts are sent after the fresh bind (tau-web dropped them);
rename/delete/fork/export all round-trip through the backend (delete refuses a
session owned by a running backend until it is closed).

### Chat preferences (Settings → Chat)

All of these are per-device (`pi-hub-prefs` in `localStorage`) and apply to
open sessions immediately:

| Pref | Default | Effect |
|---|---|---|
| Thinking blocks | on | Show the model's reasoning above each answer. |
| Usage and cost | on | Token counts and spend under every assistant turn. |
| Expand tool calls | off | Tool cards open with args/output instead of a summary line. |
| Wrap message code | off | Wrap code blocks in messages rather than scrolling sideways. |
| Wrap tool calls | off | Wrap tool card args/output (independent of the message setting). |
| Tool output | readable text | Join the result's `text` blocks as plain output; **Raw JSON** keeps the full result blocks. |
| Streaming replies | Format live | Markdown painted as it arrives (throttled once a reply grows past ~6k chars). **Format on completion** shows plain pre-wrapped text while streaming and formats once at `message_end` — the cheap choice for long replies/slow devices. |

Theme is a separate Appearance pref; **Clean** is the default for a fresh
device (Night on a dark `prefers-color-scheme`), and a saved choice always
wins.

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
# ...in another terminal, run your normal work session the same way; it shows
# up under "Live terminals" (preview -> Drive). It needs no hub path: the hub
# publishes its socket in ~/.pi/agent/pi-hub/hub.json and the mirror falls back
# to it when its configured socket is absent.
```

One hub per machine (ADR-021): the first hub to start claims the advert
file, and a second `pi -e . --mode rpc` refuses while the claim is live
(pid + reachable port/socket) instead of bumping to a surprise port — no
more shadow hubs beside the one the tunnel and mirrors point at. The
refusal names the running hub's pid/port/sock in `pi-hub.log`; stop it
first, or give the second hub its own `PI_HUB_PORT` **and** its own
`PI_HUB_ADVERT_FILE`. A hard-killed hub leaves a dead claim behind and the
next start reclaims it.

`.ts` changes need a jiti cache clear + `/reload`; `public/` changes are a
browser reload. Asset cache-busting is automatic: the shell stamps a live
version (newest mtime under `public/`) onto the `?v=` URLs, so edited CSS/JS
can never pair with freshly-served HTML — no manual bump needed.

Auth: set `PI_HUB_USER` / `PI_HUB_PASS` (or `piHub.user/pass` in
`~/.pi/agent/settings.json`). The shell is public so the login overlay can
render; `/api/*` and `/ws` require the HttpOnly `pi_hub_auth` cookie.
`PI_HUB_ALLOWED_HOSTS` pins tunnel hostnames; Host/Origin are checked on
every request.

## Brand mark

`public/js/core/icons.js` defines the π marks (`glyph`, `pi`, `knockout`,
`badge`, `nodes`, `node`) in one place; the default is chosen by the `LOGO_MARK`
constant and every logo call site (`logo(size)`) follows it.
Marks draw in `--accent`/`--on-accent`, so they recolour with the active theme
(terracotta, slate, forest… per theme) and never disappear against the page.

The default is `glyph`: a hand-drawn π (path data inlined from `pi.svg`,
filled with `--accent`, no badge), so the mark is a bare lettermark everywhere —
titlebar, welcome hero, sign-in card, favicon. It stays legible from 16px up to
display sizes because it is outline art, not strokes.

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
| `PI_HUB_ALLOWED_HOSTS` / `PI_HUB_ALLOW_ANY_HOST` | — | DNS-rebinding allowlist (exact hosts; loopback + own bind always allowed) |
| `PI_HUB_DRIVE_CONFIRM` | off | Native TUI approval per browser attach (fail-closed) |
| `PI_HUB_DIALOG_TIMEOUT_MS` | `300000` (5 min) | browser extension-dialog timeout; the owner gets a cancellation |
| `PI_HUB_DIALOG_MAX` | `32` | max pending browser dialogs (oldest is cancelled) |
| `PI_HUB_TRUST_PROXY` | off | trust `X-Forwarded-For` **only from a loopback tunnel** for per-IP limits |
| `PI_HUB_LOG_FILE` / `PI_HUB_DEBUG` | `~/.pi/pi-hub/pi-hub.log` | file-only logging (never stdout) |

Deprecation-free coexistence with an installed `tau-web`: pi-hub only reads
`PI_HUB_*`, uses its own socket and cookie, and spawns children with both
`PI_HUB_DISABLED=1` and `TAU_DISABLED=1`. Coexistence is **namespace-only** —
the two hubs are not interchangeable and share no browser session (ADR-022).

## Tests

```bash
node tests/run.mjs --unit       # pure contracts (store, protocol) — no hub
node tests/run.mjs              # HTTP/WS integration (real pi, fixture store)
node tests/run.mjs --e2e        # Playwright browser flows (system Chrome)
node tests/run.mjs --all        # + Firefox CLI smoke (cross-platform, ADR-020)
node tests/run.mjs --all -j1    # serial, deterministic logs/timings
```

Current on **Termux**: **93 unit** (~9.5 s), **94 integration** (~79 s at
`jobs=3`) and a **6-check Selenium browser smoke** (~38 s). The **171
Playwright** checks remain the Linux/Chrome gate; Playwright cannot run on this
phone, so they are not claimed here. The Firefox CLI smoke SKIPs on hosts whose
system Firefox cannot render headless. See `docs/testing.md` §1.1–§1.2 and
`docs/termux-browser-poc.md`; known gaps are tracked in `docs/code-review.md`.

```bash
npm test              # unit contracts — sub-second on Linux, ~9 s on Termux
npm run test:int      # hub contract over HTTP/WS — ~3 s Linux, ~80 s Termux
npm run test:termux   # Selenium CP3/CP4 smoke on the phone (optional deps)
npm run test:all      # + real browser + Firefox smoke (fire once when done)
```

Every suite runs against a **sandboxed agent dir + session store** (nothing can
reach `~/.pi/agent`; the runner fails the suite if it does) and a **local fake
model** (`tests/fixtures/fake-llm.mjs`) — no API keys, no cost, no variance.
Independent groups run in parallel: `-j N` / `--jobs N` (default 4), `--serial`
for deterministic logs.

The fixture store (`tests/fixtures/sessions/`) is copied to a temp dir per
run, so tests never touch real sessions. Hubs and mirrors are killed by
parent PID; every browser case fails on a page error or a non-empty
`window.__errs`.

## Security

- Cookie-session auth, HttpOnly + SameSite=Lax (+Secure over TLS), login
  and Basic backoff with 429 past sustained guessing, no
  `WWW-Authenticate` (no native browser prompt), 30-day TTL with sliding
  refresh. An authenticated browser reads like the user (full `$HOME`
  file view) — keep loopback + strong creds off-loopback.
- Child env is scrubbed of `PI_HUB_USER/PASS/AUTH*` (and `TAU_*`) **and**
  hub/mirror topology knobs, so a child can never resolve into a nested hub.
- File APIs are realpath-jailed: the viewer is jailed to the viewed
  session's cwd (ADR-017), browsing to configured roots, session relocate
  targets jailed to the browse roots, and the **only**
  mutation is a single-level `mkdir` under `$HOME` (ADR-018) — no delete,
  no rename, no write. HTML exports are restricted to the bound session's
  generated `.export.html` name and refuse symlink/hardlink finals (H11).
- Strict CSP, `nosniff`, frame denial; markdown/transcripts are built with
  DOM APIs (no `innerHTML`), images are mime/base64 validated on the wire
  and in history rendering. Attachments are downscaled in the browser to
  fit the 2 MB WS frame (per-image 640 KB, per-message 1.5 MB base64, max
  four images; GIFs are never re-encoded), so a phone photo cannot close
  the socket with 1009 — and a rejected send restores the attachments
  instead of discarding them.
- Live TUIs are driven only through the relay by the single attached driver
  (preview sockets read, drive verbs are refused); the hub never injects
  into a foreign process except through an explicit attach or the
  process-kill switch (ADR-013/014: argv/`exe` fingerprint, re-checked at
  kill time, never self, never pid ≤ 1; works on Linux, Android/Termux and macOS; bare `bundle/cli.js` is not a match). `PI_HUB_DRIVE_CONFIRM=1` adds native
  TUI approval per attach for shared deployments (deny/timeout fail closed).
  Browser dialogs are scoped to their runner, capped and timed out; set
  `PI_HUB_TRUST_PROXY=1` only when a loopback tunnel terminates the connection,
  and the per-IP limits use its `X-Forwarded-For` first hop.

## Docs

- `docs/PLAN.md` — architecture, budgets, phases.
- `docs/testing.md` — case matrix, cross-platform drivers.
- `docs/code-review.md` — the review log: every finding (H/R/P IDs), its
  status, its pinning case, verified-good tau-web regressions, and honest
  gaps (unpinned/manual checks). **Read before changing behaviour.**
- `docs/UX.md` — scripted user flows, the UX bug log (each with its
  pinning case), implemented recommendations R-1…R-12, and the handoff
  section. **Start here for UX work.**
- `docs/adr/019` — parallel rewrite decision (incl. live-keyed-by-pid
  amendment); `docs/adr/020` — browser driver strategy; `docs/adr/021` —
  one hub per machine (advert-scoped singleton); `docs/adr/022` —
  independence from tau-web, deferred features, deliberate drops.
