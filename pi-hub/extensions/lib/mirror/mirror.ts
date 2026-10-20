/**
 * mirror — the interactive-TUI side of the relay (ADR-014). It dials the
 * hub, forwards this session's events, executes drive commands, and lets the
 * browser own extension dialogs while connected (ADR-007). It never opens a
 * TCP port (ADR-011).
 */
import * as fs from "node:fs";
import { HubSocketClient } from "./socket.js";
import { hubLog } from "../log.js";
import { isValidMessageImage, randId } from "../protocol.js";
import type { HubConfig } from "../env.js";

export class Mirror {
  private client: HubSocketClient | null = null;
  private pendingDialogs = new Map<string, (v: any) => void>();
  private wrapped = new WeakSet<object>();
  /** While answering a hub drive-consent prompt, dialogs stay native: the
   *  TUI user — not the browser asking for access — must answer. */
  private forceNative = false;
  private config: HubConfig;
  private getCtx: () => any;
  private pi: any;

  constructor(config: HubConfig, pi: any, getCtx: () => any) {
    this.config = config;
    this.pi = pi;
    this.getCtx = getCtx;
  }

  get connected(): boolean {
    return !!this.client?.connected;
  }

  /** the socket we actually dial (configured or advertised) */
  get sockPath(): string {
    return this.client?.sockPath ?? this.config.sockPath;
  }

  start(): void {
    if (this.client) return;
    this.client = new HubSocketClient(() => this.candidateSocks());
    this.client.on("connected", () => {
      hubLog(`mirror connected on ${this.client!.sockPath}`);
      this.sendHello();
    });
    this.client.on("frame", (frame: any) => {
      try {
        this.onFrame(frame);
      } catch (e) {
        hubLog("mirror frame failed:", String(e));
      }
    });
    this.client.connect();
  }

  /** Socket candidates, in preference order: our configured path first, then
   *  the hub's advert (a TUI started from any directory still finds it). The
   *  client connects to the first one that actually accepts — mere existence
   *  is not enough, a hard-killed hub leaves a dead socket file behind. */
  candidateSocks(): string[] {
    const out = [this.config.sockPath];
    try {
      const advert = JSON.parse(fs.readFileSync(this.config.advertPath, "utf8"));
      let alive = false;
      try {
        process.kill(advert?.pid, 0);
        alive = typeof advert?.pid === "number";
      } catch {}
      if (alive && typeof advert?.sock === "string" && fs.existsSync(advert.sock)) out.push(advert.sock);
    } catch {}
    return [...new Set(out)];
  }

  stop(): void {
    try {
      this.client?.send({ type: "bye", pid: process.pid });
    } catch {}
    this.client?.stop();
    this.client = null;
    for (const [, resolve] of this.pendingDialogs) resolve({ cancelled: true });
    this.pendingDialogs.clear();
  }

  private sendHello(): void {
    const ctx = this.getCtx();
    this.client?.send({
      type: "hello",
      pid: process.pid,
      cwd: ctx?.cwd || process.cwd(),
      sessionFile: ctx?.sessionManager?.getSessionFile?.() || null,
      name: this.pi?.getSessionName?.() || null,
    });
  }

  /** Session identity moved (new/switch/resume): re-announce. */
  announce(): void {
    this.sendHello();
  }

  pushEvent(event: any): void {
    if (!this.connected) return;
    this.client?.send({ type: "event", pid: process.pid, event });
  }

  pushStatus(): void {
    if (!this.connected) return;
    const ctx = this.getCtx();
    this.client?.send({
      type: "status",
      pid: process.pid,
      status: {
        isStreaming: ctx ? !ctx.isIdle() : false,
        model: ctx?.model?.id || ctx?.model?.name || null,
        thinkingLevel: this.pi?.getThinkingLevel?.() || null,
        sessionFile: ctx?.sessionManager?.getSessionFile?.() || null,
        name: this.pi?.getSessionName?.() || null,
      },
    });
  }

  private onFrame(frame: any): void {
    if (frame?.type === "drive" && frame.command) {
      this.execute(frame.command);
      return;
    }
    if (frame?.type === "drive_confirm" && frame.id) {
      // Opt-in drive consent (PI_HUB_DRIVE_CONFIRM): the TUI user approves
      // each browser attach on their own terminal. No UI to ask (or an
      // answer that never comes) denies — fail-closed, never fail-open.
      const id = frame.id;
      const ui = this.getCtx()?.ui;
      if (!ui || typeof ui.confirm !== "function") {
        this.client?.send({ type: "drive_confirm_reply", pid: process.pid, id, confirmed: false });
        return;
      }
      this.forceNative = true;
      // Defer the call into the promise chain: a synchronous throw from a
      // custom UI implementation would otherwise escape and leave
      // forceNative stuck on, disabling browser dialogs for the session.
      Promise.resolve()
        .then(() => ui.confirm("Browser drive request", "A browser wants to drive this TUI (send prompts, steer, abort). Allow?"))
        .then((ok) => {
          this.client?.send({ type: "drive_confirm_reply", pid: process.pid, id, confirmed: ok === true });
        })
        .catch(() => {
          this.client?.send({ type: "drive_confirm_reply", pid: process.pid, id, confirmed: false });
        })
        .finally(() => {
          this.forceNative = false;
        });
      return;
    }
    if (frame?.type === "dialog_relay") {
      const resolve = this.pendingDialogs.get(frame.id);
      if (resolve) {
        this.pendingDialogs.delete(frame.id);
        resolve(frame.response && Object.keys(frame.response).length ? frame.response : { cancelled: true });
      }
    }
  }

  /** Browser owns dialogs while connected; otherwise native (single driver).
   *  The four methods share one shape — ask the browser, fall back to
   *  native, map the answer — so they share one wrapper. */
  wrapDialogs(ctx: any): void {
    const ui = ctx?.ui;
    if (!ui || this.wrapped.has(ui)) return;
    this.wrapped.add(ui);
    const ask = (method: string, fields: any): Promise<any> | null => {
      if (!this.connected || this.forceNative) return null;
      const id = randId("dlg");
      const promise = new Promise<any>((resolve) => {
        this.pendingDialogs.set(id, resolve);
      });
      this.client?.send({ type: "dialog", pid: process.pid, request: { type: "extension_ui_request", id, method, ...fields } });
      try {
        ctx.ui.notify(`Dialog open in the browser (${method})`, "info");
      } catch {}
      return promise;
    };
    const defs: Record<string, { fields: (a: any[]) => any; done: (r: any) => any }> = {
      select: {
        fields: ([title, options, opts]) => ({ title, options, timeout: opts?.timeout }),
        done: (r) => (r?.cancelled ? undefined : r?.value),
      },
      confirm: {
        fields: ([title, message, opts]) => ({ title, message, timeout: opts?.timeout }),
        done: (r) => (r?.cancelled ? false : !!r?.confirmed),
      },
      input: {
        fields: ([title, placeholder, opts]) => ({ title, placeholder, timeout: opts?.timeout }),
        done: (r) => (r?.cancelled ? undefined : r?.value),
      },
      editor: {
        fields: ([title, prefill, opts]) => ({ title, prefill, timeout: opts?.timeout }),
        done: (r) => (r?.cancelled ? undefined : r?.value),
      },
    };
    for (const [method, { fields, done }] of Object.entries(defs)) {
      if (typeof ui[method] !== "function") continue;
      const orig = ui[method].bind(ui);
      ui[method] = async (...args: any[]) => {
        const p = ask(method, fields(args));
        if (!p) return orig(...args);
        return done(await p);
      };
    }
  }

  private reply(command: any, data?: any, error?: string): void {
    const event: any = {
      type: "response",
      command: command?.type || "unknown",
      success: !error,
      id: command?.id,
    };
    if (error) event.error = error;
    else if (data !== undefined) event.data = data;
    this.pushEvent(event);
  }

  /** Build sendUserMessage content with validated image blocks. The hub
   *  already rejected hostile attachments (validateCommandImages); this
   *  second pass stays strict anyway — never upgrade a bad block to a
   *  default, just drop it and log (a client bug must stay visible). */
  private messageContent(message: string, images: any): string | Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
    if (!Array.isArray(images) || !images.length) return message;
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
      { type: "text", text: message || "(see attached image)" },
    ];
    for (const img of images) {
      if (!isValidMessageImage(img)) {
        hubLog(`mirror: dropping invalid image (mimeType ${String(img?.mimeType)})`);
        continue;
      }
      content.push({ type: "image", data: img.data, mimeType: String(img.mimeType) });
    }
    return content.length > 1 ? content : message;
  }

  private execute(command: any): void {
    const ctx = this.getCtx();
    const pi = this.pi;
    const fail = (e: any) => this.reply(command, undefined, e?.message || String(e));
    try {
      switch (command?.type) {
        case "prompt": {
          const isSlash = typeof command.message === "string" && command.message.trimStart().startsWith("/");
          const content = this.messageContent(command.message, command.images);
          if (ctx && !ctx.isIdle()) {
            pi.sendUserMessage(content, { deliverAs: "steer", ...(isSlash ? { expandPromptTemplates: true } : {}) });
          } else if (isSlash) {
            pi.sendUserMessage(content, { expandPromptTemplates: true });
          } else {
            pi.sendUserMessage(content);
          }
          this.reply(command, { disposition: "accepted" });
          break;
        }
        case "steer":
          pi.sendUserMessage(this.messageContent(command.message, command.images), { deliverAs: "steer" });
          this.reply(command);
          break;
        case "follow_up":
          pi.sendUserMessage(this.messageContent(command.message, command.images), { deliverAs: "followUp" });
          this.reply(command);
          break;
        case "abort":
          ctx?.abort?.();
          this.reply(command);
          break;
        case "get_state":
          this.reply(command, {
            model: ctx?.model || null,
            thinkingLevel: pi.getThinkingLevel?.() || null,
            isStreaming: ctx ? !ctx.isIdle() : false,
            sessionFile: ctx?.sessionManager?.getSessionFile?.() || null,
            sessionName: pi.getSessionName?.() || null,
          });
          break;
        case "get_available_models":
          Promise.resolve(ctx?.modelRegistry?.getAvailable?.() ?? [])
            .then((models: any[]) => this.reply(command, { models }))
            .catch(fail);
          break;
        case "get_commands":
          try {
            this.reply(command, { commands: pi.getCommands?.() || [] });
          } catch (e: any) {
            fail(e);
          }
          break;
        case "get_messages": {
          if (!ctx) return this.reply(command, undefined, "No context available");
          try {
            this.reply(command, { entries: ctx.sessionManager?.getEntries?.() || [] });
          } catch (e: any) {
            fail(e);
          }
          break;
        }
        case "get_session_stats": {
          if (!ctx) return this.reply(command, undefined, "No context available");
          try {
            const usage = ctx.getContextUsage?.();
            const entries = ctx.sessionManager?.getEntries?.() || [];
            let userMessages = 0;
            let assistantMessages = 0;
            let toolCalls = 0;
            for (const e of entries) {
              if (e?.type === "message") {
                if (e.message?.role === "user") userMessages++;
                else if (e.message?.role === "assistant") assistantMessages++;
                else if (e.message?.role === "toolResult") toolCalls++;
              }
            }
            this.reply(command, {
              sessionFile: ctx.sessionManager?.getSessionFile?.() || null,
              userMessages,
              assistantMessages,
              toolCalls,
              totalMessages: entries.length,
              tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
            });
          } catch (e: any) {
            fail(e);
          }
          break;
        }
        case "get_available_thinking_levels": {
          // Per-model levels live on the session runtime, which the
          // extension API does not expose — probe defensively and let the
          // client fall back to its static list when absent (R-2).
          try {
            const levels = ctx?.session?.getAvailableThinkingLevels?.();
            if (Array.isArray(levels) && levels.length) return this.reply(command, { levels });
            return this.reply(command, undefined, "thinking levels unavailable for this session");
          } catch (e: any) {
            return fail(e);
          }
        }
        case "clear_queue":
          // No extension API clears pi's steer/follow-up queues: the queue
          // lives in the TUI and stays queued (nothing is lost). The client
          // already treats this as empty and still delivers its abort.
          this.reply(command, undefined, "queue lives in the TUI — clear it there (Esc)");
          break;
        case "set_model": {
          Promise.resolve(ctx?.modelRegistry?.getAvailable?.() ?? [])
            .then(async (list: any[]) => {
              const model = list?.find((m) => m.provider === command.provider && m.id === command.modelId);
              if (!model) return this.reply(command, undefined, `model not found: ${command.provider}/${command.modelId}`);
              const ok = await pi.setModel(model);
              if (!ok) return this.reply(command, undefined, "no API key for this model");
              this.reply(command, model);
            })
            .catch(fail);
          break;
        }
        case "set_thinking_level":
          pi.setThinkingLevel(command.level);
          this.reply(command);
          break;
        case "cycle_thinking_level": {
          const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
          const idx = levels.indexOf(pi.getThinkingLevel?.() || "off");
          const next = levels[(idx + 1) % levels.length];
          pi.setThinkingLevel(next);
          this.reply(command, { level: pi.getThinkingLevel?.() || next });
          break;
        }
        case "compact":
          ctx?.compact?.(command.customInstructions ? { customInstructions: command.customInstructions } : undefined);
          this.reply(command);
          break;
        case "set_session_name":
          pi.setSessionName?.(command.name);
          this.reply(command);
          break;
        default:
          this.reply(command, undefined, `unsupported command: ${command?.type}`);
      }
    } catch (e: any) {
      fail(e);
    }
  }
}
