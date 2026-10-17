/**
 * File Browser — right sidebar file tree with click-to-preview
 */

import { fileKindIcon } from './icons.js';

export function getFileIcon(name, isDirectory) {
  return fileKindIcon(name || 'file', !!isDirectory);
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export class FileBrowser {
  constructor(container, pathEl) {
    this.container = container;
    this.pathEl = pathEl;
    this.currentPath = null;
    // Root directory the browser should show for the currently viewed
    // session (set by the app on every view change); load() falls back to
    // the server default when null.
    this.pendingRoot = null;
    // sessionKeyOf() the last file the browser was rooted for — lets the
    // app skip reloads when a background sync re-announces the same file.
    this.sessionKey = null;
  }

  async load(dirPath) {
    this.container.innerHTML = '<div class="file-loading">Loading…</div>';

    try {
      const url = dirPath
        ? `/api/files?path=${encodeURIComponent(dirPath)}`
        : '/api/files';
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        this.container.innerHTML = `<div class="file-loading">${data.error}</div>`;
        return;
      }

      this.currentPath = data.path;
      this.pathEl.textContent = data.path;
      this.pathEl.title = data.path;
      this.render(data.items);
    } catch (err) {
      this.container.innerHTML = '<div class="file-loading">Failed to load</div>';
    }
  }

  getParentPath() {
    if (!this.currentPath) return null;
    const sep = this.currentPath.includes('\\') ? '\\' : '/';
    const normalized = this.currentPath.endsWith(sep) ? this.currentPath.slice(0, -1) : this.currentPath;
    const lastSep = normalized.lastIndexOf(sep);
    if (lastSep <= 0) return sep === '/' ? '/' : null;
    const parent = normalized.slice(0, lastSep);
    return /^[A-Za-z]:$/.test(parent) ? parent + sep : parent;
  }

  render(items) {
    this.container.innerHTML = '';

    if (items.length === 0) {
      this.container.innerHTML = '<div class="file-loading">Empty directory</div>';
      return;
    }

    for (const item of items) {
      const el = document.createElement('div');
      el.className = `file-item${item.isDirectory ? ' directory' : ''}`;
      el.dataset.path = item.path;
      el.dataset.name = item.name;
      el.dataset.isDirectory = item.isDirectory;

      const icon = getFileIcon(item.name, item.isDirectory);
      const size = item.isDirectory ? '' : formatSize(item.size);

      el.innerHTML = `
        <span class="file-icon">${icon}</span>
        <span class="file-name" title="${escHtml(item.name)}">${escHtml(item.name)}</span>
        ${size ? `<span class="file-size">${size}</span>` : ''}
      `;

      // Click: navigate directory, or preview a file (read-only viewer).
      // Files never feed the prompt directly — blind context is out.
      el.addEventListener('click', () => {
        if (item.isDirectory) {
          this.load(item.path);
        } else {
          this.previewFile(item.path);
        }
      });

      // Double-click: open file natively
      el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (!item.isDirectory) {
          this.openNatively(item.path);
        }
      });

      this.container.appendChild(el);
    }
  }

  async openNatively(filePath) {
    try {
      await fetch('/api/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
    } catch (err) {
      console.error('[FileBrowser] Failed to open:', err);
    }
  }

  // Read-only preview entry point (IDE-like viewer): the app owns the
  // viewer (session key + attach live there), so this is just an event.
  previewFile(filePath) {
    window.dispatchEvent(new CustomEvent('tau:preview-file', { detail: { path: filePath } }));
  }
}
