/**
 * protocol — shared wire helpers. Browser frames are one envelope for every
 * runner (`{type:"event", runnerId, seq, event}`); pi events are normalized
 * once here so the client never sees provider-specific shapes.
 */

export const VALID_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Strict base64 (no data: prefix). Bounded to keep hostile payloads out. */
export function isValidMessageImage(img: any): boolean {
  if (!img || typeof img !== "object") return false;
  if (!VALID_IMAGE_MIMES.has(String(img.mimeType || ""))) return false;
  const data = typeof img.data === "string" ? img.data : "";
  if (!data || data.length > 8 * 1024 * 1024) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

/** Max attachments per prompt: the WS frame cap already bounds total bytes;
 *  this bounds downstream fan-out (child, relay, every viewer). */
export const MAX_COMMAND_IMAGES = 10;

/**
 * Validate the `images` payload of a prompt/steer/follow_up command.
 * Strict on purpose (raw base64 only, no data: URLs): a client bug must
 * surface as an error, never as a silently mutated attachment. Returns an
 * error message, or null when there is nothing to check.
 */
export function validateCommandImages(command: any): string | null {
  if (!command || typeof command !== "object") return null;
  if (command.type !== "prompt" && command.type !== "steer" && command.type !== "follow_up") return null;
  const images = (command as any).images;
  if (images === undefined) return null;
  if (!Array.isArray(images)) return "images must be an array";
  if (images.length > MAX_COMMAND_IMAGES) return `too many images (max ${MAX_COMMAND_IMAGES})`;
  for (let i = 0; i < images.length; i++) {
    if (!isValidMessageImage(images[i])) {
      return `invalid image at index ${i}: png/jpeg/gif/webp base64 up to 8 MB only`;
    }
  }
  return null;
}

export function randId(prefix = "r"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function response(id: string | undefined, command: string, data?: unknown): any {
  const r: any = { type: "response", command, success: true };
  if (id) r.id = id;
  if (data !== undefined) r.data = data;
  return r;
}

export function errorResponse(id: string | undefined, command: string, error: string): any {
  const r: any = { type: "response", command, success: false, error };
  if (id) r.id = id;
  return r;
}

/** pi compaction events → the pair the UI renders. */
export function normalizePiEvent(eventType: string, event: any): any {
  if (eventType === "session_before_compact") {
    return { type: "compaction_start", reason: event?.reason, willRetry: event?.willRetry };
  }
  if (eventType === "session_compact") {
    return {
      type: "compaction_end",
      reason: event?.reason,
      aborted: false,
      willRetry: event?.willRetry,
      summary: event?.compactionEntry?.summary,
      tokensBefore: event?.compactionEntry?.tokensBefore,
    };
  }
  if (eventType === "session_compact_failed") {
    return {
      type: "compaction_end",
      reason: event?.reason,
      aborted: event?.aborted,
      willRetry: event?.willRetry,
      errorMessage: event?.errorMessage,
    };
  }
  return { type: eventType, ...event };
}

/** Events a mirror forwards; everything else stays local to the TUI. */
export const MIRROR_EVENTS = [
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "auto_retry_start",
  "auto_retry_end",
  "model_select",
  "thinking_level_select",
] as const;

/** Commands accepted as WS `command`/`rpc_command` payloads. */
export const RPC_COMMANDS = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "get_state",
  "get_messages",
  "get_commands",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
  "set_model",
  "cycle_model",
  "set_thinking_level",
  "cycle_thinking_level",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "set_session_name",
  "bash",
  "abort_bash",
  "export_html",
]);

export function isRpcCommand(cmd: any): boolean {
  return !!cmd && typeof cmd === "object" && typeof cmd.type === "string" && RPC_COMMANDS.has(cmd.type);
}

export function sessionKey(file: string | null | undefined): string {
  if (!file) return "scratch";
  return file.split(/[\\/]/).pop() || file;
}

/** Text delta extraction for server-side coalescing. */
export function streamDelta(frame: any): { kind: "text" | "thinking"; delta: string } | null {
  const ev = frame?.event ?? frame;
  if (!ev || ev.type !== "message_update") return null;
  const inner = ev.assistantMessageEvent;
  if (!inner || typeof inner.delta !== "string") return null;
  if (inner.type === "text_delta") return { kind: "text", delta: inner.delta };
  if (inner.type === "thinking_delta") return { kind: "thinking", delta: inner.delta };
  return null;
}
