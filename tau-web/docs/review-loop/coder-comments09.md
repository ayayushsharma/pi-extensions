# T9 coder comments — Harden auth lifecycle: set_auth re-auth, token expiry, Basic backoff (S8, S12, S13)

## 1. What changed (one product file: `extensions/mirror-server.ts`)

**S8 — `set_auth` now requires the current password.**
Before: the `set_auth` WS case checked only `AUTH_CONFIGURED`, then flipped the module-level `authEnabled` and persisted `authEnabled:false` to `settings.json` with no re-auth — an XSS with a live socket could persist auth-off.
After: the case requires `command.pass` to match `AUTH_PASS` via a new timing-safe `authPassMatches()` helper (`Buffer` + `timingSafeEqual`, empty/length-mismatch fails closed). Missing/wrong pass returns `{success:false, error:"Invalid password"}` and changes neither `authEnabled` nor settings; correct pass preserves the old behavior (flip + `saveTauSetting("authEnabled")` + `auth_changed` broadcast + `success`). `get_auth` is untouched.

**S13 — cookie tokens now expire after 30 days.**
Before: `authTokens: Set<string>` with no timestamp; a minted token lived until restart (cookie `Max-Age=2592000` suggested 30 days but the server never enforced it).
After: `authTokens: Map<string, number>` (token → `createdAt`), `AUTH_TOKEN_TTL_MS = 30*24*60*60*1000`, `pruneExpiredAuthTokens()` + `isAuthTokenValid()` helpers. `mintAuthToken()` prunes, stamps `Date.now()`, and keeps the existing 200-token cap (evicts oldest `keys().next()`). `checkCookieAuth()` prunes lazily on each check then validates TTL (expired entries are deleted and return false). Logout (`delete`) and the 200-cap semantics are unchanged.

**S12 — Basic-auth failures reuse `loginFailures` with progressive backoff.**
Before: `checkWsAuth()` did a bare `credentialsMatch()` on every API/WS-upgrade request; only `/api/login` had backoff (500ms × fails, 10-min decay, 5s cap).
After: shared-counter helpers (`LOGIN_FAIL_WINDOW_MS`, `BASIC_AUTH_FAIL_THRESHOLD=3`, `BASIC_AUTH_BACKOFF_CAP_MS=2000`, `recordBasicFailure` / `clearBasicFailures` / `basicBackoffMs = min(500*(fails-3), 2000)` / `sleepAuthBackoff`). Both gates were rewritten to the same policy: cookie valid → allow (no accounting); no `Authorization` header → immediate 401 (no record, no delay); Basic match → `clearBasicFailures` + allow (no delay, so a correct request after failures succeeds fast); Basic mismatch → `recordBasicFailure` + `await` the progressive wait (0 for fails 1–3, then 500/1000/1500/2000) before the 401. HTTP gate is in `serveStaticFile` (now `async`, `await sleepAuthBackoff` before `sendAuthRequired`); WS gate is in `server.on("upgrade")` (now `async`, same wait before `401` + `destroy`). The `/api/login` path (including its Basic fallback) is untouched, and the `apiAccessLog` line still calls the pure `checkWsAuth` (cookie-or-Basic compare, now TTL-aware, no side effects).

## 2. How it was verified

Project suite (stub hub, contract unchanged):
```
$ node tests/run.mjs
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (31ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (5975ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (4101ms) late session_file pins #session + tab
  PASS H4 (3923ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18133ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1511ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3056ms) Live section lists the running TUI with Drive controls
  PASS H9 (3125ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4587ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1269ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1280ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3512ms) uplink relay frames answered, dead frames silent
  PASS D5 (3064ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (512ms) hardening: traversal, rebinding, dead WS contract
16/16 passed
```

Real-hub probes (throwaway `pi -e ./tau-web --mode rpc` on 127.0.0.1 with `TAU_USER=t9user TAU_PASS=t9pass-123`, `TAU_ROLE=hub`):
- Anon `GET /api/sessions` → 401; forged `tau_auth=forged123` → 401; `POST /api/login` correct → 200 with `HttpOnly; SameSite=Lax` cookie containing `Max-Age=2592000`; cookie → `GET /api/sessions` 200; correct Basic → 200.
- HTTP Basic backoff on cheap `/api/instances` (isolates auth from the ~0.8s `/api/sessions` scan): wrong #1/#2/#3 → 401 in 2–3ms (single-typo fast); #4 → 505ms; #5 → 1004ms; correct after failures → 200 in 2–3ms (clears counter; next wrong fast again). On `/api/sessions` the same wrongs show 4/3/2/503/1002/1503ms and correct succeeds 200 (the ~800ms there is the session-scan cost, confirmed by the `/api/instances` control).
- WS Basic backoff: wrong #1/#2/#3 → 401 in 11/2/2ms; #4 → 502ms; #5 → 1003ms; correct after → open in 4ms.
- WS `set_auth` (cookie-authed socket): `get_auth` → `{success:true, configured:true, enabled:true}` (unchanged); `set_auth {enabled:false}` no pass → `{success:false, "Invalid password"}` and anon still 401; `set_auth {enabled:false, pass:"wrong"}` → same failure and anon still 401; `set_auth {enabled:false, pass:correct}` → `{success:true, enabled:false}` and anon 200; anon-WS `set_auth {enabled:true, pass:correct}` → success and anon back to 401. Final `~/.pi/agent/settings.json` restored to `tau.authEnabled:true`.
- WS upgrade with no credentials while enabled → 401 (anon WS cannot connect; `ws` raises `Unexpected server response: 401` as expected).

## 3. Reviewer double-checks, residual risk

- Threshold/cap choice: `BASIC_AUTH_FAIL_THRESHOLD=3` (first 3 failures immediate, 4th+ 500/1000/1500/capped 2000) is the "small threshold + mirror login slope capped ~2s" reading of S12. If the reviewer wants every failure delayed (pure `min(500*fails,2000)`), change `basicBackoffMs` to drop the `-THRESHOLD` term — one line.
- Shared counter: Basic and `/api/login` share `loginFailures` per IP by design (S12 says reuse). A Basic-guessing burst also slows the next `/api/login` for that IP, and a correct Basic clears login failures for that IP. No eviction was added (S9 out of scope); the map still grows by IP.
- Success path does the credential compare immediately and only delays failures before the 401 (serial guessers are throttled; parallel floods still cost one `timingSafeEqual` each). If the reviewer wants the compare itself delayed (wait-before-compare even for the eventual success), move the `await` before `credentialsMatch` keyed on the pre-check count — the HTTP/WS gates are the only places to change.
- Expiry was verified by code + forged/fresh probes, not by waiting 30 days: `isAuthTokenValid` enforces `Date.now()-createdAt > TTL`, `pruneExpiredAuthTokens` runs on every `checkCookieAuth` and every `mintAuthToken`, TTL equals the cookie `Max-Age`. A unit probe that injects an old `createdAt` was not added (helpers are module-private).
- `serveStaticFile` / `upgrade` are now `async` (one word each) to `await` the backoff; Node ignores the returned promise and no rejection path exists (`sleep` never rejects, sends are `try`-guarded on the WS path). The pure `checkWsAuth` helper is retained for the throttled access log.

## 4. Retry round

Not a retry — no `reviewer-comments09.md` exists yet, so there are no prior reviewer comments to address. First submission for T9.
