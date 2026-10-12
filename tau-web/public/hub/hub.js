/**
 * Tau Hub shell — opencode-style session tabs + search home.
 *
 * Loaded only by /hub/ (public/hub/index.html). app.js stays the engine and
 * owns session switching through the URL hash; this module is a thin,
 * decoupled layer on top of it:
 *
 *   • renders the tab strip (one tab per open session, "+", "×")
 *   • renders the "home" search overlay (all sessions, grouped by project)
 *   • drives sessions purely via `location.hash` + /api/sessions
 *
 * It never imports app.js internals: hash writes are the contract, and it
 * also observes history.replaceState so app.js's silent URL pins still
 * register as session changes.
 */

const STORAGE_KEY = 'tau-hub-tabs';
const strip = document.getElementById('tab-strip');
const homeEl = document.getElementById('session-home');
const homeInput = document.getElementById('session-home-input');
const homeList = document.getElementById('session-home-list');
const homeBackdrop = document.getElementById('session-home-backdrop');

if (strip && homeEl) init();

function init() {
  const state = {
    tabs: [],        // [{ key, title }]
    active: null,    // active session key (basename)
    index: new Map(),// key -> { key, title, project, timestamp, live }
    live: new Set(), // keys of sessions currently owned by a running TUI
    projects: [],    // project paths, most-recently-active first
    homeOpen: false,
    filter: '',
    sel: 0,
    items: [],       // flattened, filtered home rows
  };

  // ── session key = the basename in #session=<key> ────────────────────
  const keyOf = (filePath) => {
    if (!filePath) return null;
    const parts = String(filePath).split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  };
  const hashKey = () => {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    if (!raw) return null;
    return new URLSearchParams(raw).get('session');
  };
  const titleOf = (key) => state.index.get(key)?.title || 'New session';
  const projectOf = (key) => state.index.get(key)?.project || '';

  // ── persistence (tab set survives reloads; active comes from the hash) ─
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tabs: state.tabs.map((t) => t.key),
        active: state.active,
      }));
    } catch {}
  }
  function restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!raw) return;
      const seen = new Set();
      state.tabs = (raw.tabs || [])
        .filter((k) => typeof k === 'string' && k && !seen.has(k) && seen.add(k))
        .map((key) => ({ key, title: titleOf(key) }));
    } catch {}
  }

  // ── session index ───────────────────────────────────────────────────
  async function loadIndex() {
    let projects = [];
    try {
      const res = await fetch('/api/sessions');
      projects = (await res.json()).projects || [];
    } catch { return; }
    const index = new Map();
    const ordered = projects.slice().sort((a, b) => {
      const mt = (p) => Math.max(0, ...(p.sessions || []).map((s) => s.mtime || 0));
      return mt(b) - mt(a);
    });
    state.projects = ordered.map((p) => p.path || p.dirName || '');
    for (const p of ordered) {
      for (const s of p.sessions || []) {
        const key = s.file || keyOf(s.filePath);
        if (!key) continue;
        index.set(key, {
          key,
          title: s.name || s.firstMessage || key.replace(/\.jsonl$/, ''),
          project: p.path || p.dirName || '',
          timestamp: s.timestamp || '',
        });
      }
    }
    // Preserve any open keys the index doesn't know yet (fresh sessions).
    for (const t of state.tabs) if (!index.has(t.key)) index.set(t.key, { key: t.key, title: t.title, project: '' });
    state.index = index;
    for (const t of state.tabs) t.title = titleOf(t.key);
    renderTabs();
    if (state.homeOpen) renderHome();
  }

  async function loadLive() {
    try {
      const res = await fetch('/api/instances');
      const instances = (await res.json()).instances || [];
      const live = new Set();
      for (const i of instances) {
        if (i.local) continue; // the hub's own row isn't a session to drive
        const k = keyOf(i.sessionFile);
        if (k) live.add(k);
      }
      state.live = live;
      renderTabs();
      if (state.homeOpen) renderHome();
    } catch {}
  }

  // ── tabs ────────────────────────────────────────────────────────────
  function addTab(key, makeActive = false) {
    if (!key) return;
    if (!state.tabs.some((t) => t.key === key)) {
      state.tabs.push({ key, title: titleOf(key) });
    } else {
      const t = state.tabs.find((t) => t.key === key);
      t.title = titleOf(key);
    }
    if (makeActive) activate(key);
    else persist();
  }

  function closeTab(key) {
    const i = state.tabs.findIndex((t) => t.key === key);
    if (i === -1) return;
    state.tabs.splice(i, 1);
    if (state.active === key) {
      const next = state.tabs[i] || state.tabs[i - 1] || null;
      if (next) activate(next.key);
      else { state.active = null; persist(); renderTabs(); openHome(); return; }
    }
    persist();
    renderTabs();
  }

  function activate(key) {
    if (!key) return;
    state.active = key;
    persist();
    renderTabs();
    if (hashKey() !== key) location.hash = `session=${encodeURIComponent(key)}`;
    else syncFromHash();
  }

  function renderTabs() {
    strip.textContent = '';
    for (const t of state.tabs) {
      const btn = document.createElement('button');
      btn.className = 'tab' + (t.key === state.active ? ' active' : '');
      btn.dataset.key = t.key;
      btn.setAttribute('role', 'tab');
      btn.title = t.title;

      const dot = document.createElement('span');
      dot.className = 'tab-dot' + (state.live.has(t.key) ? ' live' : '');
      btn.appendChild(dot);

      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = t.title;
      btn.appendChild(title);

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.setAttribute('aria-label', 'Close tab');
      close.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.key); });
      btn.appendChild(close);

      btn.addEventListener('click', (e) => { if (!e.target.closest('.tab-close')) activate(t.key); });
      strip.appendChild(btn);
    }
    const activeEl = strip.querySelector('.tab.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function syncFromHash() {
    const key = hashKey();
    if (key) {
      addTab(key, false);
      state.active = key;
    } else {
      state.active = null;
    }
    renderTabs();
    persist();
  }

  // ── home / search overlay ───────────────────────────────────────────
  function openHome() {
    state.homeOpen = true;
    state.filter = '';
    state.sel = 0;
    homeInput.value = '';
    homeEl.classList.remove('hidden');
    renderHome();
    loadIndex().then(() => { homeInput.focus(); });
  }
  function closeHome() {
    state.homeOpen = false;
    homeEl.classList.add('hidden');
  }
  function toggleHome() { state.homeOpen ? closeHome() : openHome(); }

  function homeRows() {
    const q = state.filter.trim().toLowerCase();
    const rank = new Map(state.projects.map((p, i) => [p, i]));
    const rows = [];
    for (const [, s] of state.index) {
      const hay = `${s.title} ${s.project} ${s.key}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      rows.push(s);
    }
    rows.sort((a, b) => {
      const pa = rank.has(a.project) ? rank.get(a.project) : 1e9;
      const pb = rank.has(b.project) ? rank.get(b.project) : 1e9;
      if (pa !== pb) return pa - pb;           // keep projects contiguous
      const la = state.live.has(a.key) ? 1 : 0;
      const lb = state.live.has(b.key) ? 1 : 0;
      if (la !== lb) return lb - la;           // live first within a project
      return String(b.timestamp).localeCompare(String(a.timestamp));
    });
    return rows;
  }

  function renderHome() {
    homeList.textContent = '';
    const rows = homeRows();
    state.items = rows;

    const newRow = document.createElement('button');
    newRow.className = 'sh-new';
    newRow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg><span>New session</span>';
    newRow.addEventListener('click', () => { closeHome(); newSession(); });
    homeList.appendChild(newRow);

    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sh-empty';
      empty.textContent = state.filter ? 'No matching sessions' : 'No sessions yet — start one with “New session”.';
      homeList.appendChild(empty);
      return;
    }

    let lastProject = null;
    rows.forEach((s, i) => {
      if (s.project !== lastProject) {
        lastProject = s.project;
        const head = document.createElement('div');
        head.className = 'sh-group-title';
        head.textContent = s.project ? s.project.split('/').filter(Boolean).pop() : 'Other';
        head.title = s.project || '';
        homeList.appendChild(head);
      }
      const item = document.createElement('button');
      item.className = 'sh-item' + (i === state.sel ? ' active' : '');
      item.dataset.key = s.key;

      const title = document.createElement('span');
      title.className = 'sh-item-title';
      title.textContent = s.title;
      item.appendChild(title);

      if (state.live.has(s.key)) {
        const tag = document.createElement('span');
        tag.className = 'sh-item-tag';
        tag.textContent = 'live';
        item.appendChild(tag);
      }
      const meta = document.createElement('span');
      meta.className = 'sh-item-meta';
      meta.textContent = relTime(s.timestamp);
      item.appendChild(meta);

      item.addEventListener('click', () => { closeHome(); addTab(s.key, true); });
      homeList.appendChild(item);
    });
  }

  function relTime(ts) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) return '';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }

  function moveSel(delta) {
    const n = state.items.length;
    if (n === 0) return;
    state.sel = (state.sel + delta + n) % n;
    renderHome();
    homeList.querySelector('.sh-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  // ── wiring ──────────────────────────────────────────────────────────
  // Instant new session in the current project (opencode-style). The event
  // keeps hub.js decoupled from app.js/sessionActions; the directory-picker
  // modal remains on the sidebar's New button (#new-session-btn).
  function newSession() {
    window.dispatchEvent(new CustomEvent('tau:new-session'));
  }

  document.getElementById('tabbar-home')?.addEventListener('click', openHome);
  document.getElementById('tab-new')?.addEventListener('click', newSession);
  homeBackdrop?.addEventListener('click', closeHome);

  homeInput?.addEventListener('input', () => { state.filter = homeInput.value; state.sel = 0; renderHome(); });
  homeEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeHome(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const s = state.items[state.sel];
      if (s) { closeHome(); addTab(s.key, true); }
    }
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (e.shiftKey && k === 'p') { e.preventDefault(); toggleHome(); }
    else if (!e.shiftKey && k === 't') { e.preventDefault(); newSession(); }
  });

  // app.js pins/clears the hash with history.replaceState (which fires no
  // hashchange) — observe it so silent pins still open/close tabs.
  const origReplace = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const before = location.hash;
    const out = origReplace(...args);
    if (location.hash !== before) syncFromHash();
    return out;
  };
  window.addEventListener('hashchange', syncFromHash);

  // Keep titles + live dots fresh without coupling to app.js internals.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { loadIndex(); loadLive(); }
  });

  restore();
  syncFromHash();
  loadIndex();
  loadLive();
  setInterval(() => { loadIndex(); loadLive(); }, 15000);
}
