# Coder comments — T5 (B8 duplicate functions + B9 hub.sock lifecycle), round 1

## 1. What changed

Two files, no new dependencies, no protocol changes, no change to the
hub↔mirror frame protocol or the browser API.

### `extensions/mirror-server.ts` — B8: deleted the duplicate block

- Before: `cwdToSessionDir`, `lossyDecodeSessionDir`, and
  `resolveHeadlessSessionPath` were each declared twice in the same closure —
  once under the `tau-web: session path resolution (L6)` banner before
  `buildStateSnapshot`, and an identical copy under a repeated banner after
  it. Last-wins at runtime; would fail `tsc` (TS2393) the day a tsconfig lands.
- After: the second copy (the block after `buildStateSnapshot`, previously
  ~lines 860–882) is deleted. The kept copy is byte-identical (verified with
  `diff`: the two blocks differed only by a leading blank line). `grep`
  confirms exactly one declaration of each function. The `hubSockets.start()`
  call site is untouched.

### `extensions/lib/hub-socket.ts` — B9: non-destructive start/stop

- Before: `start(): void` did `mkdir -p` then unconditional
  `fs.unlinkSync(sockPath)` before `listen` — a second hub silently stole a
  live hub's path. `stop(): void` did unconditional `unlinkSync` — a stopping
  old hub deleted a newer hub's socket. (`server.close()` itself also unlinks
  the path — verified empirically, see §3 — so the old `stop()` deleted the
  file twice over.)
- After:
  - New module-private `probeSocketLive(sockPath, timeoutMs = 500)`: resolves
    `true` when a connect succeeds (live hub — file must not be touched),
    `false` when dialing fails fast (`ECONNREFUSED`/`ENOENT`/non-socket =
    stale file). A connect that *hangs* past the timeout resolves `true`
    (safe direction: unlinking on a timeout could steal a loaded hub's socket).
    The probe sends nothing and never registers a mirror (hub ignores
    pre-hello frames; verified `list()` stays empty after a refused probe).
  - `start()` is now `async start(): Promise<boolean>`. When the path exists
    it probes first: live → report via `onError` ("refusing to steal it") and
    return `false` without unlinking/binding; stale → unlink and bind as
    before. Resolves `true` once listening, `false` when refused or the bind
    failed. A failed bind now also clears `this.server` (pre-listening
    errors only) so a later `start()` can retry instead of wedging.
  - Inode ownership: the `{dev, ino}` of the just-bound file is captured in
    the `listen` callback (earliest observation, `boundId`) and stored as
    `boundSocket`. New helpers `isOurSocket` / `removeIfOurs` compare-before-
    unlink. `stop()` closes **and** unlinks only while the file is still ours;
    a refused/failed start (`boundSocket == null`) removes nothing.
  - `startGen` generation counter: `stop()` during an async `start()`
    (probe/bind window) cancels the pending start; its teardown closes/unlinks
    only what is still ours, otherwise `unref()`s the orphaned listener so it
    can't hold the event loop open.
  - `start()` never rejects: `mkdir` failure and sync `listen` throws are
    routed to `onError` + `false`, so the existing floating call
    `hubSockets.start()` in `mirror-server.ts` needs no change. The 0600
    `chmod` and 0700 dir behavior are unchanged.

## 2. How it was verified

- B8: `grep -n "function cwdToSessionDir\|function lossyDecodeSessionDir\|function resolveHeadlessSessionPath" extensions/mirror-server.ts`
  → exactly one hit each (lines 811/820/823). Pre-edit `diff` of the two
  blocks → identical modulo a blank line.
- B9 contract probe (`/tmp/hub-contract.cjs`, loads the real TS source via
  pi's jiti, isolated `TAU_HUB_SOCKET` temp path) — **27/27 pass**:
  - two sequential start/stop cycles on the same path (same instance + new
    instance), socket file appears/disappears, mode 0600, answers connects;
  - stale regular file at the path is unlinked + bound + cleaned on stop;
  - `start()` on a live listener returns `false`, logs "refusing to steal it"
    via `onError`, socket inode unchanged, live hub still serving, no mirror
    registered by the probe;
  - refused hub's `stop()` leaves the live hub's socket in place and serving;
  - hello after a refused probe still registers a mirror (normal flow intact);
  - takeover simulation (file replaced, old owner stops late): old `stop()`
    does not delete the new socket (inode guard), new hub still serving, new
    `stop()` removes its own file;
  - double `start()` on one instance resolves `true` twice.
- Project suite: `node tests/run.mjs` (stub hub, default matrix) → exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (36ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (7269ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3806ms) late session_file pins #session + tab
  PASS H4 (3529ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18241ms) no-ack backend shows exact 15s timeout message
  PASS H6 (9ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1512ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3106ms) Live section lists the running TUI with Drive controls
  PASS H9 (3150ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4618ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1780ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1280ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3510ms) uplink relay frames answered, dead frames silent
  PASS D5 (3050ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (520ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

- Real-hub single-hub path (async `start()` through the real extension):
  `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` → `1/1 passed`
  (`PASS H6 (3185ms) start_session + prompt HEADLESS-OK round-trip`).
- `git status` shows only `extensions/lib/hub-socket.ts` and
  `extensions/mirror-server.ts` modified; `docs/code-review.md` and
  `tests/browser.mjs` untouched; nothing committed. No tsconfig exists in the
  package, so no `tsc` run was possible; the TS was instead executed directly
  (jiti) by the contract probe above.

## 3. Reviewer double-checks and residual risk

- **Please confirm the `start(): void` → `Promise<boolean>` change is
  acceptable.** The only caller (`startHubSocket`) floats the promise; it can
  never reject (all throw paths route to `onError` + `false`). If you prefer
  an explicit `void hubSockets.start();`, say so — behavior is identical.
- **Key discovery to double-check: `server.close()` unlinks the socket file
  itself.** Reproduced with plain `net` (bind A → unlink → bind C → `A.close()`
  → C's file gone, `/tmp/close-test.cjs`). That is why `stop()` and the
  stale-generation teardown now *skip `close()`* unless the path still holds
  our inode, and `unref()` instead. If you know a supported API to close a
  unix listener without unlinking, the orphaned-fd compromise (below) could
  be removed.
- **Residual leak:** in the takeover case the old hub's listener fd stays
  open (unreachable via the path, no connections, `unref()`ed, released on
  process exit). One fd per takeover event; hub shutdown normally exits the
  process anyway. Accepted as the price of never deleting a live file.
- **Races:** two hubs racing on a *stale* path can both pass the probe; the
  loser gets `EADDRINUSE` via `onError` + `false` and may retry (previously
  impossible — wedged server). Inode comparison has the usual
  stat-then-act window plus theoretical dev+ino reuse; both negligible for a
  same-UID local socket. Probe timeout (500 ms) resolves to *live*; a stale
  file fails in ~1 ms, so crash-recovery bind is not delayed.
- Contract/debug scripts live in `/tmp` (`hub-contract.cjs`, `hub-debug.cjs`,
  `close-test.cjs`) and are intentionally not checked in.

## 4. Retry-round comments addressed

- Not a retry round (first T5 attempt); no prior reviewer comments to address.
