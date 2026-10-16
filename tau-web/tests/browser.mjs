// Minimal CDP browser driver — system Chrome, no downloaded browsers.
// Uses `playwright-core` if installed (same selectors/assertions), else a
// raw-CDP client over the existing `ws` dependency. Every page attaches a
// pageerror listener; any uncaught exception fails the run (§6 zero-tolerance).
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { getFreePort, waitFor, TMP_DIR } from "./helpers.mjs";

function chromeBin() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  for (const c of ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const out = execSync("which google-chrome-stable || which google-chrome || which chromium", { encoding: "utf8" }).trim().split("\n")[0];
    if (out && fs.existsSync(out)) return out;
  } catch {}
  throw new Error("no system Chrome found (need /opt/google/chrome/chrome or google-chrome-stable)");
}

async function tryPlaywright() {
  try {
    const pw = await import("playwright-core").catch(() => null);
    return pw?.chromium || null;
  } catch { return null; }
}

class CdpPage {
  constructor(wsUrl, browser) {
    this.wsUrl = wsUrl;
    this.browser = browser;
    this.seq = 0;
    this.pending = new Map();
    this.pageerrors = [];
    this.consoleErrors = [];
    this._loadResolve = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { maxPayload: 256 * 1024 * 1024 });
      this.ws.on("open", async () => {
        this.ws.on("message", (raw) => this._onMsg(raw));
        try {
          await this._send("Page.enable");
          await this._send("Runtime.enable");
          await this._send("Log.enable");
        } catch (e) { reject(e); return; }
        resolve(true);
      });
      this.ws.on("error", reject);
    });
  }

  _onMsg(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    const m = msg.method;
    if (m === "Runtime.exceptionThrown") {
      const d = msg.params?.exceptionDetails;
      const text = d?.exception?.description || d?.text || "uncaught exception";
      this.pageerrors.push(String(text).slice(0, 2000));
    } else if (m === "Log.entryAdded") {
      const e = msg.params?.entry;
      // Console errors from a refused WS on Layer A are expected noise —
      // filter them, don't assert on them. pageerror is the signal (§6).
      const src = `${e?.url || ""} ${e?.text || ""}`;
      if (/WebSocket|ws:|ERR_CONNECTION_REFUSED|failed.*websocket/i.test(src)) return;
      if (e?.level === "error") this.consoleErrors.push(String(e.text || "").slice(0, 500));
    } else if (m === "Page.loadEventFired" && this._loadResolve) {
      const r = this._loadResolve;
      this._loadResolve = null;
      r(true);
    }
  }

  _send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 20000);
    });
  }

  async goto(url, { timeout = 20000 } = {}) {
    const loaded = new Promise((r) => { this._loadResolve = r; });
    await this._send("Page.navigate", { url });
    await Promise.race([
      loaded,
      new Promise((r) => setTimeout(r, timeout)),
    ]);
    // Let deferred modules boot (app.js + hub.js are type=module).
    await new Promise((r) => setTimeout(r, 2500));
  }

  async evaluate(expr, { awaitPromise = true } = {}) {
    const res = await this._send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise,
    });
    if (res?.exceptionDetails) {
      throw new Error(`page evaluate threw: ${JSON.stringify(res.exceptionDetails).slice(0, 500)}`);
    }
    return res?.result?.value;
  }

  async click(selector) {
    const ok = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return "missing"; el.scrollIntoView({block:"nearest"}); el.click(); return "ok"; })()`);
    if (ok !== "ok") throw new Error(`click: selector missing: ${selector}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  async waitForFunction(expr, { timeout = 10000 } = {}) {
    return waitFor(async () => {
      try {
        const v = await this.evaluate(`(() => { try { return (${expr}); } catch { return null; } })()`);
        return v || null;
      } catch { return null; }
    }, { timeout, label: expr.slice(0, 120) });
  }

  async screenshot(name) {
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const res = await this._send("Page.captureScreenshot", { format: "png" });
      if (res?.data) {
        const file = path.join(TMP_DIR, `${name}.png`);
        fs.writeFileSync(file, Buffer.from(res.data, "base64"));
        return file;
      }
    } catch {}
    return null;
  }

  assertNoPageErrors() {
    if (this.pageerrors.length > 0) {
      throw new Error(`pageerror(s):\n${this.pageerrors.slice(0, 3).join("\n---\n")}`);
    }
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

export async function launchBrowser({ viewport = { width: 1280, height: 800 } } = {}) {
  // Prefer playwright-core when present (doc §10); same contract otherwise.
  const pwChromium = await tryPlaywright();
  if (pwChromium) {
    const bin = chromeBin();
    const browser = await pwChromium.launch({ executablePath: bin, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const pageerrors = [];
    page.on("pageerror", (e) => pageerrors.push(String(e?.message || e).slice(0, 2000)));
    return {
      kind: "playwright",
      async newPage() {
        return {
          pageerrors,
          async goto(url) { await page.goto(url, { waitUntil: "load" }); await page.waitForTimeout(2500); },
          async evaluate(expr) { return page.evaluate(`(() => { return (${expr}); })()`); },
          async click(sel) { await page.click(sel); await page.waitForTimeout(400); },
          async waitForFunction(expr, opts) {
            // Return the matched value (the CDP path does): callers await this
            // for location.hash / status text, not just for the predicate.
            const handle = await page.waitForFunction(`(() => { try { return (${expr}); } catch { return null; } })()`, null, { timeout: opts?.timeout || 10000 });
            return handle.jsonValue();
          },
          async screenshot(name) {
            fs.mkdirSync(TMP_DIR, { recursive: true });
            const f = path.join(TMP_DIR, `${name}.png`);
            await page.screenshot({ path: f });
            return f;
          },
          assertNoPageErrors() {
            if (pageerrors.length) throw new Error(`pageerror(s):\n${pageerrors.slice(0, 3).join("\n---\n")}`);
          },
          close: async () => {},
        };
      },
      async close() { try { await browser.close(); } catch {} },
    };
  }

  // Raw CDP path (zero new deps).
  const bin = chromeBin();
  const dbgPort = await getFreePort();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-e2e-chrome-"));
  const proc = spawn(bin, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--no-first-run", "--disable-extensions", "--disable-background-networking",
    `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${userDir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      return r.ok || null;
    } catch { return null; }
  }, { timeout: 20000, label: "chrome devtools" });

  async function newTarget(url) {
    const r = await fetch(`http://127.0.0.1:${dbgPort}/json/new?about:blank`, { method: "PUT" });
    const j = await r.json();
    return j;
  }

  return {
    kind: "cdp",
    async newPage(viewport) {
      const t = await newTarget();
      const page = new CdpPage(t.webSocketDebuggerUrl, null);
      await page.connect();
      const vp = viewport || { width: 1280, height: 800 };
      try {
        await page._send("Emulation.setDeviceMetricsOverride", {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
        });
      } catch {}
      return page;
    },
    async close() {
      try { proc.kill("SIGKILL"); } catch {}
      // Wait for the process to actually exit before removing its profile:
      // rmSync racing a flushing chrome leaves stale /tmp/tau-e2e-chrome-* dirs.
      await new Promise((r) => {
        if (proc.exitCode !== null) return r(true);
        const t = setTimeout(() => r(true), 3000);
        proc.once("exit", () => { clearTimeout(t); r(true); });
      });
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(userDir, { recursive: true, force: true }); return; }
        catch { await new Promise((r) => setTimeout(r, 300)); }
      }
    },
  };
}

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};
