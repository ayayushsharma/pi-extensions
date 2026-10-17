# VERDICT: PASS — T13 mobile preview-banner layout (U1, U3), round 2

Round-1 blocking **B1 is genuinely fixed**. The ≤768px `.sb-text` rule now sits
*after* the base rule at equal specificity, wins the cascade, and produces a
full-width multi-line title with the buttons on their own row on all banner
variants at 390px. Desktop geometry is byte-for-byte identical to the baseline.
`node tests/run.mjs` is 16/16 and the deep-UI real-browser pass reports 0
pageerrors and 0 mobile horizontal overflow. No functional or UX regression found.

---

## Scope inspected

- `git status --porcelain` (repo root = `pi-extensions`): the only file this round
  touched is `tau-web/public/style.css`. `public/app.js` (mtime 04:41),
  `public/message-renderer.js` (04:26) and `extensions/mirror-server.ts` (04:26)
  predate this round's `style.css` edit (04:57) — they are the still-uncommitted
  T12 leftovers, not T13 changes. No T13 JS/HTML change; CSS-only as required.
- `git diff fb27a4f -- public/style.css` → exactly 8 insertions in 2 hunks:
  1. a new `@media (max-width: 768px)` block after the base `.sb-text` rule
     (`style.css:997-1003`), where round 1's dead `flex-basis: 100%` line has been
     removed from the early media block (`style.css:985-989`);
  2. `padding-bottom: 6px` on `.proc-list` (`style.css:1985`, U3).
- Cascade confirmed with `nl -ba public/style.css`:

```
 984  .session-banner .sb-text { min-width: 0; }
 985  @media (max-width: 768px) { ... }            <- early block: no .sb-text rule any more
 990  .session-banner .sb-text { flex: 1; ... }    <- base, sets flex-basis: 0%
1001  @media (max-width: 768px) {
1002    .session-banner .sb-text { flex: 1 1 calc(100% - 18px); }   <- later + equal specificity => wins
1003  }
```

- `renderSessionBanner()` (`public/app.js:2878-2933`) renders every variant
  (`error`, `driving`, `preview`, `preview`-pending, `detached`) with the same
  `<span class="sb-text">` + `.sb-btn` structure, so the single shared selector
  covers all of them; verified per-variant in the browser probe below.

## Tests

`node tests/run.mjs` (exact result):

```
tau-web e2e: H1 H2 H3 H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 D1 D5 P2 (stub hub)
  PASS H1 (32ms) hub alive: /api/health, /→302 /hub/, shell 200
  PASS H2 (5980ms) static-only renders with zero pageerrors (desktop + mobile)
  PASS H3 (3590ms) late session_file pins #session + tab
  PASS H4 (3520ms) disconnected + shows exact fail-fast (no 15s wait)
  PASS H5 (18513ms) no-ack backend shows exact 15s timeout message
  PASS H6 (11ms) start_session + prompt HEADLESS-OK round-trip
  PASS H7 (1519ms) uplink relay contract: list/instances live, WS-only over HTTP
  PASS H8 (3051ms) Live section lists the running TUI with Drive controls
  PASS H9 (3126ms) preview-then-drive flow: preview, cancel, drive, detach
  PASS H10 (4607ms) live pi processes list + kill (stub UI, real scan/kill)
  SKIP H11 (needs TEST_REAL_HUB=1: asserts real-hub registry behavior the stub cannot cover)
  PASS H11 (1ms) session rejoin: no re-switch + running state for the background watch
  PASS H12 (1279ms) viewer endpoint: content jailed to the viewed session
  PASS H13 (1272ms) picker endpoints: summaries + mkdir + fork
  PASS D1 (3512ms) uplink relay frames answered, dead frames silent
  PASS D5 (3163ms) auth: 401 + overlay, login → WS, logout revokes
  PASS P2 (518ms) hardening: traversal, rebinding, dead WS contract

16/16 passed
```

## Real-browser geometry (independent probe)

`/tmp/tau-t13-probe-v2.py` boots a real hub (`pi -e <repo> --mode rpc`, random
port, `TAU_STATIC_DIR=public`), logs in, and injects the **exact markup from
`renderSessionBanner()`** into the real `#session-banner` in the real page, once
with the working-tree `public/style.css` and once with the baseline
`git show fb27a4f:.../style.css`. Measurements via `getBoundingClientRect()` /
`getComputedStyle()`, Chromium, DPR1.

390×844 (mobile emulation):

| variant  | baseline basis | baseline text | baseline btn overlap | fixed basis            | fixed text | fixed btn overlap | fixed overflow |
|----------|----------------|---------------|----------------------|------------------------|------------|-------------------|----------------|
| error    | `0%`           | 31×326        | yes                  | `calc(100% - 18px)`    | 312×49     | no                | 0px            |
| driving  | `0%`           | 229×81        | yes                  | `calc(100% - 18px)`    | 312×64     | no                | 0px            |
| preview  | `0%`           | 106×163       | yes                  | `calc(100% - 18px)`    | 312×49     | no                | 0px            |
| detached | `0%`           | 150×114       | yes                  | `calc(100% - 18px)`    | 312×66     | no                | 0px            |
| pending  | `0%`           | 312×51        | n/a (no buttons)     | `calc(100% - 18px)`    | 312×51     | n/a               | 0px            |

Buttons all share one row (`btnRows=1`) below the title row on every variant, the
dot stays on the title row, and no horizontal document overflow occurs.

1280×820 (desktop): baseline and fixed measurements are **identical** for every
variant — error 945×32, driving 1126×32, preview 1013×32, detached 1053×32,
pending 1202×17, `btnRows=1` (buttons same row, vertically centered), overflow 0.
Closest to pixel-identical possible: the fix is entirely inside the media query.

390px screenshot inspected (`/tmp/tau-t13-probe/m390-fixed-preview.png`): the
preview banner shows "Previewing “2026‑10‑16T21‑54‑08‑980Z_…a49a” · :18302" on two
full-width lines with the hint, and "Drive this TUI" / "Cancel" on their own row.
The banner occupies roughly 115px of the 844px viewport — the transcript and input
stay dominant, i.e. it does not "dominate mobile browsing".

## U3 (`.proc-list` last row)

`/tmp/tau-t13-u3-probe.py`, 14 `.proc-row`s in a real served page, scrolled to the
bottom: fixed → `clientHeight=240, scrollHeight=784, paddingBottom=6px,
gapBelowLastRow=6px, overflowY=auto`; baseline → `gapBelowLastRow=0`. The 6px
bottom gap is real; panel not restructured; `max-height: 240px` retained.

## Deep-UI driver (run, as permitted)

`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui TAU_REVIEW_REPO=<repo> <playwright-python>
scripts/review-loop/deep_ui.py` — ran to completion (48.7s, real hub on :57575,
real headless child, login, prompt round-trip, live preview, settings, file
viewer, logout/login, mobile pass):

```
[step] live-preview {'banner': '\n Previewing “2026-10-16T21-54-08-980Z_01a146b5-...a49a” · :18302Read-only — Drive to take over · last active 1h ago\n Drive this TUI\n Cancel', 'rows': 1}
[step] mobile {'sidebar_collapsed': True, 'input_visible': True, 'horiz_overflow_px': 0, 'pageerrors': []}
{"errors": [], "pageerrors": [], "metrics": {"pageerrors": 0, "request_failed": 0}, ...}
```

0 pageerrors on desktop and mobile; the 401/404 console entries are the login
challenge and one stale foreign live session that 404s in both windowed and full
fetches (pre-existing T12 client fallback behavior, unrelated to this CSS change).
The script's mobile pass has no banner in its flow, so the 390px banner evidence
above is the direct one. Also inspected `07-settings-server.png`: the process list
renders in its 240px scroll region (mid-scroll clipping at the panel edge is the
scroll container, not U3's missing padding).

## Regression checks

- Desktop: exact rect equality with baseline at 1280 (above).
- Theme variables untouched — no new colors, `padding-bottom` only; coarse-pointer
  rules untouched (`.sb-btn` 40px @768 at `style.css:987` and `:4357`).
- No JS/HTML change this round (mtimes + `git diff` scope); no other
  `.session-banner .sb-text` rule exists in later media blocks that could fight the
  new one (`grep` verified single mobile `.sb-text` rule).
- H2 and deep_ui both report zero pageerrors desktop+mobile; no horizontal
  overflow at 390px on any variant.

## Non-blocking notes (no action required for T13)

- **Test gap (carry-forward):** `H2` still only asserts zero pageerrors, so this
  class of cascade regression remains invisible to CI. A small DOM-layout
  assertion (computed `flex-basis` / button-row check at 390px) would lock the fix
  in; the coder declared `tests/browser.mjs` out of scope for this task.
- **Magic constant:** `calc(100% - 18px)` is coupled to the 8px `.sb-dot` + 10px
  `.session-banner` gap. The inline comment documents this, but the value must be
  updated if either changes.
- **U3 semantics:** the 6px padding only shows when the list is scrolled fully to
  the bottom (expected with `max-height` + `overflow-y: auto`); rows clipped
  mid-scroll are the scroll container, not a bug.

VERDICT: PASS
