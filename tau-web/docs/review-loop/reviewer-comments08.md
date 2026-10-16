# VERDICT: PASS-WITH-NITS

Task T8 — S6 baseline security headers + S11 stop `/api/health` cross-origin leak.
Baseline: `023295657f23309d333b8d976433928fd45564d8`. Changed tree: one product file
(`extensions/mirror-server.ts`, +24/−7) plus the coder's untracked comments file.

## Evidence

### 1. Code inspected (actual working tree, not the summary)

`git diff 023295657f... -- extensions/mirror-server.ts`:

- `setSecurityHeaders(res)` (module scope, next to `sendAuthRequired`) sets
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Content-Security-Policy: frame-ancestors 'none'`.
- Called as the **first statement of `serveStaticFile`** (line ~1601), which is the
  sole handler of the single `http.createServer(serveStaticFile)` (line 3111). So
  every `res`-based path (auth 401, rebinding 403, `/api/*`, `/→/hub/` 302,
  traversal 403, 404, 304, 200 static, `readBody` 413) passes through it, and later
  `writeHead` calls merge per Node semantics.
- `handleApiRoute`: the three unconditional `Access-Control-Allow-*` `setHeader`
  calls are gone; `OPTIONS` still answers 200, now header-less CORS-wise.
- `/api/instances`: explicit `"Access-Control-Allow-Origin": "*"` removed.
- `/api/file/preview`: `Content-Security-Policy` changed from `sandbox` to
  `sandbox; frame-ancestors 'none'` (this route's `writeHead` overrides the global
  CSP, so the restated directive is required and correct).
- `rg 'Access-Control'` over the repo: no remaining product-code CORS emission.
- No iframes anywhere in `public/` (grep) — XFO `DENY` / `frame-ancestors 'none'`
  cannot break same-origin embedding. Only two CSP writers exist (global + preview).
- Only one HTTP server exists in the package (`extensions/lib/hub-socket.ts` is a
  `net` socket, not HTTP); no route bypasses `serveStaticFile`.

### 2. `node tests/run.mjs` (stub hub)

```
tau-web e2e: H1 H2 ... D5 P2 (stub hub)
  PASS H1 (35ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6229ms) static-only renders with zero pageerrors (desktop + mobile)
  ... (H3–H13, D1, D5, P2 all PASS; H11 SKIP noted for TEST_REAL_HUB)
16/16 passed
```

Exact summary line: `16/16 passed`.

### 3. Real-hub probes (actual `mirror-server.ts`, `TAU_MIRROR_PORT=18310/18311`, `pi -e . --mode rpc`)

- `curl -sI /hub/` and `curl -sI /api/health` → 200 with all four headers.
- `curl -sI` on `/` → 302, `/nope-xyz` → 404, `/sw.js` and `/app.js` → 200,
  `If-None-Match` → 304, `OPTIONS /api/health` → 200: **all carry the four headers**.
  Static validators (`ETag`/`Last-Modified`/`Cache-Control: no-cache`) preserved.
- Cross-origin `GET /api/health` with `Origin: https://evil.example` → 200 body over
  the wire but **no `Access-Control-Allow-Origin`/`Allow-Methods`/`Allow-Headers`**.
  Same for `/api/instances`, `/hub/`, login, logout.
- Real browser cross-origin probe (Playwright page on `127.0.0.1:19998` fetching the
  hub on `:18310`): `fetch('/api/health')` and `fetch('/api/instances')` both return
  `TypeError: Failed to fetch` — scripts cannot read the JSON.
- Auth hub (`TAU_USER=u TAU_PASS=p`): anon `/api/sessions` → `401 {"error":"Unauthorized"}`
  with the four headers and **no `WWW-Authenticate`** (unchanged); `/api/health` still
  200 exempt with `authEnabled:true`; `/api/login` valid → 200 `{"ok":true}` +
  `HttpOnly; SameSite=Lax` cookie; authed `/api/sessions` → 200; bad login → 401.
- Rebinding: `Host: evil.example.com` → 403 with the four headers (unchanged).
- `readBody` 413 on oversized `/api/login` → 413 with the four headers.
- Image preview (real PNG under `$HOME`): 200, `image/png`, bytes identical,
  `Content-Security-Policy: sandbox; frame-ancestors 'none'` +
  `X-Content-Type-Options: nosniff`. Anon preview still 401.
- `/api/file/download` path jail unchanged (403 for a non-export `.png`).

### 4. Real-browser UX pass (`scripts/review-loop/deep_ui.py`, Playwright 1.64)

`pageerrors: 0`, `"errors": []`, all 19 steps passed, including
`login-overlay-visible`, `login-ok (Connected)`, `logout-login-roundtrip`,
`reload-rejoin`, `settings-server {version: "0.1.0", uptime: "34s"}`,
`live-preview`, `mobile {sidebar_collapsed: true, horiz_overflow_px: 0}`.
The logged console 401/404 entries belong to the intentional pre-login/after-logout
and cross-cwd live-preview probes; `requestfailed: 0`. Inspected screenshots:
`07-settings-server.png` (Server pane shows Version 0.1.0 / Uptime 34s) and
`99-final-desktop.png` (chat UI visually unchanged).

## Regression checks performed

- All frontend `fetch`/WS calls are same-origin relative paths (`wsUrl` built from
  `location.host`); nothing in `public/` relies on CORS, so removing ACAO cannot
  break the shell, login, Settings, live-preview/uplink, or the file viewer.
- Service-worker/static shell: `sw.js`/`app.js` keep `Cache-Control: no-cache` +
  `ETag`/`Last-Modified` and still 304 correctly with the new headers present.
- 401/403 semantics byte-identical (status, body, no `WWW-Authenticate`);
  `/api/health` body still includes `startedAt`/`version` for Settings.
- Preview sandbox jail preserved and global CSP correctly restated where the route
  overrides it; no other route sets a conflicting `Content-Security-Policy`.

## Issues

**Blocking:** none.

**Nits (non-blocking, follow-up candidates):**

1. `extensions/mirror-server.ts` — `/api/health` remains reachable cross-origin
   (auth/origin-exempt 200) and only *unreadable* via the missing ACAO. This is
   exactly what the task prescribed ("no ACAO on that route") and the coder
   documented it; an optional future hardening is gating `authExempt` routes from
   `checkRequestOrigin` so an evil `Origin` gets 403 rather than an opaque 200.
2. `extensions/mirror-server.ts:1865` — `X-Content-Type-Options: nosniff` is
   now duplicated by the preview route's explicit header; harmless redundancy.
3. `extensions/mirror-server.ts:1712` — the global `OPTIONS` branch still returns
   `200` with an empty body (now header-less). Preflights correctly fail closed,
   but `204`/`405` would be marginally cleaner; status was deliberately kept
   stable, so no action required for this task.

No product code was modified during review. All probe processes and temp files were
cleaned up (`ss` confirmed no listeners on the probe ports).

VERDICT: PASS-WITH-NITS
