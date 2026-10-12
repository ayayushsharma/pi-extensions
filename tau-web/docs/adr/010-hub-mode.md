# ADR-010 — Hub mode: persistent control plane + per-session mirrors

Status: proposed (2026-10-12) · Supersedes discussion in 002/003/008/009

## Context

tau-web today is symmetric: every pi process runs a full mirror server
(mirror-live + headless children + uplink proxy to any other TUI), and any
browser can `uplink_attach` to any TUI. This forces three pains:

1. **Manual tmux tax** — a live TUI must exist before the web is useful.
2. **No session authority** — any mirror can drive any other; no single
   place owns start/resume/new/kill.
3. **Ephemeral backends** — `HeadlessRegistry` TTL-reaps (15 min) and WS
   close unbinds, so browser kill can strand or kill pi work.

Goal: one always-on URL that browses files, starts brand-new sessions in
any project, resumes old ones, survives browser kill, and lets the user
kill explicitly. Memory-constrained home server / Termux (3.7G).

## Decision

Split into **control plane (hub)** and **data plane (mirrors)**.
One package, two roles, selected by how pi launches.

```text
BROWSER ──HTTPS(cookie)──▶ tunnel ──▶ HUB :12045 (pi -e tau-web --mode rpc)
                                        │  static public/ + /api/* + /ws
                                        │  HeadlessRegistry (PERSISTENT)
                                        │  session switchboard (sole owner)
                                        ├──unix sock──▶ mirror: own TUI session
                                        ├──unix sock──▶ mirror: other live TUIs
                                        └──spawn──────▶ pi --mode rpc child per session
```

### Hub (canonical, always-on)

* `pi -e tau-web --mode rpc`. No TUI, `latestCtx == null`.
* Owns **all** multi-session ops: `start_session/new_session/close_session/
  list_sessions`, file browser rooted per session cwd, projects list.
* Sessions **persistent**: TTL default `0` (never reap). WS close only
  detaches; child keeps running mid-run and after `agent_end`. Kill only
  via explicit `close_session`/pool-cap/shutdown. (Implemented 2026-10-12
  in `headless-bridge.ts`.)
* Serves the only browser-facing TCP port (`127.0.0.1`, cookie `tau_auth`).

### Mirror (per TUI process)

* `pi -e tau-web` (interactive). Serves **its own session only**.
* Direct browser URL still drives it (single-session scope).
* Accepts exactly 4 hub commands over socket: `drive`, `snapshot`,
  `dialog_relay`, `health`. Rejects `switch/close/start/new` (unknown
  type → drop). No `uplink_*` handlers — mirrors never proxy each other.
* Companion forwarder (~100 lines): pushes `ctx` events to hub, accepts
  `drive` back. Reuses the `rpc_event` envelope (ADR-004).

### Transport + auth (no PSK)

* **Hub↔mirror: unix socket only** — `~/.pi/tau/hub.sock`, dir `700`.
  Kernel UID perms are the authenticator. No secret to create/rotate/go
  stale across boot order (pi-first and hub-first both work: missing
  socket → degraded direct-only mode + retry).
* **Browser→hub: cookie session** (`POST /api/login` → HttpOnly
  `SameSite=Lax tau_auth`), checked on every `/api` + WS upgrade.
  `GET /api/health` stays exempt but returns version/uptime only.
* **Anti-rebinding**: WS upgrade + `/api/*` check `Host`/`Origin`
  (localhost, IP literals, `*.ts.net`, plus `TAU_ALLOWED_HOSTS`);
  `127.0.0.1` bind by default, remote via Tailscale Serve / cloudflared
  (TLS + identity in front).
* No TCP loopback between daemons → no unauthenticated-port surface for
  on-device apps (loopback is device-global on Android; app-private
  socket files are not).

### Why not alternatives

* TCP+PSK hub↔mirror: redundant on same-UID box; adds rotation/
  invalidation bugs for zero gain. Reserved as fallback only.
* mTLS/JWT/OAuth: handshake/crypto load + CA/rotation machinery,
  unjustified for single-user home server.
* Pixel-terminal emulation (xterm/ttyd/node-pty): banned per ADR-001
  (no bionic pty, RAM, phone flicker). Functional parity instead (§UI).
* Go/Rust rewrite: saves ~30M per wrapper (ADR-003), but hub IS a pi
  process — a second runtime increases total RSS and loses ExtensionAPI
  + jiti `/reload`. Revisit only for pi-less boxes.

## Consequences

* Browsers lose `uplink_*`; hub dials mirrors. `008 one-WS-one-backend`
  amended: one WS per tab, but backends keyed by `cwd::file` and shared
  across tabs (phone+laptop = 1 child).
* `002 one-port` amended: one *browser* port (hub); plus one private
  socket (not a port).
* Memory: hub ~100M idle + 0 children; each live child ~80–150M.
  Discipline: explicit kill; optional `TAU_HEADLESS_TTL_MS>0` safety net
  (reaps only 0-client finished runs; active runs never reaped) and
  future `TAU_MAX_HEADLESS=N` LRU cap on `lastActiveMs`.
* Boot: Termux:Boot/systemd/launchd run hub; TUIs optional thereafter.

## UI/UX (hub web app)

Single-page vanilla JS (no framework, ADR-005). Three zones + two
overlays. All glyphs inline SVG, no emoji.

### Layout

```text
┌────────────┬──────────────────────────────┬───────────────┐
│ SIDEBAR    │  CHAT                        │ EXPLORER      │
│            │                              │ (per-session) │
│ Live dot   │  header: project, model,     │ breadcrumb    │
│ Projects   │  thinking, cost/context pill │ root switcher │
│ Sessions   │  ──────────────────────────  │ ───────────── │
│  group by  │  transcript (last 100 +      │ dir list      │
│  project   │  Load earlier)               │  folder ›     │
│  active●   │  tool cards w/ diff + time   │  file @insert │
│  run ▶     │  compaction pill             │ +New here btn │
│ search     │  ──────────────────────────  │               │
│ [+ New]    │  composer + queue pills      │               │
│            │  [+ New] [Kill] [Attach]     │               │
└────────────┴──────────────────────────────┴───────────────┘
```

### Key flows

1. **Cold open** → hub serves shell instantly (no session needed).
   Sidebar shows Projects (from `tau.projectsDir` + `tau.projects[]`,
   each with session count/recency/active dot) and Sessions grouped by
   project header `cwd`. Empty state: "Pick a project or New session".
2. **New session** (`+` in sidebar, `+New here` in explorer, bubble
   click): modal with Directory (prefilled from explorer/project,
   Browse drives explorer), Starter prompt (optional), Resume picker
   (Fresh vs recent files in that dir). Confirm → `new_session {cwd}`
   → optional starter `rpc_command prompt` → view clears, streams start,
   hash becomes `#session=<basename>` once discovered. Old sessions keep
   running (pi `/new` semantics).
3. **Resume**: click session → if live-owned, read-only preview +
   `Attach & Drive` banner (ADR-009); else `start_session {cwd, file}` +
   history `GET /api/sessions/:dir/:file` + explorer re-roots to header
   `cwd`. Reload rebinds via hash; second tab shares the child.
4. **Run**: Send → routed to bound headless (or attached mirror).
   Queue pills while streaming (steer), abort button, per-message usage
   → cost/context pills, compaction amber pill + inline resolution.
   Dialogs (`select/confirm/input/editor`) render as themed modals;
   abort-run targets the owning backend.
5. **Kill**: explicit Kill button / context menu → `close_session`
   (confirm modal). Nothing else kills — reload, tab close, run end,
   TTL (default off) all preserve.
6. **Explorer**: breadcrumb segments + Up + root switcher (This
   session/Projects/Home/Type path). Click folder drills, click file
   inserts `@path` into composer (drag-drop too). Native-open
   best-effort only.

### TUI parity target (functional, not pixel)

Prompt/steer/abort/queue, slash palette, all 4 dialogs incl. tool
approvals, model/thinking/cost/context/compaction, list/search/rename/
export/delete, deep-links, file+image attach — everything except raw
terminal pixels, which are out of scope.

## Rollout

* P0 hub hardening (health `{mode}`, null-`ctx` guards, ack `cwd`) —
  ~150 LoC.
* P1 projects+explorer (allowlist, `{parent}`, crumbs, `+New here`) —
  ~200 LoC.
* P2 persistent sessions + New/Kill/list (DONE server-side 2026-10-12;
  UI wiring remains) — ~400 LoC.
* P3 socket transport (replace uplink TCP dial with `hub.sock` +
  4-command allowlist, delete mirror `uplink_*`) — DONE 2026-10-13. The
  legacy `attachUplink`/`detachUplink` TCP proxy and its Basic-auth dial are
  removed; mirrors no longer proxy each other. Browsers still speak the
  `uplink_*` command names, but the hub is the only backend that answers.
* P4 polish (recents, LRU cap, mobile sheet, docs) — `TAU_MAX_HEADLESS` LRU
  cap DONE; anti-rebinding Host/Origin allowlist DONE (WS upgrade + `/api/*`).
  Recents/mobile-sheet remain.
```

Total server+UI delta ≈ 750–1,100 LoC, no new deps.
