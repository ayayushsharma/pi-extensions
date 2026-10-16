# Coder comments — T6 (S3, S4/S4b, S14: jail file preview/open/mkdir through realpath, constrain export_html), round 1

## 1. What changed

One file, no new dependencies, no protocol changes, no change to the
`/api/file/download` jail. All changes in `extensions/mirror-server.ts`.

### New helper: `isRealPathAllowed()` (next to `isPathAllowed`)

- Before: only `isPathAllowed()` existed — `path.resolve(target)` string-prefix
  against `path.resolve`d roots. A symlink inside an allowed root pointing
  outside (`secret.png -> ~/.pi/agent/settings.json`) passes it.
- After: `isRealPathAllowed(realAbs)` jails an already-resolved absolute path
  against `realpath`d roots (each root via `fs.realpathSync`, fallback to the
  resolved root when the root does not exist). All filesystem-touching routes
  below resolve first with `fs.realpathSync` and jail the result. `isPathAllowed`
  itself is unchanged (still used by `serveFileList`, which was out of scope).

### `GET /api/file/preview` — S4 + S4b

- Before: `if (!isPathAllowed(filePath)) 403`, then mime allowlist on the
  request extension, then `fs.statSync(filePath)` + `createReadStream(filePath)`
  with `{ Content-Type: mime, Cache-Control: max-age=60 }`. Symlink target
  served with full bytes; `svg` served inline as `image/svg+xml` (executes as
  hub origin when navigated to).
- After: mime allowlist first (unchanged 415 for non-images, preserves existing
  error distinctions), then `realPath = fs.realpathSync(path.resolve(filePath))`
  — failure answers `404 Not found` — then `isRealPathAllowed(realPath)` else
  `403 Path outside allowed roots`. `stat` + stream use `realPath`. Response
  headers now add `Content-Security-Policy: sandbox` and
  `X-Content-Type-Options: nosniff` to every preview, plus
  `Content-Disposition: attachment; filename="…"` when `ext === "svg"`. Raster
  images stay inline with no `Content-Disposition`, so `<img>` thumbnails are
  unaffected.

### `POST /api/open` — S4

- Before: `if (!isPathAllowed(fp)) 403`, then `explorer/open/xdg-open/termux-open`
  invoked with the raw client string `fp`.
- After: `realFp = fs.realpathSync(path.resolve(fp))` — failure answers `404` —
  then `isRealPathAllowed(realFp)` else `403`. The opener is invoked with
  `realFp` instead of `fp`, so the jailed target is what gets opened. Success
  (`200 {ok:true}`) and opener-missing (`500`) paths are otherwise unchanged.

### `POST /api/files/mkdir` — S14

- Before: `home = realpathSync(HOME)`, `abs = resolve(raw)`, string-prefix jail
  vs `home`, `409` if exists, `mkdirSync(abs)`. A symlinked parent
  (`~/link -> /etc` + `~/link/new`) passes the prefix check and escapes.
- After: same prefix jail and `409` preserved, then the parent
  (`path.dirname(abs)`, which must already exist by design since `mkdir` is
  non-recursive) is resolved with `fs.realpathSync` and jailed against `home`
  (`403 Outside the home directory` on escape, `400 Parent not found` when the
  parent does not exist). Only then `mkdirSync(abs)`.

### WS `export_html` — S3

- Before: `argv = ["--export", sessionFile]` plus raw client `outputPath`
  (`argv.push(command.outputPath.trim())`) passed to `pi --export` — arbitrary
  file write. (The `execFile` argv-only comment about quote-injection is kept;
  the path itself was never constrained.)
- After: `storeRoot = path.resolve(SESSIONS_DIR)`. No `outputPath` (the real UI
  path — `public/app.js` sends `{type:"export_html"}` with no path) behaves as
  before (export next to the session file). A supplied `outputPath` is resolved
  (`path.resolve`) and must satisfy the same string-prefix jail as
  `/api/sessions/export` (`Output must be inside the session store`, thrown as
  the command error), plus — when the parent exists — the resolved parent must
  also be inside the store (blocks a symlinked parent inside the store
  redirecting the write outside). Outside-store output is refused before any
  `execFileSync`; inside-store output is honored. No extension check was added
  (location-only jail, matching the HTTP route's intent).

## 2. How it was verified

- Project suite (required): `node tests/run.mjs` (stub hub, default matrix) →
  exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (31ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6023ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3870ms) late session_file pins #session + tab
  PASS H4 (3540ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18139ms) no-ack backend shows exact 15s timeout message
  PASS H6 (13ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1516ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3057ms) Live section lists the running TUI with Drive controls
  PASS H9 (3137ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4702ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1777ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1283ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3511ms) uplink relay frames answered, dead frames silent
  PASS D5 (3956ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (509ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

  H12/H13 always boot a real hub (extension code), so the real `isRealPathAllowed`
  and mkdir parent-jail paths were exercised by the suite itself.

- Real-hub PoC probe (throwaway `TAU_FS_ROOTS` + `PI_CODING_AGENT_SESSION_DIR`,
  real `pi` binary, scratch script): **ALL T6 POC CHECKS PASSED**:

```text
preview symlink: status=403 len=38 hasSecret=false
preview real.png: status=200 ct=image/png csp=sandbox nosniff=nosniff disp=undefined
preview evil.svg: status=200 ct=image/svg+xml disp=attachment; filename="evil.svg" csp=sandbox
open symlink: status=403 {"error":"Path outside allowed roots"}
open real: status=200 {"ok":true}
mkdir symlink-parent: status=403 {"error":"Outside the home directory"} leakedExists=false
mkdir normal: status=200 {"path":"/home/ayush/.t6-fresh-…"}
export_html outside: status=200 {"type":"response","command":"export_html","success":false,"error":"Output must be inside the session store"}
export_html inside: status=200 {"type":"response","command":"export_html","success":false,"error":"Command failed: pi --export …/sessions/…jsonl …/sessions/t6-inside.html\nError: File not found: …"}
```

  Notes: the symlink preview returns 403 with no secret bytes; the real PNG
  still previews 200 with no `Content-Disposition`; the SVG previews 200 as
  `attachment` + `sandbox`; `/api/open` on the symlink is 403 while the real
  file passes the jail (200 — an opener exists in this environment; 500 where
  no opener exists would equally prove the jail passed); the symlinked-parent
  mkdir is 403 and created nothing outside; normal HOME mkdir is 200;
  `export_html` outside the store is refused before any exec (no file written);
  inside-store output passes the jail and reaches `pi --export` (the residual
  `File not found` is the hub's own not-yet-flushed session file in the
  throwaway store, not a jail rejection).

- HTTP export/download regression (throwaway session store, real hub):

```text
http export: status=200 {"success":true,"path":"/tmp/…/sessions/proj/2000-01-01T00-00-00-000Z_test.html"} exists=true
download: status=200 ct=text/html; charset=utf-8 disp=attachment; filename="2000-01-01T00-00-00-000Z_test.html"
EXPORT+DOWNLOAD OK
```

  `/api/sessions/export` + `/api/file/download` (untouched code paths) still
  succeed for legitimate paths.

- `git status --short` → only `M extensions/mirror-server.ts` plus this untracked
  comments file. `docs/code-review.md` and `tests/browser.mjs` untouched, nothing
  committed, no other package touched. No `tsconfig.json` exists so no `tsc`
  run was possible; the TS was validated by execution — stub suite (jiti stub
  not needed) plus three real-hub boots above, all through the real extension
  source.

## 3. Reviewer double-checks and residual risk

- **Preview mime order:** the allowlist (415) runs before `realpath`/jail, so a
  missing non-image still answers 415 (pre-existing distinction) while a missing
  image answers 404 via `realpath` failure (previously 404 via `stat`). Confirm
  the 404-vs-415 split for missing files is acceptable; the alternative (realpath
  first) would turn missing non-images from 415 into 404.
- **SVG handling is `attachment` + `sandbox`, raster is inline + `sandbox`:**
  please confirm `Content-Security-Policy: sandbox` on image responses cannot
  break any client you care about (`<img>` needs no script origin; direct
  navigation to a raster image still renders). `X-Content-Type-Options: nosniff`
  is included so a mislabelled SVG served as `image/png` is not sniffed into a
  document.
- **`/api/open` now 404s missing files** (previously it would attempt the opener
  and return 500). Legitimate opens target existing files, so this only affects
  error-path status codes — flag if any client depends on 500-for-missing.
- **`export_html` refuses (errors) rather than silently ignoring outside output.**
  The task allows either; refusal is explicit and auditable. The real UI never
  sends `outputPath`, so no legit flow changes. Inside-store output is honored
  (not coerced to the default), so a future UI that exports to a chosen
  in-store path keeps working — at the cost that an in-store non-`.html`
  overwrite (e.g. a `.jsonl`) is still possible. Enforcing `.html` would close
  that but was left out as beyond the finding's scope; say the word if wanted.
- **TOCTOU:** check-then-use races remain (symlink swapped between `realpath`
  check and `read`/`mkdir`/`exec`). The window is narrow and the pre-existing
  code has the same shape; a fully atomic fix (open with `O_NOFOLLOW`, `mkdirat`
  on an opened parent fd) would be a larger change. The `export_html` parent
  realpath check additionally falls back to the string-prefix jail when the
  parent does not exist (nothing to resolve); `pi --export` then fails cleanly.
- **Roots with symlinks:** `isRealPathAllowed` realpaths each root per request.
  Roots that do not exist fall back to the unresolved string. Per-request
  `realpathSync` on a handful of roots is negligible next to the file I/O it
  guards. `serveFileList` still uses the unresolved `isPathAllowed` (out of
  scope for this task — directory listings, not file reads/writes).

## 4. Retry-round comments addressed

- Not a retry round (first T6 attempt); no prior reviewer comments to address.
