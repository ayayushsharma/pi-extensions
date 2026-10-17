/**
 * mirror — the interactive-TUI side of the relay (ADR-014). It dials the
 * hub, forwards this session's events, executes drive commands, and lets the
 * browser own extension dialogs while connected (ADR-007). It never opens a
 * TCP port (ADR-011).
 */
import { HubSocketClient } from "./socket.js";
import { hubLog } from "../log.js";
import { randId } from "../protocol.js";
import type { HubConfig } from "../env.js";

export class Mirror {
  private client: HubSocketClient | null = null;
  private pendingDialogs = new Map<string, (v: any) => void>();
  private wrapped = new WeakSet<object>();
  private getCtx: () => any;
  private pi: any;

  constructor(
    private config: HubConfig,
    pi: any,
    getCtx: () => any,
  ) {
    this.pi = pi;
    this.getCtx = getCtx;
  }

  get connected(): boolean {
    return !!this.client?.connected;
  }

  start(): void {
    if (this.client) return;
    this.client = new HubSocketClient(this.config.sockPath);
    this.client.on("connected", () => this.sendHello());
    this.client.on("frame", (frame: any) => {
      try {
        this.onFrame(frame);
      } catch (e) {
        hubLog("mirror frame failed:", String(e));
      }
    });
    this.client.connect();
  }

  stop(): void {
    const ctx = this.getCtx();
    try {
      this.client?.send({ type: "bye", pid: process.pid });
    } catch {}
    this.client?.stop();
    this.client = null;
    for (const [, resolve] of this.pendingDialogs) resolve({ cancelled: true });
    this.pendingDialogs.clear();
    void ctx;
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
    if (frame?.type === "dialog_relay") {
      const resolve = this.pendingDialogs.get(frame.id);
      if (resolve) {
        this.pendingDialogs.delete(frame.id);
        resolve(frame.response && Object.keys(frame.response).length ? frame.response : { cancelled: true });
      }
    }
  }

  /** Browser owns dialogs while connected; otherwise native (single driver). */
  wrapDialogs(ctx: any): void {
    const ui = ctx?.ui;
    if (!ui || this.wrapped.has(ui)) return;
    this.wrapped.add(ui);
    const ask = (method: string, fields: any): Promise<any> | null => {
      if (!this.connected) return null;
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
    if (ui.select) {
      const orig = ui.select.bind(ui);
      ui.select = async (title: string, options: string[], opts?: any) => {
        const p = ask("select", { title, options, timeout: opts?.timeout });
        if (!p) return orig(title, options, opts);
        const r = await p;
        return r?.cancelled ? undefined : r?.value;
      };
    }
    if (ui.confirm) {
      const orig = ui.confirm.bind(ui);
      ui.confirm = async (title: string, message: string, opts?: any) => {
        const p = ask("confirm", { title, message, timeout: opts?.timeout });
        if (!p) return orig(title, message, opts);
        const r = await p;
        return r?.cancelled ? false : !!r?.confirmed;
      };
    }
    if (ui.input) {
      const orig = ui.input.bind(ui);
      ui.input = async (title: string, placeholder?: string, opts?: any) => {
        const p = ask("input", { title, placeholder, timeout: opts?.timeout });
        if (!p) return orig(title, placeholder, opts);
        const r = await p;
        return r?.cancelled ? undefined : r?.value;
      };
    }
    if (ui.editor) {
      const orig = ui.editor.bind(ui);
      ui.editor = async (title: string, prefill?: string, opts?: any) => {
        const p = ask("editor", { title, prefill, timeout: opts?.timeout });
        if (!p) return orig(title, prefill, opts);
        const r = await p;
        return r?.cancelled ? undefined : r?.value;
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

  private execute(command: any): void {
    const ctx = this.getCtx();
    const pi = this.pi;
    try {
      switch (command?.type) {
        case "prompt": {
          const isSlash = typeof command.message === "string" && command.message.trimStart().startsWith("/");
          if (ctx && !ctx.isIdle()) {
            pi.sendUserMessage(command.message, { deliverAs: "steer", ...(isSlash ? { expandPromptTemplates: true } : {}) });
          } else if (isSlash) {
            pi.sendUserMessage(command.message, { expandPromptTemplates: true });
          } else {
            pi.sendUserMessage(command.message);
          }
          this.reply(command, { disposition: "accepted" });
          break;
        }
        case "steer":
          pi.sendUserMessage(command.message, { deliverAs: "steer" });
          this.reply(command);
          break;
        case "follow_up":
          pi.sendUserMessage(command.message, { deliverAs: "followUp" });
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
          ctx?.modelRegistry
            ?.getAvailable?.()
            .then((models: any[]) => this.reply(command, { models }))
            .catch((e: any) => this.reply(command, undefined, e?.message || String(e)));
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
            .catch((e: any) => this.reply(command, undefined, e?.message || String(e)));
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
      this.reply(command, undefined, e?.message || String(e));
    }
  }
}
