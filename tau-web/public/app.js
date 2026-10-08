/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { SessionSidebar } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { Launcher } from './launcher.js';

// ─── Basic Auth re-login recovery ───
// fetch() and WebSocket 401s never trigger the browser's native login
// dialog — only a top-level navigation does. If the cached app shell ever
// loads without credentials (stale service worker, restored tab), API calls
// fail with 401 and the app looks broken instead of prompting. Reloading
// forces a real navigation, which brings the login prompt back.
let tauAuthReloading = false;
function tauNeedsLogin(res, url) {
  const u = typeof url === 'string' ? url : url?.url || '';
  if (res?.status === 401 && u.includes('/api/')) {
    if (!tauAuthReloading) {
      tauAuthReloading = true;
      window.location.reload();
    }
    return true;
  }
  return false;
}
const tauRawFetch = window.fetch.bind(window);
window.fetch = (url, opts) => tauRawFetch(url, opts).then((res) => {
  tauNeedsLogin(res, url);
  return res;
});


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
const dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const sessionSearchInput = document.getElementById('session-search-input');
const typingIndicator = document.getElementById('typing-indicator');

const sessionCostEl = document.getElementById('session-cost');
const tokenUsageEl = document.getElementById('token-usage');
const contextSizeEl = document.getElementById('context-size');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const messagesContainer = document.getElementById('messages');

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Tau instances [{port, sessionFile, cwd}]
// ─── tau-web unified: epoch guard, headless binding, uplink (ADR-004) ───
let bindingEpoch = 0; // bumped on every session switch; stale stream events are dropped
let activeStreamEpoch = -1; // epoch captured when the current stream started
const VISIBLE_MESSAGE_WINDOW = 60; // render only the tail; full history stays on disk
let headlessSessionKey = null; // acked by start_session response; null = headless not bound
let headlessBinding = null; // { cwd, sessionFile } — rejoin target persisted per browser
try { headlessBinding = JSON.parse(localStorage.getItem('tau-web-binding') || 'null'); } catch {}
let uplinkActive = null; // { port, pid } while attached to a live TUI via uplink proxy
let rpcSeq = 0;
const pendingRpc = new Map(); // id -> { resolve, command } for start_session / uplink_list acks
function sendRpc(command) {
  const id = `web-${Date.now().toString(36)}-${(rpcSeq++).toString(36)}`;
  return new Promise((resolve) => {
    pendingRpc.set(id, { resolve, command: command.type });
    wsClient.send({ ...command, id });
    setTimeout(() => { if (pendingRpc.has(id)) { pendingRpc.delete(id); resolve({ timeout: true }); } }, 15000);
  });
}
function persistBinding() {
  try {
    if (headlessBinding) localStorage.setItem('tau-web-binding', JSON.stringify(headlessBinding));
    else localStorage.removeItem('tau-web-binding');
  } catch {}
}

// File browser
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarToggle = document.getElementById('file-sidebar-toggle');
const fileSidebarClose = document.getElementById('file-sidebar-close');
const fileSidebarUp = document.getElementById('file-sidebar-up');
const fileList = document.getElementById('file-list');
const fileSidebarPath = document.getElementById('file-sidebar-path');
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput, (filePath) => {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  const ext = name.split('.').pop()?.toLowerCase() || '';
  pendingFilePaths.push({ path: filePath, name, ext });
  renderAttachmentPreviews();
});

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  // Only one slide-over at a time on mobile
  if (isMobile() && !isCollapsed) {
    sidebarEl.classList.add('collapsed');
  }
  refreshMobileOverlay();
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  refreshMobileOverlay();
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

fetch('/api/health').then(r => r.json()).then(data => {
  const names = { win32: 'Explorer', darwin: 'Finder', linux: 'file manager' };
  const name = names[data.platform] || 'file manager';
  document.getElementById('file-sidebar-finder').title = `Open in ${name}`;
}).catch(() => {});

document.getElementById('file-sidebar-finder').addEventListener('click', () => {
  if (fileBrowser.currentPath) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// Restore file sidebar state (desktop only — mobile starts as a slide-over)
if (!isMobile() && localStorage.getItem('tau-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);
  // Warm the slash-command cache for palette search + input validation
  fetchSlashCommands();
  // (Re)bind the headless backend: rejoin the stored session or start fresh.
  // One WS = one backend (server keys by connection); a second browser tab or
  // window gets its own backend, so phone + laptop stay independent.
  bindHeadless(headlessBinding?.cwd || null, headlessBinding?.sessionFile || null);
  // Refresh the Live TUI section.
  refreshUplinkList();
});

// ─── tau-web unified protocol events ───
wsClient.addEventListener('rpcResponse', (e) => {
  const { id, response } = e.detail;
  const pend = id ? pendingRpc.get(id) : null;
  if (pend) { pendingRpc.delete(id); try { pend.resolve(response?.data || response); } catch {} }
  if (response?.command === 'start_session' && response?.success) {
    headlessSessionKey = response?.data?.sessionKey || 'bound';
  } else if (response?.command === 'uplink_list' && response?.success) {
    renderLiveSection(response?.data?.instances || []);
  }
});
wsClient.addEventListener('uplinkAttached', (e) => {
  uplinkActive = { port: e.detail.port, pid: e.detail.pid };
  renderLiveSection(liveInstances);
  messageRenderer.renderSystemMessage(`Attached to live session on :${e.detail.port} — prompts now drive the TUI.`);
});
wsClient.addEventListener('uplinkDetached', () => {
  uplinkActive = null;
  renderLiveSection(liveInstances);
});
wsClient.addEventListener('uplinkDead', (e) => {
  const was = uplinkActive;
  uplinkActive = null;
  renderLiveSection(liveInstances);
  // Never silent (ADR-007): surface the drop and offer headless-continue on the same file.
  messageRenderer.renderError(`Live uplink to :${e.detail.port} dropped. The TUI may have exited.`);
  if (e.detail.headlessContinue && was) offerHeadlessContinue(e.detail);
});
wsClient.addEventListener('sessionEnded', (e) => {
  headlessSessionKey = null;
  messageRenderer.renderError(`Headless session ended (exit ${e.detail.code ?? '?'}). Pick a session from the sidebar to continue.`);
});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
  // A dead socket can't tell "server down" from "credentials lost" (an
  // auth-rejected WS upgrade surfaces as an abnormal close). Probe an
  // authenticated endpoint — the fetch wrapper reloads into the login
  // prompt on 401, while network errors reject silently and keep retrying.
  tauRawFetch('/api/sessions').then((res) => tauNeedsLogin(res, '/api/sessions')).catch(() => {});
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  messageRenderer.renderError(e.detail.message);
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function handleAgentStart() {
  activeStreamEpoch = bindingEpoch;
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  updateUI();

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;

  }
}

let currentStreamingThinking = '';

function handleMessageStart(message) {
  activeStreamEpoch = bindingEpoch;
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    // In mirror mode, user messages from TUI appear via events
    // Only render if we didn't just send this message ourselves
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
  }
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function handleMessageUpdate(event) {
  if (activeStreamEpoch !== -1 && activeStreamEpoch !== bindingEpoch) return; // stale stream after switch
  const { assistantMessageEvent } = event;

  if (assistantMessageEvent.type === 'thinking_delta') {
    currentStreamingThinking += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'text_delta') {
    currentStreamingText += assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  }
}

function handleMessageEnd(message) {
  if (activeStreamEpoch !== -1 && activeStreamEpoch !== bindingEpoch) { currentStreamingElement = null; return; }
  if (currentStreamingElement) {
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateCostDisplay();
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: 'pending',
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionUpdate(event) {
  if (activeStreamEpoch !== -1 && activeStreamEpoch !== bindingEpoch) return;
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  if (activeStreamEpoch !== -1 && activeStreamEpoch !== bindingEpoch) return;
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(event);
      break;
    case 'confirm':
      dialogHandler.showConfirm(event);
      break;
    case 'input':
      dialogHandler.showInput(event);
      break;
    case 'editor':
      dialogHandler.showEditor(event);
      break;
    case 'notify':
      dialogHandler.showNotification(event);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return '';

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// Keep the message list clear of the overlay chrome: the input grows with
// multi-line text, queued messages and image previews, and the header grows
// with stacked info rows on mobile — measure both and expose the heights as
// --input-height / --header-height (consumed by .messages padding and the
// scroll-to-bottom button). Re-pin when already at the bottom.
(function syncChromeHeights() {
  const inputArea = document.querySelector('.input-area');
  const headerEl = document.querySelector('.header');
  if (!inputArea || typeof ResizeObserver === 'undefined') return;
  const apply = () => {
    const wasNearBottom =
      messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 150;
    document.documentElement.style.setProperty('--input-height', `${inputArea.offsetHeight}px`);
    if (headerEl) {
      document.documentElement.style.setProperty('--header-height', `${headerEl.offsetHeight}px`);
    }
    if (wasNearBottom) messagesContainer.scrollTop = messagesContainer.scrollHeight;
  };
  const ro = new ResizeObserver(apply);
  ro.observe(inputArea);
  if (headerEl) ro.observe(headerEl);
  window.addEventListener('resize', apply);
  apply();
})();

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviews = document.getElementById('image-previews');

let pendingImages = [];     // { data: base64, mimeType }
let pendingFilePaths = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      thumb.src = `/api/file/preview?path=${encodeURIComponent(fp.path)}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue = [];

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  // Guard against mistyped slash commands — Pi would otherwise treat
  // them as literal text. Browse exact names via the command palette.
  if (message.startsWith('/') && !isKnownSlashCommand(message)) {
    const bad = message.split(/\s/)[0];
    messageRenderer.renderError(`Unknown command ${bad} — open the command palette to browse available commands.`);
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';

  const cmd = { type: 'prompt', message: message || '(see attached image)' };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  routeCommand(cmd);
}

const queuedMessagesEl = document.getElementById('queued-messages');

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    const cmd = messageQueue.shift();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    routeCommand(cmd);
  }
}

abortBtn.addEventListener('click', () => {
  routeCommand({ type: 'abort' });
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');

const commandSearch = document.getElementById('command-search');

const localCommands = [
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },
];

// Slash commands from the Pi session (fetched via get_commands, cached here).
// Used for palette search and for validating `/...` input before sending.
let slashCommands = []; // [{ name, description, source }]
let paletteSelected = 0;

async function fetchSlashCommands() {
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_commands' }),
    });
    const data = await resp.json();
    if (data.success && Array.isArray(data.data?.commands)) {
      slashCommands = data.data.commands;
    }
  } catch { /* keep stale cache — validation is best-effort */ }
  return slashCommands;
}

function isKnownSlashCommand(message) {
  const m = message.trimStart().match(/^\/(\S+)/);
  if (!m) return true; // not a slash invocation — nothing to validate
  if (slashCommands.length === 0) return true; // no data yet — let it through
  const name = m[1].toLowerCase();
  return slashCommands.some(c => c.name.toLowerCase() === name);
}

// Fuzzy match: all query chars must appear in order in text.
// Scores prefix and word-boundary matches higher, penalizes gaps.
// Returns -1 on no match.
function fuzzyScore(query, text) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  if (!query) return 0;
  let qi = 0, score = 0, lastMatch = -1;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      if (ti === 0 || text[ti - 1] === ' ' || text[ti - 1] === '/' || text[ti - 1] === '-') score += 3;
      else if (lastMatch === ti - 1) score += 2; // consecutive bonus
      else score += 1;
      lastMatch = ti;
      qi++;
    } else if (lastMatch !== -1) {
      score -= 0.05; // small gap penalty only after first match
    }
  }
  return qi === query.length ? score : -1;
}

function pickSlashCommand(cmd) {
  // Prefill the input as `/name ` and focus it so args can be added
  // before sending — Enter fires it via slash expansion server-side.
  closeCommandPalette();
  messageInput.value = `/${cmd.name} `;
  messageInput.dispatchEvent(new Event('input'));
  messageInput.focus();
}

function renderPalette(filter = '') {
  const q = filter.trim().toLowerCase();
  const items = [];

  for (const cmd of localCommands) {
    if (!q || (`${cmd.label} ${cmd.desc}`.toLowerCase().includes(q))) {
      items.push({ kind: 'local', sort: 0, cmd });
    }
  }

  const stripped = q.startsWith('/') ? q.slice(1) : q;
  for (const cmd of slashCommands) {
    const haystack = `/${cmd.name} ${cmd.description || ''}`;
    const s = fuzzyScore(stripped, haystack);
    if (s >= 0) items.push({ kind: 'slash', sort: -s, cmd });
  }
  items.sort((a, b) => a.sort - b.sort);

  commandList.innerHTML = '';
  if (items.length === 0) {
    commandList.innerHTML = '<div class="command-empty">No matching commands</div>';
  }
  const els = [];
  items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'command-item';
    if (item.kind === 'local') {
      el.innerHTML = `
        <div class="command-icon">${item.cmd.icon}</div>
        <div>
          <div class="command-label">${item.cmd.label}</div>
          <div class="command-desc">${item.cmd.desc}</div>
        </div>
      `;
      el.addEventListener('click', () => { closeCommandPalette(); item.cmd.action(); });
    } else {
      el.innerHTML = `
        <div class="command-icon">/</div>
        <div>
          <div class="command-label">/${item.cmd.name}</div>
          <div class="command-desc">${escapeHtml(item.cmd.description || item.cmd.source || '')}</div>
        </div>
      `;
      el.addEventListener('click', () => pickSlashCommand(item.cmd));
    }
    commandList.appendChild(el);
    els.push(el);
  });
  paletteSelected = Math.min(paletteSelected, Math.max(0, els.length - 1));
  highlightPalette(els);
  return els;
}

function highlightPalette(els) {
  els = els || [...commandList.querySelectorAll('.command-item')];
  els.forEach((el, i) => el.classList.toggle('selected', i === paletteSelected));
  els[paletteSelected]?.scrollIntoView({ block: 'nearest' });
}

async function openCommandPalette() {
  commandPalette.classList.remove('hidden');
  commandPaletteOverlay.classList.remove('hidden');
  commandSearch.value = '';
  paletteSelected = 0;
  renderPalette('');
  commandSearch.focus();
  await fetchSlashCommands();
  if (!commandPalette.classList.contains('hidden')) renderPalette(commandSearch.value);
}

function closeCommandPalette() {
  commandPalette.classList.add('hidden');
  commandPaletteOverlay.classList.add('hidden');
}

commandSearch.addEventListener('input', () => {
  paletteSelected = 0;
  renderPalette(commandSearch.value);
});

commandSearch.addEventListener('keydown', (e) => {
  const els = [...commandList.querySelectorAll('.command-item')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteSelected = Math.min(paletteSelected + 1, els.length - 1);
    highlightPalette(els);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSelected = Math.max(paletteSelected - 1, 0);
    highlightPalette(els);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    els[paletteSelected]?.click();
  } else if (e.key === 'Escape') {
    closeCommandPalette();
    messageInput.focus();
  }
});

commandBtn.addEventListener('click', openCommandPalette);
commandPaletteOverlay.addEventListener('click', closeCommandPalette);

async function rpcCommand(cmd, statusMsg) {
  try {
    if (statusMsg) statusText.textContent = statusMsg;
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      statusText.textContent = 'Done';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
    } else {
      statusText.textContent = data.error || 'Failed';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    }
    return data;
  } catch (e) {
    statusText.textContent = 'Error';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    statusText.textContent = `Exported: ${data.data.path}`;
    setTimeout(() => { statusText.textContent = 'Connected'; }, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
const thinkingBtn = document.getElementById('thinking-btn');
function updateThinkingBtn() {
  thinkingBtn.textContent = currentThinkingLevel;
  thinkingBtn.classList.toggle('off', currentThinkingLevel === 'off');
}
let currentModelId = '';
let availableModels = [];
let currentThinkingLevel = 'off';

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models' }) }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state' }) }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      updateModelLabel();

      const model = availableModels.find(m => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      updateThinkingBtn();
    }
  } catch (e) {
    // ignore
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  modelDropdownLabel.textContent = shortName || 'model';
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains('hidden');
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  modelDropdownMenu.innerHTML = '';

  // Search input
  const search = document.createElement('input');
  search.className = 'model-dropdown-search';
  search.placeholder = 'Search models…';
  search.type = 'text';
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'model-dropdown-items';
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.innerHTML = '';
    const query = (filter || '').toLowerCase();
    availableModels.forEach(m => {
      const shortName = m.id.replace(/-\d{8}$/, '');
      const providerStr = m.provider || '';
      if (query && !shortName.toLowerCase().includes(query) && !providerStr.toLowerCase().includes(query)) return;

      const el = document.createElement('div');
      el.className = `model-dropdown-item${m.id === currentModelId ? ' active' : ''}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : '';
      const providerLabel = m.provider && m.provider !== 'anthropic' ? `<span class="model-dropdown-item-provider">${m.provider}</span>` : '';
      el.innerHTML = `<span>${shortName}${providerLabel}</span><span class="model-dropdown-item-ctx">${ctxK}</span>`;
      el.addEventListener('click', async () => {
        closeModelDropdown();
        const display = m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        await rpcCommand({ type: 'set_model', provider: m.provider, modelId: m.id }, `Switching to ${display}...`);
        currentModelId = m.id;
        updateModelLabel();
        if (m.contextWindow) {
          contextWindowSize = m.contextWindow;
          updateTokenUsage();
        }
      });
      itemsContainer.appendChild(el);
    });
  }

  renderItems('');

  search.addEventListener('input', () => renderItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelDropdown(); e.stopPropagation(); }
    if (e.key === 'Enter') {
      const first = itemsContainer.querySelector('.model-dropdown-item');
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
}

modelDropdownBtn.addEventListener('click', toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
});

// Thinking level button — cycles through levels
thinkingBtn.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' }, 'Cycling thinking...');
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains('hidden')) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains('hidden')) {
      closeModelDropdown();
      return;
    }

    if (state.isStreaming) {
      routeCommand({ type: 'abort' });
      messageRenderer.renderError('Aborted by user');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function refreshMobileOverlay() {
  if (!isMobile()) return;
  const anyOpen =
    !sidebarEl.classList.contains('collapsed') || !fileSidebar.classList.contains('collapsed');
  sidebarOverlay.classList.toggle('visible', anyOpen);
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  // Only one slide-over at a time on mobile
  if (isMobile() && !sidebarEl.classList.contains('collapsed')) {
    fileSidebar.classList.add('collapsed');
  }
  refreshMobileOverlay();
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  fileSidebar.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn');
newSessionBtn.addEventListener('click', () => {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  state.reset();
  messageRenderer.clear();
  toolCardRenderer.clear();
  messageRenderer.renderWelcome();
  sidebar.clearActive();
  viewingActiveSession = true;
  updateMirrorInputState();
});

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(null);
  sidebar.clearActive();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleSessionSelect(session, project) {
  sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    // New binding epoch — in-flight stream events from the old session are dropped.
    bindingEpoch++;
    activeStreamEpoch = -1;
    // Clear any streaming state from previous session to prevent bleed
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage('Loading session...');

      const dirName = project?.dirName;
      const file = session.file;
      console.log('[App] Loading history:', { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const res = await fetch(`/api/sessions/${dirName}/${file}`);
          console.log('[App] History fetch status:', res.status);
          const data = await res.json();
          console.log('[App] History entries:', data.entries?.length || 0);

          messageRenderer.clear();
          renderSessionHistory(data.entries || []);
          // Bind the headless backend to this file so prompts have a runner
          // even when no live TUI owns the session.
          bindHeadless(project?.path || null, file);
        } catch (e) {
          console.error('[App] History fetch error:', e);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      messageRenderer.renderWelcome();
    }

    // In mirror mode, check if this session is live on any instance
    if (isMirrorMode) {
      // Check if this session is live on a different instance
      const otherInstance = liveInstances.find(i => i.sessionFile === sessionFile && i.port !== new URL(wsClient.url).port * 1);
      if (otherInstance) {
        // Reconnect to the other instance
        const protocol = document.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const newUrl = `${protocol}//${location.hostname}:${otherInstance.port}/ws`;
        console.log(`[App] Switching to instance on port ${otherInstance.port}`);
        wsClient.disconnect();
        wsClient.url = newUrl;
        wsClient.forceReconnect();
        mirrorActiveSessionFile = sessionFile;
        viewingActiveSession = true;
        updateMirrorInputState();
        return;
      }

      // Check if this is the active session on the current instance
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      updateMirrorInputState();

      if (viewingActiveSession) {
        // Re-request live state from the extension
        wsClient.send({ type: 'mirror_sync_request' });
      }
    } else {
      const res = await fetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        messageRenderer.renderError(`Failed to switch session: ${err.error}`);
      }
    }
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  bindingEpoch++; // fresh binding; drop anything in flight from before
  activeStreamEpoch = -1;
  isMirrorMode = true;

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  viewingActiveSession = true;
  updateMirrorInputState();
  updateMirrorLiveIndicator();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
    updateModelLabel();
    if (data.model.contextWindow) {
      contextWindowSize = data.model.contextWindow;
    }
  }

  // Update thinking level
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    updateThinkingBtn();
  }

  // Clear and render message history
  messageRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }

  updateCostDisplay();
  updateTokenUsage();
}

// Mark all live sessions in the sidebar with a green dot
function updateMirrorLiveIndicator() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current mirror session
  if (mirrorActiveSessionFile) liveFiles.add(mirrorActiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('mirror-live', liveFiles.has(el.dataset.filePath));
  });
}

// ═══════════════════════════════════════
// tau-web unified: headless binding + uplink routing + Live section
// ═══════════════════════════════════════
// Prompt routing order: live uplink first (the TUI owns the run), then the
// mirror-live session, then the headless backend, then legacy direct send.
function routeCommand(cmd) {
  if (uplinkActive) {
    wsClient.send({ type: 'uplink_command', command: cmd });
    return;
  }
  if (isMirrorMode && viewingActiveSession) {
    wsClient.send(cmd);
    return;
  }
  if (headlessSessionKey) {
    wsClient.send({ type: 'rpc_command', command: cmd });
    return;
  }
  wsClient.send(cmd);
}
function bindHeadless(cwd, sessionFile) {
  headlessSessionKey = null; // cleared until the ack re-arms it
  headlessBinding = (cwd || sessionFile) ? { cwd: cwd || null, sessionFile: sessionFile || null } : null;
  persistBinding();
  const payload = { type: 'start_session' };
  if (cwd) payload.cwd = cwd;
  if (sessionFile) payload.sessionFile = sessionFile;
  sendRpc(payload).then((data) => {
    if (data && !data.timeout) headlessSessionKey = data.sessionKey || 'bound';
  });
}
async function refreshUplinkList() {
  try {
    const data = await sendRpc({ type: 'uplink_list' });
    if (data && !data.timeout) renderLiveSection(data.instances || []);
  } catch {}
}
async function attachUplink(port, pid) {
  wsClient.send({ type: 'uplink_attach', port, pid });
}
function detachUplink() {
  if (!uplinkActive) return;
  wsClient.send({ type: 'uplink_detach' });
  uplinkActive = null;
  renderLiveSection(liveInstances);
}
function offerHeadlessContinue(detail) {
  // Uplink died (TUI exited?): offer to continue the same file headless.
  const el = document.createElement('div');
  el.className = 'system-message';
  el.innerHTML = `Live session ended. <button class="link-btn" id="headless-continue-btn">Continue headless</button>`;
  messagesContainer.appendChild(el);
  el.querySelector('#headless-continue-btn')?.addEventListener('click', () => {
    el.remove();
    bindHeadless(null, null);
    messageRenderer.renderSystemMessage('Continuing headless — prompts now run in a background backend.');
  });
  scrollToBottom();
}
function renderLiveSection(instances) {
  const host = document.getElementById('live-section');
  if (!host) return;
  const others = (instances || []).filter((i) => i.pid !== undefined);
  if (others.length === 0 && !uplinkActive) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }
  host.style.display = '';
  const rows = others.map((i) => {
    const attached = uplinkActive && uplinkActive.port === i.port;
    const label = i.sessionFile ? i.sessionFile.split('/').pop() : `:${i.port}`;
    return `<div class="live-row${attached ? ' attached' : ''}">
      <span class="live-dot"></span>
      <span class="live-label" title="${escapeHtml(i.sessionFile || '')}">${escapeHtml(label)}</span>
      <span class="live-port">:${i.port}</span>
      ${attached
        ? `<button class="live-btn" data-action="detach" data-port="${i.port}">Detach</button>`
        : `<button class="live-btn" data-action="attach" data-port="${i.port}" data-pid="${i.pid}">Attach</button>`}
    </div>`;
  }).join('');
  host.innerHTML = `<div class="live-header">LIVE</div>${rows}`;
  host.querySelectorAll('.live-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'attach') attachUplink(Number(btn.dataset.port), Number(btn.dataset.pid));
      else detachUplink();
    });
  });
}
// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch('/api/instances');
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      updateMirrorLiveIndicator();
      renderLiveSection(liveInstances);
    }
  } catch {}
}

// Poll every 5 seconds
setInterval(pollInstances, 5000);
pollInstances();

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  if (!isMirrorMode) return;

  const inputArea = document.querySelector('.input-area');
  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('mirror-readonly');
  } else {
    messageInput.disabled = true;
    messageInput.placeholder = 'Viewing historical session (read-only)';
    inputArea?.classList.add('mirror-readonly');
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries) {
  // Window the render: full history stays on disk, the DOM only holds the tail.
  const total = entries.length;
  const visible = total > VISIBLE_MESSAGE_WINDOW ? entries.slice(total - VISIBLE_MESSAGE_WINDOW) : entries;
  if (total > VISIBLE_MESSAGE_WINDOW) {
    messageRenderer.renderSystemMessage(`Showing last ${VISIBLE_MESSAGE_WINDOW} of ${total} entries — full history is on disk.`);
  }
  console.log(`[History] Rendering ${visible.length}/${total} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

  for (const entry of visible) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = (msg.content || []).filter((b) => b.type === 'text');
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === 'thinking');
      const toolCalls = (msg.content || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError
      );
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateCostDisplay();
  updateTokenUsage();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  const messagesEl = document.getElementById('messages');
  messagesEl.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle('hidden', !show);
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (contextSizeEl) {
      contextSizeEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k`;
      contextSizeEl.classList.add('visible');
    }
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    tokenUsageEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (contextSizeEl) contextSizeEl.classList.remove('visible');
  } else if (contextSizeEl) {
    contextSizeEl.classList.remove('visible');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to token usage in header
  tokenUsageEl.parentElement.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;

  if (isStreaming) {
    statusIndicator.classList.add('streaming');
    statusIndicator.classList.remove('connected');
    statusText.textContent = 'Working...';
  } else {
    statusIndicator.classList.remove('streaming');
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Connected';
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    flushQueue();
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const themeGrid = document.getElementById('theme-grid');


const toggleAutoCompact = document.getElementById('toggle-auto-compact');
const btnThinkingLevel = document.getElementById('btn-thinking-level');
const toggleShowThinking = document.getElementById('toggle-show-thinking');


function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state' }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      currentThinkingLevel = s.thinkingLevel || 'off';
      updateThinkingBtn();
      // Session name
      inputSessionName.value = s.sessionName || '';
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', !isOn);
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth');
const authSection = document.getElementById('settings-auth-section');

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz');
const contextBar = document.getElementById('context-bar');
const contextLegend = document.getElementById('context-legend');
const contextVizUsed = document.getElementById('context-viz-used');
const contextVizTotal = document.getElementById('context-viz-total');


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: 'Cached', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: 'Input', tokens: freshInput, color: 'messages' },
    { key: 'free', label: 'Available', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `${pct}% used`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// Voice Input
// ═══════════════════════════════════════

const micBtn = document.getElementById('mic-btn');
let recognition = null;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-AU';

  let finalTranscript = '';
  let interimTranscript = '';

  recognition.addEventListener('result', (e) => {
    interimTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }
    // Show live transcription in the input
    messageInput.value = finalTranscript + interimTranscript;
    messageInput.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  });

  recognition.addEventListener('error', (e) => {
    console.error('[Voice] Error:', e.error);
    stopRecording();
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    finalTranscript = messageInput.value; // Append to existing text
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = 'Stop recording';
    recognition.start();
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    try { recognition.stop(); } catch {}
    // Commit final transcript
    messageInput.value = finalTranscript;
    messageInput.dispatchEvent(new Event('input'));
    messageInput.focus();
  }
} else {
  // No speech recognition support — hide mic button
  micBtn.style.display = 'none';
}



// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, start with the sidebar hidden (header grid handles the rest)
if (isMobile()) {
  sidebarEl.classList.add('collapsed');
}

// Launcher
const launcherEl = document.getElementById('launcher');
const launcher = new Launcher(launcherEl, async (projectPath) => {
  try {
    const res = await fetch('/api/projects/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projectPath }),
    });
    const data = await res.json();
    if (data.ok) {
      // Refresh the launcher to show the new active instance
      setTimeout(() => launcher.load(), 2000);
    }
  } catch (e) {
    console.error('[Launcher] Failed to launch:', e);
  }
});

// Check if launcher should show (projects configured)
async function initLauncher() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (data.projects && data.projects.length > 0) {
      launcher.projects = data.projects;
      launcher.render();
      // Show launcher by default, add a nav link in the sidebar
      addLauncherNav();
    }
  } catch {}
}

function addLauncherNav() {
  const modeToggle = document.getElementById('mode-toggle');
  if (!modeToggle || modeToggle.querySelector('.mode-link-launcher')) return;

  const launcherLink = document.createElement('span');
  launcherLink.className = 'mode-link mode-link-launcher';
  launcherLink.title = 'Projects';
  launcherLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  launcherLink.addEventListener('click', () => {
    showLauncher();
  });
  modeToggle.appendChild(launcherLink);
}

function showLauncher() {
  launcherEl.classList.remove('hidden');
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.welcome')?.remove();

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link-launcher')?.classList.add('active');

  launcher.load();
}

function hideLauncher() {
  launcherEl.classList.add('hidden');
  messagesContainer.style.display = '';
  document.querySelector('.input-area').style.display = '';

  // Update nav state
  document.querySelectorAll('.mode-link').forEach(l => l.classList.remove('active'));
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

// Make the tau icon in sidebar switch back to chat
document.querySelector('.mode-link:first-child')?.addEventListener('click', () => {
  hideLauncher();
});

wsClient.connect();
messageRenderer.renderWelcome();
sidebar.loadSessions().then(() => {
  if (isMirrorMode) updateMirrorLiveIndicator();
});
initLauncher();

// Service workers and HTTP Basic Auth don't mix: an installed worker can
// serve the cached app shell without hitting the network, so the browser
// never sees the 401 + WWW-Authenticate challenge that triggers its native
// login dialog — APIs just fail. When auth is on, remove any stuck worker
// and stay unregistered so logins prompt natively again.
async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const health = await tauRawFetch('/api/health').then((r) => r.json()).catch(() => null);
    if (health?.authEnabled) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      return;
    }
  } catch {}
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
initServiceWorker();

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
