# tau-web architecture

One package, one port: a hub serving one vanilla-JS UI, owning headless
backends — and relaying live terminal sessions dialed in over hub.sock
(ADR-014). Mirrors serve nothing directly (no per-TUI port, ADR-011).

## Big picture

```text
                    ┌──────────────────────────────────────────────────┐
                    │  tau-web hub (pi -e ./tau-web --mode rpc)         │
                    │  extensions/mirror-server.ts  ·  ONE PORT        │
                    │                                                  │
  browser ──HTTP──▶ │  static public/hub/  +  /api/*                   │
         ──WS /ws─▶ │                                                  │
                    │   ┌───────────────┐    ┌──────────────────┐       │
                    │   │  headless     │    │  attach relay    │◀──────┼── live TUIs
                    │   │  registry     │    │  (hub.sock +     │  dial-in
                    │   │  (spawned     │    │  uplink proxy)   │       │
                    │   │  pi --mode    │    └──────────────────┘       │
                    │   │  rpc children)│                              │
                    │   └───────────────┘                              │
                    └──────────────────────────────────────────────────┘
```

Role split: the hub owns the port and serves browsers; headless
children run sessions (one per WS); live TUIs ("mirrors") dial the hub
over `~/.pi/tau/hub.sock` and execute relayed drive commands. A mirror
never serves a browser directly.

## Connections per browser client

```text
                    ┌───────────────┐
                    │    browser    │  one WS = one headless backend
                    │   (one tab /  │  phone + laptop stay independent
                    │    window)    │
                    └───────┬───────┘
                            │ WS /ws (cookie)
              ┌─────────────▼─────────────┐
              │  mirror-server connection  │
              │  handlers                  │
              └──┬──────────┬──────────────┘
                 │          │
        headless │ legacy   │
        backend  │ commands │
           │     │ (get_commands,
           ▼     │  files, …)
      ┌────────┐ │
      │pi --mode│ │
      │rpc child│ │
      │(TAU_    │ │
      │DISABLED │ │
      │=1)      │ │
      └────────┘ │
      keyed by WS · persistent
```

## Prompt routing (client decides, server executes)

```text
  user hits Send
       │
       ▼
  ┌────────────────┐  yes   ┌─────────────────────────────┐
  │ driving a live │──────▶ │ {type:"uplink_command"}       │──▶ relayed to the
  │ TUI (uplink)?  │        └─────────────────────────────┘    driven TUI
  └───────┬────────┘
          │ no
          ▼
  ┌────────────────┐  yes   ┌─────────────────────────────┐
  │ headless bound?├──────▶ │ {type:"rpc_command"}          │──▶ pi --mode rpc child
  └───────┬────────┘        └─────────────────────────────┘
          │ no (fallback)
          ▼
        direct send (hub's own pi process)
```

Driving is preview-first (ADR-009): picking a live session loads its
history read-only with a confirm banner; only "Drive this TUI" wires
the uplink (`uplink_attach` → `uplink_attached`). Detach freezes the
view with a Drive-again banner — the file is never resumed headless
while its TUI runs (two writers, ADR-003).

## Event flow (server → browser, ADR-004 unified envelope)

```text
  headless child stdout (LF JSONL) ──▶ broadcast / sendTo ─▶ {type:"rpc_event", event} ─▶ UI rpcEvent path

  responses (start_session acks) ─▶ {type:"rpc_event", event:{type:"response"}, id}
                                        └─▶ correlated by id (pendingRpc map)
```

Session switching bumps `bindingEpoch`; stream handlers capture the epoch at
`message_start`/`agent_start` and drop anything stale. History renders the
last 100 entries with a Load-earlier control; the full log stays on disk.

Mirror frames (hub.sock → browser): a dialed-in TUI's live state
arrives as hello/status/snapshot/event frames over the socket and is
forwarded to attached browsers as `mirror_sync` snapshots and
`uplink_attached` / `uplink_detached` / `uplink_dead` / `mirrors_changed`
frames; the Live section (`/api/instances` + `uplink_list`) is the
human-visible side of the same data.

## Dialogs (ADR-007, no fallbacks, no two-drivers)

```text
  hub session needs select/confirm/input/editor
       │
       ▼
  ┌──────────────────┐   no browsers?   ┌──────────────────┐
  │ browser clients? ├─────────────────▶ │ native prompt     │
  └───────┬──────────┘                   └──────────────────┘
          │ browsers connected
          ▼
  broadcast {type:"event", event:{type:"extension_ui_request", id, method, …}}
  + hub shows "Dialog open in browser" notice (it does NOT also prompt)
          │
          ▼
  browser dialogs.js renders modal ─▶ user answers
          │
          ▼
  {type:"extension_ui_response", id, …}
          │
          ├─ id owned by headless child? ──▶ write to child stdin
          └─ else (hub's own ctx) ──▶ resolve wrapUiDialogs waiter
          (browser gone mid-dialog → waiter released back to native)
```

## Security gates

```text
  internet ─▶ cloudflared ─▶ 127.0.0.1:PORT ─▶ cookie-session auth (login form) ─▶ app
                                        ▲
                                        │ never 0.0.0.0 without auth (browsers use the
                                        │ HttpOnly tau_auth cookie; the WS handshake
                                        │ cannot carry headers)
  headless files ─▶ resolved under ~/.pi/agent/sessions/, traversal rejected
```

## Live processes (ADR-013)

Observability without driving: `GET /api/processes` scans `/proc` for
argv[0]/exe basename exactly `pi` (self excluded, hub children labeled
`hub`, everything else `live`) and the Settings → Server pane renders
one row per process with a Kill button. `POST /api/processes/kill`
retires hub-owned pids through the headless registry (bindings die
together) and TERM→KILLs live pids after a kill-time re-fingerprint —
bad pid `400`, stale pid `404`, hub-self `400`. Killed terminal
sessions keep their files; resume stays a headless `start_session`.
