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
import { openFileViewer } from './file-viewer.js';
import { openSessionPicker } from './session-picker.js';
import { FileBrowser, getFileIcon } from './file-browser.js';
import { Launcher } from './launcher.js';
import { icon } from './icons.js';
import { SpeechController } from './tts.js';
import { createSessionActions } from './session-actions.js';

// ─── Cookie-session login (no Basic Auth client-side) ───
// The login form POSTs JSON credentials to /api/login once; the server mints
// an HttpOnly cookie session which the browser then sends on every fetch AND
// the WS handshake (which can't carry custom headers). The server never sends
// WWW-Authenticate, so the native browser login prompt can never appear —
// any API 401 raises the inline overlay instead. Nothing credential-like is
// kept in JS memory or storage; the cookie is the whole session.
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
  try { window.tauResetPasswordReveal?.(); } catch {}
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
  try { renderCurrentSessionCard(); } catch {}
  try { updateMirrorLiveIndicator(); } catch {}
  try { await refreshUplinkList(); } catch {}
  fetchSlashCommands();
}
function tauNeedsLogin(res, url) {
  const u = typeof url === 'string' ? url : url?.url || '';
  if (res?.status === 401 && u.includes('/api/')) {
    tauShowLogin();
    return true;
  }
  return false;
}
const tauRawFetch = window.fetch.bind(window);
window.fetch = (url, opts) => {
  opts = opts || {};
  // Cookie session rides along automatically (same-origin). No auth headers.
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
// Dialog abort-run routing: mirror session by default; dialogs.js targets the
// uplink/headless owner itself when the request came from one.
dialogHandler.onAbortRequest = () => routeCommand({ type: 'abort' });

// Session sidebar (themed confirm modal for destructive actions)
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect,
  (opts) => dialogHandler.confirmLocal(opts)
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

// ─── Speech (text-to-speech) ───
// Browser-native speechSynthesis: on-device voices, no API key, works offline
// and over plain HTTP (see tts.js for the engine rationale and quirks).
const speech = new SpeechController();
document.body.classList.toggle('no-tts', !speech.supported);
messageRenderer.onSpeak = (messageEl) => {
  if (speech.isSpeakingFor(messageEl)) speech.stop();
  else speech.speak(messageEl._speakText || '', { element: messageEl });
};
speech.addEventListener('start', (e) => setSpeakButtonState(e.detail.element, true));
speech.addEventListener('end', (e) => setSpeakButtonState(e.detail.element, false));
speech.addEventListener('error', (e) => flashStatus(e.detail.message));
speech.addEventListener('voiceschanged', () => populateVoiceSelect());
speech.addEventListener('settings', () => syncVoiceControls());
function setSpeakButtonState(messageEl, speaking) {
  const btn = messageEl?.querySelector?.('.message-speak-btn');
  if (btn) btn.classList.toggle('speaking', speaking);
}
// Transient status text that reverts to the connection state (never "Connected"
// while offline, and never left stranded by a newer flash).
let statusFlashTimer = null;
function flashStatus(message, ms = 3000) {
  statusText.textContent = message;
  if (statusFlashTimer) clearTimeout(statusFlashTimer);
  statusFlashTimer = setTimeout(() => {
    statusFlashTimer = null;
    if (lastConnStatus !== null) statusText.textContent = idleStatusText();
  }, ms);
}

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
// Locally shown user messages awaiting the backend echo ({ text, queued }).
// FIFO-matched in handleMessageStart so a message is never rendered twice and
// a queued bubble can be dropped exactly when the backend delivers it.
let pendingEchoes = [];
const pendingPrompts = new Map(); // prompt id -> { text } (rejection surfacing)
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let serverMode = null; // 'hub' | 'mirror' — from the WS state frame (ADR-010)
let liveInstances = []; // All running Tau instances [{port, sessionFile, cwd}]
// ─── tau-web unified: epoch guard, headless binding, uplink (ADR-004) ───
let bindingEpoch = 0; // bumped on every session switch; stale stream events are dropped
let bgWatchToken = 0; // bumped to stop the background-run history watch (see startBackgroundWatch)
let bgAgentRunning = false; // backend working with no local stream (e.g. after reload): abort stays available
let activeStreamEpoch = -1; // epoch captured when the current stream started
const VISIBLE_MESSAGE_WINDOW = 50; // render only the last 50; older loads on demand, full history stays on disk
// ─── URL session routing (per-tab sessions) ───
// The hash carries only the session file's basename (timestamp + uuid) — never
// a filesystem path, which would leak system details when the URL is shared.
let restoreInFlight = false;
let suppressHashWrite = false;
let urlRestorePending = !!parseSessionHash()?.key; // suppresses the first server snapshot race
let headlessSessionKey = null; // acked by start_session response; null = headless not bound
let headlessBinding = null; // { cwd, sessionFile } — rejoin target persisted per browser
try { headlessBinding = JSON.parse(localStorage.getItem('tau-web-binding') || 'null'); } catch {}
let uplinkActive = null; // { port, pid } while attached to a live TUI via uplink proxy
// tau-web preview-then-drive: driving a live TUI is two-phase. Picking Drive
// loads the session history read-only with a confirm banner; only "Drive this
// TUI" wires the uplink. uplinkLastDetached powers the "Drive again" affordance.
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
// NOTE: the explorer no longer feeds the prompt (blind context is out):
// file clicks route to FileBrowser.previewFile (read-only viewer stub).
// The pendingFilePaths pipeline below stays dormant until the viewer grows
// an explicit, preview-first "Add to prompt" action.
// Read-only file viewer: the explorer only announces taps (it knows no
// session key); the dormant pendingFilePaths pipeline is re-fed here, so
// attach stays an explicit, preview-first user action.
window.addEventListener('tau:preview-file', (e) => {
  const p = e?.detail?.path;
  if (!p) return;
  openFileViewer(p, {
    sessionKey: sessionKeyOf(sidebar.activeSessionFile || mirrorActiveSessionFile),
    onAttach: (info) => { pendingFilePaths.push(info); renderAttachmentPreviews(); },
  });
});
const fileBrowser = new FileBrowser(fileList, fileSidebarPath);

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    // Open on the viewed session's directory — never the server's own cwd
    // when another session (history, preview, uplink) is on screen.
    fileBrowser.load(fileBrowser.pendingRoot || resolveViewCwd(sidebar.activeSessionFile || mirrorActiveSessionFile) || undefined);
    fileBrowser.pendingRoot = null;
  }
  // Only one slide-over at a time on mobile
  if (isMobile() && !isCollapsed) {
    sidebarEl.classList.add('collapsed');
  }
  refreshMobileOverlay();
  updatePaneButtons();
  localStorage.setItem('tau-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  refreshMobileOverlay();
  updatePaneButtons();
  localStorage.setItem('tau-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

// Start a brand-new session rooted at the directory the explorer is showing.
document.getElementById('file-sidebar-new')?.addEventListener('click', () => {
  const cwd = fileBrowser.currentPath;
  if (cwd) sessionActions.newSessionInCwd(cwd);
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
  fileBrowser.load(resolveViewCwd(sidebar.activeSessionFile || mirrorActiveSessionFile) || undefined);
}

// File browser follows the viewed session: opening another session (history,
// preview, or driving a live TUI) must show THAT session's directory, not
// the web server's own cwd.
function resolveViewCwd(sessionFile, session = null, project = null) {
  const inst = (liveInstances || []).find((i) => sessionFile && i.sessionFile && sessionKeyOf(i.sessionFile) === sessionKeyOf(sessionFile));
  if (inst?.cwd) return inst.cwd;
  if (session?.cwd) return session.cwd;
  if (project?.path) return project.path;
  if (sessionFile) {
    const found = findSidebarSession(sessionFile);
    if (found?.session?.cwd) return found.session.cwd;
    if (found?.project?.path) return found.project.path;
  }
  return null;
}
function refreshFileBrowser(sessionFile, session = null, project = null, entries = null) {
  let cwd = resolveViewCwd(sessionFile, session, project);
  if (!cwd && entries) {
    try {
      const hdr = entries.find((e) => e && e.type === 'session');
      if (hdr?.cwd) cwd = hdr.cwd;
    } catch {}
  }
  if (!cwd) return;
  fileBrowser.pendingRoot = cwd;
  fileBrowser.sessionKey = sessionKeyOf(sessionFile);
  if (fileBrowser.currentPath === cwd) return;
  if (fileSidebar.classList.contains('collapsed')) {
    // Closed: drop the stale path so the next open loads the new root.
    fileBrowser.currentPath = null;
  } else {
    fileBrowser.load(cwd);
  }
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

wsClient.addEventListener('connected', async () => {
  pollConnectionStatus();
  // A reconnect wipes the streaming class; re-apply if a run is in flight.
  if (state.isStreaming) { lastUiStreaming = null; updateUI(); }
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);
  // Warm the slash-command cache for palette search + input validation
  fetchSlashCommands();
  // (Re)bind the headless backend. A session pinned in the URL wins over the
  // stored binding (per-tab sessions): resume it headless unless a live TUI
  // owns it — resuming there would put two writers on one session file.
  const pinned = parseSessionHash();
  await pollInstances();
  const pinnedLive = pinned?.key
    ? liveInstances.find((i) => !i.local && sessionKeyOf(i.sessionFile) === pinned.key)
    : null;
  if (pinned?.key) {
    await ensureSessionsLoaded();
    const found = findSidebarSession(pinned.key);
    // Same-file reload replays the backend id (exact rejoin); a live-owned
    // file or a different file binds by path and lets the server resolve.
    const sameFile = !pinnedLive && (headlessBinding?.sessionFile || null) === pinned.key;
    bindHeadless(found?.project?.path || null, pinnedLive ? null : pinned.key,
      sameFile ? headlessBinding?.sessionKey || null : null);
  } else {
    bindHeadless(headlessBinding?.cwd || null, headlessBinding?.sessionFile || null,
      headlessBinding?.sessionKey || null);
  }
  // The server detaches uplinks on WS close; re-drive the same TUI.
  if (uplinkActive) attachUplink(uplinkActive.port, uplinkActive.pid, uplinkTargetSessionFile);
  // Refresh the Live TUI section.
  refreshUplinkList();
  // Restore the URL-pinned session (per-tab sessions survive reloads).
  restoreSessionFromUrl();
});

// Manual hash edits switch tabs/sessions live (back/forward included). The
// teardown below rewrites the hash, so suppress those writes.
window.addEventListener('hashchange', async () => {
  suppressHashWrite = true;
  try {
    if (uplinkActive || uplinkPreview) {
      detachUplink();
      uplinkPreview = null;
    }
    uplinkLastDetached = null;
    uplinkAttachError = null;
    updateMirrorInputState();
    syncUplinkControls();
    renderSessionBanner();
    if (parseSessionHash()?.key) {
      await restoreSessionFromUrl();
    } else {
      updateSessionHash(null);
      sidebar.clearActive();
      newSession();
    }
  } finally {
    suppressHashWrite = false;
  }
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
  } else if (response?.command === 'prompt') {
    // A rejected prompt must never be silent (ADR-007): the backend refused it
    // before acceptance, so drop the queued bubble and say why.
    const sent = id ? pendingPrompts.get(id) : null;
    if (id) pendingPrompts.delete(id);
    if (response.success === false) {
      const text = sent?.text;
      if (text) {
        const ei = pendingEchoes.findIndex((x) => x.text === text);
        if (ei !== -1) pendingEchoes.splice(ei, 1);
        const qi = messageQueue.findIndex((c) => c.message === text);
        if (qi !== -1) { messageQueue.splice(qi, 1); renderQueuedMessages(); }
      }
      messageRenderer.renderError(`Prompt rejected: ${response.error || 'the agent is busy'}`);
    }
  }
});
wsClient.addEventListener('uplinkAttached', (e) => {
  uplinkActive = { port: e.detail.port, pid: e.detail.pid };
  // Authoritative target from the server (banner retry / reconnect paths
  // carry no file — without this the file browser keeps a stale directory).
  if (e.detail.sessionFile) uplinkTargetSessionFile = e.detail.sessionFile;
  uplinkPreview = null;
  uplinkLastDetached = null;
  uplinkAttachPending = false;
  uplinkAttachError = null;
  viewingActiveSession = true; // the uplinked TUI's session is now the live view
  refreshFileBrowser(uplinkTargetSessionFile);
  pollInstances().then(() => refreshFileBrowser(uplinkTargetSessionFile)).catch(() => {});
  pollAttachedState();
  updateSessionHash(uplinkTargetSessionFile, true);
  updateMirrorInputState();
  renderSessionBanner();
  syncUplinkControls();
  closeSidebarOnMobile(); // reveal the Driving banner + live transcript
  messageRenderer.renderSystemMessage(`Now driving the live TUI on :${e.detail.port} — your prompts go to that session.`);
});
wsClient.addEventListener('uplinkDetached', () => {
  // Echo of our own uplink_detach — teardown already happened synchronously
  // at the send site. Re-applying it here would clobber whatever view was
  // opened since (e.g. backToLive's fresh live session).
  if (!uplinkActive && !uplinkPreview && !uplinkAttachPending) return;
  const prev = uplinkActive;
  uplinkActive = null;
  uplinkPreview = null;
  uplinkAttachPending = false;
  if (prev) uplinkLastDetached = { port: prev.port, pid: prev.pid, sessionFile: uplinkTargetSessionFile };
  viewingActiveSession = false; // frozen view: routing stays on the bound backend
  if (serverOwnSessionFile) mirrorActiveSessionFile = serverOwnSessionFile;
  updateSessionHash(uplinkTargetSessionFile, false);
  updateMirrorInputState();
  renderSessionBanner();
  syncUplinkControls();
  closeSidebarOnMobile(); // reveal the Drive-again banner
});
wsClient.addEventListener('uplinkDead', (e) => {
  const was = uplinkActive;
  uplinkActive = null;
  uplinkAttachPending = false;
  uplinkAttachError = `Lost the drive link to :${e.detail.port} — the TUI may have exited.`;
  if (was) uplinkLastDetached = { port: was.port, pid: was.pid, sessionFile: uplinkTargetSessionFile };
  viewingActiveSession = false;
  if (serverOwnSessionFile) mirrorActiveSessionFile = serverOwnSessionFile;
  updateSessionHash(uplinkTargetSessionFile, false);
  renderSessionBanner();
  syncUplinkControls();
  closeSidebarOnMobile(); // reveal the dropped-uplink banner
  // Never silent (ADR-007): surface the drop and offer headless-continue on the same file.
  messageRenderer.renderError(`Lost the drive link to :${e.detail.port}. The TUI may have exited.`);
  if (e.detail.headlessContinue && was) offerHeadlessContinue(e.detail);
});
wsClient.addEventListener('sessionEnded', (e) => {
  headlessSessionKey = null;
  messageRenderer.renderError(`Headless session ended (exit ${e.detail.code ?? '?'}). Pick a session from the sidebar to continue.`);
});

// A fresh headless backend discovered its session file: pin the URL identity so
// reload/resume works (ADR-010 §UI flow 2). Never clobber a previewed/driven or
// URL-pinned view with a discovery from the background backend.
wsClient.addEventListener('sessionFile', (e) => {
  const file = e.detail?.sessionFile;
  if (!file) return;
  if (uplinkOwnsView()) return;
  const pinned = parseSessionHash();
  const key = sessionKeyOf(file);
  if (pinned?.key && pinned.key !== key) return;
  if (!headlessBinding) headlessBinding = { cwd: e.detail?.cwd || null, sessionFile: null, sessionKey: null };
  // Keep the backend id only when this discovery belongs to the bound file
  // (or the file is still unknown) — a late event for a previous session
  // must not label the new one.
  const prevFile = headlessBinding.sessionFile || null;
  const keepKey = !prevFile || prevFile === key ? headlessBinding.sessionKey || null : null;
  headlessBinding = { cwd: headlessBinding.cwd || e.detail?.cwd || null, sessionFile: key, sessionKey: keepKey };
  persistBinding();
  updateSessionHash(file, false);
  // Fresh headless identity: the backend is bound and the hash is pinned,
  // but the card/title still read "No session" until the view points at
  // it. Adopt the discovered file as the viewed session (guards above
  // already protect preview/driven and foreign-pin cases) and repaint.
  if (sessionKeyOf(sidebar.activeSessionFile) !== key) sidebar.setActive(file);
  renderCurrentSessionCard();
});

// Track hub vs mirror so the Live section never offers cross-session attach on
// a mirror (ADR-010: only the hub owns the switchboard / dials other TUIs).
wsClient.addEventListener('stateUpdate', (e) => {
  serverMode = e.detail?.mode || null;
  renderLiveSection(liveInstances);
});

wsClient.addEventListener('disconnected', () => {
  pollConnectionStatus();
  // A dead socket can't tell "server down" from "credentials lost" (an
  // auth-rejected WS upgrade surfaces as an abnormal close). Probe an
  // authenticated endpoint — the fetch wrapper reloads into the login
  // prompt on 401, while network errors reject silently and keep retrying.
  tauRawFetch('/api/sessions').then((res) => tauNeedsLogin(res, '/api/sessions')).catch(() => {});
});

wsClient.addEventListener('reconnectFailed', () => {
  pollConnectionStatus();
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
    case 'compaction_start':
    case 'auto_compaction_start':
      handleCompactionStart(event);
      break;
    case 'compaction_end':
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

let isCompacting = false;

function compactionReasonText(reason) {
  if (reason === 'threshold') return 'context limit reached';
  if (reason === 'overflow') return 'context overflow — recovering';
  if (reason === 'manual') return 'manual';
  return '';
}

// Compaction can run for a while (summary request + retries) with no stream
// output, which used to read as "stuck". Give it a first-class state: amber
// pulsing dot + "Compacting…" in the header, plus a transcript message.
function setCompactingStatus(active, title) {
  isCompacting = active;
  renderStatusDot();
  if (active) {
    statusText.textContent = 'Compacting…';
    statusText.title = title || 'Summarizing the conversation context';
  } else {
    statusText.title = '';
    // Force updateUI() to re-apply the streaming/idle chrome.
    lastUiStreaming = null;
    updateUI();
  }
}

function handleCompactionStart(event) {
  const reason = compactionReasonText(event?.reason);
  setCompactingStatus(true, reason || 'Summarizing the conversation context');
  let el = document.getElementById('compaction-indicator');
  if (!el) {
    el = document.createElement('div');
    el.className = 'system-message compaction-message';
    el.id = 'compaction-indicator';
    messagesContainer.appendChild(el);
  }
  el.classList.remove('compaction-done');
  el.innerHTML = `<span class="compaction-spinner svg-wrap">${icon('spinner', 13)}</span> Compacting context${reason ? ` — ${escapeHtml(reason)}` : ''}…`;
  scrollToBottom();
}

function handleCompactionEnd(event) {
  setCompactingStatus(false);
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const error = event?.errorMessage || event?.error;
    const summary = event?.summary || event?.result?.summary;
    if (event?.aborted) {
      indicator.innerHTML = `${icon('x', 13)} Compaction cancelled`;
    } else if (error) {
      indicator.innerHTML = `${icon('warn', 13)} Compaction failed — ${escapeHtml(String(error))}`;
    } else {
      indicator.innerHTML = `${icon('check', 13)} Context compacted${summary ? ` — ${escapeHtml(String(summary))}` : ''}${event?.willRetry ? ' · retrying' : ''}`;
    }
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
let pendingAutoRead = null; // { el, text } — last finalized assistant reply with text
function cancelStreamSettle() {
  if (streamSettleTimer) { clearTimeout(streamSettleTimer); streamSettleTimer = null; }
}
function handleAgentStart() {
  activeStreamEpoch = bindingEpoch;
  bgWatchToken++; // a new run renders live; the history watch yields
  bgAgentRunning = false; // the local run owns the chrome now
  cancelStreamSettle();
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
  // A new run makes the previous reply stale — never read over it.
  pendingAutoRead = null;
  speech.stop();
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
    // Auto-read the reply once the run has actually settled (tool loops emit
    // agent_end between messages; reading each one would overlap the next).
    if (speech.settings.autoRead && pendingAutoRead) {
      speech.speak(pendingAutoRead.text, { element: pendingAutoRead.el });
    }
    pendingAutoRead = null;
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
    // User messages from the TUI arrive via events. Messages this browser sent
    // are matched against pendingEchoes: already-rendered ones are suppressed,
    // and a queued (steered) one moves from the queue into the transcript when
    // the backend actually delivers it.
    const content = getMessageText(message);
    const idx = content ? pendingEchoes.findIndex((e) => e.text === content) : -1;
    if (idx === -1) {
      if (content) messageRenderer.renderUserMessage({ content });
    } else {
      const echo = pendingEchoes.splice(idx, 1)[0];
      if (echo.queued) {
        const qi = messageQueue.findIndex((c) => c.message === content);
        if (qi !== -1) { messageQueue.splice(qi, 1); renderQueuedMessages(); }
        if (content) messageRenderer.renderUserMessage({ content });
      }
    }
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
    const finalizedEl = currentStreamingElement;
    messageRenderer.finalizeStreamingMessage(finalizedEl, usage, currentStreamingThinking, message);
    if (finalizedEl._speakText) pendingAutoRead = { el: finalizedEl, text: finalizedEl._speakText };
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
  // Tool output can stream dozens of times per second; formatting the full
  // partial result and rewriting the card per event saturates the phone's main
  // thread, which is what makes the pulsing "streaming" badge look like it
  // flickers. Keep only the latest partial and flush once per frame instead.
  pendingToolUpdates.set(toolCallId, partialResult);
  if (!toolFlushRaf) toolFlushRaf = requestAnimationFrame(flushToolCardUpdates);
}

const pendingToolUpdates = new Map(); // toolCallId -> latest partialResult
let toolFlushRaf = null;
function flushToolCardUpdates() {
  toolFlushRaf = null;
  for (const [toolCallId, partialResult] of pendingToolUpdates) {
    // The tool may have ended before this frame ran; finalize already wrote
    // the final state and re-marking it streaming would restart the pulse.
    const exec = state.getToolExecution(toolCallId);
    if (!exec || exec.status === 'complete' || exec.status === 'error') continue;
    state.updateToolExecution(toolCallId, {
      status: 'streaming',
      output: formatToolOutput(partialResult),
    });
    toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
  }
  pendingToolUpdates.clear();
}
function cancelToolFlush() {
  if (toolFlushRaf) { cancelAnimationFrame(toolFlushRaf); toolFlushRaf = null; }
  pendingToolUpdates.clear();
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
  // Enter sends on desktop, Shift+Enter inserts a newline everywhere.
  // On touch devices (coarse pointer = virtual keyboard) Enter inserts a
  // newline too — send via the send button instead.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    const touchKeyboard = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    if (touchKeyboard) return; // let the newline through
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
let pendingFilePaths = [];  // { path, name, ext } — dormant; the read-only viewer will feed it via explicit attach

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// History-path guard for session-file image blocks (B1/S1): the renderer
// re-validates at the sink, but filter here too so invalid blocks never
// become message state.
function isValidHistoryImage(data, mimeType) {
  if (!VALID_MIME_TYPES.includes(mimeType)) return false;
  if (typeof data !== 'string' || !data) return false;
  let b64 = data;
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma === -1) return false;
    const header = b64.slice(0, comma);
    const m = header.match(/^data:([^;,]+)(;base64)?$/i);
    if (!m || !VALID_MIME_TYPES.includes((m[1] || '').toLowerCase())) return false;
    b64 = b64.slice(comma + 1);
  }
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) return false;
  return b64.replace(/\s/g, '').length > 0;
}
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
  btn.innerHTML = icon('x', 12);
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
        // innerHTML: getFileChipIcon returns SVG markup, not text.
        icon.innerHTML = getFileChipIcon(fp.name);
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
      icon.innerHTML = getFileChipIcon(fp.ext);
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
  // Pi queues steered prompts natively while a run is in flight. Always
  // declare the behavior (ignored when idle) so a send racing the end of a
  // run is queued instead of rejected with "Agent is already processing".
  cmd.streamingBehavior = 'steer';
  cmd.id = `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  pendingPrompts.set(cmd.id, { text: cmd.message });
  // Bounded cleanup: the server-own path never answers over WS (fire-and-forget),
  // so a rejection response may simply never arrive.
  setTimeout(() => pendingPrompts.delete(cmd.id), 60000);

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
    // Show it as a bubble AND forward it right away: pi holds the steer in
    // its own queue and delivers it after the current turn. Waiting for a
    // browser-side flush on agent_end stranded messages for the whole run.
    messageQueue.push(cmd);
    pendingEchoes.push({ text: cmd.message, queued: true });
    renderQueuedMessages();
    cmd.sent = !!(wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN);
    routeCommand(cmd);
    return;
  }

  pendingEchoes.push({ text: cmd.message, queued: false });
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
    // Already forwarded as a steer: pi will run it after the current turn,
    // so there is nothing left to cancel — say so instead of offering a
    // cancel button that only hides the bubble.
    const sent = !!cmd.sent;
    el.innerHTML = `
      <span class="queued-msg-label">${sent ? 'Sent · runs next' : 'Queued'}</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      ${sent ? '' : `<button class="queued-msg-cancel" title="Cancel" aria-label="Cancel">${icon('x', 12)}</button>`}
    `;
    if (!sent) {
      el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
        const [removed] = messageQueue.splice(i, 1);
        const ei = pendingEchoes.findIndex((x) => x.text === removed?.message);
        if (ei !== -1) pendingEchoes.splice(ei, 1);
        renderQueuedMessages();
      });
    }
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  // innerHTML escapes &<>, but NOT quotes — attribute contexts
  // (title="…", data-file="…") need &quot; too.
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function flushQueue() {
  if (messageQueue.length === 0 || state.isStreaming) return;
  // Queued messages are forwarded immediately as steers, so normally there is
  // nothing to do here — their echo moves them into the transcript. Only a
  // command that never reached the wire is routed now (and not re-sent later).
  for (const cmd of messageQueue) {
    if (cmd.sent) continue;
    cmd.sent = true;
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
  { icon: icon('compact', 15), label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: icon('export', 15), label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: icon('stats', 15), label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: icon('expand', 15), label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: icon('collapse', 15), label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },
  { icon: icon('reload', 15), label: 'Reload Runtime', desc: 'Reload extensions, skills and prompts (/reload)', action: () => { messageInput.value = '/reload'; sendMessage(); } },
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
      `Session Stats`,
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
// pi's canonical thinking levels, picked from the header dropdown.
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
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
      if (model?.contextWindow) setContextWindow(model.contextWindow);
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
  // would hit the wrong backend. Drive the TUI first.
  if (uplinkPreview) {
    statusText.textContent = 'Drive this TUI to change the model';
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
        if (m.contextWindow) setContextWindow(m.contextWindow);
      });
      itemsContainer.appendChild(el);
    });
  }

  renderItems('');

  search.addEventListener('input', () => renderItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelDropdown(); e.stopPropagation(); }
    if (e.key === 'Enter') {
      // Inside a <form> (hub composer) Enter would submit and send the message.
      e.preventDefault();
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
const thinkingDropdown = document.getElementById('thinking-dropdown');
const thinkingMenu = document.getElementById('thinking-menu');
function renderThinkingMenu() {
  if (!thinkingMenu) return;
  thinkingMenu.innerHTML = THINKING_LEVELS.map((lv) =>
    `<button type="button" class="thinking-item${lv === currentThinkingLevel ? ' active' : ''}" data-level="${lv}">${lv}</button>`
  ).join('');
  thinkingMenu.querySelectorAll('.thinking-item').forEach((item) => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const level = item.dataset.level;
      thinkingMenu.classList.add('hidden');
      thinkingDropdown?.classList.remove('open');
      if (level === currentThinkingLevel) return;
      if (uplinkPreview) {
        statusText.textContent = 'Drive this TUI to change thinking level';
        setTimeout(() => { statusText.textContent = 'Connected'; }, 2500);
        return;
      }
      const data = await rpcCommand({ type: 'set_thinking_level', level }, `Thinking: ${level}...`);
      if (data?.success === false) return; // keep the previous level on failure
      currentThinkingLevel = level;
      updateThinkingBtn();
    });
  });
}
thinkingBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  renderThinkingMenu();
  thinkingMenu?.classList.toggle('hidden');
  thinkingDropdown?.classList.toggle('open');
});
document.addEventListener('click', () => {
  thinkingMenu?.classList.add('hidden');
  thinkingDropdown?.classList.remove('open');
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Escape always stops read-aloud, then falls through to the usual handling.
    if (speech.speaking) speech.stop();
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

    if (state.isStreaming || bgAgentRunning) {
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

// Phone slide-over: every navigation path must dismiss it, or the new view
// loads invisibly behind the open sidebar.
function closeSidebarOnMobile() {
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  updatePaneButtons();
}

function updateSidebarToggleIcon() {
  sidebarToggle.innerHTML = icon('menu', 18);
  updatePaneButtons();
}

// A pane's toggle only shows while that pane is closed — once it is open its
// own Back button closes it, so the toggle would be redundant.
function updatePaneButtons() {
  sidebarToggle.classList.toggle('hidden', !sidebarEl.classList.contains('collapsed'));
  if (fileSidebarToggle) {
    fileSidebarToggle.classList.toggle('hidden', !fileSidebar.classList.contains('collapsed'));
  }
}
updatePaneButtons();

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

// Explicit close button in the sidebar header (works on desktop too: collapses
// the pane; the header hamburger brings it back).
document.getElementById('sidebar-close-btn')?.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  fileSidebar.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn');
newSessionBtn.addEventListener('click', () => {
  promptNewSession();
});

// New-session busy guard: creation spawns a cold backend (slow on phones),
// so all three entries (#new-session-btn, #tab-new, .sh-new) spin and
// ignore extra taps while one is in flight — no duplicate sessions.
let newSessionBusy = false;
let newSessionStage = null; // transient statusText override while busy
function setNewSessionBusy(busy, stage = null) {
  newSessionBusy = busy;
  newSessionStage = busy ? stage : null;
  for (const el of document.querySelectorAll('#new-session-btn, #tab-new, .sh-new')) {
    el.classList.toggle('ns-busy', busy);
  }
  lastUiStreaming = null; // the stage joins the repaint key — force it through
  updateUI();
}
function setNewSessionStage(stage) {
  if (!newSessionBusy) return;
  newSessionStage = stage;
  lastUiStreaming = null;
  updateUI();
}

// ─── Persistent session actions (hub mode) ───
// Browser close only detaches; pi keeps running until explicit Kill.
// Module kept tiny and separate (session-actions.js) so lifecycle reads
// in one place instead of scattered across app.js.
const sessionActions = createSessionActions({
  sendRpc,
  dialogConfirm: (opts) => dialogHandler.confirmLocal(opts),
  getCwd: () => headlessBinding?.cwd || fileBrowser.currentPath || null,
  onFresh: (data) => applyFreshSession(data),
  onClosed: () => { newSession(); },
  onTimeout: () => messageRenderer.renderSystemMessage('New session timed out — the server did not answer. Check the backend connection and try again.'),
});
// Decoupled hook for the hub shell: `+` / Ctrl+T dispatch `tau:new-session`
// (instant, same project) so hub.js never reaches into app.js internals.
// The directory-picker modal stays on the sidebar's New button.
// Fail fast when the socket is down: without this the click sits silent until
// the 15s RPC timeout (the classic "new tab button does nothing" report).
window.addEventListener('tau:new-session', () => {
  if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) {
    messageRenderer.renderSystemMessage('Not connected to the backend — start (or wait for) the server before opening a new session.');
    return;
  }
  if (newSessionBusy) return; // a creation is already in flight — no duplicates
  setNewSessionBusy(true, 'Creating session…');
  console.time('[NewSession] total (tap to bound view)');
  sessionActions.newSessionSameProject().finally(() => {
    console.timeEnd('[NewSession] total (tap to bound view)');
    setNewSessionBusy(false);
  });
});
// Header Kill button. Placed on the current-session card so it is visually
// attached to the session it terminates (no ambiguity about which one dies).
(function initKillButton() {
  if (document.getElementById('kill-session-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'icon-btn cs-kill';
  btn.id = 'kill-session-btn';
  btn.title = 'Kill this session';
  btn.setAttribute('aria-label', 'Kill this session');
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  btn.addEventListener('click', () => sessionActions.closeCurrentSession());
  const csTop = document.querySelector('#current-session .cs-top');
  if (csTop) {
    csTop.appendChild(btn);
  } else if (newSessionBtn?.parentElement) {
    newSessionBtn.parentElement.insertBefore(btn, newSessionBtn.nextSibling);
  }
})();

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
  // A scratch view gets a fresh headless backend so prompts never leak
  // into the previously bound session's backend.
  bindHeadless(null, null);
  await resetToScratchView();
}

// Shared UI reset for "empty scratch session" — no binding changes here.
async function resetToScratchView() {
  updateSessionHash(null); // a fresh scratch session has no URL identity
  resetTokenTracking();
  updateCostDisplay();
  updateTokenUsage();
  try { speech.stop(); } catch {}
  pendingAutoRead = null;
  await switchSession(null);
  sidebar.clearActive();
  closeSidebarOnMobile();
  if (!isMobile()) messageInput.focus();
}

// Adopt the backend the server already created for a `new_session` ack.
// Rebinding here (calling bindHeadless) would spawn a second child and orphan
// the one we just asked for.
async function applyFreshSession(data) {
  console.time('[NewSession] applyFreshSession (reset + bind)');
  setNewSessionStage('Starting backend…');
  const cwd = data?.data?.cwd || null;
  headlessSessionKey = data?.data?.sessionKey || 'bound';
  headlessBinding = { cwd, sessionFile: null, sessionKey: data?.data?.sessionKey || null };
  persistBinding();
  await resetToScratchView();
  if (cwd) {
    fileBrowser.pendingRoot = cwd;
    if (!fileSidebar.classList.contains('collapsed')) fileBrowser.load(cwd);
  }
  console.timeEnd('[NewSession] applyFreshSession (reset + bind)');
}

// New-session modal: directory (prefilled) + optional starter prompt. Resume
// lives in the sidebar; this path always starts fresh.
// Start / Resume picker: directory browser + per-directory sessions +
// favourites + optional starter. New sessions reuse the busy-guarded
// creation flow; resume/fork bind through the normal switch path.
async function promptNewSession() {
  const cwd = fileBrowser.currentPath || headlessBinding?.cwd || '';
  openSessionPicker({
    cwd,
    isFavourite: (fp) => sidebar.isFavourite(fp),
    onToggleFavourite: (fp) => sidebar.toggleFavourite(fp),
    onNew: async (dir, starter) => {
      if (!wsClient.ws || wsClient.ws.readyState !== WebSocket.OPEN) {
        messageRenderer.renderSystemMessage('Not connected to the backend — start (or wait for) the server before opening a new session.');
        return;
      }
      if (newSessionBusy) return;
      setNewSessionBusy(true, 'Creating session…');
      try {
        console.time('[NewSession] total (picker confirm to bound view)');
        await sessionActions.newSessionInCwd(dir || null);
        if (starter) sendMessage(starter);
        console.timeEnd('[NewSession] total (picker confirm to bound view)');
      } finally {
        setNewSessionBusy(false);
      }
    },
    onResume: async (sm) => {
      let found = findSidebarSession(sm.file);
      if (!found) { await sidebar.loadSessions(); found = findSidebarSession(sm.file); }
      if (!found) {
        messageRenderer.renderSystemMessage('That session is no longer on disk.');
        return;
      }
      await handleSessionSelect(found.session, found.project);
    },
    onFork: async (sm) => {
      const res = await fetch('/api/sessions/fork', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirName: sm.dirName, file: sm.file }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error || !data?.file) {
        messageRenderer.renderSystemMessage(`Fork failed: ${data?.error || res.status}`);
        return;
      }
      await sidebar.loadSessions();
      const found = findSidebarSession(data.file);
      if (found) await handleSessionSelect(found.session, found.project);
      else messageRenderer.renderSystemMessage('Forked, but the copy is not listed — pull to refresh.');
    },
  });
}

async function handleSessionSelect(session, project) {
  if (!session) {
    // Deleting the active session lands here with null — go to a clean slate
    // instead of crashing on session.filePath.
    sidebar.clearActive();
    updateSessionHash(null);
    await newSession();
    return;
  }
  sidebar.setActive(session.filePath);
  updateSessionHash(session.filePath, false);
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
  closeSidebarOnMobile(); // reveal the new view from behind the slide-over
}

async function switchSession(sessionFile, session = null, project = null, opts = {}) {
  try {
    // New binding epoch — in-flight stream events from the old session are dropped.
    bindingEpoch++;
    // Captured for the stale-switch guards below: a second switchSession
    // (fast tab-hopping) invalidates everything this call fetches after.
    const myEpoch = bindingEpoch;
    bgWatchToken++; // stop any background-run watch from the previous view
    bgAgentRunning = false; // fresh view; the bind ack re-arms if still running
    cancelStreamSettle();
    state.setStreaming(false);
    showTypingIndicator(false);
    updateUI();
    activeStreamEpoch = -1;
    // Clear any streaming state from previous session to prevent bleed
    cancelStreamFlush();
    cancelToolFlush();
    speech.stop();
    pendingAutoRead = null;
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

          // Superseded while fetching (fast tab switch): the newer view
          // owns the screen — drop this payload so neither its content,
          // its title, nor its headless bind lands on the wrong tab.
          if (myEpoch !== bindingEpoch) return;

          messageRenderer.clear();
          renderSessionHistory(data.entries || []);
          // Bind the headless backend to this file so prompts have a runner
          // even when no live TUI owns the session. Previews stay read-only
          // and don't move the headless backend. Files owned by a live TUI
          // are never bound (ADR-003): a second process must not attach to
          // a live session's file — drive the running TUI instead.
          if (!opts.preview) {
            const ownedByTui = (liveInstances || []).some((li) => !li.local && li.sessionFile && sessionFile && li.sessionFile === sessionFile);
            if (!ownedByTui) bindHeadless(project?.path || null, file, null, { dirName });
          }
          // File browser follows the viewed session (history entries carry
          // the authoritative cwd when the sidebar object lacks it).
          refreshFileBrowser(sessionFile, session, project, data.entries || []);
        } catch (e) {
          console.error('[App] History fetch error:', e);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      messageRenderer.renderWelcome();
    }

    // In mirror mode, track whether this view is the live session. Binding
    // is owned by the WS start_session / mirror_sync path — there is no
    // legacy HTTP switch (the hub has no /api/sessions/switch route).
    if (isMirrorMode) {
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      if (uplinkPreview) viewingActiveSession = false; // preview is read-only
      updateMirrorInputState();
    }
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
  // A creation that drove this switch is now bound: drop the transient
  // stage (the busy flag itself clears in the new-session finally).
  if (newSessionStage) { newSessionStage = null; lastUiStreaming = null; updateUI(); }
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
  // Same protection for a session pinned in the URL (per-tab sessions): the
  // server's own snapshots must not clobber the pinned view while the restore
  // is pending (first snapshot race) or once it is active.
  const pinned = parseSessionHash();
  const pinnedActive = !!pinned?.key && sessionKeyOf(sidebar.activeSessionFile) === pinned.key;
  if (!fromUplink && !uplinkOwnsView() && pinned?.key && sessionKeyOf(data.sessionFile) !== pinned.key && (urlRestorePending || pinnedActive)) {
    isMirrorMode = true;
    serverOwnSessionFile = data.sessionFile || serverOwnSessionFile;
    return;
  }
  // The driven TUI rotated sessions (e.g. /new in the TUI): follow it so
  // the banner, URL pin and file browser track the session actually driven.
  if (fromUplink && data.sessionFile && uplinkTargetSessionFile && data.sessionFile !== uplinkTargetSessionFile) {
    uplinkTargetSessionFile = data.sessionFile;
    updateSessionHash(uplinkTargetSessionFile, true);
    if (findSidebarSession(uplinkTargetSessionFile)) sidebar.setActive(uplinkTargetSessionFile);
    renderSessionBanner();
    syncUplinkControls();
  }
  bindingEpoch++; // fresh binding; drop anything in flight from before
  cancelStreamSettle();
  // A sync replaces the whole view: drop stale tool state too, or tool
  // updates land on orphaned (DOM-detached) cards and vanish silently.
  state.reset();
  toolCardRenderer.clear();
  showTypingIndicator(false);
  updateUI();
  activeStreamEpoch = -1;
  isMirrorMode = true;

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  viewingActiveSession = true;
  // File browser follows the live session, but a background sync must not
  // yank a browser the user deliberately drilled into a subdirectory.
  if (!fileBrowser.currentPath || fileBrowser.sessionKey !== sessionKeyOf(data.sessionFile)) {
    refreshFileBrowser(data.sessionFile, null, null, data.entries || []);
  }
  updateMirrorInputState();
  updateMirrorLiveIndicator();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
    updateModelLabel();
    if (data.model.contextWindow) setContextWindow(data.model.contextWindow);
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
    if (data.contextUsage.contextWindow) setContextWindow(data.contextUsage.contextWindow);
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

// ─── Current session card (left pane) ───
// One always-visible answer to "which session is this pane on, and where does
// it live?" — used especially after detaching, when the frozen view no longer
// says anything about the session it froze on.
function currentConnectionInfo() {
  const activeFile = sidebar.activeSessionFile || mirrorActiveSessionFile || null;
  if (uplinkAttachPending) {
    const port = uplinkPreview?.port || uplinkLastDetached?.port;
    return { state: 'preview', label: `Taking over${port ? ` · :${port}` : ''}…` };
  }
  if (uplinkActive) return { state: 'live', label: `Driving · :${uplinkActive.port}` };
  if (uplinkPreview) return { state: 'preview', label: `Preview · :${uplinkPreview.port}` };
  if (uplinkLastDetached?.sessionFile && sessionKeyOf(uplinkLastDetached.sessionFile) === sessionKeyOf(activeFile)) {
    return { state: 'detached', label: `Detached · :${uplinkLastDetached.port}` };
  }
  const boundKey = headlessBinding?.sessionFile ? sessionKeyOf(headlessBinding.sessionFile) : null;
  if (headlessSessionKey && boundKey && boundKey === sessionKeyOf(activeFile)) {
    return { state: 'headless', label: 'Headless runner' };
  }
  // The hub has no session of its own — never label its view "This server".
  // (Mirror-direct mode keeps the label: there the page IS the TUI's view.)
  if (serverMode === 'mirror' && viewingActiveSession) return { state: 'server', label: 'This server' };
  if (activeFile) return { state: 'headless', label: 'Headless runner' };
  return { state: 'none', label: 'No session' };
}

// ─── Session status bar: project + git branch (bottom of the composer) ───
const gitInfoCache = new Map(); // cwd -> { at, info }
async function fetchGitInfo(cwd) {
  if (!cwd) return null;
  const hit = gitInfoCache.get(cwd);
  if (hit && Date.now() - hit.at < 10000) return hit.info;
  try {
    const r = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
    const info = await r.json();
    gitInfoCache.set(cwd, { at: Date.now(), info });
    return info;
  } catch {
    const info = { repo: false };
    gitInfoCache.set(cwd, { at: Date.now(), info });
    return info;
  }
}
function renderSessionBar(cwd) {
  const bar = document.getElementById('session-bar');
  if (!bar) return;
  const projItem = document.getElementById('sb-project');
  const projName = document.getElementById('sb-project-name');
  const branchItem = document.getElementById('sb-branch');
  const branchName = document.getElementById('sb-branch-name');
  if (!cwd) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || cwd;
  if (projName) projName.textContent = base;
  if (projItem) projItem.title = cwd;
  if (branchItem) branchItem.classList.add('hidden');
  fetchGitInfo(cwd).then((info) => {
    if (!branchItem) return;
    if (!info || !info.repo || !info.branch) { branchItem.classList.add('hidden'); return; }
    branchItem.classList.remove('hidden');
    branchItem.classList.toggle('dirty', !!info.dirty);
    if (branchName) branchName.textContent = info.branch;
    branchItem.title = `${info.detached ? 'detached HEAD ' : ''}${info.branch}${info.dirty ? ' · uncommitted changes' : ''}${info.root ? ` — ${info.root}` : ''}`;
  });
}

let currentSessionSig = null;
function renderCurrentSessionCard() {
  const nameEl = document.getElementById('cs-name');
  if (!nameEl) return;
  const activeFile = sidebar.activeSessionFile || mirrorActiveSessionFile || null;
  const found = findSidebarSession(activeFile);
  const inst = (liveInstances || []).find((i) => activeFile && sessionKeyOf(i.sessionFile) === sessionKeyOf(activeFile));
  let name = found?.session?.name || found?.session?.firstMessage || liveSessionName(activeFile) || '';
  if (!name && activeFile) name = activeFile.split('/').pop().replace(/\.jsonl$/, '');
  if (!name) name = 'New session';
  const dir = found?.project?.path || inst?.cwd || headlessBinding?.cwd || '';
  const info = currentConnectionInfo();
  const sig = `${info.state}|${info.label}|${name}|${dir}`;
  if (sig === currentSessionSig) return;
  currentSessionSig = sig;
  const dot = document.getElementById('cs-dot');
  const stateEl = document.getElementById('cs-state');
  const dirEl = document.getElementById('cs-dir');
  if (dot) dot.className = `cs-dot ${info.state}`;
  if (stateEl) stateEl.textContent = info.label;
  nameEl.textContent = name;
  nameEl.title = activeFile || name;
  if (dirEl) {
    dirEl.textContent = dir;
    dirEl.title = dir;
    dirEl.style.display = dir ? '' : 'none';
  }
  // The kill × lives on this card: attach it to the session it terminates.
  const killBtn = document.getElementById('kill-session-btn');
  if (killBtn) {
    killBtn.classList.toggle('hidden', info.state === 'none');
    killBtn.title = `Kill this session${name ? ` — ${name}` : ''}`;
  }
  // Title bar (hub) under the tabs: names the session this view is showing.
  const titleBar = document.getElementById('title-bar');
  if (titleBar) {
    const show = !!activeFile;
    titleBar.classList.toggle('hidden', !show);
    if (show) {
      const tbTitle = document.getElementById('tb-title');
      const tbState = document.getElementById('tb-state');
      if (tbTitle) { tbTitle.textContent = name; tbTitle.title = activeFile || name; }
      if (tbState) tbState.textContent = info.state === 'none' ? '' : info.label;
    }
  }
  renderSessionBar(dir);
  // Keep the LIVE list's "viewing" marker in sync with the selection.
  renderLiveSection(liveInstances);
}
function liveByFileMap() {
  const m = new Map();
  for (const i of liveInstances) {
    if (i.sessionFile && !i.local && !m.has(i.sessionFile)) m.set(i.sessionFile, i);
  }
  return m;
}
// Mark all live sessions in the sidebar with a running tag + green dot + inline
// Drive. Clicking an item still only views history; Drive is what takes over the
// running TUI.
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
    const row = el.querySelector(':scope > .session-title-row');
    // A running tag tells a live row apart from a resumable historical one.
    let tag = row ? row.querySelector(':scope > .running-tag') : null;
    if (inst && !inst.local && row) {
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'session-tag running-tag';
        tag.textContent = 'running';
        tag.title = 'A Pi TUI is running this session — viewing it is read-only';
        row.appendChild(tag);
      }
    } else if (tag) {
      tag.remove();
    }
    // ADR-010: cross-session drive is hub-only; a mirror never shows it.
    const canAttach = !serverMode || serverMode === 'hub';
    if (inst && !inst.local && canAttach) {
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
        if (row) row.appendChild(btn);
      }
      btn.dataset.port = String(inst.port);
      btn.dataset.pid = String(inst.pid);
      btn.dataset.file = inst.sessionFile || '';
      btn.dataset.started = inst.startedAt || '';
      const label = attached ? 'Detach' : previewing ? 'Cancel' : 'Drive';
      if (btn.textContent !== label) btn.textContent = label;
      btn.classList.toggle('attached', attached);
      btn.title = attached
        ? `Stop driving the running TUI on :${inst.port}`
        : previewing
          ? 'Cancel the preview'
          : `Take over the running TUI on :${inst.port} and send prompts to it`;
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
  // The envelope id lets the server inject it into the forwarded command so
  // the backend's response resolves back to this browser request.
  if (uplinkActive) {
    wsClient.send({ type: 'uplink_command', id: cmd.id, command: cmd });
    return;
  }
  if (isMirrorMode && viewingActiveSession) {
    wsClient.send(cmd);
    return;
  }
  if (headlessSessionKey) {
    wsClient.send({ type: 'rpc_command', id: cmd.id, command: cmd });
    return;
  }
  wsClient.send(cmd);
}
function bindHeadless(cwd, sessionFile, sessionKey = null, opts = {}) {
  headlessSessionKey = null; // cleared until the ack re-arms it
  // Reload-proof rejoin: name the exact backend from the last ack. A caller
  // key wins; otherwise keep the stored key when the file is unchanged, so a
  // plain history reselect doesn't lose the id. A stale key only misses —
  // the server falls back to the cwd+file scan, never to a wrong backend.
  const prev = headlessBinding;
  const file = sessionFile || null;
  const key = sessionKey ?? (prev && (prev.sessionFile || null) === file ? prev.sessionKey || null : null);
  headlessBinding = (cwd || file) ? { cwd: cwd || null, sessionFile: file, sessionKey: key || null } : null;
  persistBinding();
  const payload = { type: 'start_session' };
  if (cwd) payload.cwd = cwd;
  if (file) payload.sessionFile = file;
  if (key) payload.sessionKey = key;
  sendRpc(payload).then((data) => {
    if (data && !data.timeout) {
      headlessSessionKey = data?.data?.sessionKey || 'bound';
      // Learn the backend id — but only if the tab hasn't moved on to
      // another file while the ack was in flight.
      if (data?.data?.sessionKey && headlessBinding && (headlessBinding.sessionFile || null) === file) {
        headlessBinding.sessionKey = data.data.sessionKey;
        persistBinding();
      }
      // Rejoined a backend that's still running (e.g. returned to a
      // session whose agent kept working): live WS events for it were
      // dropped by the epoch bump, so watch its history until it lands.
      if (data?.data?.isAgentRunning && file && opts?.dirName && headlessBinding && (headlessBinding.sessionFile || null) === file) {
        startBackgroundWatch(opts.dirName, cwd, file);
      }
    }
  });
}

// Background-run watch: after binding to a session whose agent is still
// working, the static history ends mid-turn and live events stay dropped.
// Poll cheap backend status + re-render history on change until the run
// lands, so a returned-to session visibly progresses instead of looking
// dead. Stops on session switch, on a new live run, or when the backend
// goes idle/gone. Never sends anything to the backend — read-only.
function histSignature(entries) {
  if (!entries || !entries.length) return '0';
  const last = entries[entries.length - 1];
  return `${entries.length}|${last.id || ''}`;
}
async function startBackgroundWatch(dirName, cwd, file) {
  const token = ++bgWatchToken;
  bgAgentRunning = true; // the ack says the backend is working: abort stays available
  showTypingIndicator(true);
  updateUI();
  const histUrl = `/api/sessions/${dirName}/${file}`;
  const statusUrl = `/api/headless/status?cwd=${encodeURIComponent(cwd || '')}&file=${encodeURIComponent(file)}`;
  let lastSig = null;
  try {
    const h0 = await fetch(histUrl).then((r) => (r.ok ? r.json() : null));
    if (token !== bgWatchToken) return;
    lastSig = histSignature(h0?.entries);
  } catch {}
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    if (token !== bgWatchToken) return;
    let st = null;
    try {
      const r = await fetch(statusUrl);
      if (r.ok) st = await r.json();
    } catch {}
    // Backend picked up work after binding (or the ack raced it): surface
    // the abort button even without a local stream.
    if (st?.isWorking && !bgAgentRunning) { bgAgentRunning = true; showTypingIndicator(true); updateUI(); }
    if (!st || !st.isWorking) {
      // Landed (or backend gone): one final refresh, hand the view back.
      try {
        const h = await fetch(histUrl).then((r) => (r.ok ? r.json() : null));
        if (token === bgWatchToken && h?.entries) refreshWatchedHistory(h.entries);
      } catch {}
      if (token === bgWatchToken) {
        bgAgentRunning = false; // landed (or backend gone): abort hides
        showTypingIndicator(false);
        updateUI();
      }
      return;
    }
    try {
      const h = await fetch(histUrl).then((r) => (r.ok ? r.json() : null));
      if (token !== bgWatchToken) return;
      const sig = histSignature(h?.entries);
      if (h?.entries && sig !== lastSig) {
        lastSig = sig;
        refreshWatchedHistory(h.entries);
      }
    } catch {}
  }
}
function refreshWatchedHistory(entries) {
  const sc = messagesContainer;
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 150;
  renderSessionHistory(entries);
  if (atBottom) sc.scrollTop = sc.scrollHeight;
}
async function refreshUplinkList() {
  try {
    const data = await sendRpc({ type: 'uplink_list' });
    if (data && !data.timeout) renderLiveSection(data?.data?.instances || []);
  } catch {}
}
// ─── Preview-then-drive (tau-web) ───
// Driving is two-phase: picking a live session loads its history read-only
// with a confirm banner; only "Drive this TUI" wires the uplink.

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

// ─── Session-key URL routing ───
// The hash carries only the session file's basename — never a filesystem path
// (URLs get shared; the basename leaks nothing beyond timestamp + uuid).
function sessionKeyOf(filePath) {
  if (!filePath) return '';
  return String(filePath).split('/').filter(Boolean).pop() || '';
}
function parseSessionHash() {
  const raw = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const key = params.get('session');
  if (!key) return null;
  return { key, drive: params.get('drive') === '1' };
}
// replaceState only: no history spam, and it does not fire hashchange.
function updateSessionHash(filePathOrKey, drive) {
  if (suppressHashWrite) return;
  const key = sessionKeyOf(filePathOrKey);
  const next = key ? `#session=${encodeURIComponent(key)}${drive ? '&drive=1' : ''}` : '';
  if (next ? location.hash === next : !location.hash) return;
  history.replaceState(null, '', next || `${location.pathname}${location.search}`);
}
// Resolve the session pinned in the URL once the socket is up: a live TUI gets
// previewed (and driven if asked), otherwise the headless backend resumes it.
async function restoreSessionFromUrl() {
  const wanted = parseSessionHash();
  if (!wanted?.key) return;
  // Instant chrome: paint the incoming session's title/card/loading from
  // the cached index BEFORE any await, so a tab tap feels immediate while
  // the socket/index/instances + history loads still resolve.
  const early = findSidebarSession(wanted.key);
  if (early) {
    // Reconnect guard (B5): don't wipe a transcript already showing the
    // wanted session — the live branch below reloads it via switchSession.
    const alreadyShowing = sessionKeyOf(sidebar.activeSessionFile) === wanted.key
      && (messagesContainer?.childElementCount || 0) > 0;
    sidebar.setActive(early.session.filePath);
    renderCurrentSessionCard();
    if (!alreadyShowing) {
      messageRenderer.clear();
      messageRenderer.renderSystemMessage('Loading session...');
    }
  }
  // A switch landing mid-restore is served by the finally re-run below,
  // which picks up the latest hash — taps can never strand the view.
  if (restoreInFlight) return;
  const myKey = wanted.key;
  restoreInFlight = true;
  urlRestorePending = true;
  isMirrorMode = true; // a pinned view never repoints the server's own session
  try {
    await waitForWsOpen();
    await ensureSessionsLoaded();
    await pollInstances();
    const live = liveInstances.find((i) => !i.local && sessionKeyOf(i.sessionFile) === wanted.key);
    uplinkLastDetached = null;
    uplinkAttachError = null;
    if (live) {
      await previewAttach(live.port, live.pid, live.sessionFile, live.startedAt, { fromRestore: true });
      if (wanted.drive) attachUplink(live.port, live.pid, live.sessionFile);
      return;
    }
    const found = findSidebarSession(wanted.key);
    if (found) {
      sidebar.setActive(found.session.filePath);
      await switchSession(found.session.filePath, found.session, found.project);
      return;
    }
    // The pinned session is gone (deleted/rotated): say so and drop the pin so
    // a reload doesn't loop on a ghost.
    updateSessionHash(null);
    sidebar.clearActive();
    messageRenderer.clear();
    messageRenderer.renderError(`Session ${wanted.key} was not found — it may have been deleted.`);
  } finally {
    urlRestorePending = false;
    restoreInFlight = false;
    // The hash moved on while we worked: serve it now (converges once
    // taps stop; the ghost path clears the hash so this can't loop).
    const now = parseSessionHash()?.key;
    if (now && now !== myKey) restoreSessionFromUrl();
  }
}
function waitForWsOpen(timeoutMs = 5000) {
  const ws = wsClient.ws;
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wsClient.removeEventListener('connected', onConnected);
      resolve(ok);
    };
    const onConnected = () => finish(true);
    wsClient.addEventListener('connected', onConnected);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
async function ensureSessionsLoaded() {
  if (sidebar.projects?.length) return;
  try { await sidebar.loadSessions(); } catch {}
}

// One banner, five states: error / driving / pending / preview / detached.
function renderSessionBanner() {
  const el = document.getElementById('session-banner');
  if (!el) return;
  // The sidebar card answers "which session am I on" — keep it in step with
  // every banner-state change (attach, detach, drop, error).
  renderCurrentSessionCard();
  const mainEl = document.querySelector('.main');
  const esc = (s) => escapeHtml(String(s ?? ''));
  const nameOf = (file) => liveSessionName(file) || (file ? file.split('/').pop().replace(/\.jsonl$/, '') : '');
  let cls = '';
  let html = '';
  if (uplinkAttachError) {
    const target = uplinkPreview || uplinkLastDetached;
    const errName = nameOf(target?.sessionFile) || nameOf(uplinkTargetSessionFile);
    cls = 'error';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Couldn't drive TUI${errName ? ` — ${esc(errName)}` : ''}</strong><span class="sb-hint">${esc(uplinkAttachError)}</span></span>
      ${target ? `<button class="sb-btn" data-action="retry" data-port="${target.port}" data-pid="${target.pid}">Retry</button>` : ''}
      ${(target?.sessionFile || uplinkTargetSessionFile) ? `<button class="sb-btn" data-action="headless">Continue headless</button>` : ''}
      <button class="sb-btn svg-btn" data-action="dismiss" aria-label="Dismiss">${icon('x', 12)}</button>`;
  } else if (uplinkActive) {
    const driveName = nameOf(uplinkTargetSessionFile);
    cls = 'driving';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Driving${driveName ? ` “${esc(driveName)}”` : ' live TUI'} · :${uplinkActive.port}</strong><span class="sb-hint">The TUI is still running — prompts from both places may race</span></span>
      <button class="sb-btn" data-action="detach">Detach</button>`;
  } else if (uplinkAttachPending) {
    const target = uplinkPreview || uplinkLastDetached;
    const pendName = nameOf(target?.sessionFile) || nameOf(uplinkTargetSessionFile);
    cls = 'preview';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Taking over${pendName ? ` “${esc(pendName)}”` : ''}${target?.port ? ` · :${target.port}` : ''}…</strong></span>`;
  } else if (uplinkPreview) {
    const last = uplinkPreview.lastActive ? ` · last active ${timeAgo(uplinkPreview.lastActive)}` : '';
    const prevName = nameOf(uplinkPreview.sessionFile) || nameOf(uplinkTargetSessionFile);
    cls = 'preview';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Previewing${prevName ? ` “${esc(prevName)}”` : ' live TUI'} · :${uplinkPreview.port}</strong><span class="sb-hint">Read-only — Drive to take over${esc(last)}</span></span>
      <button class="sb-btn primary" data-action="attach">Drive this TUI</button>
      <button class="sb-btn" data-action="cancel">Cancel</button>`;
  } else if (uplinkLastDetached) {
    const detName = nameOf(uplinkLastDetached.sessionFile) || nameOf(uplinkTargetSessionFile);
    cls = 'detached';
    html = `<span class="sb-dot"></span>
      <span class="sb-text"><strong>Detached${detName ? ` from “${esc(detName)}”` : ''} · :${uplinkLastDetached.port}</strong><span class="sb-hint">View is frozen; the TUI keeps running</span></span>
      <button class="sb-btn primary" data-action="retry" data-port="${uplinkLastDetached.port}" data-pid="${uplinkLastDetached.pid}">Drive again</button>
      <button class="sb-btn svg-btn" data-action="dismiss" aria-label="Dismiss">${icon('x', 12)}</button>`;
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

// Back to this server's own live session — the one-click return after a
// detach (or after wandering into history). Clears any frozen-detached or
// preview state, then opens the server-owned session file read-write.
async function backToLive(sessionFile) {
  // Leaving a driven TUI for the server session ends the drive: prompts
  // must not keep flowing to a TUI the view no longer shows.
  if (uplinkActive) {
    wsClient.send({ type: 'uplink_detach' });
    uplinkActive = null;
  }
  uplinkPreview = null;
  uplinkLastDetached = null;
  uplinkAttachError = null;
  uplinkAttachPending = false;
  viewingActiveSession = true;
  renderSessionBanner();
  const target = sessionFile || serverOwnSessionFile || mirrorActiveSessionFile;
  const found = target ? findSidebarSession(target) : null;
  if (found) {
    sidebar.setActive(target);
    updateSessionHash(target, false);
    await switchSession(target, found.session, found.project);
  } else if (target) {
    // The server's session is listed nowhere (quiet sessions are filtered
    // from the sidebar): drive the live view anyway. The sync carries the
    // transcript; the instance record carries the directory.
    sidebar.clearActive();
    updateSessionHash(target, false);
    messageRenderer.clear();
    messageRenderer.renderSystemMessage('Loading live session...');
    refreshFileBrowser(target);
  } else {
    updateSessionHash(null);
    sidebar.clearActive();
    messageRenderer.renderWelcome();
  }
  updateMirrorInputState();
  syncUplinkControls();
  closeSidebarOnMobile(); // return to the home server in full view
}

async function previewAttach(port, pid, sessionFile, lastActive, opts = {}) {
  // ADR-010: cross-session drive is hub-only. A mirror must never preview or
  // drive another TUI, even if stale instance data slipped through.
  if (serverMode && serverMode !== 'hub') {
    messageRenderer.renderSystemMessage('Driving another TUI is only available through the hub.');
    return;
  }
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
  // URL pin (per-tab sessions) — skipped on restore so a drive=1 pin is not
  // downgraded before uplinkAttached confirms the attach.
  if (!opts.fromRestore) updateSessionHash(sessionFile, false);
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
  if (session && project && sessionKeyOf(sidebar.activeSessionFile) !== sessionKeyOf(sessionFile)) {
    sidebar.setActive(sessionFile);
    await switchSession(sessionFile, session, project, { preview: true });
  } else if (session && project) {
    // Already viewing the wanted live session (e.g. WS reconnect while it
    // is pinned): reload history so the view doesn't stick on the early
    // "Loading session..." placeholder. preview:true keeps read-only
    // semantics (no headless bind to a TUI-owned file); switchSession
    // already roots the file browser.
    await switchSession(sidebar.activeSessionFile || sessionFile, session, project, { preview: true });
  } else if (!session || !project) {
    messageRenderer.renderSystemMessage('History unavailable for this session — you can still drive it.');
  }
  renderSessionBanner();
  closeSidebarOnMobile(); // let the preview banner show, not the sidebar
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
    updateSessionHash(returnTo.filePath, false);
    switchSession(returnTo.filePath, found.session, found.project);
  } else if (isMirrorMode && mirrorActiveSessionFile) {
    const mf = findSidebarSession(mirrorActiveSessionFile);
    if (mf) { sidebar.setActive(mirrorActiveSessionFile); switchSession(mirrorActiveSessionFile, mf.session, mf.project); }
    else messageRenderer.renderWelcome();
  } else {
    // Fresh load with nothing to return to: cancel means a clean slate — drop
    // the URL pin too, or the server's own snapshot stays suppressed forever.
    updateSessionHash(null);
    sidebar.clearActive();
    messageRenderer.renderWelcome();
  }
  updateMirrorInputState();
  closeSidebarOnMobile(); // back to the pre-preview view in full
}

async function attachUplink(port, pid, sessionFile) {
  if (!Number.isInteger(port) || !Number.isInteger(pid)) return;
  uplinkTargetSessionFile = sessionFile || uplinkPreview?.sessionFile || uplinkLastDetached?.sessionFile || uplinkTargetSessionFile;
  updateSessionHash(uplinkTargetSessionFile, true);
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
  updateSessionHash(uplinkTargetSessionFile, false);
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
  else if (action === 'live') backToLive();
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
  // The hub never shows its own process: it connects browsers to OTHER pi
  // sessions, never to itself. (Mirror-direct mode keeps its own row — that
  // row is the page's own TUI view, not a drive target.)
  const others = (instances || []).filter((i) => i.pid !== undefined && (serverMode === 'mirror' || !i.local));
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
  const activeKey = sessionKeyOf(sidebar.activeSessionFile || mirrorActiveSessionFile);
  const sig = others.map((i) => `${i.port}:${i.pid}:${(uplinkActive && uplinkActive.port === i.port) ? 1 : 0}:${(uplinkPreview && uplinkPreview.port === i.port) ? 1 : 0}:${i.sessionFile || ''}:${liveInstanceLabel(i)}:${(activeKey && sessionKeyOf(i.sessionFile) === activeKey) ? 1 : 0}`).join('|');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.style.display = '';
  const rows = others.map((i) => {
    const attached = uplinkActive && uplinkActive.port === i.port;
    const previewing = uplinkPreview && uplinkPreview.port === i.port;
    const viewing = !!activeKey && !!i.sessionFile && sessionKeyOf(i.sessionFile) === activeKey;
    const label = liveInstanceLabel(i);
    const sub = `${viewing ? 'viewing · ' : ''}${i.cwd ? `${escapeHtml(i.cwd.split('/').filter(Boolean).pop() || '')} · :${i.port}` : `:${i.port}`}`;
    const action = i.local
      ? (viewing
        ? `<span class="live-tag" title="The web server's own Pi process — the browser already talks to it directly; Drive is only for separate running TUIs">this server</span>`
        : `<button class="live-btn" data-action="live" data-file="${escapeHtml(i.sessionFile || '')}" title="Back to this server's live session">Live</button>`)
      : (serverMode && serverMode !== 'hub')
        // A mirror has no switchboard: never offer to dial a sibling TUI.
        ? ''
        : attached
        ? `<button class="live-btn" data-action="detach" data-port="${i.port}">Detach</button>`
        : previewing
          ? `<button class="live-btn" data-action="cancelpreview">Cancel</button>`
          : `<button class="live-btn" data-action="attach" data-port="${i.port}" data-pid="${i.pid}" data-file="${escapeHtml(i.sessionFile || '')}" data-started="${escapeHtml(i.startedAt || '')}">Drive</button>`;
    return `<div class="live-row${attached ? ' attached' : ''}${viewing ? ' viewing' : ''}">
      <span class="live-dot"></span>
      <span class="live-text">
        <span class="live-label" title="${escapeHtml(i.sessionFile || '')}">${escapeHtml(label)}</span>
        <span class="live-sub">${sub}</span>
      </span>
      ${action}
    </div>`;
  }).join('');
  host.innerHTML = `<div class="live-header">RUNNING TUIs</div><div class="live-hint">Drive takes over a running TUI. Past sessions open directly.</div>${rows}`;
  host.querySelectorAll('.live-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'attach') {
        // Two-phase: preview the session first, confirm to drive.
        previewAttach(Number(btn.dataset.port), Number(btn.dataset.pid), btn.dataset.file || null, btn.dataset.started || null);
      } else if (btn.dataset.action === 'cancelpreview') {
        cancelPreview();
      } else if (btn.dataset.action === 'live') {
        backToLive(btn.dataset.file || null);
      } else {
        detachUplink();
      }
    });
  });
}
// Attached-session state: model, thinking level and context window belong to
// the TUI being driven, not to the web server. mirror_sync covers the attach
// moment; this 60s poll keeps the header honest on long-lived attaches.
function applyAttachedState(d) {
  if (!d) return;
  if (d.model?.id) {
    currentModelId = d.model.id;
    updateModelLabel();
    if (d.model.contextWindow) setContextWindow(d.model.contextWindow);
  }
  if (d.thinkingLevel) {
    currentThinkingLevel = d.thinkingLevel;
    updateThinkingBtn();
  }
}
async function pollAttachedState() {
  if (!uplinkActive) return;
  try {
    const data = await sendRpc({ type: 'uplink_command', command: { type: 'get_state' } });
    if (data && !data.timeout && data.success && data.data) applyAttachedState(data.data);
  } catch {}
}
setInterval(pollAttachedState, 60000);

// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch('/api/instances');
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      updateMirrorLiveIndicator();
      renderLiveSection(liveInstances);
      renderCurrentSessionCard();
    }
  } catch {}
  return liveInstances;
}

// Safety-net poll only: the hub pushes `mirrorsChanged` on join/leave/update
// and the handler below already refreshes immediately, so a fast poll is
// redundant. (Was every 5s.)
setInterval(pollInstances, 30000);
pollInstances();

// Hub pushes this when a TUI mirror connects/disconnects — refresh the LIVE
// list immediately instead of waiting for the next 5s poll.
wsClient.addEventListener('mirrorsChanged', () => { pollInstances(); });

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  // Cheap + signature-guarded: the sidebar card must reflect preview/detach
  // transitions, which all funnel through here.
  renderCurrentSessionCard();
  const inputArea = document.querySelector('.input-area');
  // Preview: read-only until the user takes over. Detached: the frozen view of
  // a live session is read-only too (the TUI keeps running without us).
  const frozenDetached = uplinkLastDetached && !uplinkActive
    && sidebar.activeSessionFile === uplinkLastDetached.sessionFile;
  if (uplinkPreview) {
    messageInput.disabled = true;
    messageInput.placeholder = 'Previewing live session — Drive to take over';
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
  // A history session is read-only only while a live TUI owns it — driving
  // (or detaching) takes over that session. Anything else can be continued headless.
  const activeFile = sidebar.activeSessionFile;
  const ownedByTui = activeFile && liveInstances.some((i) => !i.local && i.sessionFile === activeFile);
  if (ownedByTui) {
    messageInput.disabled = true;
    messageInput.placeholder = 'Owned by a running TUI — Drive to take over';
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

// Loaded session entries + render-window state. The full history stays in
// memory (it came over the wire anyway); the DOM only holds the tail until
// the user asks for older messages.
let historyEntries = [];
let historyWindow = VISIBLE_MESSAGE_WINDOW;
let historyLoadMoreEl = null;
let historyToolResults = new Map();

// Precompute toolCallId -> result so a tool call and its result stay paired
// even when the window boundary falls between them (the card is created with
// its output already applied).
function computeToolResults(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (msg?.role === 'toolResult' && msg.toolCallId) {
      map.set(msg.toolCallId, { content: msg.content || [], isError: msg.isError });
    }
  }
  return map;
}

function renderHistoryEntries(slice) {
  let userCount = 0, assistantCount = 0, toolCardCount = 0;
  for (const entry of slice) {
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
            .filter((img) => isValidHistoryImage(img.data, img.mimeType))
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
        toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
          timestamp: entry.timestamp || null,
        });
        // Pair the result now: the result entry may sit outside this slice.
        const result = historyToolResults.get(tc.id);
        if (result) toolCardRenderer.addHistoryResult(tc.id, { content: result.content }, result.isError);
      }
    }
    // toolResult entries are paired via historyToolResults at card creation;
    // rendering them in the loop would create empty cards at window edges.
  }
  console.log(`[History] Rendered ${slice.length} entries (${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools)`);
}

// Boundary control at the top of the transcript: load older messages in
// VISIBLE_MESSAGE_WINDOW steps. Inserted as the first child so it stays put
// while older entries are prepended after it.
function renderLoadMoreControl() {
  if (historyLoadMoreEl) { historyLoadMoreEl.remove(); historyLoadMoreEl = null; }
  const total = historyEntries.length;
  if (total <= VISIBLE_MESSAGE_WINDOW) return;
  const shown = Math.min(historyWindow, total);
  const older = total - shown;
  const el = document.createElement('div');
  el.className = 'history-more system-message';
  if (older > 0) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-more-btn';
    btn.textContent = `↑ Load ${Math.min(older, VISIBLE_MESSAGE_WINDOW)} earlier messages`;
    btn.addEventListener('click', loadEarlierMessages);
    const info = document.createElement('span');
    info.className = 'history-more-info';
    info.textContent = `showing last ${shown} of ${total} entries`;
    el.appendChild(btn);
    el.appendChild(info);
  } else {
    el.classList.add('done');
    const info = document.createElement('span');
    info.className = 'history-more-info';
    info.textContent = `beginning of session · all ${total} entries shown`;
    el.appendChild(info);
  }
  messagesContainer.insertBefore(el, messagesContainer.firstChild);
  historyLoadMoreEl = el;
}

// Prepend the next older slice without rebuilding the DOM. Scroll anchoring is
// manual (CSS overflow-anchor is off on .messages): shift scrollTop by the
// height the prepend added so the previously visible content stays put.
function loadEarlierMessages() {
  const total = historyEntries.length;
  const shownBefore = Math.min(historyWindow, total);
  const nextWindow = Math.min(historyWindow + VISIBLE_MESSAGE_WINDOW, total);
  const older = historyEntries.slice(total - nextWindow, total - shownBefore);
  if (older.length === 0) return;
  const prevHeight = messagesContainer.scrollHeight;
  const prevTop = messagesContainer.scrollTop;
  // Render the slice off-screen at the end, then move just those nodes to the
  // top — the existing messages are never touched (no animation restarts).
  const marker = document.createComment('older-messages');
  messagesContainer.appendChild(marker);
  renderHistoryEntries(older);
  const frag = document.createDocumentFragment();
  let node = marker.nextSibling;
  while (node) { const next = node.nextSibling; frag.appendChild(node); node = next; }
  marker.remove();
  historyWindow = nextWindow;
  const anchor = historyLoadMoreEl ? historyLoadMoreEl.nextSibling : messagesContainer.firstChild;
  messagesContainer.insertBefore(frag, anchor);
  messagesContainer.scrollTop = prevTop + (messagesContainer.scrollHeight - prevHeight);
  renderLoadMoreControl();
}

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
  // Session-specific window: the history endpoint serves entries only, so
  // re-derive the window from the history's model via the catalog, then
  // repaint — otherwise the pill shows the previous session's percentage.
  const hm = histModel && availableModels.find((m) => m.id === histModel);
  if (hm?.contextWindow) setContextWindow(hm.contextWindow);
  else updateTokenUsage();

  // Window the render: full history stays in memory/on disk, the DOM only
  // holds the tail until "load earlier" grows the window.
  historyEntries = entries;
  historyWindow = VISIBLE_MESSAGE_WINDOW;
  historyToolResults = computeToolResults(entries);
  historyLoadMoreEl = null;
  const total = entries.length;
  const visible = total > VISIBLE_MESSAGE_WINDOW ? entries.slice(total - VISIBLE_MESSAGE_WINDOW) : entries;
  console.log(`[History] Rendering ${visible.length}/${total} entries`);
  renderHistoryEntries(visible);
  renderLoadMoreControl();

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

// Single funnel for context-window changes (model switch, per-session
// history, attached-state poll, dynamic cap): a new window forces a pill
// repaint instead of showing a stale percentage.
function setContextWindow(n) {
  if (!Number.isFinite(n) || n <= 0 || n === contextWindowSize) return;
  contextWindowSize = n;
  lastTokenRenderKey = null;
  updateTokenUsage();
  if (!contextViz.classList.contains('hidden')) updateContextViz();
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
    // Toggle with force: remove+add of the same class restarts its pulse
    // animation on every percentage tick (visible phone flicker).
    tokenUsageEl.classList.toggle('critical', pct >= 80);
    tokenUsageEl.classList.toggle('warning', pct >= 60 && pct < 80);
    if (contextSizeEl) {
      contextSizeEl.textContent = `${(effective / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k`;
      contextSizeEl.classList.add('visible');
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
let wsConnected = false;
let dotState = '';
let lastConnStatus = null;

// Dot color is derived once, here, and written only when the derived state
// actually changes. The one pulse animation lives on the base
// .status-indicator class, so swapping a color class never restarts it
// (only animation-name changes do) — a flapping phone connection can no
// longer strobe the dot or restart its pulse.
function renderStatusDot() {
  const next = !wsConnected
    ? 'disconnected'
    : isCompacting
      ? 'compacting'
      : (state.isStreaming || bgAgentRunning)
        ? 'streaming'
        : 'connected';
  if (next === dotState) return;
  dotState = next;
  statusIndicator.className = `status-indicator ${next}`;
}

function idleStatusText() {
  return wsConnected ? (tailscaleUrl ? 'Connected • TS' : 'Connected') : 'Disconnected';
}

function applyConnectionUi(status) {
  if (status === lastConnStatus) return;
  lastConnStatus = status;
  renderStatusDot();
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
  } else {
    statusText.textContent = 'Disconnected';
    statusText.title = '';
  }
}

// Plain poll of the socket's own state — the single source of truth for the
// dot color and connection text. Socket events only trigger a tick here, they
// never write the class themselves. The periodic tick also catches transitions
// the events miss and guarantees the color settles without socket traffic.
function pollConnectionStatus() {
  const ws = wsClient.ws;
  if (!ws || ws.readyState === WebSocket.CONNECTING) return; // keep gray "Connecting..."
  const up = ws.readyState === WebSocket.OPEN;
  wsConnected = up;
  applyConnectionUi(up ? 'connected' : 'disconnected');
}
setInterval(pollConnectionStatus, 3000);

function updateUI() {
  // A reloaded page has no live stream, but the backend may still be
  // working (bgAgentRunning from the background watch): abort + Working
  // state follow either signal.
  const isStreaming = state.isStreaming || bgAgentRunning;
  const uiKey = `${state.isStreaming}:${bgAgentRunning}:${newSessionStage}`;
  // No-op when nothing changed: rewriting classes/text restarts CSS pulses.
  if (uiKey === lastUiStreaming) return;
  lastUiStreaming = uiKey;

  // Dot color follows the derived state. Its pulse lives on the base class,
  // so this swap never restarts the animation.
  renderStatusDot();
  // While compacting, the pill belongs to the compaction state.
  if (!isCompacting) {
    statusText.textContent = newSessionStage || (isStreaming ? 'Working...' : idleStatusText());
  }

  sendBtn.disabled = false;
  // Preview / detached-frozen views are read-only, and updateUI runs on
  // every stream transition — re-derive the input state instead of forcing
  // it enabled (which briefly unlocked the input over read-only views).
  updateMirrorInputState();

  // Keep Send visible while streaming: a message sent mid-run is queued and
  // forwarded as a steer (runs right after the current turn).
  abortBtn.classList.toggle('hidden', !isStreaming);
  sendBtn.classList.remove('hidden');
  if (!isStreaming) flushQueue();
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const themeGrid = document.getElementById('theme-grid');


const toggleShowThinking = document.getElementById('toggle-show-thinking');

// Settings tabs: one pane visible at a time so the panel stays short.
const settingsTabs = document.querySelectorAll('#settings-tabs .settings-tab');
function selectSettingsTab(name) {
  settingsTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('#settings-panel .settings-section').forEach((sec) => {
    sec.classList.toggle('hidden', sec.dataset.pane !== name);
  });
  try { localStorage.setItem('tau-settings-tab', name); } catch {}
}
settingsTabs.forEach((t) => t.addEventListener('click', () => selectSettingsTab(t.dataset.tab)));


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
  // Voice tab: hidden where the browser has no speechSynthesis.
  const voiceTab = document.querySelector('#settings-tabs .settings-tab[data-tab="voice"]');
  const voiceSection = document.getElementById('settings-voice-section');
  if (!speech.supported) {
    if (voiceTab) voiceTab.style.display = 'none';
    if (voiceSection) voiceSection.style.display = 'none';
  } else {
    if (voiceTab) voiceTab.style.display = '';
    if (voiceSection) voiceSection.style.display = '';
  }
  let lastTab = null;
  try { lastTab = localStorage.getItem('tau-settings-tab'); } catch {}
  selectSettingsTab(!speech.supported && lastTab === 'voice' ? 'appearance' : (lastTab === 'voice' || lastTab === 'server' ? lastTab : 'appearance'));
  populateVoiceSelect();
  syncVoiceControls();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');
  // Server pane: version + uptime from /api/health (auth-exempt).
  try {
    const h = await tauRawFetch('/api/health').then((r) => r.json()).catch(() => null);
    if (h) {
      document.getElementById('server-version').textContent = h.version || '—';
      document.getElementById('server-uptime').textContent = h.startedAt ? formatUptime(Date.now() - new Date(h.startedAt).getTime()) : '—';
    }
  } catch {}
  // Live pi processes (ADR-013): refresh every time the panel opens so a
  // kill from another tab never shows a stale row. Refresh button bound once.
  const procRefresh = document.getElementById('btn-proc-refresh');
  if (procRefresh && !procRefresh.dataset.bound) {
    procRefresh.dataset.bound = '1';
    procRefresh.addEventListener('click', () => loadProcesses());
  }
  loadProcesses();
function procDisplayName(p) {
  const hint = typeof p.sessionHint === 'string' && p.sessionHint ? p.sessionHint.split('/').pop() : '';
  if (hint) return hint;
  if (typeof p.cwd === 'string' && p.cwd) {
    const base = p.cwd.replace(/\/$/, '').split('/').pop();
    if (base) return base;
  }
  const args = Array.isArray(p.argv) ? p.argv.slice(1, 4).join(' ') : '';
  return args ? `pi ${args}` : 'pi';
}

function procMetaLine(p) {
  const parts = [`pid ${p.pid}`];
  if (typeof p.rssKb === 'number') parts.push(p.rssKb >= 1024 ? `${(p.rssKb / 1024).toFixed(0)}M` : `${p.rssKb}K`);
  if (typeof p.ageSec === 'number') parts.push(formatUptime(p.ageSec * 1000));
  return parts.join(' · ');
}

// Live pi processes (ADR-013): read-only list + on-demand kill. Rows are
// OS processes, not sessions — killing frees resources, files stay on disk.
async function loadProcesses() {
  const list = document.getElementById('proc-list');
  const count = document.getElementById('proc-count');
  const errBox = document.getElementById('proc-error');
  if (!list) return;
  if (errBox) { errBox.textContent = ''; errBox.classList.add('hidden'); }
  list.innerHTML = '<div class="proc-empty">Scanning…</div>';
  let data = null;
  try {
    const r = await tauRawFetch('/api/processes');
    data = await r.json();
  } catch { data = null; }
  list.textContent = '';
  const rows = data && Array.isArray(data.processes) ? data.processes : null;
  if (!rows) {
    list.innerHTML = '<div class="proc-empty">Process list unavailable.</div>';
    if (count) count.textContent = '—';
    return;
  }
  if (data.unsupported) {
    list.innerHTML = '<div class="proc-empty">Process listing is unsupported on this platform.</div>';
    if (count) count.textContent = '—';
    return;
  }
  if (count) count.textContent = rows.length === 1 ? '1 live process' : `${rows.length} live processes`;
  if (rows.length === 0) {
    list.innerHTML = '<div class="proc-empty">No live pi processes — nothing to kill.</div>';
    return;
  }
  for (const p of rows) {
    const row = document.createElement('div');
    row.className = 'proc-row';
    row.dataset.pid = String(p.pid);
    const name = procDisplayName(p);
    const owner = p.owner === 'hub' ? 'hub backend' : 'terminal';
    row.innerHTML = '' +
      '<div class="proc-main">' +
        `<div class="proc-name"></div>` +
        `<div class="proc-meta"></div>` +
      '</div>' +
      `<span class="proc-tag proc-tag-${p.owner === 'hub' ? 'hub' : 'live'}">${owner}</span>` +
      '<button class="proc-kill">Kill</button>';
    row.querySelector('.proc-name').textContent = name;
    row.querySelector('.proc-meta').textContent = procMetaLine(p);
    row.querySelector('.proc-kill').addEventListener('click', () => killProcess(p.pid, name));
    list.appendChild(row);
  }
}

async function killProcess(pid, label) {
  const errBox = document.getElementById('proc-error');
  const showErr = (m) => { if (errBox) { errBox.textContent = m; errBox.classList.remove('hidden'); } };
  if (!window.confirm(`Kill pi process ${pid} (${label})?\n\nFrees its resources. Session files stay on disk.`)) return;
  try {
    const r = await tauRawFetch('/api/processes/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error) || `kill failed (${r.status})`);
    await loadProcesses();
  } catch (e) {
    showErr((e && e.message) || 'kill failed');
  }
}
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
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// ─── Voice settings (text-to-speech) ───
const toggleAutoRead = document.getElementById('toggle-auto-read');
const ttsVoiceSelect = document.getElementById('tts-voice-select');
const ttsRate = document.getElementById('tts-rate');
const ttsRateValue = document.getElementById('tts-rate-value');
const btnTtsTest = document.getElementById('btn-tts-test');

function populateVoiceSelect() {
  if (!ttsVoiceSelect) return;
  const current = speech.settings.voiceURI;
  ttsVoiceSelect.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Automatic (best available)';
  ttsVoiceSelect.appendChild(auto);
  for (const v of speech.getVoices()) {
    const opt = document.createElement('option');
    opt.value = v.voiceURI || v.name;
    opt.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' · network'}`;
    ttsVoiceSelect.appendChild(opt);
  }
  ttsVoiceSelect.value = current;
  if (ttsVoiceSelect.value !== current) ttsVoiceSelect.value = '';
}

function syncVoiceControls() {
  if (toggleAutoRead) toggleAutoRead.className = `settings-toggle${speech.settings.autoRead ? ' on' : ''}`;
  if (ttsRate) ttsRate.value = String(speech.settings.rate);
  if (ttsRateValue) ttsRateValue.textContent = `${Number(speech.settings.rate).toFixed(2)}×`;
  if (ttsVoiceSelect) ttsVoiceSelect.value = speech.settings.voiceURI || '';
}

if (toggleAutoRead) {
  toggleAutoRead.addEventListener('click', () => {
    const on = !speech.settings.autoRead;
    speech.setSettings({ autoRead: on });
    if (!on) speech.stop();
  });
}
if (ttsVoiceSelect) {
  ttsVoiceSelect.addEventListener('change', () => {
    speech.setSettings({ voiceURI: ttsVoiceSelect.value });
    speech.speak('This is the selected voice.');
  });
}
if (ttsRate) {
  ttsRate.addEventListener('input', () => {
    speech.setSettings({ rate: Number(ttsRate.value) });
  });
}
if (btnTtsTest) {
  btnTtsTest.addEventListener('click', () => {
    speech.speak('Tau is ready. This is how I will read replies aloud.');
  });
}

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

// Log out this browser: clear the cookie session, then prompt.
document.getElementById('btn-logout')?.addEventListener('click', async () => {
  try { await tauRawFetch('/api/logout', { method: 'POST' }); } catch {}
  try { wsClient.disconnect(); } catch {}
  closeSettings();
  tauShowLogin('You have been logged out.');
});
// Press-and-hold to reveal the password (typo check), auto-hides on release.
// Keyboard users get Enter/Space toggling; blur always re-hides.
(() => {
  const input = document.getElementById('login-pass');
  const btn = document.getElementById('login-reveal');
  if (!input || !btn) return;
  const eye = btn.querySelector('.login-reveal-eye');
  const eyeOff = btn.querySelector('.login-reveal-eye-off');
  const setRevealed = (on) => {
    input.type = on ? 'text' : 'password';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
    eye?.classList.toggle('hidden', on);
    eyeOff?.classList.toggle('hidden', !on);
  };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setRevealed(true);
    // Release anywhere (mouse or touch) hides it — no need to stay on the icon.
    const done = () => {
      setRevealed(false);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
    };
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  });
  btn.addEventListener('blur', () => setRevealed(false));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setRevealed(btn.getAttribute('aria-pressed') !== 'true');
    }
  });
  document.getElementById('login-form')?.addEventListener('reset', () => setRevealed(false));
  // Starting a fresh login always hides it again.
  window.tauResetPasswordReveal = () => setRevealed(false);
})();
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
    const res = await tauRawFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    if (res.ok) {
      document.getElementById('login-pass').value = '';
      try { window.tauResetPasswordReveal?.(); } catch {}
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

  let baseText = '';
  let finalTranscript = '';
  let interimTranscript = '';

  // Chain-safe append: strips any prefix of b already present as a tail of
  // a (some Chrome builds emit cumulative segments per index AND repeat
  // confirmed words at the head of the next interim). Never cuts mid-word.
  function appendSpeech(a, b) {
    const A = String(a ?? '');
    const B = String(b ?? '');
    if (!A) return B.replace(/^\s+/, '');
    if (!B) return A;
    const max = Math.min(A.length, B.length);
    let k = 0;
    for (let n = max; n > 0; n--) {
      if (A.slice(-n) === B.slice(0, n)) { k = n; break; }
    }
    while (k > 0 && k < B.length && /\S/.test(B[k - 1]) && /\S/.test(B[k])) k--;
    const tail = B.slice(k).replace(/^\s+/, '');
    if (!tail) return A.replace(/\s+$/, '');
    return /\s$/.test(A) ? A + tail : A + ' ' + tail;
  }

  function joinSpeech(base, chunk) {
    return appendSpeech(base, chunk);
  }

  // Mobile Chrome often re-emits confirmed words at the head of the next
  // interim (final="this", interim="this is") and may emit cumulative
  // segments per index. Naive final+interim then renders "thisthis is".
  // Every boundary goes through appendSpeech so repeats collapse.

  // Property assignment (not addEventListener): re-evaluating this script
  // must not stack a second handler and double-write every word.
  console.log('[Voice] stt chain-fix v4');
  recognition.onresult = (e) => {
    // e.results is cumulative: it re-emits previously-finalised results on
    // every event. Rebuild from index 0 each time — incrementally appending
    // from e.resultIndex double-counts finals and duplicates words.
    let final = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final = appendSpeech(final, t);
      else interim = appendSpeech(interim, t);
    }
    finalTranscript = final;
    interimTranscript = interim;
    // Show live transcription in the input
    messageInput.value = appendSpeech(appendSpeech(baseText, final), interim);
    messageInput.dispatchEvent(new Event('input'));
  };

  recognition.onend = () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  };

  recognition.onerror = (e) => {
    console.error('[Voice] Error:', e.error);
    stopRecording();
  };

  if (!micBtn.dataset.voiceWired) {
    micBtn.dataset.voiceWired = '1';
    micBtn.addEventListener('click', () => {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  function startRecording() {
    if (isRecording) return; // ignore double-tap: reset would orphan in-flight results
    baseText = messageInput.value; // Append to existing text
    finalTranscript = '';
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = 'Stop recording';
    try { recognition.start(); } catch {}
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    try { recognition.stop(); } catch {}
    // Commit whatever is on screen (final + last interim) — overwriting
    // with finalTranscript alone drops the trailing words and can
    // re-introduce a stale prefix as a duplicate.
    messageInput.value = appendSpeech(appendSpeech(baseText, finalTranscript), interimTranscript);
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
  launcherLink.title = 'Projects — click again to return to chat';
  launcherLink.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  launcherLink.addEventListener('click', () => {
    // Toggle: the link is now the only nav item, so it must also lead back.
    if (launcherEl.classList.contains('hidden')) showLauncher();
    else hideLauncher();
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
}

wsClient.connect();
messageRenderer.renderWelcome();
sidebar.loadSessions().then(() => {
  updateMirrorLiveIndicator();
  renderCurrentSessionCard();
});
initLauncher();

// Service workers and cookie auth don't mix: an installed worker can
// serve the cached app shell without hitting the network, so the app
// never learns the cookie session died — APIs just 401. When auth is on,
// remove any stuck worker and stay unregistered so the inline login
// overlay appears over a live shell instead.
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

console.log('Tau initialized');
