# Mobile Optimisations

Everything customised for mobile (≤768px) compared to the desktop experience.

## Layout & Scrolling
- **Single scroller** — `html`/`body` scroll is locked; only the message list scrolls (`overscroll-behavior: contain`), so the page body can't be dragged around on phones
- **Dynamic input clearance** — a `ResizeObserver` measures the overlay input (which grows with multi-line text, queued messages and image previews) into `--input-height`; message list padding, scroll-padding and the scroll-to-bottom button all follow it, so the newest answer is never clipped behind the input
- **Keyboard-aware viewport** — `viewport-fit=cover` + `interactive-widget=resizes-content`, safe-area insets on input and message padding

## Layout & Navigation
- **Slide-over sidebar** — 80% width (max 320px) panel with dark overlay behind it, instead of persistent sidebar
- **Swipe-from-edge gesture** — swipe right from the left 20px edge to open sidebar
- **Sidebar tinted backgrounds** — per-theme tint (warm for Terracotta, green for Sage, cool for Clean, slightly lighter for dark themes)
- **File browser as right slide-over** — shares the dim overlay with the left sidebar, one panel open at a time

## Header (taller 3-row grid)
- **Info stack (column 1)** — model name / thinking level + session cost / token % + context size (`45% · 12.3k/200k`) in one column; empty rows collapse so the bar only grows as info arrives
- **Files (column 2) + Settings (column 3)** — separate 44px touch columns, vertically centred
- **Slim nav column** — sidebar toggle over a dot-only connection indicator (text label hidden)
- **Measured, never clipped** — header height is observed into `--header-height`; message list top padding follows it live
- **Context popover goes full-width** — fixed below the header instead of overflowing the screen edge
- **Desktop** — same flat flex row; session cost now sits with the thinking tag on the left instead of next to the token pill

## Session List
- **iOS-native styling** — 17px regular-weight titles (not bold), 13px meta text, flat divider lines between items
- **Titles wrap** — up to 2 lines instead of truncating
- **Larger touch targets** — 16px vertical padding per row, 44px minimum on all interactive elements
- **Larger search input** — 16px font (prevents iOS zoom), 10px padding, 12px border radius
- **Larger action buttons** — 36×36px icons

## Conversation Stream
- **Assistant messages full-width** — extend 100% instead of 85%, cost badge wraps below
- **Larger text** — 15.5px (up from 14px)
- **System font** — SF Pro via `-apple-system` on mobile
- **Copy button always visible** — small clipboard icon at 40% opacity instead of hover-only text

## Input Area
- **16px font size** — prevents iOS Safari auto-zoom on focus (pinch-zoom left enabled)
- **No autofocus** — keyboard doesn't hijack the screen on load/navigation
- **Form buttons removed from tab order** — `tabindex="-1"` on all non-textarea elements
- **Popovers stay on screen** — the model picker and thinking menu sit right of centre, so ≤768px they anchor to their right edge and `clampMenuToViewport()` measures and nudges them back in if a narrow screen would still clip one; opening either can no longer make the page scroll sideways
- **Model picker is keyboard-proof** — the search field is the *bottom* element of the menu (the list scrolls above it) and the menu is capped at `min(360px, 45dvh)`, so with the on-screen keyboard up it stays above the composer instead of pushing the field off screen

## Connection & Lifecycle
- **Auto-reconnect on return** — detects visibility change and silently reconnects WebSocket instead of showing disconnected state
- **Instant scroll on history load** — temporarily disables smooth scrolling so loading a session jumps to bottom without the zoom animation
- **Refresh button does full page reload** — `location.reload()` on mobile instead of just refreshing the session list
