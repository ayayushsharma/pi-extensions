// ws — one connection, reconnect with backoff, id-correlated acks, seq tracking.
const MAX_BACKOFF = 10000;

export class HubSocket {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.connected = false;
    this.retryMs = 500;
    this.heartbeat = null;
    this.stopped = false;
  }

  connect() {
    this.stopped = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retryMs = 500;
      this.handlers.onOpen?.();
      this.heartbeat = setInterval(() => this.send({ type: "ping" }), 25000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatch(msg);
    };
    ws.onclose = () => this.reconnect();
    ws.onerror = () => {};
  }

  dispatch(msg) {
    if (msg.type === "pong") return;
    if (msg.type === "ack" || msg.type === "bound" || msg.type === "attached" || msg.type === "detached" || msg.id) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.type === "error") pending.reject(new Error(msg.message || "request failed"));
        else pending.resolve(msg);
        if (msg.type !== "error") return;
      }
    }
    if (msg.type === "error") {
      this.handlers.onError?.(msg);
      return;
    }
    this.handlers.onMessage?.(msg);
  }

  reconnect() {
    this.connected = false;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.handlers.onClose?.();
    for (const [, p] of this.pending) p.reject(new Error("connection lost"));
    this.pending.clear();
    if (this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_BACKOFF);
    setTimeout(() => {
      if (document.visibilityState === "visible") this.connect();
      else document.addEventListener("visibilitychange", () => this.connect(), { once: true });
    }, wait);
  }

  requestId() {
    return `c${++this.seq}-${Date.now().toString(36)}`;
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  request(msg, timeoutMs = 30000) {
    const id = msg.id || this.requestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${msg.type} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      if (!this.send({ ...msg, id })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("not connected"));
      }
    });
  }

  close() {
    this.stopped = true;
    try {
      this.ws?.close();
    } catch {}
  }
}
