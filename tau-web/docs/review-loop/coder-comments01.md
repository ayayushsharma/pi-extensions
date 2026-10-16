# Coder comments — T1 (B1/S1 stored XSS + B2 markdown placeholder crash), round 1

## 1. What changed

Three files, no new dependencies, no layout changes, no change to normal
markdown/code/math/user-message rendering.

### `public/message-renderer.js` — fixed the XSS sink in `renderUserMessage()`

- Before: `renderUserMessage()` built an `imagesHtml` string with
  `img.data.startsWith('data:') ? img.data : 'data:' + mime + ';base64,' + data`
  interpolated raw into `src="..."`, then set it via `div.innerHTML`. A
  session-file image block with `data` = `"><img src=x onerror=...>` broke
  out of the attribute and executed JS in the hub origin. It also threw
  (`img.data.startsWith`) when `data` was not a string.
- After: images are built with DOM APIs only — `document.createElement('img')`
  with `el.className = 'message-image'`, `el.alt = 'Attached image'`,
  `el.src = ...` — and appended into a `div.message-images` inside a
  `div.message-content` created via `createElement`. The text part is still
  inserted with `insertAdjacentHTML('beforeend', renderUserMarkdown(...))`
  (that output is escaped upstream), and the copy button is static markup
  with no user data. `data`/`mimeType` never appear in an HTML string.
- Added sink-side validation `isValidMessageImage()` (allowlist mirrors
  `processImageFile`'s `VALID_MIME_TYPES` in `app.js`): `mimeType` must be one
  of `image/png, image/jpeg, image/gif, image/webp`; `data` must be a
  non-empty string whose payload matches `/^[A-Za-z0-9+/=\s]*$/` after
  stripping an optional `data:...;base64,` prefix (a `data:` payload with no
  comma, a non-allowlisted embedded mime, or an empty payload is invalid).
  Invalid blocks are skipped (`continue`); the wrapper is only appended when
  at least one image is valid, so a fully-crafted block renders no `<img>`
  at all instead of a broken image.

### `public/app.js` — history-path validation in `renderHistoryEntries()`

- Before: image blocks were mapped straight through —
  `{ data: b.source?.data || b.data, mimeType: b.source?.media_type || ... }`
  — and handed to `renderUserMessage()`.
- After: added `isValidHistoryImage(data, mimeType)` (same allowlist +
  base64-charset rule as the renderer) next to `VALID_MIME_TYPES`, and the
  history extraction chain is now `.map(...).filter(img =>
  isValidHistoryImage(img.data, img.mimeType))`. Defense in depth: the
  renderer re-validates at the sink, so the live-echo path
  (`renderUserMessage({ content, images: cmd.images })`, canvas-generated
  base64) is covered by the same rule and still passes.

### `public/markdown.js` — B2 placeholder-collision guards

- Before: a line exactly `%%CODEBLOCK_n%%` / `%%DMATH_n%%` was substituted by
  index with no guard — `codeBlocks[i].lang` threw
  (`undefined.lang`) and `escapeHtml(displayMath[i])` threw
  (`undefined.replace`), aborting `renderMarkdown` and (for array content,
  one `renderMarkdown` per block) silently dropping every following block;
  live streaming also escaped via `handleMessageEnd` into the client-error
  beacon. `%%ICODEn%%` / `%%MATHXn%%` restores interpolated `undefined`,
  emitting the literal string `"undefined"`.
- After: both block lookups check `!== undefined` and only render the
  code/math wrapper + `continue` when the entry exists; otherwise they fall
  through to the normal block/table/heading/list/paragraph handling, so the
  marker line renders as plain text via `renderInline()` (`<p>%%CODEBLOCK_0%%</p>`)
  and rendering continues. Inline restores now fall back to the original
  marker (`(m, idx) => mathSpans[parseInt(idx)] ?? m` and the same for
  `codeSpans`), so user text like `%%ICODE0%%` / `%%MATHX0%%` round-trips as
  text instead of `"undefined"`. No marker-scheme change, no `%`-escaping, so
  real code blocks, display math, inline code, and inline math are untouched.

## 2. How it was verified

- `node --check public/markdown.js` → OK
- `node --check public/message-renderer.js` → OK
- `node --check public/app.js` → OK
- Node probe of `public/markdown.js` (with `global.window = {}` stub for the
  trailing `window.copyCode` assignment):
  - `renderMarkdown('%%CODEBLOCK_0%%')` → `<p>%%CODEBLOCK_0%%</p>`, no throw, no `undefined` — OK
  - `renderMarkdown('%%DMATH_0%%')` → `<p>%%DMATH_0%%</p>`, no throw — OK
  - `renderMarkdown('%%CODEBLOCK_0%%\n\nSECOND-BLOCK-REACHED')` still contains `SECOND-BLOCK-REACHED` — OK
  - `renderMarkdown('%%DMATH_0%%\n\nAFTER-MATH')` still contains `AFTER-MATH` — OK
  - `renderMarkdown('%%ICODE0%%')` → `<p>%%ICODE0%%</p>` (no `undefined`) — OK
  - `renderMarkdown('%%MATHX0%%')` → `<p>%%MATHX0%%</p>` (no `undefined`) — OK
  - Normal markdown (`# Hi`, `**bold**`, `` `code` ``), real fenced ` ```js `
    block, and inline code still render as before — OK
- Validation probe (replica of the sink regex/allowlist): XSS payload
  `"><img src=x onerror=...>` skipped, `text/html` / `image/svg+xml` mime
  skipped, empty/undefined data skipped, `javascript:alert(1)` skipped, evil
  `data:text/html;base64,...` skipped; valid `image/png` base64 and valid
  `data:image/png;base64,...` pass; whitespace-tolerant base64 passes — 10/10 OK.
- Source grep: no `src="${` / raw `<img ... ${` interpolation remains in
  `message-renderer.js` (only static `/icons/tau-192.png` left); sink uses
  `createElement('img')` + `.src =` — OK
- `node tests/run.mjs` (stub hub, default matrix) → exact summary:

```text
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (31ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (6053ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3585ms) late session_file pins #session + tab
  PASS H4 (4077ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18439ms) no-ack backend shows exact 15s timeout message
  PASS H6 (6ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1511ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (4015ms) Live section lists the running TUI with Drive controls
  PASS H9 (3232ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4667ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (0ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1262ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1268ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3510ms) uplink relay frames answered, dead frames silent
  PASS D5 (3148ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (512ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

- No `TEST_REAL_HUB=1` run was needed (no contract change); the stub suite
  already covers the touched paths and H2 reports zero pageerrors.

## 3. Reviewer double-checks and residual risk

- Please re-run the in-browser PoCs: (a) session file with an `image` block
  `{"data":"\"><img src=x onerror=...>","mimeType":"image/png"}` opened via
  `/hub/#session=<file>` — expect no `<img>` rendered for that block,
  `document.body.dataset.xss` unset, zero pageerrors; (b) assistant text block
  `%%CODEBLOCK_0%%` followed by `SECOND-BLOCK-REACHED` — expect both lines as
  text, no `TypeError`, second block visible in history and live paths.
- `el.src = <data-url>` assignment itself is safe against attribute breakout,
  but a `data:` URL with an allowlisted image mime and valid base64 payload is
  still honored (by design — the live canvas-echo path relies on it). The
  charset + mime gates are what neutralize `text/html` / `javascript:` /
  quote-breakout payloads; confirm the exact crafted payloads from §9 are
  skipped rather than rendered.
- Base64 strictness: the charset regex permits whitespace/`=` padding and
  requires at least one non-whitespace char, but does not validate padding
  position or decodeability — a syntactically-valid but undecodable string
  renders as a broken image icon (no script risk). Tightening to a real
  base64 decode check was deliberately avoided to keep the change minimal.
- `data:`-URL header parsing accepts only `data:<mime>[;base64],` with the
  mime in the allowlist (case-insensitive); exotic but legitimate headers
  with extra parameters (e.g. `;charset=utf-8`) are conservatively skipped.
  If the reviewer wants those to render, the header regex is the place to widen.
- Markdown fix preserves the `%%...%%` marker scheme rather than switching to
  collision-proof tokens, per the task's "guard + fallback" option. A model
  reply containing a marker-like line now renders it as visible text — correct
  and non-crashing, but the reviewer should confirm the deep-UI driver shows
  no new pageerrors on a normal session (H2 already asserts zero).
- Only `public/app.js`, `public/markdown.js`, `public/message-renderer.js`
  are modified; `docs/code-review.md` and `tests/browser.mjs` untouched; no
  other packages touched; nothing committed.

## 4. Retry-round comments addressed

- Not a retry round (first T1 attempt on a clean tree at `6e0f9ea` baseline);
  no prior reviewer comments to address.
