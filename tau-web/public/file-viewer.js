/**
 * Read-only file viewer — IDE-like preview with syntax highlighting.
 *
 * Opened from the file explorer (via the `tau:preview-file` event, so this
 * module never imports app internals). Highlighting is highlight.js from
 * CDN; the token colors below reuse the app's own CSS vars so every theme
 * (and the pre-paint head script) applies automatically. No hljs on the
 * box (offline CDN) degrades to plain text — never an error.
 */

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonl: 'json', py: 'python', rb: 'ruby', php: 'php',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', go: 'go',
  rs: 'rust', c: 'c', h: 'cpp', hh: 'cpp', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  sql: 'sql', xml: 'xml', html: 'xml', svg: 'xml', css: 'css', scss: 'css',
  md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff',
  tex: 'latex', r: 'r', lua: 'lua', pl: 'perl', vim: 'vim',
};
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']);
const AUTO_LIMIT = 64 * 1024; // highlightAuto only below this (it's slow)

let shell = null;   // built lazily
let current = null; // { path, content } for Copy
let onAttachCb = null;
let escBound = false;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function extOf(p) {
  const base = String(p || '').split(/[/\\]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function ensureShell() {
  if (shell) return shell;
  const overlay = document.createElement('div');
  overlay.className = 'fv-overlay hidden';
  overlay.id = 'file-viewer';
  overlay.innerHTML = `
    <div class="fv-backdrop" data-close></div>
    <div class="fv-panel" role="dialog" aria-label="File preview">
      <div class="fv-head">
        <div class="fv-title-wrap">
          <div class="fv-name" id="fv-name"></div>
          <div class="fv-meta" id="fv-meta"></div>
        </div>
        <div class="fv-actions">
          <button class="fv-btn" id="fv-copy" title="Copy contents">Copy</button>
          <button class="fv-btn fv-btn-primary" id="fv-attach" title="Add this file to the prompt">Add to prompt</button>
          <button class="fv-btn fv-btn-x" id="fv-close" title="Close (Esc)" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="fv-notice hidden" id="fv-notice"></div>
      <div class="fv-body" id="fv-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-close]').addEventListener('click', closeFileViewer);
  overlay.querySelector('#fv-close').addEventListener('click', closeFileViewer);
  overlay.querySelector('#fv-copy').addEventListener('click', async () => {
    if (!current?.content) return;
    try { await navigator.clipboard.writeText(current.content); } catch {}
  });
  overlay.querySelector('#fv-attach').addEventListener('click', () => {
    if (!current?.path || !onAttachCb) return;
    const name = current.path.split(/[/\\]/).pop() || current.path;
    onAttachCb({ path: current.path, name, ext: extOf(current.path) });
    closeFileViewer();
  });
  if (!escBound) {
    escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && shell && !shell.classList.contains('hidden')) closeFileViewer();
    });
  }
  shell = overlay;
  return shell;
}

export function closeFileViewer() {
  shell?.classList.add('hidden');
  current = null;
}

function renderCode(content, lang) {
  const body = shell.querySelector('#fv-body');
  const lines = content.split('\n').length;
  const gutter = `<div class="fv-gutter" aria-hidden="true">${Array.from(
    { length: lines }, (_, i) => `<span>${i + 1}</span>`).join('')}</div>`;
  let html = esc(content);
  try {
    const hljs = window.hljs;
    if (hljs && content.length) {
      if (lang && hljs.getLanguage(lang)) {
        html = hljs.highlight(content, { language: lang }).value;
      } else if (!lang && content.length < AUTO_LIMIT && hljs.highlightAuto) {
        html = hljs.highlightAuto(content).value;
      }
    }
  } catch {}
  body.innerHTML = `${gutter}<pre class="fv-code"><code class="hljs">${html}</code></pre>`;
  body.scrollTop = 0;
  body.scrollLeft = 0;
}

export async function openFileViewer(filePath, opts = {}) {
  const ov = ensureShell();
  onAttachCb = opts.onAttach || null;
  ov.querySelector('#fv-attach').style.display = onAttachCb ? '' : 'none';
  const name = String(filePath).split(/[/\\]/).pop() || filePath;
  ov.querySelector('#fv-name').textContent = name;
  ov.querySelector('#fv-name').title = filePath;
  ov.querySelector('#fv-meta').textContent = 'Loading…';
  ov.querySelector('#fv-notice').classList.add('hidden');
  ov.querySelector('#fv-body').innerHTML = '<div class="fv-loading">Loading…</div>';
  ov.classList.remove('hidden');
  current = null;

  const ext = extOf(filePath);
  let data = null;
  try {
    const url = `/api/files/content?path=${encodeURIComponent(filePath)}&sessionKey=${encodeURIComponent(opts.sessionKey || '')}`;
    const res = await fetch(url);
    data = await res.json();
  } catch {
    data = { error: 'Request failed' };
  }
  if (ov.classList.contains('hidden')) return; // closed while loading
  const body = ov.querySelector('#fv-body');
  const notice = ov.querySelector('#fv-notice');
  if (!data || data.error) {
    ov.querySelector('#fv-meta').textContent = '';
    body.innerHTML = `<div class="fv-error">${esc(data?.error || 'Could not load file')}</div>`;
    return;
  }
  const meta = [fmtSize(data.size), ext ? ext.toUpperCase() : 'TEXT'].filter(Boolean).join(' · ');
  ov.querySelector('#fv-meta').textContent = meta;
  if (data.binary) {
    if (IMAGE_EXTS.has(ext)) {
      body.innerHTML = `<div class="fv-image-wrap"><img class="fv-image" src="/api/file/preview?path=${encodeURIComponent(data.path)}" alt="${esc(name)}"></div>`;
      current = { path: data.path, content: '' };
    } else {
      body.innerHTML = `<div class="fv-error">Binary file (${fmtSize(data.size)}) — not previewable.</div>`;
      current = { path: data.path, content: '' };
    }
    return;
  }
  if (data.truncated) {
    notice.textContent = `Showing the first 256 KiB of ${fmtSize(data.size)}.`;
    notice.classList.remove('hidden');
  }
  current = { path: data.path, content: data.content || '' };
  renderCode(current.content, EXT_LANG[ext] || null);
}
