/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';
import { icon } from './icons.js';

// Allowlist mirrors processImageFile's VALID_MIME_TYPES in app.js. History
// session files are attacker-influenced, so image blocks are validated here
// at the sink (and filtered on the history path in app.js).
const VALID_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function isValidMessageImage(img) {
  if (!img || typeof img.data !== 'string' || !img.data) return false;
  if (!VALID_IMAGE_MIMES.includes(img.mimeType || 'image/png')) return false;
  let b64 = img.data;
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma === -1) return false;
    const header = b64.slice(0, comma);
    const m = header.match(/^data:([^;,]+)(;base64)?$/i);
    if (!m || !VALID_IMAGE_MIMES.includes((m[1] || '').toLowerCase())) return false;
    b64 = b64.slice(comma + 1);
  }
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) return false;
  return b64.replace(/\s/g, '').length > 0;
}

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;
    // Set by app.js: called with (messageEl, buttonEl) when a speak button is
    // tapped. Keeping the callback here means the renderer owns no speech state.
    this.onSpeak = null;
    // tau-web: sticky scroll. Programmatic per-chunk scrolls fight the user's
    // finger (and the mobile URL bar collapsing shifts clientHeight, making
    // near-bottom flap) — visible as flicker on phones. So a recent manual
    // scroll suppresses autoscroll for a few seconds.
    this.lastUserScroll = 0;
    this.touchActive = false;
    const markUserScroll = () => { this.lastUserScroll = Date.now(); };
    this.container.addEventListener('wheel', markUserScroll, { passive: true });
    this.container.addEventListener('touchstart', () => { this.touchActive = true; markUserScroll(); }, { passive: true });
    this.container.addEventListener('touchmove', markUserScroll, { passive: true });
    this.container.addEventListener('touchend', () => { this.touchActive = false; markUserScroll(); }, { passive: true });

    // Track scroll position for smart auto-scroll
    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
  }
  userIsReading() {
    return this.touchActive || (Date.now() - this.lastUserScroll < 2500);
  }

  clear() {
    this.container.innerHTML = '';
  }

  /**
   * Render KaTeX math in the given element if the library is loaded.
   * Safe to call on streaming/escaped content — KaTeX only processes $...$ patterns.
   */
  _renderMath(element) {
    // P6: KaTeX auto-render is the heaviest DOM work in the renderer — skip
    // it when the finalized text contains no math delimiter at all.
    try {
      const text = element?.textContent || '';
      if (!text.includes('$')) return;
    } catch { return; }
    if (typeof renderMathInElement !== 'undefined') {
      try {
        renderMathInElement(element, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) {
        // KaTeX not loaded or rendering failed — math stays as raw TeX
      }
    }
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="/icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>Welcome to Tau</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    if (message.images && message.images.length > 0) {
      const imagesWrap = document.createElement('div');
      imagesWrap.className = 'message-images';
      let validCount = 0;
      for (const img of message.images) {
        if (!isValidMessageImage(img)) continue;
        const el = document.createElement('img');
        el.className = 'message-image';
        el.alt = 'Attached image';
        el.src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
        imagesWrap.appendChild(el);
        validCount++;
      }
      if (validCount > 0) contentDiv.appendChild(imagesWrap);
    }
    contentDiv.insertAdjacentHTML('beforeend', renderUserMarkdown(message.content));
    div.appendChild(contentDiv);
    div.insertAdjacentHTML('beforeend', `
      <button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `);
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    this._renderMath(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text);
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? '<button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      this._setupCopyBtn(div);
      const speakText = typeof message.content === 'string'
        ? message.content
        : (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      this._addSpeakBtn(div, speakText);
    }
    this.container.appendChild(div);
    if (!isStreaming) this._renderMath(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      // Always write into a dedicated text node. Rewriting the whole
      // contentDiv per chunk churns layout and disturbs the ::after cursor.
      let textNode = contentDiv.querySelector('.streaming-text');
      if (!textNode) {
        textNode = document.createElement('div');
        textNode.className = 'streaming-text';
        contentDiv.appendChild(textNode);
      }
      const escaped = this.escapeHtml(content);
      if (textNode.innerHTML !== escaped) textNode.innerHTML = escaped;
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '', message = null) {
    const contentDiv = messageElement.querySelector('.message-content');
    // Capture the streamed text before the content div is rewritten: it is the
    // fallback when the final payload has no text blocks (synthetic end).
    const streamingText = contentDiv?.querySelector('.streaming-text');
    const streamedRaw = streamingText ? streamingText.textContent : '';
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      // Prefer the authoritative final message content: it carries the real
      // block order (thinking → text → thinking). The old fallback used
      // contentDiv.textContent when no text streamed, which INCLUDED the
      // streaming thinking block — duplicating thinking into the body text.
      let html = '';
      const blocks = Array.isArray(message?.content) ? message.content : null;
      if (blocks) {
        let sawThinking = false;
        let sawText = false;
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            sawText = true;
            html += renderMarkdown(block.text);
          } else if (block.type === 'thinking' && block.thinking) {
            sawThinking = true;
            html += this.renderThinkingBlock(block.thinking);
          }
        }
        if (!sawThinking && thinking) html = this.renderThinkingBlock(thinking) + html;
        // The final payload should carry every text block; if it somehow
        // doesn't, keep what was streamed instead of dropping it.
        if (!sawText && streamedRaw) html += renderMarkdown(streamedRaw);
      } else {
        // No final message payload (e.g. synthetic end): use the streamed text
        // only — never the whole content div (it includes the thinking block).
        if (thinking) html += this.renderThinkingBlock(thinking);
        html += renderMarkdown(streamedRaw);
      }
      contentDiv.innerHTML = html;
      // Render math after markdown is applied
      this._renderMath(contentDiv);
    }

    // Add copy + speak buttons after streaming finishes
    if (!messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }
    if (!messageElement.querySelector('.message-speak-btn')) {
      const blocks = Array.isArray(message?.content) ? message.content : null;
      const text = blocks
        ? blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        : streamedRaw;
      this._addSpeakBtn(messageElement, text);
    }

    // Add usage info if available
    if (usage && usage.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector('.message-usage')) {
        const span = document.createElement('span');
        span.className = 'message-usage';
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.innerHTML = `${icon('warn', 14)}<span></span>`;
    div.querySelector('span').textContent = errorMessage;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      // Copy the reply text, not the Thinking blocks (their label + body
      // would otherwise pollute the clipboard).
      const clone = content.cloneNode(true);
      clone.querySelectorAll('.thinking-block').forEach((n) => n.remove());
      const text = clone.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  // Add a read-aloud button to a finalized assistant message. The raw text is
  // kept on the element (a DOM property, not an attribute) so the speech
  // controller can read the source markdown rather than the rendered DOM.
  _addSpeakBtn(messageEl, text) {
    if (!text || !String(text).trim()) return;
    messageEl._speakText = String(text);
    const btn = document.createElement('button');
    btn.className = 'message-speak-btn';
    btn.title = 'Read aloud';
    btn.setAttribute('aria-label', 'Read message aloud');
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    btn.addEventListener('click', () => this.onSpeak?.(messageEl, btn));
    messageEl.appendChild(btn);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    // innerHTML escapes &<>, but NOT quotes — attribute contexts need them too.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  scrollToBottom() {
    // Never yank the view out from under a reading finger (phone flicker).
    if (this.userIsReading()) return;
    // Coalesce to one write per frame: a scroll write per stream delta keeps
    // restarting scroll animations and repaints the viewport needlessly.
    if (this.isNearBottom && !this._scrollRaf) {
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = null;
        if (this.userIsReading()) return;
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
