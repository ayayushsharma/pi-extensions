# T8 coder comments — S6 baseline security headers + S11 /api/health CORS leak

## 1. What changed (one product file: `extensions/mirror-server.ts`)

**New helper `setSecurityHeaders(res)`** (next to `sendAuthRequired`):
sets on every HTTP response `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and
`Content-Security-Policy: frame-ancestors 'none'` (frame-ancestors only —
no `script-src`/`style-src`, the app uses inline handlers and CDN assets).

**Before:** no response carried any of the four headers (S6 open).
**After:** `serveStaticFile` — the single `http.createServer` handler, so it
covers static files, all `/api/*`, and every early return — calls
`setSecurityHeaders(res)` as its first statement, before the
auth gate (`checkWsAuth` → 401), the anti-rebinding gate (403), the
`/api/*` dispatch (`handleApiRoute`), the `/→/hub/` 302, and the static-file
`Cache-Control`/`ETag`/`304` path. Later `writeHead` calls merge with these,
so 401/403/302/304/200 all carry the baseline. 401/403 semantics are
otherwise untouched (same status, same body, still no `WWW-Authenticate`).

**`handleApiRoute` — wildcard CORS removed (S11):**
before it unconditionally sent `Access-Control-Allow-Origin: *` (+
`Allow-Methods`/`Allow-Headers`) on every API route including auth-exempt
`/api/health`, so any web page could `fetch()` and read
mode/version/uptime/platform. After, it sends no CORS headers at all — the
UI is same-origin, so no route needs them; omitting `ACAO` makes a
cross-origin `fetch` opaque/unreadable while same-origin fetch + cookies keep
working. The `OPTIONS` branch is kept (answers `200`, now without any CORS
headers, so preflights fail closed) to avoid changing the preflight status
contract. `/api/health` itself is unchanged apart from headers: still
auth-exempt, still returns `{status, mode, mirrorUrl, platform, authEnabled,
startedAt, version}` so the login flow and Settings version/uptime keep
working.

**`/api/instances` redundant wildcard removed:** before it passed
`"Access-Control-Allow-Origin": "*"` explicitly to `writeHead`; after it
passes only `Content-Type` (inherits the baseline security headers, no CORS).

**`/api/file/preview` CSP merge (avoid regressing S6/S4b):** before it set
`Content-Security-Policy: sandbox` via `writeHead`, which would have
overridden the new global `frame-ancestors 'none'`. After it sends
`sandbox; frame-ancestors 'none'`, keeping the sandbox jail for mislabelled
payloads plus the frame guard. `X-Content-Type-Options: nosniff` there was
already correct and is kept (now redundant with the global, harmless).

No frontend, test, or other-package files touched. No new dependencies.

## 2. How it was verified

Project suite (stub hub — contract unchanged, still green):
```
$ node tests/run.mjs
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (30ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6327ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3646ms) late session_file pins #session + tab
  PASS H4 (3487ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18073ms) no-ack backend shows exact 15s timeout message
  PASS H6 (5ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1513ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3055ms) Live section lists the running TUI with Drive controls
  PASS H9 (3146ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4515ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1268ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1265ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3509ms) uplink relay frames answered, dead frames silent
  PASS D5 (3102ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (511ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

Real-hub contract probe (allowed by the task; `TEST_REAL_HUB=1` path):
```
$ TEST_REAL_HUB=1 node tests/run.mjs --filter H6
tau-web e2e: H6 (real hub)
  PASS H6 (4856ms) start_session + prompt HEADLESS-OK round-trip
1/1 passed
```

Real-hub header/CORS probes (throwaway `pi -e ./tau-web --mode rpc` on
127.0.0.1:18299 open + 127.0.0.1:18302 with `TAU_USER=u TAU_PASS=p`):
- `curl -sI /hub/` → 200 with all four headers, no `Access-Control-*`.
- `curl -sI /api/health` → 200 with all four headers, no `Access-Control-*`;
  body still `{status:"ok",mode:"hub",…,authEnabled,startedAt,version}`.
- `curl -H 'Origin: https://evil.example' /api/health` → 200 body but **no
  `ACAO` header**, so a cross-origin script cannot read it (previously `*`).
  Same result for `/api/instances` and `/hub/`.
- `OPTIONS /api/health` → 200 with the four security headers, no CORS headers.
- Auth hub: anon `/api/sessions` → 401 `{"error":"Unauthorized"}` with the
  four headers, no `WWW-Authenticate` (unchanged); `/api/health` still 200
  exempt with `authEnabled:true`; `/api/login {u/p}` → 200 `{"ok":true}` +
  `HttpOnly; SameSite=Lax` cookie with the four headers and no CORS; authed
  `/api/sessions` with that cookie → 200.
- Rebinding still gated: raw `Host: evil.example.com` → 403 with the four headers.
- 404 (`/nonexistent-xyz`) → 404 with the four headers.
- Image preview (real 1px PNG under `$HOME`, allowed root, authed cookie) →
  200 `Content-Type: image/png` with `Content-Security-Policy: sandbox;
  frame-ancestors 'none'` + the other three headers; body bytes intact.
- Static shell assets (`/sw.js`, `/app.js`) → 200 with the four headers plus
  existing `Cache-Control: no-cache`/`ETag` (validators preserved, so the
  service worker and no-stale-shell logic are unaffected).

## 3. Reviewer double-checks / residual risk

- Global `writeHead(200, {Content-Type})` + earlier `setHeader` merge relies
  on Node's documented merge (explicit `writeHead` headers win on conflict).
  Only the preview route sets a conflicting `Content-Security-Policy`, and it
  was updated to restate `frame-ancestors`. If a future route sets its own
  `X-Frame-Options`/`CSP`, it will silently override the baseline — grep for
  `writeHead` + `Content-Security-Policy` when adding routes.
- `/api/health` is still auth-exempt **and** origin-check-exempt by design
  (the login page and Settings need it pre-auth). The fix removes readability
  (no `ACAO`), not reachability: a cross-origin page still gets a 200 body
  over the wire, just opaque to script. An attacker that can lure the user to
  `curl` the URL, or abuse a browser extension with host permissions, still
  learns version/uptime/platform. If the reviewer wants reachability closed
  too, the follow-up is to drop `authExempt` for the origin gate on health
  (same-origin passes, evil `Origin` 403s) — deliberately not done here to
  keep 401/403 behavior byte-identical per the task.
- `OPTIONS` still answers 200 (no CORS headers) rather than 404/405. Either
  denies the preflight; 200 was kept to minimize the status-code diff.
- The stub/test servers (`tests/hub-stub.mjs`, `fake-backend.mjs`,
  `static-server.mjs`) were intentionally left alone — they still send no
  security headers and the suite does not assert headers, so 16/16 passes on
  stubs. The real-hub probes above are the S6/S11 evidence.

## 4. Retry round

Not a retry — no `reviewer-comments08.md` exists yet, so there are no prior
reviewer comments to address. First submission for T8.
