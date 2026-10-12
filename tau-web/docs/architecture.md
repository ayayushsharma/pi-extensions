# tau-web architecture

One package, one port: a live-TUI mirror plus headless backends plus an
uplink proxy, serving one vanilla-JS UI.

## Big picture

```text
                    ┌──────────────────────────────────────────────────┐
                    │  tau-web pi extension (pi -e ./tau-web)          │
                    │  extensions/mirror-server.ts  ·  ONE PORT        │
                    │                                                  │
  browser ──HTTP──▶ │  static public/  +  /api/*                       │
         ──WS /ws─▶ │                                                  │
                    │   ┌────────────┐   ┌───────────────┐               │
                    │   │  mirror    │   │  headless     │   ┌────────┐  │
                    │   │  (own TUI  │   │  registry     │   │ uplink │  │
                    │   │   session) │   │  (spawned     │   │ proxy  │  │
                    │   └────────────┘   │  pi --mode    │   └────────┘  │
                    │                    │  rpc children)│      │       │
                    │                    └───────────────┘      │       │
                    └──────────────────────────────────────────┼───────┘
                             ▲                                 │ loopback WS
                             │ owns                  ┌─────────▼─────────┐
                    ┌──────────┴─────────┐           │ other live TUIs   │
                    │ own TUI session    │           │ (tau :12045, …)   │
                    │ (drivable)         │           │ driving their own │
                    └────────────────────┘           │ terminal sessions │
                                                     └───────────────────┘
```

## Connections per browser client

```text
                    ┌───────────────┐
                    │    browser    │  one WS = one headless backend
                    │   (one tab /  │  phone + laptop stay independent
                    │    window)    │
                    └───────┬───────┘
                            │ WS /ws  (cookie; uplink dials use Basic)
              ┌─────────────▼─────────────┐
              │  mirror-server connection  │
              │  handlers                  │
              └──┬──────────┬──────────┬───┘
                 │          │          │
        headless │ uplink   │ mirror   │ legacy
        backend  │ proxy    │ session  │ commands
           │         │          │       (get_commands,
           ▼         ▼          ▼        files, …)
      ┌────────┐ ┌────────┐ ┌────────┐
      │pi --mode│ │live TUI│ │own TUI │
      │rpc child│ │:12045  │ │session │
      │(TAU_    │ │(WS     │ │(ctx    │
      │DISABLED │ │proxy)  │ │events) │
      │=1)      │ │        │ │        │
      └────────┘ └────────┘ └────────┘
      keyed by WS · TTL-reaped
```

## Prompt routing (client decides, server executes)

```text
  user hits Send
       │
       ▼
  ┌────────────────┐  yes   ┌─────────────────────────────┐
  │ uplink attached?├──────▶ │ {type:"uplink_command"}      │──▶ live TUI owns the run
  └───────┬────────┘        └─────────────────────────────┘
          │ no
          ▼
  ┌────────────────┐  yes   ┌─────────────────────────────┐
  │ viewing mirror │──────▶ │ {type:"prompt"} (direct)      │──▶ own TUI session
  │ live session?  │        └─────────────────────────────┘
  └───────┬────────┘
          │ no
          ▼
  ┌────────────────┐  yes   ┌─────────────────────────────┐
  │ headless bound?├──────▶ │ {type:"rpc_command"}          │──▶ pi --mode rpc child
  └───────┬────────┘        └─────────────────────────────┘
          │ no (fallback)
          ▼
        direct send (legacy mirror path)
```

## Event flow (server → browser, ADR-004 unified envelope)

```text
  mirror ctx events ──┐
                      ├─▶ broadcast / sendTo ─▶ {type:"rpc_event", event} ─▶ UI rpcEvent path
  headless child ─────┤                              ▲
  stdout (LF JSONL) ──┘                              │
  uplink upstream WS ── re-wrap {type:"event"} ──────┘  (+ uplink:true, port)

  responses (start_session / uplink_list acks) ─▶ {type:"rpc_event", event:{type:"response"}, id}
                                                        └─▶ correlated by id (pendingRpc map)
```

Session switching bumps `bindingEpoch`; stream handlers capture the epoch at
`message_start`/`agent_start` and drop anything stale. History renders the
last 100 entries with a Load-earlier control; the full log stays on disk.

## Dialogs (ADR-007, no fallbacks, no two-drivers)

```text
  TUI session needs select/confirm/input/editor
       │
       ▼
  ┌──────────────────┐   no browsers?   ┌──────────────────┐
  │ browser clients? ├─────────────────▶ │ native TUI prompt │
  └───────┬──────────┘                   └──────────────────┘
          │ browsers connected
          ▼
  broadcast {type:"event", event:{type:"extension_ui_request", id, method, …}}
  + TUI shows "Dialog open in browser" notice (it does NOT also prompt)
          │
          ▼
  browser dialogs.js renders modal ─▶ user answers
          │
          ▼
  {type:"extension_ui_response", id, …}
          │
          ├─ id owned by uplink? ──▶ forward to upstream TUI
          ├─ id owned by headless child? ──▶ write to child stdin
          └─ else (mirror) ──▶ resolve wrapUiDialogs waiter
          (browser gone mid-dialog → TUI waiter released back to native)
```

## Security gates

```text
  internet ─▶ cloudflared ─▶ 127.0.0.1:PORT ─▶ cookie-session auth (login form) ─▶ app
                                        ▲
                                        │ never 0.0.0.0 without auth (browsers use the
                                        │ HttpOnly tau_auth cookie; the WS handshake
                                        │ cannot carry headers)
  uplink attach ─▶ instance registry ─▶ /api/health fingerprint (mode=mirror)
                ─▶ /proc/<pid>/cmdline is pi ─▶ loopback-only ─▶ Basic re-auth
  headless files ─▶ resolved under ~/.pi/agent/sessions/, traversal rejected
```
