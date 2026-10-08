# ADR-005 — Evolve vanilla UI, no framework migration

Status: accepted (2026-10-09)

## Context
C1 (low-end Android, bionic): no 1 GB modules, no 300 MB+ resident stacks.

## Decision
Keep `public/` vanilla split (`websocket-client.js`, `message-renderer.js`, `session-sidebar.js`, plus new `switcher.js`, `slash-popup.js`, `stream-guard.js`, `dialogs.js` extension). Port pi-web fixes, don't rewrite. No npm framework, no `node-pty`.

## Alternatives rejected
React port, Next.js, code-server, Open WebUI, OpenAI-shim chat UI (lose streaming/tools/steering or violate C1).

## Consequences
- Browser reload only for UI work (`TAU_STATIC_DIR=$(pwd)/public pi` override).
- PWA, file browser, themes retained.
