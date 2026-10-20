# ADR-021 — One hub per machine: advert-scoped singleton, no port bumping

Status: **accepted** (2026-10-21). Implemented in `extensions/lib/hub/singleton.ts`
+ `extensions/lib/hub/hub.ts`; pinned by `tests/unit/singleton.test.ts`.

## Context

A hub is a singleton control plane: one runner registry, one `hub.sock`
relay, one advert file (`~/.pi/agent/pi-hub/hub.json`) that every mirror
uses for discovery. But nothing enforced it:

- `Hub.listen` bumped silently to `port+1 … +5` on `EADDRINUSE`. A second
  hub started beside the real one (tunnel still pointed at the old port),
  owning its own runners and relay while the UI showed the first hub's
  sessions. The runit service (`deploy/runit/run`) already worked around
  this externally with a pre-flight port probe — the in-process bump
  defeated the intent of that guard for any other starter.
- `hub.sock` conflicts were non-fatal: the second hub logged
  `hub.sock unavailable` and kept serving HTTP without the relay.
- The advert file was last-writer-wins with no liveness check, so two hubs
  could each believe they were *the* hub while mirrors flap between them.

Failure mode on the phone host: prod hub on `:12045` plus a dev hub (or a
restarted service racing the old process) = two registries, prompts routed
to the wrong child, mirrors attached to a hub the browser never sees.

## Decision

1. **The advert file is the singleton record**, keyed by advert path
   (`extensions/lib/hub/singleton.ts`). `claimSingleton()` runs before any
   bind: if `findLiveHub()` reports a live owner, the starter throws naming
   the owner (`pid, host:port, sock, startedAt`) and how to resolve it
   (stop the hub, or use a different `PI_HUB_PORT` *with* its own
   `PI_HUB_ADVERT_FILE`). Stale claims are reclaimed by overwrite.
2. **Liveness is pid + reachability, never either alone:**
   `live = pid alive AND (claimed within 10 s grace OR tcp port accepts OR sock accepts)`.
   Pid alone recycles; file existence alone survives hard kills. The grace
   covers the window where the claimant has written the advert but not yet
   bound its port/socket. Own-pid claims are always reclaimable.
3. **Bind exactly the configured port.** `EADDRINUSE` is a fatal,
   actionable error, not a bump. `stop()` only closes a server that
   actually bound (a failed bind leaves nothing to close).
4. **A live `hub.sock` conflict is fatal.** Other socket errors keep the
   old degrade-to-HTTP behaviour; `another hub is listening` refuses to
   start a second hub.
5. **Simultaneous starts close via post-bind re-read.** Two starters can
   both pass the pre-check; the advert keeps the last writer, so after
   binding each re-reads it and the loser stands down (closes what it
   bound, releases nothing — the advert isn't its) instead of running as
   an unadvertised shadow hub. Costs one 250 ms sleep at startup.
6. **Release is owner-only** (pid match), so a dying hub can never
   withdraw its successor's claim. Claims are written atomically
   (tmp + rename).

Scope note: production hubs share the default advert path, so exactly one
runs per machine. Tests isolate with a per-hub `PI_HUB_ADVERT_FILE` and
stay parallel — no opt-out flag, so the invariant cannot be switched off
in production by accident.

## Alternatives rejected

- **Fixed global lock file / mutex socket independent of config:** same
  effect for production, but serializes the parallel test suite (each
  group boots its own hub) unless paired with a bypass flag — and a
  bypass flag is exactly the accident vector this ADR removes.
- **Keep bumping, document "check the log for the real port":** the tunnel,
  the advert, bookmarks and muscle memory all point at the configured
  port. A hub on a surprise port is a shadow hub by definition.
- **Kill-the-other-hub (takeover):** a stale-path probe can be fooled
  during the victim's restart window; murdering a live registry destroys
  running agents. Refuse, never preempt.
- **`flock` on the advert:** no dependency-free cross-platform flock in
  Node; the claim + reachability + post-bind re-read closes the same races
  with primitives already in the codebase.

## Consequences

- `pi -e pi-hub --mode rpc` while a hub is up fails fast with the owner's
  pid/port/sock in `pi-hub.log`. Supervised restarts are unaffected: a
  dead pid (or an alive-but-unreachable one past grace) is reclaimed.
- `scripts/dev-hub.sh` shares the default advert path, so a dev hub
  refuses while the prod hub is up (and vice versa) — stop one first.
- `deploy/runit/run`'s pre-flight port probe is now redundant with the
  in-process check but stays as a fast fail before jiti loads.
- New case D7 in `docs/testing.md`; unit pins in
  `tests/unit/singleton.test.ts` (no hub boot needed).
