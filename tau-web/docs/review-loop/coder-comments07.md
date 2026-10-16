# Coder comments — T7 (S5: cap request bodies; S7: rate-limit the client-error beacon), round 1

## 1. What changed

One file, no new dependencies, no response-shape changes for normal-sized
requests, no change to any route's JSON parse/error handling.
All changes in `extensions/mirror-server.ts`.

### New shared helper: `readBody(req, res, maxBytes, onBody)` (module scope, next to `loginFailures`)

- Before: every POST route in `handleApiRoute` accumulated its body with an
  unbounded inline pattern — `let body = ""; req.on("data", (chunk) => {
  body += chunk.toString(); }); req.on("end", …)` — with no cap anywhere
  except `/api/client-error` (which destroyed the stream past 8000 chars but
  answered nothing). The unauthenticated `/api/login` POST was a memory-DoS
  lever: an arbitrary-size body was fully buffered as a string.
- After: `readBody` counts bytes (`size += chunk.length`) and the moment the
  total exceeds `maxBytes` it answers `413 {"error":"Request body too large"}`,
  destroys the request stream (so the rest of the body is never read or
  buffered), and never invokes `onBody`. Under the cap the callback receives
  exactly the string the old accumulators built, so every route's existing
  `JSON.parse` / try/catch / status-code behavior is preserved byte-for-byte.
- Caps: `BODY_LIMIT_LOGIN = 64 KiB` (`/api/login` — two short credential
  strings), `BODY_LIMIT_JSON = 256 KiB` (every other JSON endpoint),
  `BODY_LIMIT_RPC = 1 MiB` (`/api/rpc` — carries prompt text plus optional
  inline image payloads), `BODY_LIMIT_CLIENT_ERROR = 8 KiB` (unchanged cap,
  now enforced with a 413 instead of a silent destroy).

### All 11 POST body readers converted to `readBody`

`/api/client-error`, `/api/login`, `/api/projects/launch` (also capped at
256 KiB although the task's route list omits it — it reads a client JSON body
the same way), `/api/processes/kill`, `/api/files/mkdir`,
`/api/sessions/fork`, `/api/open`, `/api/rpc`, `/api/sessions/delete`,
`/api/sessions/rename`, `/api/sessions/export`. Each conversion only replaces
the three opener lines (`let body` / `data` / `end`) with the `readBody(…)`
call; the handler bodies and their closing `});` (which now closes the
`readBody` callback) are untouched. `/api/logout` reads no body and needed no
change. Async handlers (`login`, `kill`, `open`, `rpc`) pass an `async (body)`
callback; sync ones pass `(body)`.

### `/api/client-error` — S7 rate limit (module-scope `clientErrorAllowed`)

- Before: auth-exempt, no rate limit — any LAN/internet client could flood
  `tau.log` (disk fill) with unlimited 204-logged beacons.
- After: per-source-IP sliding window (`CLIENT_ERROR_MAX_PER_MIN = 20`,
  `CLIENT_ERROR_WINDOW_MS = 60s`, keyed on `req.socket.remoteAddress`). The
  gate runs **before** any body byte is read: excess requests get
  `429 {"error":"Too many requests"}`, the stream is destroyed, and nothing
  is written to the log. The `clientErrorHits` map prunes timestamps older
  than the window on every hit and evicts the oldest IP entry past 1000 keys,
  so the limiter itself cannot grow without bound (cf. S9). Only gated (≤20)
  requests consume quota — an over-8-KiB beacon that passes the gate then
  413s still consumes one slot, which only tightens the throttle.

## 2. How it was verified

- Project suite (required): `node tests/run.mjs` (stub hub, default matrix) →
  exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6009ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3620ms) late session_file pins #session + tab
  PASS H4 (3595ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18107ms) no-ack backend shows exact 15s timeout message
  PASS H6 (12ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1518ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3112ms) Live section lists the running TUI with Drive controls
  PASS H9 (3123ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4639ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1777ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1387ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3511ms) uplink relay frames answered, dead frames silent
  PASS D5 (3148ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

  (The stub suite exercises `tests/hub-stub.mjs`, not the patched routes, so
  the real evidence for this task is the live-hub probe below. The suite
  confirms no collateral damage; D5 covers the auth contract.)

- Real-hub probe (real `pi` binary, `pi -e ./tau-web --mode rpc`, `TAU_ROLE=hub`,
  `TAU_USER/TAU_PASS` set, throwaway `TAU_LOG_FILE` + session dir, port 18293;
  the hub booting at all proves the edited TS loads cleanly under jiti):

```text
normal login (small body): 200 + Set-Cookie tau_auth=…; HttpOnly; SameSite=Lax
bad login (small body, wrong pass): 401
2 MiB POST /api/login: 413 {"error":"Request body too large"}
small kill, garbage JSON: 400 {"error":"Unexpected token 'o', "not-json{{{" is not valid JSON"} (parse-failure shape preserved)
small kill, nonexistent pid: 404 {"error":"no live pi process with pid 999999999"} (normal path preserved)
2 MiB POST /api/processes/kill (authed): 413 {"error":"Request body too large"}
normal rpc get_commands (small body): 200 {"type":"response","command":"get_commands","success":true,…}
client-error single 9 KiB post: 413 {"error":"Request body too large"} (8 KiB cap kept)
client-error normal beacon: 204 + 1 [client] line appended to tau.log
client-error burst of 25 rapid beacons (2 quota slots already spent above): 18×204 then 7×429, tau.log gained exactly 18 lines (19 total) — no 429 was logged
```

  The 413s arrive without the server buffering the 2 MiB (cap trips on the
  first over-limit chunk, stream destroyed); normal login/cookie/kill/rpc
  behavior is unchanged.

- `TEST_REAL_HUB=1 … --filter H6` was **not** run: it exercises the WS
  headless/prompt path, which this change does not touch (no WS code
  modified), and it needs model credentials for a live round-trip. The real-hub
  boot above already validated the edited extension source end-to-end over HTTP.
- `git status --short` → only `M extensions/mirror-server.ts` plus this
  untracked comments file. `docs/code-review.md` and `tests/browser.mjs`
  untouched, nothing committed, no other package touched. No `tsconfig.json`
  exists so no `tsc` run was possible; the TS was validated by execution (real
  hub boot through the actual extension source).

## 3. Reviewer double-checks and residual risk

- **413 vs destroy-only:** over-limit bodies now get an explicit `413 + JSON`
  where the old code either buffered forever (10 routes) or destroyed silently
  (client-error). The task explicitly allows "413 (or connection closed)". If
  any client treats a JSON 413 as fatal where a hang was somehow tolerated,
  flag it — the new behavior is strictly more informative.
- **Cap sizes are judgment calls:** 64 KiB login (credentials are ~dozens of
  bytes; even exotic setups stay far below), 256 KiB JSON (largest legit JSON
  bodies today are a few KB — fork/delete/rename/export/mkdir/kill/open/launch),
  1 MiB rpc (prompts with inline images; the WS `prompt` path itself is
  uncapped by design — S10 — so a determined client can still send large
  prompts over WS; this cap only bounds the HTTP ingress copy). Raise/lower on
  request.
- **Rate-limit quota accounting:** an over-8-KiB beacon that passes the gate
  consumes one of the 20 slots before 413ing (gate runs before the body is
  read, necessarily — otherwise the throttle couldn't protect the read). Effect
  is conservative (tighter throttle under attack); a legit client that fat-
  fingers one oversized beacon loses one slot for a minute. Alternative is to
  only count logged beacons — say the word if preferred.
- **IP keying:** quota is per `remoteAddress`. Behind a shared NAT/proxy all
  browsers share one bucket (20/min aggregate) — acceptable for a LAN-scale
  diagnostic beacon, but note it if tau is ever fronted by a shared proxy.
  `X-Forwarded-For` is deliberately *not* trusted (spoofable).
- **WS `maxPayload`/backpressure (S10) is untouched** — out of scope for T7; the
  WS `prompt`/`message` path still has no size cap.
- **No persistence:** `clientErrorHits` is in-memory only; a restart resets
  quotas. Consistent with `loginFailures`/`authTokens` handling.

## 4. Retry-round comments addressed

- Not a retry round (first T7 attempt); no prior reviewer comments to address.
