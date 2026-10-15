/**
 * Start / Resume picker — one scrolling sheet replacing the dumb
 * New-session text modal:
 *   ★ favourites (shared with the sidebar list) →
 *   directory browser (free browse + single-level New folder) →
 *   sessions in the directory (title, date, running dot, ★; tap offers
 *   Resume / Fork-as-new, Enter defaults to Resume) →
 *   New session here (optional starter prompt).
 *
 * The picker owns no session state: favourites and resume/fork/new all
 * round-trip through opts callbacks owned by app.js.
 */

let shell = null;
let S = null; // per-open state { dir, summaries, favs, opts, newFolderOpen }
let escBound = false;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  try {
    const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function ensureShell() {
  if (shell) return shell;
  const ov = document.createElement('div');
  ov.className = 'sp-overlay hidden';
  ov.id = 'session-picker';
  ov.innerHTML = `
    <div class="sp-backdrop" data-close></div>
    <div class="sp-panel" role="dialog" aria-label="Start or resume a session">
      <div class="sp-head">
        <div class="sp-title">Start / Resume</div>
        <button class="fv-btn fv-btn-x" id="sp-close" aria-label="Close">✕</button>
      </div>
      <div class="sp-scroll">
        <div class="sp-section hidden" id="sp-favs">
          <div class="sp-label">★ Favourites</div>
          <div id="sp-fav-rows"></div>
        </div>
        <div class="sp-section">
          <div class="sp-label">Directory</div>
          <div class="sp-crumb" id="sp-crumb"></div>
          <div class="sp-dir-actions">
            <button class="fv-btn" id="sp-up">↑ Up</button>
            <button class="fv-btn" id="sp-newfolder">+ New folder</button>
          </div>
          <div class="sp-newfolder hidden" id="sp-newfolder-row">
            <input class="sp-input" id="sp-newfolder-name" placeholder="folder name" maxlength="64">
            <button class="fv-btn fv-btn-primary" id="sp-newfolder-go">Create</button>
          </div>
          <div class="sp-err hidden" id="sp-dir-err"></div>
          <div id="sp-dirs"></div>
        </div>
        <div class="sp-section">
          <div class="sp-label" id="sp-sess-label">Sessions</div>
          <div id="sp-sessions"></div>
        </div>
        <div class="sp-section">
          <div class="sp-label">New session here</div>
          <textarea class="sp-input sp-prompt" id="sp-starter" placeholder="Starter prompt (optional) — leave empty for a blank session"></textarea>
          <button class="fv-btn fv-btn-primary sp-start" id="sp-start">Start new session</button>
        </div>
      </div>
      <div class="sp-choice hidden" id="sp-choice">
        <div class="sp-choice-box">
          <div class="sp-choice-title" id="sp-choice-title"></div>
          <button class="fv-btn fv-btn-primary sp-choice-btn" id="sp-resume">Resume <span class="sp-key">Enter</span></button>
          <button class="fv-btn sp-choice-btn" id="sp-fork">Fork as new</button>
          <button class="fv-btn sp-choice-btn" id="sp-choice-cancel">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('[data-close]').addEventListener('click', closeSessionPicker);
  ov.querySelector('#sp-close').addEventListener('click', closeSessionPicker);
  ov.querySelector('#sp-up').addEventListener('click', () => navTo(parentOf(S.dir)));
  ov.querySelector('#sp-newfolder').addEventListener('click', () => {
    ov.querySelector('#sp-newfolder-row').classList.toggle('hidden');
    ov.querySelector('#sp-newfolder-name').focus();
  });
  ov.querySelector('#sp-newfolder-go').addEventListener('click', createFolder);
  ov.querySelector('#sp-newfolder-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createFolder();
  });
  ov.querySelector('#sp-start').addEventListener('click', () => {
    const starter = ov.querySelector('#sp-starter').value.trim();
    const dir = S.dir;
    closeSessionPicker();
    S.opts.onNew?.(dir, starter);
  });
  ov.querySelector('#sp-resume').addEventListener('click', () => choose('resume'));
  ov.querySelector('#sp-fork').addEventListener('click', () => choose('fork'));
  ov.querySelector('#sp-choice-cancel').addEventListener('click', hideChoice);
  if (!escBound) {
    escBound = true;
    document.addEventListener('keydown', (e) => {
      if (!shell || shell.classList.contains('hidden')) return;
      if (e.key === 'Escape') {
        if (!shell.querySelector('#sp-choice').classList.contains('hidden')) hideChoice();
        else closeSessionPicker();
      } else if (e.key === 'Enter' && !shell.querySelector('#sp-choice').classList.contains('hidden') && S?.choice) {
        // Enter defaults to Resume (unless focus sits in a text field).
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') choose('resume');
      }
    });
  }
  shell = ov;
  return shell;
}

export function closeSessionPicker() {
  shell?.classList.add('hidden');
  S = null;
}

function parentOf(p) {
  if (!p) return null;
  const norm = p.replace(/[/\\]+$/, '');
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  if (i <= 0) return null;
  return norm.slice(0, i) || '/';
}

function dirNameOf(p) {
  const norm = String(p || '').replace(/[/\\]+$/, '');
  return norm.split(/[/\\]/).pop() || norm;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: 'Request failed' }));
  return data;
}

function showDirErr(msg) {
  const el = shell.querySelector('#sp-dir-err');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function createFolder() {
  const name = shell.querySelector('#sp-newfolder-name').value.trim().replace(/[/\\]/g, '');
  if (!name) return;
  showDirErr('');
  const sep = S.dir.includes('\\') ? '\\' : '/';
  const data = await api('/api/files/mkdir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: S.dir + sep + name }),
  });
  if (data?.error) { showDirErr(data.error); return; }
  shell.querySelector('#sp-newfolder-name').value = '';
  shell.querySelector('#sp-newfolder-row').classList.add('hidden');
  await navTo(data.path || (S.dir + sep + name));
}

function renderCrumb() {
  const parts = String(S.dir || '').split(/[/\\]/).filter(Boolean);
  const isAbs = /^[\\/]/.test(S.dir || '');
  let html = '';
  let acc = isAbs ? (S.dir[0] === '\\' ? '' : '/') : '';
  parts.forEach((p, i) => {
    acc += (acc && !/[\\/]$/.test(acc) ? '/' : '') + p;
    html += `<button class="sp-crumb-btn" data-i="${i}">${esc(p)}</button><span class="sp-crumb-sep">/</span>`;
  });
  const el = shell.querySelector('#sp-crumb');
  el.innerHTML = html || esc(S.dir);
  el.querySelectorAll('.sp-crumb-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      let acc2 = isAbs ? (S.dir[0] === '\\' ? '' : '/') : '';
      parts.slice(0, i + 1).forEach((p) => { acc2 += (acc2 && !/[\\/]$/.test(acc2) ? '/' : '') + p; });
      navTo(acc2);
    });
  });
}

function starBtn(filePath) {
  const on = S.opts.isFavourite?.(filePath);
  const b = document.createElement('button');
  b.className = `sp-star${on ? ' on' : ''}`;
  b.textContent = on ? '★' : '☆';
  b.title = on ? 'Unfavourite' : 'Favourite';
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    S.opts.onToggleFavourite?.(filePath);
    renderAll();
  });
  return b;
}

function sessionRow(sm, showDir) {
  const row = document.createElement('div');
  row.className = 'sp-sess';
  const dot = sm.running ? '<span class="sp-dot running" title="Running"></span>' : '<span class="sp-dot" title="Idle"></span>';
  row.innerHTML = `${dot}<div class="sp-sess-main"><div class="sp-sess-title">${esc(sm.title || '(empty session)')}</div>
    <div class="sp-sess-sub">${showDir ? `${esc(sm.dirName || '')} · ` : ''}${esc(fmtDate(sm.date))}</div></div>`;
  row.appendChild(starBtn(sm.filePath));
  row.addEventListener('click', () => showChoice(sm));
  return row;
}

function renderFavs() {
  const box = shell.querySelector('#sp-favs');
  const rows = shell.querySelector('#sp-fav-rows');
  rows.innerHTML = '';
  const favs = (S.favs || []).filter((s) => S.opts.isFavourite?.(s.filePath));
  box.classList.toggle('hidden', favs.length === 0);
  favs.forEach((s) => rows.appendChild(sessionRow(s, true)));
}

function renderSessions() {
  const box = shell.querySelector('#sp-sessions');
  box.innerHTML = '';
  shell.querySelector('#sp-sess-label').textContent = `Sessions in ${dirNameOf(S.dir)}`;
  if (!S.summaries?.length) {
    box.innerHTML = '<div class="sp-empty">No sessions here yet.</div>';
    return;
  }
  S.summaries.forEach((sm) => box.appendChild(sessionRow(sm, false)));
}

function renderDirs() {
  const box = shell.querySelector('#sp-dirs');
  box.innerHTML = '';
  if (!S.dirs?.length) {
    box.innerHTML = '<div class="sp-empty">No subdirectories.</div>';
    return;
  }
  S.dirs.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'sp-dir';
    row.innerHTML = `<span class="sp-dir-icon">📁</span><span class="sp-dir-name">${esc(d.name)}</span>`;
    row.addEventListener('click', () => navTo(d.path));
    box.appendChild(row);
  });
}

function renderAll() {
  renderCrumb();
  renderDirs();
  renderFavs();
  renderSessions();
}

async function navTo(dir) {
  if (!dir) return;
  S.dir = dir;
  showDirErr('');
  shell.querySelector('#sp-dirs').innerHTML = '<div class="sp-empty">Loading…</div>';
  shell.querySelector('#sp-sessions').innerHTML = '<div class="sp-empty">Loading…</div>';
  renderCrumb();
  try {
    const [listing, sums] = await Promise.all([
      api(`/api/files?path=${encodeURIComponent(dir)}`),
      api(`/api/sessions/summaries?cwd=${encodeURIComponent(dir)}`),
    ]);
    if (!S || S.dir !== dir) return; // moved on while loading
    if (listing?.error) { showDirErr(listing.error); S.dirs = []; }
    else {
      S.dir = listing.path || dir;
      S.dirs = (listing.items || []).filter((i) => i.isDirectory);
    }
    S.summaries = sums?.error ? [] : (sums.sessions || []);
  } catch {
    S.dirs = [];
    S.summaries = [];
  }
  renderAll();
}

function showChoice(sm) {
  S.choice = sm;
  shell.querySelector('#sp-choice-title').textContent = sm.title || '(empty session)';
  shell.querySelector('#sp-choice').classList.remove('hidden');
}
function hideChoice() {
  S.choice = null;
  shell.querySelector('#sp-choice').classList.add('hidden');
}
function choose(kind) {
  const sm = S.choice;
  const opts = S.opts;
  hideChoice();
  closeSessionPicker();
  if (!sm) return;
  if (kind === 'fork') opts.onFork?.(sm);
  else opts.onResume?.(sm);
}

export async function openSessionPicker(opts = {}) {
  const ov = ensureShell();
  S = { dir: opts.cwd || '', dirs: [], summaries: [], favs: [], opts, choice: null };
  ov.querySelector('#sp-starter').value = '';
  ov.querySelector('#sp-newfolder-row').classList.add('hidden');
  ov.querySelector('#sp-newfolder-name').value = '';
  hideChoice();
  ov.classList.remove('hidden');
  // Favourites need store-wide data (any directory): one full listing,
  // filtered to starred ids. Running dots stay directory-scoped below.
  try {
    const data = await api('/api/sessions');
    const all = [];
    for (const p of data.projects || []) {
      for (const s of p.sessions || []) {
        all.push({
          filePath: s.filePath,
          file: s.file,
          dirName: p.dirName || dirNameOf(pathOfProject(p)),
          title: s.name || s.firstMessage || '(empty session)',
          date: s.timestamp || s.mtime,
        });
      }
    }
    if (S) S.favs = all;
  } catch { /* favs stay empty */ }
  await navTo(S ? S.dir : opts.cwd);
}

function pathOfProject(p) {
  return p.path || '';
}
