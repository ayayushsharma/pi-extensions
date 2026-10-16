# T11 review — session-store caching (P1, P2, P5)

VERDICT: PASS-WITH-NITS

## Scope inspected

Working tree vs baseline `88ef3617146ec08f9cbc0accba01b5f3830c02c5`:

- `tau-web/extensions/mirror-server.ts` (+112/−12): per-file `sessionSummaryCache`
  (`cachedParseSessionFile`, `sweepSessionSummaryCache`, `invalidateSessionSummary`),
  `tmuxInstalled` probe + 8 s `getTmuxSessionFiles` cache, 10 s
  `sessionInfoMapCache` in `buildSessionInfoMap`, mutation-path invalidation.
- `tau-web/public/app.js` (+4/−2): `pollInstances` interval 5 s → 30 s; the
  `mirrorsChanged` listener is kept.
- Untracked: `docs/review-loop/coder-comments11.md` only. No other files changed.
  No product code was edited by this review.

Code paths read in full: the two cached call sites (`/api/sessions/summaries`,
`serveSessionsList`), `parseSessionFile` (early break semantics), the
`/api/sessions/rename|delete|fork` handlers, `buildSessionInfoMap` /
`serveProjectsList`, `getTmuxSessionFiles`, and `public/app.js`
(`pollInstances` + `mirrorsChanged` + interval list).

## Evidence

### Tests

`node tests/run.mjs` (fresh run, whole suite):

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 ... PASS H2 ... PASS H3 ...
  PASS H12 (1261ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1273ms) picker endpoints: summaries + mkdir + fork
  PASS D1 ... PASS D5 ... PASS P2 ...
16/16 passed
```

H2/H3 (app boot, late session_file pin) and H13 (summaries + fork against a
real hub with a throwaway `PI_CODING_AGENT_SESSION_DIR`) pass against the
changed code. The exact suite line captured is `16/16 passed`.

### Independent before/after measurement

Fresh 100-session store (5 project dirs × 20 files, pi-style dir names, real
cwds), real hub booted per run. Baseline was run from a temporary git worktree
at `88ef361` (node_modules symlinked), current from the working tree; ports
18401/18402.

| metric | baseline 88ef361 | current |
|---|---|---|
| `/api/sessions` ms (6 calls) | 830.2 756.0 760.9 817.6 771.4 814.0 | 813.4 3.8 3.7 2.1 4.0 3.9 |
| `/api/sessions/summaries` ms (3) | 17.5 21.0 25.6 | 4.0 3.8 3.2 |
| `/api/projects` ms (3) | 4.7 3.1 2.6 | 3.9 1.4 1.0 |

Response equality (JSON-aware, `mtime` excluded — it is live by design):

- baseline vs current `/api/sessions`: equal
- baseline vs current `/api/sessions/summaries`: equal
- current cold (call 1) vs warm (call 3): equal; baseline the same

No `id`/`firstMessage`/`name`/`cwd`/`file`/`filePath`/ordering differences.

Mutation visibility, all on the next request (no TTL involved for these):

- external add → visible in `/api/sessions` (100 → 101)
- external delete → gone (101 → 100)
- external rewrite of a first message → new marker visible
- hub endpoints: `rename` → new name visible immediately in `/api/sessions`;
  `fork` → `/api/projects` count 2 → 3 immediately; `delete` → 3 → 2
  immediately (invalidation works for hub-driven changes)

tmux not installed: hub booted with a PATH containing no tmux → every
`/api/sessions` call 2.9–6.1 ms, including one after a 9 s gap; the negative
probe result is remembered as claimed.

### Real-browser pass

`deep_ui.py` (Playwright) ran against the working tree:
`pageerrors: []`, `errors: []`, 19 steps clean, `/api/sessions` warm timings
4.1–6.7 ms on the real store (116 sidebar items), prompt round-trip PONG,
reload/rejoin, live preview, mobile no overflow. Two screenshots inspected
(`99-final-desktop.png`, `11-live-section.png`) — sidebar/home surfaces render
normally; nothing in the UI depends on the changed internals.

## Regression checks

- Response shape byte-identical ignoring `mtime` (both endpoints).
- Sidebar and picker both still read the same `/api/sessions` /
  `/api/sessions/summaries` data; only latency changed. No UI code paths
  touched beyond the poll interval.
- P2: `mirrorsChanged` handler retained (`public/app.js`), no other
  instance poll added; 30 s safety-net interval only.
- Cache invalidation verified for delete/rename/fork endpoints; `sweep`
  drops deleted/renamed-away files from the map.
- Function-declaration hoisting of `cachedParseSessionFile` /
  `parseSessionFile` is safe (both hoisted at closure creation; exercised by
  every real-hub boot).

## Issues

Blocking: none. The finding is fixed for `/api/sessions` (per-file parse is
cached, warm calls 2–4 ms, identical data, mutations immediate) and the suite
is green.

Nits / follow-ups (non-blocking):

1. `/api/projects` freshness (extensions/mirror-server.ts, `buildSessionInfoMap`).
   `sessionInfoMapCache` is a 10 s TTL, not the "(mtime,size) cache" P5
   suggested, so out-of-band (non-hub) session writes are invisible to
   `sessionCount`/`lastActive` for up to 10 s. Measured: warm count 20,
   external add → `/api/projects` still 20 while `/api/sessions` shows it;
   after 11 s → 21; same for delete. Hub-driven rename/delete/fork invalidate
   immediately, and the per-request readdir+stat it replaced measured only
   1–4 ms, so the TTL buys almost nothing for real staleness. Consider keeping
   the exact per-request pass or keying counts off the already-cached stats.
2. tmux cache TTL 8 s is shorter than the hub's 15 s `/api/sessions` poll
   (`public/hub/hub.js` line ~396). On this host (11 tmux panes) `pgrep`/`lsof`
   costs 646–712 ms, so a call >8 s after the previous one still pays it
   (measured 727 ms then 4 ms back-to-back, 778 ms after a 9 s gap). Parse work
   is indeed cached, but the 15 s poll stays expensive on tmux-heavy hosts.
   The task explicitly prescribed 5–10 s, so this is a follow-up: consider
   TTL ≥ the poll interval or a cheaper liveness probe.
3. Stale comment in `public/app.js` above the `mirrorsChanged` handler:
   "instead of waiting for the next 5s poll" — the interval is now 30 s.
4. `getTmuxSessionFiles` returns the cached `Set` by reference, and a failed
   `command -v tmux` probe permanently pins `tmuxInstalled = false`. Both are
   fine with today's callers (`.has()` only) but are latent traps if the
   function is reused with a transient failure or a mutating caller.
5. The `session_info` rename is invisible for files where the entry lands past
   the `parseSessionFile` 50-line early break. Pre-existing (baseline behaves
   identically), correctly flagged by the coder; only noted so it is not
   mistaken for a cache regression. The rename endpoint's cache invalidation
   itself is correct.

VERDICT: PASS-WITH-NITS
