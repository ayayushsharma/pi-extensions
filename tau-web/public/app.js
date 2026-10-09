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

// ─── Inline login (replaces the native browser login prompt) ───
// The server mints an HttpOnly cookie session via POST /api/login, which the
// browser then sends on fetches AND the WS handshake (which can't carry
// custom headers). On any API 401 we show the overlay instead of reloading.
// Creds live in memory + sessionStorage (per-tab; a fresh tab re-prompts).
let tauBasicCreds = null;
try { tauBasicCreds = sessionStorage.getItem('tau-basic') || null; } catch {}
function tauSetCreds(basic) {
  tauBasicCreds = basic;
  try {
    if (basic) sessionStorage.setItem('tau-basic', basic);
    else sessionStorage.removeItem('tau-basic');
  } catch {}
}
let tauLoginVisible = false;
function tauShowLogin(hint) {
  const overlay = document.getElementById('login-overlay');
  if (!overlay || tauLoginVisible) return;
  tauLoginVisible = true;
  if (hint) {
    const sub = document.getElementById('login-sub');
    if (sub) sub.textContent = hint;
  }
  overlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('login-user')?.focus(), 50);
}
function tauHideLogin() {
  tauLoginVisible = false;
  document.getElementById('login-overlay')?.classList.add('hidden');
  document.getElementById('login-error')?.classList.add('hidden');
}
async function tauRefreshAfterLogin() {
  tauHideLogin();
  wsClient.forceReconnect();
  try { await sidebar.loadSessions(); } catch {}
  try { updateMirrorLiveIndicator(); } catch {}
  try { await refreshUplinkList(); } catch {}
  fetchSlashCommands();
}
function tauNeedsLogin(res, url) {
  const u = typeof url === 'string' ? url : url?.url || '';
  if (res?.status === 401 && u.includes('/api/')) {
    tauSetCreds(null);
    tauShowLogin();
    return true;
  }
  return false;
}
const tauRawFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
  opts = opts || {};
  // Attach in-memory Basic creds so the login POST itself authenticates
  // without ever invoking the browser's native prompt.
  if (tauBasicCreds && typeof url === 'string' && url.includes('/api/')) {
    opts.headers = { ...(opts.headers || {}), Authorization: `Basic ${tauBasicCreds}` };
  }
  return tauRawFetch(url, opts).then((res) => {
    // The login/logout endpoints manage their own 401s — never loop on them.
    if (typeof url === 'string' && (url.endsWith('/api/login') || url.endsWith('/api/logout'))) return res;
    tauNeedsLogin(res, url);
    return res;
  });
};


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
// Shared sticky-scroll courtesy: tool cards defer to the message renderer.
toolCardRenderer.shouldStick = () => !messageRenderer.userIsReading();
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
// tau-web: per-message usage reports make the context pill strobe during tool
// loops. Peak holds the high-water mark within a run; compaction/session
// switch resets it. lastTokenRenderKey skips no-op DOM writes.
let contextPeakTokens = 0;
let lastTokenRenderKey = '';
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
// tau-web preview-then-attach: attaching is two-phase. Picking Attach loads the
// session history read-only with a confirm banner; only "Attach & Drive" wires
// the uplink. uplinkLastDetached powers the "Attach again" affordance.
let uplinkPreview = null; // { port, pid, sessionFile, returnTo } while previewing
let uplinkLastDetached = null; // { port, pid, sessionFile } after a detach
let uplinkAttachPending = false;
let uplinkAttachError = null; // string while an attach attempt failed
let uplinkTargetSessionFile = null; // session file of the current/last attach target
let serverOwnSessionFile = null; // the web server's own session (non-uplink mirror syncs)
// Effective context usage from the rendered snapshot (pi's own numbers, incl.
// any ctx-limit cap). While set, the static model registry must not overwrite
// the context window in the header.
let uplinkContextUsage = null;
// True while the browser view is bound to a live TUI (attached, previewing, or
// frozen after detach). The web server's own pi state must not overwrite the
// model/thinking/cost/context of the session the user is actually viewing.
function uplinkOwnsView() {
  return !!(uplinkActive || uplinkPreview || uplinkLastDetached);
}
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
  // A reconnect wipes the streaming class; re-apply if a run is in flight.
  if (state.isStreaming) { lastUiStreaming = null; updateUI(); }
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
  if (pend) { pendingRpc.delete(id); try { pend.resolve(response || {}); } catch {} }
  if (response?.command === 'start_session' && response?.success) {
    headlessSessionKey = response?.data?.sessionKey || 'bound';
  } else if (response?.command === 'uplink_list' && response?.success) {
    renderLiveSection(response?.data?.instances || []);
  }
});
wsClient.addEventListener('uplinkAttached', (e) => {
  uplinkActive = { port: e.detail.port, pid: e.detail.pid };
  uplinkPreview = null;
  uplinkLastDetached = null;
  uplinkAttachPending = false;
  uplinkAttachError = null;
  viewingActiveSession = true; // the uplinked TUI's session is now the live view
  updateMirrorInputState();
  renderSessionBanner();
  syncUplinkControls();
  messageRenderer.renderSystemMessage(`Attached to live session on :${e.detail.port} — prompts now drive the TUI.`);
});
wsClient.addEventListener('uplinkDetached', () => {
  const prev = uplinkActive;
  uplinkActive = null;
  uplinkPreview = null;
  uplinkAttachPending = false;
  if (prev) uplinkLastDetached = { port: prev.port, pid: prev.pid, sessionFile: uplinkTargetSessionFile };
  viewingActiveSession = false; // frozen view: routing stays on the bound backend
  if (serverOwnSessionFile) mirrorActiveSessionFile = serverOwnSessionFile;
  updateMirrorInputState();
  renderSessionBanner();
  syncUplinkControls();
});
wsClient.addEventListener('uplinkDead', (e) => {
  const was = uplinkActive;
  uplinkActive = null;
  uplinkAttachPending = false;
  uplinkAttachError = `Live uplink to :${e.detail.port} dropped — the TUI may have exited.`;
  if (was) uplinkLastDetached = { port: was.port, pid: was.pid, sessionFile: uplinkTargetSessionFile };
  viewingActiveSession = false;
  if (serverOwnSessionFile) mirrorActiveSessionFile = serverOwnSessionFile;
  renderSessionBanner();
  syncUplinkControls();
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
  const msg = e.detail?.message || 'Unknown server error';
  // While previewing/driving, attach failures belong in the banner, not only
  // buried in the transcript.
  if (uplinkAttachPending || uplinkPreview) {
    uplinkAttachPending = false;
    uplinkAttachError = msg;
    renderSessionBanner();
  }
  messageRenderer.renderError(msg);
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail, false);
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
    case 'mirror_sync':
      // Uplinked TUI state (attach flow): the live view replaces the preview.
      if (event.uplink) handleMirrorSync(event, true);
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
  // Reset token tracking — next message will update with the compacted size
  lastInputTokens = 0;
  resetContextPeak();
  updateTokenUsage();
  hideCompactButton();
}

// Anti-flicker: backends may emit agent_end/agent_start around every assistant
// message inside one run (tool loops). Clearing the streaming chrome on each
// boundary strobes the status pill, typing bubble and abort/send buttons.
// So agent_end arms a short settle timer; an intervening agent_start cancels
// it and the UI never visibly drops. Session switches cancel it too.
let streamSettleTimer = null;
let lastUiStreaming = null;
function cancelStreamSettle() {
  if (streamSettleTimer) { clearTimeout(streamSettleTimer); streamSettleTimer = null; }
}
function handleAgentStart() {
  activeStreamEpoch = bindingEpoch;
  cancelStreamSettle();
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentEnd() {
  cancelStreamFlush();
  currentStreamingElement = null;
  currentStreamingText = '';
  // Hold the streaming chrome briefly to bridge message-boundary gaps.
  cancelStreamSettle();
  streamSettleTimer = setTimeout(() => {
    streamSettleTimer = null;
    state.setStreaming(false);
    showTypingIndicator(false);
    updateUI();
  }, 1200);

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

  // Coalesce DOM writes to one per frame (scheduleStreamFlush): thinking/text
  // deltas arrive dozens per second, and rewriting the whole accumulated string
  // plus scrolling per delta saturates the main thread on phones — which starves
  // compositor animations and makes pulsing indicators look like they flicker.
  if (assistantMessageEvent.type === 'thinking_delta') {
    currentStreamingThinking += assistantMessageEvent.delta;
    scheduleStreamFlush();
  } else if (assistantMessageEvent.type === 'text_delta') {
    currentStreamingText += assistantMessageEvent.delta;
    scheduleStreamFlush();
  }
}

let streamFlushRaf = null;
function flushStreamingDom() {
  if (!currentStreamingElement) return;
  if (currentStreamingThinking) {
    messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
  }
  if (currentStreamingText) {
    messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
  }
}
function scheduleStreamFlush() {
  if (streamFlushRaf) return;
  streamFlushRaf = requestAnimationFrame(() => {
    streamFlushRaf = null;
    flushStreamingDom();
  });
}
function cancelStreamFlush() {
  if (streamFlushRaf) { cancelAnimationFrame(streamFlushRaf); streamFlushRaf = null; }
}

function handleMessageEnd(message) {
  if (activeStreamEpoch !== -1 && activeStreamEpoch !== bindingEpoch) { cancelStreamFlush(); currentStreamingElement = null; return; }
  if (currentStreamingElement) {
    // Flush any pending frame first: finalize's no-payload fallback reads the
    // streamed text node, so the last delta must already be in the DOM.
    flushStreamingDom();
    cancelStreamFlush();
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking + the final message so finalize renders the real block
    // order (thinking-only messages used to duplicate thinking into the body).
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking, message);
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
    const inputH = `${inputArea.offsetHeight}px`;
    const headerH = headerEl ? `${headerEl.offsetHeight}px` : null;
    // Anti-flicker: ResizeObserver can fire during streaming (cost pill, token
    // %, compact button change the header contents). Rewriting the custom
    // properties invalidates styles for the banner (margin-top) and .messages
    // padding even when the value is unchanged, repainting the pulsing dot.
    if (
      document.documentElement.style.getPropertyValue('--input-height') === inputH &&
      (!headerEl || document.documentElement.style.getPropertyValue('--header-height') === headerH)
    ) {
      return;
    }
    const wasNearBottom =
      messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 150;
    document.documentElement.style.setProperty('--input-height', inputH);
    if (headerEl) {
      document.documentElement.style.setProperty('--header-height', headerH);
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
    // Control commands must follow the bound backend: attached live TUI first,
    // then a bound headless session, then the web server's own pi process.
    // Server-level settings (auth toggle) belong to the web server process,
    // not to the attached session's backend.
    const serverLevel = cmd && (cmd.type === 'get_auth' || cmd.type === 'set_auth');
    let data;
    if (serverLevel) {
      const resp = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      data = await resp.json();
    } else if (uplinkActive) {
      data = await sendRpc({ type: 'uplink_command', command: cmd });
    } else if (isMirrorMode && viewingActiveSession) {
      // The web server's own session lives in the same pi process as /api/rpc.
      const resp = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      data = await resp.json();
    } else if (headlessSessionKey) {
      data = await sendRpc({ type: 'rpc_command', command: cmd });
    } else {
      const resp = await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      data = await resp.json();
    }
    if (data?.timeout) {
      statusText.textContent = 'Timed out';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
      return { success: false, error: 'timeout' };
    }
    if (data?.success) {
      statusText.textContent = 'Done';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
    } else {
      statusText.textContent = data?.error || 'Failed';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    }
    return data;
  } catch (e) {
    statusText.textContent = 'Error';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    return { success: false, error: String(e) };
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
// pi's canonical thinking levels. Older tau builds cycle a 5-level subset
// (off..high), which would skip xhigh/max on an attached session — so cycle
// the full list here and send the explicit level instead.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function nextThinkingLevel(current) {
  const i = THINKING_LEVELS.indexOf(current);
  return THINKING_LEVELS[(i + 1) % THINKING_LEVELS.length];
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
    // The server's own state is authoritative only when no live-TUI view owns
    // the screen — otherwise the uplink snapshot / session entries supply the
    // model, thinking level, cost and context for the session being viewed.
    if (stateData.success && stateData.data?.model && !uplinkOwnsView()) {
      currentModelId = stateData.data.model.id || '';
      updateModelLabel();
    }
    if (currentModelId && !uplinkContextUsage) {
      const model = availableModels.find(m => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel && !uplinkOwnsView()) {
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
  // Preview is read-only: the uplink isn't wired yet, so a model switch here
  // would hit the wrong backend. Attach & Drive first.
  if (uplinkPreview) {
    statusText.textContent = 'Attach & Drive to change the model';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 2500);
    return;
  }
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
        const resp = await rpcCommand({ type: 'set_model', provider: m.provider, modelId: m.id }, `Switching to ${display}...`);
        if (resp && resp.success === false) return; // keep the previous label on failure
        currentModelId = resp?.data?.id || m.id;
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
  if (uplinkPreview) {
    statusText.textContent = 'Attach & Drive to change thinking level';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 2500);
    return;
  }
  const next = nextThinkingLevel(currentThinkingLevel);
  const data = await rpcCommand({ type: 'set_thinking_level', level: next }, `Thinking: ${next}...`);
  if (data?.success === false) return; // keep the previous level on failure
  currentThinkingLevel = next;
  updateThinkingBtn();
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

  // Ctrl/⌘+K — command palette from anywhere (Esc closes, as usual)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (commandPalette.classList.contains('hidden')) openCommandPalette();
    else closeCommandPalette();
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
  resetTokenTracking();
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
    updateMirrorLiveIndicator();
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
  resetTokenTracking();
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
  // Navigating away from a detached live session clears its frozen banner.
  if (uplinkLastDetached && !uplinkActive && !uplinkPreview && uplinkLastDetached.sessionFile !== session.filePath) {
    uplinkLastDetached = null;
    uplinkAttachError = null;
    renderSessionBanner();
  }
  resetTokenTracking();
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile, session = null, project = null, opts = {}) {
  try {
    // New binding epoch — in-flight stream events from the old session are dropped.
    bindingEpoch++;
    cancelStreamSettle();
    state.setStreaming(false);
    showTypingIndicator(false);
    updateUI();
    activeStreamEpoch = -1;
    // Clear any streaming state from previous session to prevent bleed
    cancelStreamFlush();
    currentStreamingElement = null;
    currentStreamingThinking = '';
    currentStreamingText = '';
    
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();
    // Fresh accounting per session: preview/cancel paths bypass the explicit
    // resets in handleSessionSelect, and the peak must not bleed across views.
    resetTokenTracking();
    uplinkContextUsage = null;

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
          // even when no live TUI owns the session. Previews stay read-only
          // and don't move the headless backend.
          if (!opts.preview) bindHeadless(project?.path || null, file);
        } catch (e) {
          console.error('[App] History fetch error:', e);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      messageRenderer.renderWelcome();
    }

    // In mirror mode, check if this is the active session on the current
    // instance. tau-web never re-points the browser WS at another instance
    // (legacy tau did) — driving another TUI goes through the uplink proxy so
    // the unified envelope + auth stay intact.
    if (isMirrorMode) {
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      if (uplinkPreview) viewingActiveSession = false; // preview is read-only
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
  updateMirrorInputState();
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data, fromUplink = false) {
  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries', fromUplink ? '(uplink)' : '');
  // While previewing/driving/frozen on a live session, snapshots about the web
  // server's OWN session must not clobber the view the user is looking at.
  if (!fromUplink && uplinkOwnsView() && data.sessionFile !== uplinkTargetSessionFile) {
    isMirrorMode = true;
    serverOwnSessionFile = data.sessionFile || serverOwnSessionFile;
    return;
  }
  bindingEpoch++; // fresh binding; drop anything in flight from before
  cancelStreamSettle();
  state.setStreaming(false);
  showTypingIndicator(false);
  updateUI();
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
  resetTokenTracking();

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }

  // Authoritative context usage for the attached session (pi's own estimate),
  // overrides the last assistant message's token count from the entries.
  uplinkContextUsage = data.contextUsage || null;
  if (data.contextUsage && typeof data.contextUsage === 'object') {
    if (data.contextUsage.contextWindow) contextWindowSize = data.contextUsage.contextWindow;
    if (Number.isFinite(data.contextUsage.tokens)) lastInputTokens = data.contextUsage.tokens;
  }

  updateCostDisplay();
  updateTokenUsage();
}

// Session file -> display name, joined from the sidebar's session list.
function liveSessionName(file) {
  if (!file) return '';
  try {
    for (const p of sidebar.projects || []) {
      for (const s of p.sessions || []) {
        if (s.filePath === file) return s.name || s.firstMessage || '';
      }
    }
    // Fallback: match on the file tail (relative vs absolute path forms).
    const tail = file.split('/').pop();
    for (const p of sidebar.projects || []) {
      for (const s of p.sessions || []) {
        if ((s.filePath || '').split('/').pop() === tail) return s.name || s.firstMessage || '';
      }
    }
  } catch {}
  return '';
}
function liveInstanceLabel(i) {
  // Prefer the session name; fall back to project dir, then the file tail.
  return liveSessionName(i.sessionFile)
    || (i.cwd ? i.cwd.split('/').filter(Boolean).pop() : '')
    || (i.sessionFile ? i.sessionFile.split('/').pop() : `:${i.port}`);
}
function liveByFileMap() {
  const m = new Map();
  for (const i of liveInstances) {
    if (i.sessionFile && !i.local && !m.has(i.sessionFile)) m.set(i.sessionFile, i);
  }
  return m;
}
// Mark all live sessions in the sidebar with a green dot + inline Attach.
// Clicking an item still only views history; Attach is what drives the TUI.
function updateMirrorLiveIndicator() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  // Also include the current mirror session
  if (mirrorActiveSessionFile) liveFiles.add(mirrorActiveSessionFile);
  const byFile = liveByFileMap();

  document.querySelectorAll('.session-item').forEach(el => {
    const f = el.dataset.filePath;
    el.classList.toggle('mirror-live', liveFiles.has(f));
    const inst = f && byFile.get(f);
    let btn = el.querySelector(':scope > .session-title-row > .live-attach-btn');
    if (inst && !inst.local) {
      // Shared state: same port = same backend, whichever section attached.
      const attached = !!(uplinkActive && uplinkActive.port === inst.port);
      const previewing = !!(uplinkPreview && uplinkPreview.port === inst.port);
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'live-attach-btn';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const port = Number(e.currentTarget.dataset.port);
          const pid = Number(e.currentTarget.dataset.pid);
          // Dispatch on current state so one listener serves all actions.
          if (uplinkActive && uplinkActive.port === port) detachUplink();
          else if (uplinkPreview && uplinkPreview.port === port) cancelPreview();
          else previewAttach(port, pid, e.currentTarget.dataset.file || null, e.currentTarget.dataset.started || null);
        });
        const row = el.querySelector('.session-title-row');
        if (row) row.appendChild(btn);
      }
      btn.dataset.port = String(inst.port);
      btn.dataset.pid = String(inst.pid);
      btn.dataset.file = inst.sessionFile || '';
      btn.dataset.started = inst.startedAt || '';
      const label = attached ? 'Detach' : previewing ? 'Cancel' : 'Attach';
      if (btn.textContent !== label) btn.textContent = label;
      btn.classList.toggle('attached', attached);
      btn.title = attached
        ? `Stop driving the live session on :${inst.port}`
        : previewing
          ? 'Cancel the preview'
          : `Preview and drive the live session on :${inst.port}`;
    } else if (btn) {
      btn.remove();
    }
  });
}

// One place to refresh every attach-state affordance (Live section + sidebar).
function syncUplinkControls() {
  renderLiveSection(liveInstances);
  updateMirrorLiveIndicator();
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
    if (data && !data.timeout) headlessSessionKey = data?.data?.sessionKey || 'bound';
  });
}
async function refreshUplinkList() {
  try {
    const data = await sendRpc({ type: 'uplink_list' });
    if (data && !data.timeout) renderLiveSection(data?.data?.instances || []);
  } catch {}
}
// ─── Preview-then-attach (tau-web) ───
// Attaching is two-phase: picking a live session loads its history read-only
// with a confirm banner; only "Attach & Drive" wires the uplink.

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function toMs(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

function findSidebarSession(filePath) {
  if (!filePath) return null;
  const tail = filePath.split('/').pop();
  for (const p of sidebar.projects || []) {
    for (const s of p.sessions || []) {
      if (s.filePath === filePath || (s.filePath || '').split('/').pop() === tail) return { session: s, project: p };
    }
  }
  return null;
}

// One banner, five states: error / driving / pending / preview / detached.
function renderSessionBanner() {
  const el = document.getElementById('session-banner');
  if (!el) return;
  const mainEl = document.querySelector('.main');
  const esc = (s) => escapeHtml(String(s ?? ''));
  let cls = '';
  let html = '';
  if (uplinkAttachError) {
    const target = uplinkPreview || uplinkLastDetached;
    cls = 'error';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Attach failed</strong><span class="sb-hint">${esc(uplinkAttachError)}</span></span>
      ${target ? `<button class="sb-btn" data-action="retry" data-port="${target.port}" data-pid="${target.pid}">Retry</button>` : ''}
      ${(target?.sessionFile || uplinkTargetSessionFile) ? `<button class="sb-btn" data-action="headless">Continue headless</button>` : ''}
      <button class="sb-btn" data-action="dismiss">×</button>`;
  } else if (uplinkActive) {
    cls = 'driving';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Live · driving :${uplinkActive.port}</strong><span class="sb-hint">TUI is also attached — typing in both places may race</span></span>
      <button class="sb-btn" data-action="detach">Detach</button>`;
  } else if (uplinkAttachPending) {
    const target = uplinkPreview || uplinkLastDetached;
    cls = 'preview';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Attaching to :${target?.port ?? '…'}…</strong></span>`;
  } else if (uplinkPreview) {
    const last = uplinkPreview.lastActive ? ` · last active ${timeAgo(uplinkPreview.lastActive)}` : '';
    cls = 'preview';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Previewing live session on :${uplinkPreview.port}</strong><span class="sb-hint">Read-only until you attach${esc(last)}</span></span>
      <button class="sb-btn primary" data-action="attach">Attach &amp; Drive</button>
      <button class="sb-btn" data-action="cancel">Cancel</button>`;
  } else if (uplinkLastDetached) {
    cls = 'detached';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Detached from :${uplinkLastDetached.port}</strong><span class="sb-hint">View is frozen; the TUI keeps running</span></span>
      <button class="sb-btn primary" data-action="retry" data-port="${uplinkLastDetached.port}" data-pid="${uplinkLastDetached.pid}">Attach again</button>
      <button class="sb-btn" data-action="dismiss">×</button>`;
  }
  // Anti-flicker: only touch the DOM when the rendered banner actually
  // changes. Re-writing innerHTML recreates .sb-dot and restarts its pulse
  // animation (the same reason renderLiveSection is signature-guarded).
  const sig = `${cls}|${html}`;
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.className = `session-banner${cls ? ` ${cls}` : ''}${html ? '' : ' hidden'}`;
  el.innerHTML = html;
  mainEl?.classList.toggle('has-banner', !!html);
}

async function previewAttach(port, pid, sessionFile, lastActive) {
  if (uplinkActive && uplinkActive.port === port) return; // already driving it
  if (uplinkAttachPending) return;
  // Switching targets: drop local "driving" state; the server detaches the old
  // uplink when the new attach arrives.
  if (uplinkActive && uplinkActive.port !== port) {
    wsClient.send({ type: 'uplink_detach' });
    uplinkActive = null;
    uplinkLastDetached = null;
    syncUplinkControls();
  }
  uplinkAttachError = null;
  uplinkLastDetached = null; // a new preview supersedes any frozen-detached view
  uplinkTargetSessionFile = sessionFile || null;
  const found = findSidebarSession(sessionFile);
  uplinkPreview = {
    port,
    pid,
    sessionFile: sessionFile || null,
    lastActive: toMs(lastActive) || toMs(found?.session?.timestamp),
    returnTo: uplinkPreview?.returnTo || { filePath: sidebar.activeSessionFile || null },
  };
  renderSessionBanner();
  updateMirrorInputState();

  // Phase 1: history read-only. Prefer the sidebar's session object (it has
  // dirName/file); otherwise derive both from the absolute path.
  let session = found?.session || null;
  let project = found?.project || null;
  if (!session && sessionFile) {
    const parts = sessionFile.split('/');
    const file = parts.pop();
    const dirName = parts.pop();
    if (file && dirName) { session = { file, filePath: sessionFile }; project = { dirName }; }
  }
  if (session && project && sidebar.activeSessionFile !== sessionFile) {
    sidebar.setActive(sessionFile);
    await switchSession(sessionFile, session, project, { preview: true });
  } else if (!session || !project) {
    messageRenderer.renderSystemMessage('History unavailable for this session — you can still attach.');
  }
  renderSessionBanner();
}

function cancelPreview() {
  const returnTo = uplinkPreview?.returnTo;
  uplinkPreview = null;
  uplinkAttachError = null;
  // Returning to the previous view also ends any frozen-detached state, so the
  // server's own snapshot may own the header again (model/thinking/context).
  uplinkLastDetached = null;
  renderSessionBanner();
  // Return to whatever was open before the preview.
  const found = returnTo?.filePath ? findSidebarSession(returnTo.filePath) : null;
  if (found) {
    sidebar.setActive(returnTo.filePath);
    switchSession(returnTo.filePath, found.session, found.project);
  } else if (isMirrorMode && mirrorActiveSessionFile) {
    const mf = findSidebarSession(mirrorActiveSessionFile);
    if (mf) { sidebar.setActive(mirrorActiveSessionFile); switchSession(mirrorActiveSessionFile, mf.session, mf.project); }
    else messageRenderer.renderWelcome();
  } else {
    messageRenderer.renderWelcome();
  }
  updateMirrorInputState();
}

async function attachUplink(port, pid, sessionFile) {
  if (!Number.isInteger(port) || !Number.isInteger(pid)) return;
  uplinkTargetSessionFile = sessionFile || uplinkPreview?.sessionFile || uplinkLastDetached?.sessionFile || uplinkTargetSessionFile;
  uplinkAttachPending = true;
  uplinkAttachError = null;
  renderSessionBanner();
  wsClient.send({ type: 'uplink_attach', port, pid });
}

function detachUplink() {
  if (!uplinkActive) return;
  const prev = uplinkActive;
  wsClient.send({ type: 'uplink_detach' });
  uplinkActive = null;
  uplinkPreview = null;
  uplinkAttachPending = false;
  uplinkLastDetached = { port: prev.port, pid: prev.pid, sessionFile: uplinkTargetSessionFile };
  viewingActiveSession = false;
  if (serverOwnSessionFile) mirrorActiveSessionFile = serverOwnSessionFile;
  renderSessionBanner();
  updateMirrorInputState();
  syncUplinkControls();
}

document.getElementById('session-banner')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.sb-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'attach') attachUplink(uplinkPreview?.port, uplinkPreview?.pid);
  else if (action === 'retry') attachUplink(Number(btn.dataset.port), Number(btn.dataset.pid));
  else if (action === 'detach') detachUplink();
  else if (action === 'cancel') cancelPreview();
  else if (action === 'dismiss') { uplinkAttachError = null; uplinkLastDetached = null; renderSessionBanner(); updateMirrorInputState(); }
  else if (action === 'headless') {
    uplinkAttachError = null;
    uplinkPreview = null;
    renderSessionBanner();
    bindHeadless(null, uplinkTargetSessionFile);
    messageRenderer.renderSystemMessage('Continuing headless — prompts now run in a background backend.');
  }
});
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
    // Signature-guarded clear: rebuilding innerHTML restarts dot pulses.
    if (host.dataset.sig !== 'empty') {
      host.innerHTML = '';
      host.style.display = 'none';
      host.dataset.sig = 'empty';
    }
    return;
  }
  // Skip rebuilds when nothing changed — the 5s poll must not restart
  // the green-dot pulse animations (perceived as flicker).
  const sig = others.map((i) => `${i.port}:${i.pid}:${(uplinkActive && uplinkActive.port === i.port) ? 1 : 0}:${(uplinkPreview && uplinkPreview.port === i.port) ? 1 : 0}:${i.sessionFile || ''}:${liveInstanceLabel(i)}`).join('|');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.style.display = '';
  const rows = others.map((i) => {
    const attached = uplinkActive && uplinkActive.port === i.port;
    const previewing = uplinkPreview && uplinkPreview.port === i.port;
    const label = liveInstanceLabel(i);
    const sub = i.cwd ? `${escapeHtml(i.cwd.split('/').filter(Boolean).pop() || '')} · :${i.port}` : `:${i.port}`;
    const action = i.local
      ? `<span class="live-tag" title="Runs inside this web server's own process — nothing to attach to">this server</span>`
      : attached
        ? `<button class="live-btn" data-action="detach" data-port="${i.port}">Detach</button>`
        : previewing
          ? `<button class="live-btn" data-action="cancelpreview">Cancel</button>`
          : `<button class="live-btn" data-action="attach" data-port="${i.port}" data-pid="${i.pid}" data-file="${escapeHtml(i.sessionFile || '')}" data-started="${escapeHtml(i.startedAt || '')}">Attach</button>`;
    return `<div class="live-row${attached ? ' attached' : ''}">
      <span class="live-dot"></span>
      <span class="live-text">
        <span class="live-label" title="${escapeHtml(i.sessionFile || '')}">${escapeHtml(label)}</span>
        <span class="live-sub">${sub}</span>
      </span>
      ${action}
    </div>`;
  }).join('');
  host.innerHTML = `<div class="live-header">LIVE</div>${rows}`;
  host.querySelectorAll('.live-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'attach') {
        // Two-phase: preview the session first, confirm to drive.
        previewAttach(Number(btn.dataset.port), Number(btn.dataset.pid), btn.dataset.file || null, btn.dataset.started || null);
      } else if (btn.dataset.action === 'cancelpreview') {
        cancelPreview();
      } else {
        detachUplink();
      }
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
  const inputArea = document.querySelector('.input-area');
  // Preview: read-only until the user confirms the attach. Detached: the frozen
  // view of a live session is read-only too (the TUI keeps running without us).
  const frozenDetached = uplinkLastDetached && !uplinkActive
    && sidebar.activeSessionFile === uplinkLastDetached.sessionFile;
  if (uplinkPreview) {
    messageInput.disabled = true;
    messageInput.placeholder = 'Previewing live session — attach to drive';
    inputArea?.classList.add('mirror-readonly');
    return;
  }
  if (frozenDetached) {
    messageInput.disabled = true;
    messageInput.placeholder = 'Detached — view is frozen';
    inputArea?.classList.add('mirror-readonly');
    return;
  }
  if (!isMirrorMode) return;

  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('mirror-readonly');
    return;
  }
  // A history session is read-only only while a live TUI owns it — attaching
  // (or detaching) drives that session. Anything else can be continued headless.
  const activeFile = sidebar.activeSessionFile;
  const ownedByTui = activeFile && liveInstances.some((i) => !i.local && i.sessionFile === activeFile);
  if (ownedByTui) {
    messageInput.disabled = true;
    messageInput.placeholder = 'Owned by a live TUI — attach to drive';
    inputArea?.classList.add('mirror-readonly');
  } else {
    messageInput.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('mirror-readonly');
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries) {
  // Full-session accounting + last known model/thinking, independent of the
  // rendered window: an attached/history session must show its own model,
  // thinking level, cost and context — not the web server's own state.
  let histCost = 0;
  let histTokens = 0;
  let histUsage = null;
  let histModel = null;
  let histThinking = null;
  for (const entry of entries) {
    if (entry.type === 'model_change') {
      if (entry.modelId) histModel = entry.modelId;
    } else if (entry.type === 'thinking_level_change') {
      if (entry.thinkingLevel) histThinking = entry.thinkingLevel;
    } else if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const usage = entry.message.usage;
      if (usage?.cost?.total) histCost += usage.cost.total;
      if (Number.isFinite(usage?.input)) { histTokens = usage.input + (usage.cacheRead || 0); histUsage = usage; }
    }
  }
  if (histModel && histModel !== currentModelId) { currentModelId = histModel; updateModelLabel(); }
  if (histThinking && histThinking !== currentThinkingLevel) { currentThinkingLevel = histThinking; updateThinkingBtn(); }
  sessionTotalCost = histCost;
  if (histTokens) { lastInputTokens = histTokens; lastUsage = histUsage; }

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

// Reset the context-% high-water mark (compaction, session switch, reload).
function resetContextPeak() {
  contextPeakTokens = 0;
  lastTokenRenderKey = '';
}

// Full per-session reset: cost + token tracking + peak.
function resetTokenTracking() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  resetContextPeak();
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
    // Monotonic within a run: the displayed value only ever ticks up between
    // real compactions. Per-message usage in tool loops would otherwise make
    // the pill strobe between per-message values.
    const effective = Math.max(lastInputTokens, contextPeakTokens);
    contextPeakTokens = effective;
    const pct = Math.round((effective / contextWindowSize) * 100);
    const key = `pct:${pct}:${Math.round(effective / 100)}`;
    if (key === lastTokenRenderKey) return;
    lastTokenRenderKey = key;
    tokenUsageEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (contextSizeEl) {
      contextSizeEl.textContent = `${(effective / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k`;
      contextSizeEl.classList.add('visible');
    }
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
    }
    tokenUsageEl.title = `Context: ${(effective / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    const key = `raw:${Math.round(lastInputTokens / 100)}`;
    if (key === lastTokenRenderKey) return;
    lastTokenRenderKey = key;
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
  // No-op when nothing changed: rewriting classes/text restarts CSS pulses.
  if (isStreaming === lastUiStreaming) return;
  lastUiStreaming = isStreaming;

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
  // Server section: version + uptime from /api/health (auth-exempt).
  try {
    const h = await tauRawFetch('/api/health').then((r) => r.json()).catch(() => null);
    const sec = document.getElementById('settings-server-section');
    if (h && sec) {
      sec.style.display = '';
      document.getElementById('server-version').textContent = h.version || '—';
      document.getElementById('server-uptime').textContent = h.startedAt ? formatUptime(Date.now() - new Date(h.startedAt).getTime()) : '—';
    }
  } catch {}
function formatUptime(ms) {
  if (ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

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
      // Thinking level — only when no live-TUI view owns the header state.
      if (!uplinkOwnsView()) {
        btnThinkingLevel.textContent = s.thinkingLevel || 'off';
        currentThinkingLevel = s.thinkingLevel || 'off';
        updateThinkingBtn();
      }
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
  if (uplinkPreview) {
    statusText.textContent = 'Attach & Drive to change thinking level';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 2500);
    return;
  }
  const next = nextThinkingLevel(currentThinkingLevel);
  const data = await rpcCommand({ type: 'set_thinking_level', level: next });
  if (data?.success === false) return;
  currentThinkingLevel = next;
  btnThinkingLevel.textContent = next;
  updateThinkingBtn();
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
// Log out this browser: clear the cookie session + cached creds, then prompt.
document.getElementById('btn-logout')?.addEventListener('click', async () => {
  try { await tauRawFetch('/api/logout', { method: 'POST' }); } catch {}
  tauSetCreds(null);
  try { wsClient.disconnect(); } catch {}
  closeSettings();
  tauShowLogin('You have been logged out.');
});
// Login form: verify via /api/login (cookie session), never the native prompt.
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = document.getElementById('login-user').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-submit');
  const card = document.querySelector('.login-card');
  if (!user || !pass) return;
  btn.disabled = true;
  try {
    const basic = btoa(`${user}:${pass}`);
    const res = await tauRawFetch('/api/login', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}` },
    });
    if (res.ok) {
      tauSetCreds(basic);
      document.getElementById('login-pass').value = '';
      await tauRefreshAfterLogin();
    } else {
      errEl?.classList.remove('hidden');
      card?.classList.remove('shake');
      void card?.offsetWidth;
      card?.classList.add('shake');
    }
  } catch {
    errEl?.classList.remove('hidden');
  } finally {
    btn.disabled = false;
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
  updateMirrorLiveIndicator();
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
