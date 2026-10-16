# Reviewer comments — T6 (S3, S4/S4b, S14), round 1

VERDICT: PASS-WITH-NITS

## Scope and method

- `git diff 003556d06eac53fc6c859afe1951ae40cc34a4dd` + `git status --porcelain`:
  only `tau-web/extensions/mirror-server.ts` modified (+97/−15); untracked
  `docs/review-loop/coder-comments06.md`. Nothing else in the tree.
- Read the actual changed code paths, not the summary: WS `export_html`
  (extensions/mirror-server.ts:1460–1500), `GET /api/file/preview`
  (:1746–1798), `POST /api/files/mkdir` (:2070–2106), `POST /api/open`
  (:2250–2286), new `isRealPathAllowed` (:2851–2882), and (for comparison)
  `/api/sessions/export` (:2463–2502), `/api/file/download` (:2504–2530,
  untouched), `fsAllowedRoots` (:2854–2865).
- All probes below are mine (throwaway hub/roots under `/tmp/t6-review`,
  real `pi` binary from `~/.pi/agent/bin/pi`), plus a baseline worktree at
  `003556d` for before/after.

## Evidence

### Required suite — PASS

`node tests/run.mjs`:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6027ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3522ms) late session_file pins #session + tab
  PASS H4 (3539ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18273ms) no-ack backend shows exact 15s timeout message
  PASS H6 (12ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1517ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3051ms) Live section lists the running TUI with Drive controls
  PASS H9 (3158ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4589ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1286ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1275ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3509ms) uplink relay frames answered, dead frames silent
  PASS D5 (3285ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (510ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

### Independent real-hub probe — 13/13 PASS

`node /tmp/t6-review/probe.mjs` (real hubs, `TAU_FS_ROOTS=/tmp/t6-review/roots`,
throwaway session store):

```text
PASS preview symlink->outside-root — status=403 leaked=false body={"error":"Path outside allowed roots"}
PASS preview real png — status=200 ct=image/png disp=undefined csp=sandbox nosniff=nosniff
PASS preview svg attachment — status=200 ct=image/svg+xml disp=attachment; filename="evil.svg" csp=sandbox
PASS preview symlink->inside-root — status=200 ct=image/png
PASS preview missing 404 / non-image 415 — missing=404 nonimage=415
PASS open symlink refused — status=403 body={"error":"Path outside allowed roots"}
PASS open real passes jail (200/500) — status=200 body={"ok":true}
PASS mkdir symlinked parent refused — status=403 body={"error":"Outside the home directory"} outsideBefore=0 after=0
PASS mkdir normal HOME works — status=200 made=true
PASS export_html outside refused — success=false error=Output must be inside the session store wrote=false
PASS export_html inside not jail-refused — success=false error=Command failed: pi --export … (reaches pi)
PASS preview symlink->~/settings.json 403/404 — status=403 len=38 (throwaway HOME)
PASS preview symlink->inside fake HOME allowed — status=200 body=FAKEHOME-SECRET
13/13 reviewer probe checks passed
```

### Baseline reproduction (worktree at `003556d`, then removed)

```text
BASELINE preview symlink->outside-root: status=200 ct=image/png body=T6-SECRET-OUTSIDE-ROOTS
BASELINE mkdir symlinked parent: status=200 body={"path":"/home/ayush/.t6-review-link/baseline-escape-…"} outsideBefore=0 after=1
```

After the fix the same two requests are `403` with nothing created — the S4/S14
bypass is genuinely closed, not just re-labelled.

### export_html detail

- Outside-store output: refused with `Output must be inside the session store`
  before `execFileSync`; no file written.
- Inside-store output and the no-`outputPath` UI path produce the *same*
  `pi --export` reachability: both reach the real `pi` and fail only with
  `File not found: <sessionFile>` because the rpc-mode hub has not flushed a
  session file in the throwaway env. The jail is not the cause.
- `/api/sessions/export` + `/api/file/download` code paths are untouched and
  still pass (suite + coder evidence).

### UX / browser pass

- `scripts/review-loop/deep_ui.py` (Playwright python available): 19 steps,
  `pageerrors: []`, `errors: []`, `requestfailed: []`; `file-viewer` step
  rendered `AGENTS.md`. Console 401s are pre-login noise from the auth test.
- Targeted Chromium check against a live hub:
  `img naturalWidth/Height: {'png': [2, 2], 'svg': [300, 150]}`, `pageerrors: []`;
  top-level navigation to the SVG preview raised `Download is starting` and
  produced **no dialog/script execution**. So `<img>` thumbnails (raster and
  SVG-as-image) still render, and SVG is no longer executable as a document.

### Notes on the `settings.json` PoC

The realpath jail blocks a symlink *out of the allowed roots*. Because
`fsAllowedRoots()` always includes `$HOME`, a symlink to
`~/.pi/agent/settings.json` is only an escape when the hub's `HOME` does not
contain that file. Verified both:

- hub booted with throwaway `HOME` → `403` (fixed);
- hub booted with the default `HOME` → `200 image/png` with settings bytes,
  exactly as baseline. That target is inside an allowed root, and the task
  instruction explicitly says to "keep serving legitimate files inside the
  roots", so this is policy, not a regression from T6. If the evaluator wants
  the literal PoC to be refused even under default `HOME`, see nit 3.

## Issues

### Blocking

None.

### Nits (follow-ups, not blockers)

1. **`export_html`: symlinked `SESSIONS_DIR` false-positive.**
   `extensions/mirror-server.ts:1481` compares `parentReal` (resolved with
   `fs.realpathSync`) against the *unresolved* `storeRoot`. If the store path
   itself resolves through a symlink (`~/.pi` symlinked, or
   `PI_CODING_AGENT_SESSION_DIR` pointing at a symlink), a legitimate in-store
   `outputPath` is refused. Reproduced: hub with
   `PI_CODING_AGENT_SESSION_DIR=/tmp/t6-review/store-link -> store-real`,
   `outputPath=/tmp/t6-review/store-link/out-edge.html` →
   `Output must be inside the session store`. UI is unaffected (app.js sends no
   `outputPath`), but a one-line fix (`fs.realpathSync(storeRoot)` fallback, as
   `isRealPathAllowed` already does) removes the false positive.

2. **`export_html`: in-store `outputPath` is location-jailed but not
   `.html`-jailed.** An authenticated WS client can pass e.g.
   `…/sessions/proj/<real>.jsonl` and `pi --export` will overwrite it with HTML.
   The task allowed "inside the session store" so this is technically compliant
   and the coder flagged it; requiring `.html` (or always exporting next to the
   session file) would be stricter.

3. **Preview mime/extension comes from the requested path, not the resolved
   path.** `ext` (`:1756`) is computed from `filePath`; `realPath` is only used
   for the jail/stream. A symlink `x.png -> <allowed-root>/settings.json`
   (target inside roots) is still served as `image/png` with the JSON bytes.
   This is unchanged from baseline and inside the root policy, but if the
   literal S4 PoC should return 403/404 under a default-`HOME` hub, derive the
   allowlist/`Content-Disposition` decision from `realPath` (or refuse
   symlinks) as an extra gate. Not required by the task's stated fix, which was
   realpath-before-jail only.

4. **No automated regression test for the new paths.** H12 uses
   `/api/files/content`, H13 tests only string-jail mkdir, P2 tests
   traversal/rebinding. The symlinked preview/open, symlinked mkdir parent, and
   `export_html` outside-store jail are only covered by manual probes
   (mine and the coder's). Worth adding to `tests/e2e` so a later refactor
   can't silently re-open S4/S14.

5. **`serveFileList` still uses the string-prefix `isPathAllowed`**
   (`:2885`). A symlinked directory inside a root can be listed (names/sizes),
   although opening/reading its entries is now refused by the realpath jail.
   The coder explicitly left it out of scope; noting it only.

6. **TOCTOU** between the realpath check and `read`/`mkdir`/`exec` remains
   (acknowledged by the coder). Narrow window, same shape as pre-existing code;
   an atomic fix (`O_NOFOLLOW`, `mkdirat`) is a larger change and not required.

VERDICT: PASS-WITH-NITS
