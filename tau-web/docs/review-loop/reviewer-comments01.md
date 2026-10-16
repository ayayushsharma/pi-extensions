# VERDICT: PASS-WITH-NITS

Task **T1 — Fix stored XSS in session images and the markdown placeholder crash**.
Baseline `6e0f9ea08346ba124649affc533649d571cfbe8f`; reviewed working tree
(`tau-web/public/app.js`, `tau-web/public/markdown.js`,
`tau-web/public/message-renderer.js` + coder comments). No product code was
edited during review.

## 1. Evidence — commands and results

### Scope / diff inspected
- `git status --porcelain`: only `public/app.js`, `public/markdown.js`,
  `public/message-renderer.js` modified; untracked `docs/review-loop/coder-comments01.md`,
  `scripts/review-loop/README.md`. No other package touched.
- `git diff 6e0f9ea -- public/{app,markdown,message-renderer}.js` read in full.
- Read the actual rendered code paths: `renderUserMessage()` /
  `isValidMessageImage()` (message-renderer.js), `renderHistoryEntries()` /
  `isValidHistoryImage()` / `processImageFile()` / live-echo (app.js ~1073–1105,
  ~1275–1298, ~3289–3314), and `renderMarkdown()` / `renderInline()` /
  `renderUserMarkdown()` (markdown.js).
- `node --check public/{app,markdown,message-renderer}.js` → all OK.

### Project tests
`node tests/run.mjs` →
```
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (36ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (5999ms) static-only renders with zero pageerrors (desktop + mobile)
  ...
  PASS P2 (511ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```
(Full run output in the session; summary line exact.)

### Real-browser deep-UI pass
`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui .../deep_ui.py` → exit 0,
`"errors": []`, `"pageerrors": [], "pageerrors": 0`; 19 steps incl. run,
reload-rejoin, live preview, mobile. Console 401s are the expected
login/auth-probe noise, not page errors. Screenshot `04-after-reply-full.png`
shows normal chat rendering unchanged.

### Targeted real-browser PoC (added by reviewer, no code changes)
Booted the real hub with `PI_CODING_AGENT_SESSION_DIR` pointed at a temp store
containing one crafted session file opened via `#session=crafted-xss.jsonl`.
Payloads in the user content: quote-breakout `"><img src=x onerror=...>`,
`image/svg+xml`, `text/html` data, plus two valid PNG blocks (raw base64 and
`data:image/png;base64,` URL). Assistant blocks contained literal
`%%CODEBLOCK_0%%` / `%%DMATH_0%%` followed by real text.

Fixed tree result (all checks PASS):
```
xss: null
imgCount: 2   (both srcs data:image/png;base64…)
hasSvg: false, hasHtml: false
userText: "hello marker %%CODEBLOCK_0%% %%ICODE0%%"
asstText: ["%%CODEBLOCK_0%%SECOND-BLOCK-REACHED", "%%DMATH_0%%AFTER-DMATH-REACHED"]
imgBeforeText: "message-images", copyBtns: 1
direct sink matrix: count 2, no execution
pageerrors: []
RESULT: PASS (all checks)
```

Differential against baseline files (`git show 6e0f9ea:…` served from a temp
static dir, same crafted session):
```
xss: "executed"          <- baseline stored XSS fires
imgCount: 5, hasSvg: true, hasHtml: true
asstText: []             <- %%CODEBLOCK_0%% TypeError drops all assistant entries
userText: "... %%ICODE0%% undefined"   <- baseline "undefined" fallback bug
RESULT: FAIL (9)
```
So the PoC is sensitive to both B1/S1 and B2, and the fixed tree neutralizes
them.

### B2 acceptance in Node (fixed module)
```
%%CODEBLOCK_0%%                -> <p>%%CODEBLOCK_0%%</p>              (no throw)
%%DMATH_0%%                    -> <p>%%DMATH_0%%</p>                  (no throw)
%%CODEBLOCK_0%%\n\nSECOND…     -> <p>…</p><p>SECOND-BLOCK-REACHED</p>
%%DMATH_0%%\n\nAFTER-MATH      -> <p>…</p><p>AFTER-MATH</p>
huge index, unknown index after real fenced block/display math -> text + real block renders
%%ICODE0%% / %%MATHX0%%        -> literal marker (no "undefined")
```

### Normal-rendering regression differential
Baseline vs fixed `renderMarkdown`/`renderUserMarkdown` over 14 content cases
(headings, bold/italic, inline/fenced code, inline/display math, lists, task
lists, blockquote, table, hr, links/images/autolink, escaped HTML, multiline):
**26/28 outputs byte-identical**; the only 2 differences are the intended
`%%ICODE0%%`/`%%MATHX0%%` `undefined` → literal-marker fix.

## 2. What was verified

- **B1/S1 fixed**: `renderUserMessage()` builds `<img>` via
  `document.createElement`, sets `className`/`alt`/`src` as properties; no
  data/mimeType in any HTML string (`grep` confirms no raw-src interpolation
  remains). Sink-side `isValidMessageImage()` enforces mime allowlist
  (`png/jpeg/gif/webp`), optional `data:` prefix parsing with embedded-mime
  allowlist, base64 charset, non-empty payload; invalid blocks are skipped and
  the wrapper is omitted when none are valid. History path additionally filters
  in `renderHistoryEntries()` via `isValidHistoryImage()` (defense in depth).
  Real-browser check: crafted blocks skipped, `dataset.xss` unset, valid blocks
  render.
- **B2 fixed**: both block lookups guard `!== undefined` and fall through to
  the normal paragraph path; inline restores use `?? m`. Rendered text is the
  literal marker and following blocks still render. Real fenced code and
  display math still render identically.
- **No regression**: full test suite green; deep-UI 0 pageerrors; DOM structure
  preserved (`.message.user > .message-content > .message-images >
  img.message-image` + text + copy button outside content); normal markdown
  byte-identical; live canvas-echo path (`base64` + `image/png|jpeg`) still
  passes the sink validator; no other message-image sink exists
  (`renderQueuedMessages` uses `escapeHtml`, attachment thumb uses DOM `src`).
- **No new dependencies, no layout changes** per diff.

## 3. Issues by severity

**Blocking: none.**

**Nits (non-blocking, optional follow-ups):**
1. `public/message-renderer.js` `isValidMessageImage()` (and the mirrored
   `isValidHistoryImage()` in `app.js`): the base64 gate is charset +
   non-empty only, so a payload that matches `/^[A-Za-z0-9+/=\s]*$/` but is not
   decodable (e.g. `"===="`, bad padding) still mounts an `<img>` that shows a
   broken-image icon instead of being skipped. No script risk; task specified
   this exact charset rule, so it is acceptable. Optional hardening: validate
   padding/decodability (`atob` try/catch) and cap payload size.
2. The allowlist/validator logic is duplicated in `app.js` and
   `message-renderer.js`. Intentional defense-in-depth; if either copy drifts
   behavior can diverge. Optional: export the helper from one module and import
   it in the other (same package, no build step needed).
3. `isValidHistoryImage()` compares the block-level `mimeType` case-sensitively
   while the embedded `data:` header check is case-insensitive; a session file
   with `IMAGE/PNG` is skipped rather than rendered. Real pi session files are
   lowercase, so no functional impact.

## 4. Required changes next round

None — the finding is fixed and verified. The nits above are optional
hardening/maintainability follow-ups only.

VERDICT: PASS-WITH-NITS
