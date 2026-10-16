# VERDICT: PASS

T7 — S5 (cap POST request bodies) + S7 (rate-limit the auth-exempt client-error beacon).
Reviewed diff: `git diff 19b3acb98f8077ecb58eed83ed1a88ffd2726237 -- tau-web/extensions/mirror-server.ts`
(+70/−33 in `extensions/mirror-server.ts`, no other product files touched).

## Evidence

### Working tree
```
$ git status --porcelain
 M tau-web/extensions/mirror-server.ts
?? tau-web/docs/review-loop/coder-comments07.md
```
Only the expected file changed; test files, frontend, and other packages untouched.

### Project suite (required)
```
$ node tests/run.mjs
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (38ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (5986ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3560ms) late session_file pins #session + tab
  PASS H4 (3542ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18075ms) no-ack backend shows exact 15s timeout message
  PASS H6 (12ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1520ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3564ms) Live section lists the running TUI with Drive controls
  PASS H9 (3150ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4570ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1287ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1271ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3510ms) uplink relay frames answered, dead frames silent
  PASS D5 (3071ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (511ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```
(D5 is the auth/login case the acceptance criteria names; the stub suite does not
load `mirror-server.ts`, so the real-hub probe below is the direct S5/S7 evidence.)

### Real-hub probe (real `pi -e ./tau-web --mode rpc`, TAU_ROLE=hub, auth ON, throwaway port/log)
Probe: `/tmp/t7-review-probe.mjs` (reviewer-written, not product code). Results:
```
health:                200 authEnabled=true
login small:           200 {"ok":true} + Set-Cookie tau_auth=…
login 2MiB:            413 {"error":"Request body too large"}
login drip (32KiB chunks): 413, respondedAfterBytes=131072  <- response arrives
                           after ~128KiB of a 6.4MiB stream, i.e. no full-body buffering
login bad:             401 {"ok":false,"error":"Invalid username or password"}
kill bad JSON:         400 {"error":"Unexpected token 'o', \"not-json{{{\" is not valid JSON"}
kill nonexistent:      404 {"error":"no live pi process with pid 999999999"}
kill 2MiB (authed):    413 {"error":"Request body too large"}
rpc small:             200 {"type":"response","command":"get_commands","success":true,…}
rpc 1.5MiB:            413 (1 MiB cap)
client-error 9KiB:     413 (8 KiB cap kept)
client-error burst:    19x204 6x429; tau.log gained exactly 19 [client] lines
                       (20/min quota, 1 slot spent by the 9KiB 413; 429s not logged)
```
Normal response bodies/Set-Cookie/parse-error text are byte-for-byte what the
pre-change handlers produced (the diff only replaces the `data`/`end` opener lines).

### Real-browser UX pass (Playwright, `scripts/review-loop/deep_ui.py`, boots real hub via `pi -e REPO`)
```
report: /tmp/tau-loop-deep-ui/deep-ui-report.json
steps: 19  errors: []  pageerrors: []  request_failed: 0
login-overlay-visible -> login-ok -> sessions-sidebar -> new-session -> run-complete
-> reload-rejoin -> settings-server -> command-palette -> file-viewer -> live-preview
-> logout-login-roundtrip -> nav-timing -> mobile
```
Inspected screenshots `01-login.png` (inline login overlay normal) and
`99-final-desktop.png` (main panel, preview banner, transcript, input all normal).
The 401 entries are the expected pre-login overlay fetches; no console pageerrors.

## Code reviewed

- `readBody(req, res, maxBytes, onBody)` (mirror-server.ts ~L101): counts **bytes**
  (`size += chunk.length`), stops appending, sends `413 {"error":"Request body too
  large"}` and `req.destroy()`s on first over-cap chunk, never calls `onBody`;
  attaches an `error` no-op so a destroyed stream cannot crash the process.
  Buffer is bounded by `maxBytes` (+ at most one in-flight chunk), not the body size.
- Caps: login 64 KiB, JSON routes 256 KiB, rpc 1 MiB, client-error 8 KiB.
- All 11 POST body readers converted: `/api/client-error`, `/api/login`,
  `/api/projects/launch` (extra, same JSON cap), `/api/processes/kill`,
  `/api/files/mkdir`, `/api/sessions/fork`, `/api/open`, `/api/rpc`,
  `/api/sessions/delete`, `/api/sessions/rename`, `/api/sessions/export`.
  `/api/logout` reads no body and needed none. `rg 'req.on\("data"'` shows no
  remaining unbounded HTTP body accumulation anywhere else in `extensions/`
  (other hits are child-process stdout and the Unix-domain hub socket).
- `clientErrorAllowed(ip)` (L122): per-`req.socket.remoteAddress` sliding 60s
  window, max 20, checked **before** any body byte is read; excess => `429`
  + `req.destroy()`, no `tauLog`. Map prunes expired timestamps per hit and
  evicts an entry past 1000 keys, so the limiter itself is memory-bounded.
- Auth gate (`serveStaticFile`) runs before `handleApiRoute`; login/client-error
  are the intended auth-exempt routes, and the 429/413 paths never touch the log.

## Regression checks

- Normal login (cookie minted), bad login (401 + backoff), normal kill/404,
  malformed-JSON 400 shape, normal `/api/rpc` response — all reproduced unchanged.
- Front-end beacon (`public/hub/index.html`) is fire-and-forget (`fetch(...).catch`),
  so 413/429 responses cannot surface to the user; the 8 KiB cap still drops
  over-long stacks exactly as before (now with a 413 instead of a silent close).
- Full test matrix 16/16, D5 auth path, and deep UI (login overlay + every
  panel + mobile, 0 pageerrors) all pass. No visible change anywhere.

## Issues

No blocking issues. The finding pair (S5, S7) is fixed and verified end-to-end.

Minor observations (not defects, no action required):
1. `extensions/mirror-server.ts` `clientErrorAllowed` — an over-8-KiB beacon that
   passes the gate consumes one of the 20 slots before it is 413'd (approved
   route behavior). Deliberate and documented by the coder; only tightens the
   throttle under flood.
2. The limiter keys on `remoteAddress` only and later inserts evict in
   insertion order (FIFO, not LRU). Bounded memory either way; acceptable for a
   best-effort LAN diagnostic beacon and safer than trusting `X-Forwarded-For`.
3. Over-cap responses close the connection (`req.destroy()`); the task explicitly
   allows "413 (or connection closed)", and 413 was observed with real clients in
   every probe.

VERDICT: PASS
