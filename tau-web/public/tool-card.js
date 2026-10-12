/**
 * Tool Card - Renders and updates tool execution cards (collapsible)
 */

// .tool-output element -> last full string written. Lets streaming updates
// append only the delta instead of re-writing (and re-laying-out) the block.
const lastOutput = new WeakMap();

function fmtClock(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
function fmtDuration(ms) {
  if (ms == null || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class ToolCardRenderer {
  constructor(container) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
  }

  createToolCard(toolExecution) {
    // A repeated start event must not recreate the card: rebuilding it would
    // restart the streaming badge's pulse and orphan the old card in the DOM.
    const existing = this.toolCards.get(toolExecution.toolCallId);
    if (existing) return existing;

    const { toolCallId, toolName, args, status } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = toolCallId;

    const startedAt = toolExecution.startedAt || Date.now();
    card.dataset.startedAt = String(startedAt);
    const clock = fmtClock(startedAt);
    const timeHtml = clock
      ? `<span class="tool-time" title="Started ${new Date(startedAt).toLocaleString()}">${this.escapeHtml(clock)}</span>`
      : '';

    const argsPreview = this.getArgsPreview(toolName, args);
    const argsJson = this.formatJson(args);
    const isExpanded = (status === 'streaming' || status === 'pending');

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.parentElement.querySelector('.tool-card-body').classList.toggle('expanded'); this.querySelector('.tool-card-chevron').classList.toggle('expanded')">
        <div class="tool-header-left">
          <span class="tool-card-chevron${isExpanded ? ' expanded' : ''}"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="tool-name">${this.escapeHtml(toolName)}</span>
          ${argsPreview ? `<span class="tool-args-preview">${this.escapeHtml(argsPreview)}</span>` : ''}
        </div>
        <div class="tool-header-right">
          ${timeHtml}
          <button class="tool-action-btn copy-output-btn" title="Copy output" onclick="event.stopPropagation(); var t=this.closest('.tool-card').querySelector('.tool-output'); if(!t||!t.textContent.trim())return; var s=t.textContent,b=this; (navigator.clipboard?navigator.clipboard.writeText(s):new Promise(function(r){var a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;left:-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);r()})).then(function(){b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <div class="tool-status ${status}">${status}</div>
        </div>
      </div>
      <div class="tool-card-body${isExpanded ? ' expanded' : ''}">
        ${!isEdit && argsJson ? `<div class="tool-args">${this.escapeHtml(argsJson)}</div>` : ''}
        <div class="tool-output-wrapper">
          <div class="tool-output"></div>
        </div>
      </div>
    `;

    // Insert diff view for Edit tools
    if (isEdit) {
      const diffEl = this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text);
      const body = card.querySelector('.tool-card-body');
      body.insertBefore(diffEl, body.firstChild);
    }

    this.container.appendChild(card);
    this.toolCards.set(toolCallId, card);
    this.scrollToBottom();

    return card;
  }

  updateToolCard(toolExecution) {
    let card = this.toolCards.get(toolExecution.toolCallId);

    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    // Update status — write only on change so the streaming pulse never restarts.
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      const cls = `tool-status ${toolExecution.status}`;
      if (statusElement.className !== cls) statusElement.className = cls;
      if (statusElement.textContent !== toolExecution.status) statusElement.textContent = toolExecution.status;
    }

    // Auto-expand when streaming
    if (toolExecution.status === 'streaming') {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      if (body) body.classList.add('expanded');
      if (chevron) chevron.classList.add('expanded');
    }

    // Update output — textContent write only on change (avoids layout churn).
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && toolExecution.output) {
      const next = toolExecution.output;
      const prev = lastOutput.get(outputElement) || '';
      if (next !== prev) {
        // Streaming output almost always grows by appending; append just the
        // delta so the whole block isn't re-laid-out every frame on phones.
        if (prev && next.startsWith(prev)) {
          outputElement.appendChild(document.createTextNode(next.slice(prev.length)));
        } else {
          outputElement.textContent = next;
        }
        lastOutput.set(outputElement, next);
        this.scrollToBottom();
      }
    }
  }

  finalizeToolCard(toolCallId, result, isError) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    // Light timestamp: start clock plus how long the call took.
    const timeEl = card.querySelector('.tool-time');
    if (timeEl) {
      const started = Number(card.dataset.startedAt) || Date.now();
      const dur = fmtDuration(Date.now() - started);
      const next = timeEl.textContent + (dur ? ` · ${dur}` : '');
      if (timeEl.textContent !== next) timeEl.textContent = next;
      timeEl.title = `Started ${new Date(started).toLocaleString()}${dur ? ` · took ${dur}` : ''}`;
    }

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      const status = isError ? 'error' : 'complete';
      statusElement.className = `tool-status ${status}`;
      statusElement.textContent = status;
    }

    // Update output with final result
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      const output = this.formatResult(result);
      outputElement.textContent = output;
      lastOutput.set(outputElement, output);
    }

    // Collapse completed cards (less noise)
    if (!isError) {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      if (body) body.classList.remove('expanded');
      if (chevron) chevron.classList.remove('expanded');
    }
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = toolCallId;

    // Header
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'tool-header-left';

    const chevron = document.createElement('span');
    chevron.className = 'tool-card-chevron';
    chevron.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>';
    headerLeft.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = toolName;
    headerLeft.appendChild(name);

    const preview = this.getArgsPreview(toolName, args);
    if (preview) {
      const previewEl = document.createElement('span');
      previewEl.className = 'tool-args-preview';
      previewEl.textContent = preview;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: timestamp + copy button + status
    const headerRight = document.createElement('div');
    headerRight.className = 'tool-header-right';

    if (toolExecution.timestamp) {
      const ts = new Date(toolExecution.timestamp).getTime();
      if (!Number.isNaN(ts)) {
        const timeEl = document.createElement('span');
        timeEl.className = 'tool-time';
        timeEl.textContent = fmtClock(ts);
        timeEl.title = new Date(ts).toLocaleString();
        headerRight.appendChild(timeEl);
      }
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-action-btn copy-output-btn';
    copyBtn.title = 'Copy output';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const output = card.querySelector('.tool-output');
      if (!output || !output.textContent.trim()) return;
      const text = output.textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : new Promise((r) => {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); r();
      })).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      });
    });
    headerRight.appendChild(copyBtn);

    const status = document.createElement('div');
    status.className = 'tool-status complete';
    status.textContent = 'complete';
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    // Toggle expand on click
    header.addEventListener('click', () => {
      body.classList.toggle('expanded');
      chevron.classList.toggle('expanded');
    });

    card.appendChild(header);

    // Body (collapsed by default)
    const body = document.createElement('div');
    body.className = 'tool-card-body';

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text));
    } else {
      const argsJson = this.formatJson(args);
      if (argsJson) {
        const argsEl = document.createElement('div');
        argsEl.className = 'tool-args';
        argsEl.textContent = argsJson;
        body.appendChild(argsEl);
      }
    }

    const outputEl = document.createElement('div');
    outputEl.className = 'tool-output';
    body.appendChild(outputEl);

    card.appendChild(body);

    this.container.appendChild(card);
    this.toolCards.set(toolCallId, card);

    return card;
  }

  /**
   * Add result to a history card (stays collapsed)
   */
  addHistoryResult(toolCallId, result, isError) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    if (isError) {
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) {
        statusEl.className = 'tool-status error';
        statusEl.textContent = 'error';
      }
    }

    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      const out = this.formatResult(result);
      outputElement.textContent = out;
      lastOutput.set(outputElement, out);
    }
  }

  /** Compact preview for the header line */
  getArgsPreview(toolName, args) {
    if (!args || Object.keys(args).length === 0) return '';

    // Show the most relevant arg inline
    if (args.path) return args.path;
    if (args.command) return args.command.substring(0, 80);
    if (args.query) return args.query.substring(0, 60);
    if (args.url) return args.url;

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0) {
        return val.substring(0, 60);
      }
    }
    return '';
  }

  formatJson(obj) {
    try {
      if (Object.keys(obj).length === 0) return '';
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  /** GitHub-style unified diff for the Edit tool (LCS on lines). */
  renderDiff(oldText, newText) {
    const container = document.createElement('div');
    container.className = 'tool-diff';
    const table = document.createElement('div');
    table.className = 'diff-table';
    container.appendChild(table);

    const oldLines = String(oldText ?? '').split('\n');
    const newLines = String(newText ?? '').split('\n');
    // Cap pathological inputs: bound the LCS matrix, fall back to
    // remove-all/add-all past the cap instead of hanging the phone.
    const MAX = 400;
    const a = oldLines.slice(0, MAX);
    const b = newLines.slice(0, MAX);
    const truncated = oldLines.length > MAX || newLines.length > MAX;

    // LCS lengths (Uint16 is plenty: capped at 400 lines per side).
    const n = a.length, m = b.length;
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] = a[i] === b[j]
          ? dp[(i + 1) * (m + 1) + j + 1] + 1
          : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    let i = 0, j = 0, oldNo = 0, newNo = 0;
    const row = (kind, gutter, text, oNum, nNum) => {
      const el = document.createElement('div');
      el.className = `diff-line diff-${kind}`;
      const g = document.createElement('span');
      g.className = 'diff-gutter';
      g.textContent = gutter;
      const on = document.createElement('span');
      on.className = 'diff-n';
      on.textContent = oNum || '';
      const nn = document.createElement('span');
      nn.className = 'diff-n';
      nn.textContent = nNum || '';
      const code = document.createElement('span');
      code.className = 'diff-code';
      code.textContent = text;
      el.append(g, on, nn, code);
      table.appendChild(el);
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) { oldNo++; newNo++; row('ctx', ' ', a[i] || ' ', String(oldNo), String(newNo)); i++; j++; }
      else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { oldNo++; row('del', '−', a[i], String(oldNo), ''); i++; }
      else { newNo++; row('add', '+', b[j], '', String(newNo)); j++; }
    }
    while (i < n) { oldNo++; row('del', '−', a[i], String(oldNo), ''); i++; }
    while (j < m) { newNo++; row('add', '+', b[j], '', String(newNo)); j++; }
    if (truncated) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-note';
      el.textContent = `… diff truncated at ${MAX} lines per side`;
      table.appendChild(el);
    }
    return container;
  }

  formatResult(result) {
    if (!result) return '';

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map(block => {
          if (block.type === 'text') return block.text;
          return JSON.stringify(block);
        })
        .join('\n');
    }

    return JSON.stringify(result, null, 2);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // innerHTML escapes &<>, but NOT quotes — attribute contexts need them too.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  scrollToBottom() {
    // Same courtesy as MessageRenderer: never yank a reading finger.
    if (typeof this.shouldStick === 'function' && !this.shouldStick()) return;
    if (this.container && !this._scrollRaf) {
      const threshold = 100;
      const isNear =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
      if (isNear) {
        this._scrollRaf = requestAnimationFrame(() => {
          this._scrollRaf = null;
          if (typeof this.shouldStick === 'function' && !this.shouldStick()) return;
          this.container.scrollTop = this.container.scrollHeight;
        });
      }
    }
  }

  expandAll() {
    this.toolCards.forEach(card => {
      card.querySelector('.tool-card-body')?.classList.add('expanded');
      card.querySelector('.tool-card-chevron')?.classList.add('expanded');
    });
  }

  collapseAll() {
    this.toolCards.forEach(card => {
      card.querySelector('.tool-card-body')?.classList.remove('expanded');
      card.querySelector('.tool-card-chevron')?.classList.remove('expanded');
    });
  }

  clear() {
    this.toolCards.forEach((card) => card.remove());
    this.toolCards.clear();
  }
}
