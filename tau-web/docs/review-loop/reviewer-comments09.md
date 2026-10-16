# VERDICT: PASS-WITH-NITS

T9 review — S8 (`set_auth` re-auth), S13 (token expiry), S12 (Basic-auth backoff).
Reviewed diff: `git diff ed4aa58cd20e4ec7dc80547c019913f6b9be194d` + untracked files.
Working tree: only `tau-web/extensions/mirror-server.ts` modified (+117/−13) and
`tau-web/docs/review-loop/coder-comments09.md` untracked. No product code was edited by this review.

## Evidence

### 1. Project suite — exact result

```
$ node tests/run.mjs
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (31ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6007ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3519ms) late session_file pins #session + tab
  PASS H4 (3487ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18128ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1511ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3090ms) Live section lists the running TUI with Drive controls
  PASS H9 (3187ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (5946ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1264ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1264ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3508ms) uplink relay frames answered, dead frames silent
  PASS D5 (3101ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (515ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

Caveat recorded during review: D5 (and the whole e2e suite) runs against
`tests/hub-stub.mjs`, **not** `extensions/mirror-server.ts`, so the suite alone does not
exercise this diff. The real-hub probe below is the load-bearing evidence.

### 2. Real-hub probe (independent, mirrors the shipped code)

Booted the actual extension: `pi -e <repo>/tau-web --mode rpc` with
`TAU_USER=t9user TAU_PASS=t9pass-123`, temp `HOME` (so `saveTauSetting()` never touched the
user's real `~/.pi/agent/settings.json`), seeded temp `settings.json`, `TAU_ROLE=hub`.
Plus wrangler-driven `NODE_OPTIONS=--require` fake-clock to jump `Date.now()` +31 days on demand.
Results (all from `/tmp/t9-probe-report.json`):

- **S8** — `get_auth` `{configured:true,enabled:true}` (unchanged). WS `set_auth`:
  - `{enabled:false}` no pass → `success:false, "Invalid password"`; anon `/api/sessions` still **401**; settings untouched.
  - `{enabled:false, pass:"wrong"}` → `success:false, "Invalid password"`; anon still **401**; settings untouched.
  - `{enabled:false, pass:correct}` → `success:true`; anon **200**; temp settings persisted `authEnabled:false`.
  - re-enable with correct pass → `success:true`; anon **401**; persisted `authEnabled:true`.
  - Same journey via `POST /api/rpc` (the UI's actual transport): no/wrong pass → HTTP 200 + `success:false`, anon 401; correct pass works.
- **S13** — forged cookie `tau_auth=forged123` → **401**. Login → cookie
  (`HttpOnly; SameSite=Lax; Max-Age=2592000`). Fake-clock advanced +31 days: pre-advance
  token → **401**; fresh login after the jump → **200**. (TTL path executed in the real process.)
- **S12** — wrong Basic on `/api/instances`, 8 attempts:
  ms `[1, 1, 1, 502, 1002, 1502, 2002, 2002]`, all **401**; correct Basic right after → **200 in 2ms**;
  next wrong → **401 in 1ms** (counter cleared). WS upgrade with wrong Basic: `[3, 2, 2, 502]` all 401,
  correct Basic after → opens in 2ms. Wrong `/api/login` still `401` after ~503ms (login response shape unchanged).
- The user's real `~/.pi/agent/settings.json` remained `tau.authEnabled:true` after all probes.

### 3. Real-browser UX pass (`scripts/review-loop/deep_ui.py`, Playwright)

Ran against a real hub on a random port with auth enabled:
`pageerrors: []`, `errors: []`, `requestfailed: []`.
Steps passed included `login-overlay-visible` → `login-ok` (Connected) → sessions sidebar →
new headless session → reload-rejoin → logout-login roundtrip → mobile layout
(`horiz_overflow_px: 0`). The logged console 401s are the expected pre-login anonymous
fetches; there were no new error shapes.

### 4. Robustness probe for the new `await` window

8 wrong-Basic requests + 3 wrong `/api/login` requests were aborted mid-backoff
(250ms) each: hub stayed alive, `exitCode null`, no `uncaught` / `ERR_STREAM_DESTROYED` /
`ERR_HTTP_HEADERS_SENT` in stderr. No crash from the async `serveStaticFile` / `upgrade` change.

## Code paths inspected

- `mirror-server.ts:76-98` — auth constants, `authTokens: Map<string, number>`, TTL/threshold constants.
- `:99-134` — `pruneExpiredAuthTokens`, `isAuthTokenValid`, `basicClientKey`, `recordBasicFailure`,
  `clearBasicFailures`, `basicBackoffMs`, `sleepAuthBackoff`.
- `:195-201` — `mintAuthToken` (prune, stamp, 200-cap evicts oldest).
- `:421-436` — `saveTauSetting` / `credentialsMatch` (unchanged).
- `:439-457` — `authPassMatches` (timing-safe, empty/length-mismatch fails closed), `checkCookieAuth` (lazy prune + TTL).
- `:463-478` — `parseBasicCredentials`, `checkWsAuth` (now only used by the throttled log).
- `:1629-1650` — `get_auth` untouched; `set_auth` re-auth gate before in-memory flip + persist + broadcast.
- `:1666-1720` — `serveStaticFile` async; API gate cookie-first, Basic success clears, failure records + delays + 401;
  anti-rebinding, static serving, `handleApiRoute` untouched.
- `:1835-1900` — `/api/login`, `/api/logout` (responses/cookie attrs unchanged; logout still deletes the Map entry).
- `:3205-3240` — `server.on("upgrade", async ...)` with the same cookie/Basic policy before `handleUpgrade`.
- `public/app.js:1555` — only `set_auth`/`get_auth` reference is `/api/rpc` routing; no UI caller sends `set_auth`.

## Regression checks

- No UI/resource files changed; login overlay, `/api/login` JSON+Set-Cookie, `/api/logout`, `get_auth`,
  `/api/health`, anti-rebinding, static fallback, `checkWsAuth` usage outside the gate all unchanged in behavior.
- Cookie/WS auth semantics: cookie still first, no `WWW-Authenticate` (verified `wwwAuth:null`), forged/expired 401,
  fresh token 200, logout revokes (D5 + deep UI roundtrip).
- `node tests/run.mjs` 16/16, including D5; deep UI pageerrors 0.

## Issues

No blocking issues. The three findings are fixed and independently reproduced against the real server.

### Nits (non-blocking, optional follow-ups)

1. **Duplicated decay constant** — `extensions/mirror-server.ts:89` defines `LOGIN_FAIL_WINDOW_MS`
   and the new Basic helpers use it, but `/api/login` still hardcodes `10 * 60 * 1000` at ~line 1882.
   Behavior is identical; using the constant would give one source of truth.
2. **Double credential compare on failed basic requests** — the throttled access log (~line 1688) calls
   `checkWsAuth(req)` (cookie-or-Basic compare) *before* the S12 gate compares again. Log-only, negligible CPU,
   but the log could report `auth=no` without re-comparing.
3. **Backoff delays the answer, not the compare** — `credentialsMatch` runs first and the delay is applied only
   to the 401 path (~1709-1716, ~3217-3221), so a *parallel* flood still executes one compare per request before
   the counter delays anything (serial guessing is throttled to 500/1000/1500/2000ms as required). This mirrors
   the existing `/api/login` design and matches the task's "record the failure, then delay the 401" wording;
   moving the wait before the compare would additionally bound parallel guessing (at the cost of delaying a
   correct retry). Residual hardening only, as the coder already noted.
4. **First 3 failures are free** — `BASIC_AUTH_FAIL_THRESHOLD=3` means a client gets 3 immediate guesses per
   10-min decay window. This is the spec's explicit "small threshold / don't slow a single typo" trade-off, not a defect.

## Verdict rationale

Every acceptance criterion was reproduced against the real extension, not just the stub suite:
`set_auth` fails closed without/with a wrong password (WS and `/api/rpc`) and does not change state or settings;
expired and forged tokens 401 while fresh logins work; Basic failures ramp 1ms→2s across attempts, never succeed,
and a correct request still clears the counter and succeeds; `node tests/run.mjs` is 16/16 including D5; the
real-browser pass reports zero pageerrors and an unchanged login/logout flow. Remaining items are style/optional
hardening only.

VERDICT: PASS-WITH-NITS
