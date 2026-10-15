/**
 * Session actions — New / Kill wiring for persistent headless backends.
 * Small module kept separate from app.js so session lifecycle reads in one place.
 * Protocol (mirror-server.ts): new_session {cwd?}, close_session, start_session.
 * Lifecycle: browser close only detaches; pi keeps running until close_session.
 */

export function createSessionActions(deps) {
  const { sendRpc, dialogConfirm, onFresh, onClosed, onTimeout, getCwd } = deps;

  /** /new semantics: old session keeps running detached, fresh bound. */
  async function newSessionInCwd(cwd) {
    const payload = { type: "new_session" };
    if (cwd) payload.cwd = cwd;
    console.time("[NewSession] new_session RPC (cold backend spawn)");
    const data = await sendRpc(payload);
    console.timeEnd("[NewSession] new_session RPC (cold backend spawn)");
    // A dropped ack must never be silent: the view stays put, so say why.
    if (data && !data.timeout) onFresh?.(data);
    else if (data?.timeout) onTimeout?.("new_session");
    return data;
  }

  async function newSessionSameProject() {
    return newSessionInCwd(getCwd?.() || null);
  }

  /** Explicit kill from the web UI. Nothing else kills. */
  async function closeCurrentSession() {
    const ok = await dialogConfirm?.({
      title: "Kill session",
      message: "Terminate the running pi backend for this view? The transcript file stays on disk; the process dies.",
      okLabel: "Kill",
    });
    if (!ok) return false;
    const data = await sendRpc({ type: "close_session" });
    if (data && !data.timeout) onClosed?.(data);
    return true;
  }

  return { newSessionInCwd, newSessionSameProject, closeCurrentSession };
}
