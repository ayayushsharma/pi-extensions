#!/usr/bin/env python3
"""
tau-web deep UI pass with Playwright (uv-installed playwright 1.64 + cached chromium).

Boots a REAL hub on a dev port, logs in through the inline cookie form, drives
the real UI against a real headless pi child, reloads to prove rejoin, and
screenshots every major surface. Zero pageerror tolerance; prints a JSON report.
"""
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(os.environ.get("TAU_REVIEW_REPO", "/home/ayush/projects/personal/pi-extensions/tau-web"))
OUT = Path(os.environ.get("TAU_REVIEW_OUT", "/tmp/tau-review"))
SHOTS = OUT / "shots"
SHOTS.mkdir(parents=True, exist_ok=True)
USER, PASS = os.environ.get("TAU_REVIEW_USER", "tau-review"), os.environ.get("TAU_REVIEW_PASS", "review-pass-123")

report = {"steps": [], "errors": [], "pageerrors": [], "console": [], "requestfailed": [], "metrics": {}}


def log(*a):
    print(*a, flush=True)


def step(name, **kw):
    entry = {"name": name, "t": round(time.time() - START, 2), **kw}
    report["steps"].append(entry)
    log(f"  [step] {name} {kw if kw else ''}")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http_json(url, timeout=5):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read().decode() or "{}")


def wait_health(port, tries=40):
    for _ in range(tries):
        for cand in (port, port + 1, port + 2):
            try:
                st, data = http_json(f"http://127.0.0.1:{cand}/api/health")
                if st == 200:
                    return cand, data
            except Exception:
                pass
        time.sleep(0.75)
    return None, None


def kill_tree(pid, sig=signal.SIGTERM):
    try:
        subprocess.run(["pkill", "-P", str(pid)], timeout=5)
    except Exception:
        pass
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


def main():
    global START
    START = time.time()

    port_base = free_port()
    env = dict(os.environ)
    env.update(
        TAU_MIRROR_PORT=str(port_base),
        TAU_HOST="127.0.0.1",
        TAU_STATIC_DIR=str(REPO / "public"),
        TAU_ROLE="hub",
        TAU_USER=USER,
        TAU_PASS=PASS,
        TAU_LOG_FILE=str(OUT / "hub-playwright.log"),
    )
    env.pop("TAU_DISABLED", None)
    pi_bin = shutil.which("pi") or os.path.expanduser("~/.pi/agent/bin/pi")
    log(f"hub: pi={pi_bin} port={port_base}")

    tail = subprocess.Popen(["tail", "-f", "/dev/null"], stdout=subprocess.PIPE)
    hub = subprocess.Popen(
        [pi_bin, "-e", str(REPO), "--mode", "rpc"],
        env=env, stdin=tail.stdout,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    frozen = None
    browser = None
    try:
        port, health = wait_health(port_base)
        if not port:
            raise RuntimeError("hub did not come up")
        log(f"hub up on :{port} health={health}")
        report["metrics"]["hub_port"] = port
        report["metrics"]["health"] = health
        if port != port_base:
            report["errors"].append(f"PORT BUMP: requested {port_base}, bound {port}")

        base = f"http://127.0.0.1:{port}"
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            ctx = browser.new_context(viewport={"width": 1280, "height": 820})
            page = ctx.new_page()
            wired = {"console": [], "errors": [], "failed": []}

            def on_console(m):
                txt = f"{m.type}: {m.text}"
                wired["console"].append(txt)
                if m.type == "error":
                    report["console"].append(txt)

            def on_error(e):
                wired["errors"].append(str(e))
                report["pageerrors"].append(str(e))

            def on_failed(r):
                if "favicon" in r.url:
                    return
                wired["failed"].append(f"{r.method} {r.url} -> {r.failure}")
                report["requestfailed"].append(wired["failed"][-1])

            def on_response(r):
                if r.status >= 400 and "/api/login" not in r.url:
                    wired.setdefault("http4xx", []).append(f"{r.status} {r.request.method} {r.url}")
                    report.setdefault("http4xx", []).append(wired["http4xx"][-1])

            page.on("console", on_console)
            page.on("pageerror", on_error)
            page.on("requestfailed", on_failed)
            page.on("response", on_response)

            # ── 1. login overlay ────────────────────────────────────────
            page.goto(base + "/", wait_until="load")
            page.wait_for_selector("#login-overlay", state="attached", timeout=15000)
            page.wait_for_function(
                "() => !document.getElementById('login-overlay').classList.contains('hidden')",
                timeout=15000,
            )
            page.screenshot(path=str(SHOTS / "01-login.png"))
            step("login-overlay-visible", url=page.url)

            page.fill("#login-user", USER)
            page.fill("#login-pass", PASS)
            page.click("#login-submit")
            page.wait_for_function(
                "() => document.getElementById('login-overlay').classList.contains('hidden')",
                timeout=15000,
            )
            page.wait_for_function(
                "() => (document.getElementById('status-text')||{}).textContent.includes('Connected')",
                timeout=15000,
            )
            step("login-ok", status=page.text_content("#status-text"))

            # ── 2. sessions sidebar loaded ──────────────────────────────
            page.wait_for_function(
                "() => document.querySelectorAll('#session-list .session-item').length > 0 "
                "|| (document.querySelector('#session-list')||{}).textContent.includes('No sessions')",
                timeout=20000,
            )
            n_items = page.eval_on_selector_all("#session-list .session-item", "els => els.length")
            step("sessions-sidebar", items=n_items)

            # API timings used by the shell
            api_times = {}
            for path in ("/api/sessions", "/api/instances", "/api/health"):
                vals = page.evaluate(
                    """async (path) => {
                        const out = [];
                        for (let i = 0; i < 5; i++) {
                            const t0 = performance.now();
                            await fetch(path).then(r => r.text());
                            out.push(performance.now() - t0);
                        }
                        return out;
                    }""",
                    path,
                )
                api_times[path] = [round(v, 1) for v in vals]
            report["metrics"]["api_ms"] = api_times
            step("api-timings", **{k: v for k, v in api_times.items()})

            # ── 3. new session (real headless child) ────────────────────
            t0 = time.time()
            page.click("#tab-new")
            page.wait_for_function(
                """() => {
                    const h = location.hash || '';
                    const st = (document.getElementById('cs-state')||{}).textContent || '';
                    return h.includes('session=') || st.includes('Headless') || st.includes('runner');
                }""",
                timeout=45000,
            )
            spawn_ms = int((time.time() - t0) * 1000)
            page.wait_for_timeout(1200)
            step("new-session", ms=spawn_ms, hash=page.evaluate("() => location.hash"),
                 state=page.text_content("#cs-state"), card=page.text_content("#cs-name"),
                 title_bar_hidden=page.evaluate("() => document.getElementById('title-bar').classList.contains('hidden')"),
                 error_msgs=page.eval_on_selector_all(".error-message", "els => els.map(e => e.textContent)"))
            page.screenshot(path=str(SHOTS / "02-new-session.png"))

            # ── 4. model dropdown (no switch — just inspect + close) ────
            page.click("#model-dropdown-btn")
            page.wait_for_selector("#model-dropdown-menu:not(.hidden)", timeout=10000)
            n_models = page.eval_on_selector_all(".model-dropdown-item", "els => els.length")
            model_now = page.text_content("#model-dropdown-label")
            page.screenshot(path=str(SHOTS / "03-model-menu.png"))
            page.keyboard.press("Escape")
            step("model-menu", count=n_models, current=model_now)

            # ── 5. live prompt round-trip ───────────────────────────────
            page.fill("#message-input", "Reply with exactly: PONG and nothing else.")
            t0 = time.time()
            page.click("#send-btn")
            page.wait_for_function(
                "() => !document.getElementById('abort-btn').classList.contains('hidden')",
                timeout=20000,
            )
            step("run-started", ms=int((time.time() - t0) * 1000))
            page.wait_for_function(
                """() => {
                    const els = [...document.querySelectorAll('.message.assistant')];
                    const last = els[els.length - 1];
                    return last && last.textContent.includes('PONG')
                        && document.getElementById('abort-btn').classList.contains('hidden');
                }""",
                timeout=180000,
            )
            run_ms = int((time.time() - t0) * 1000)
            step("run-complete", ms=run_ms,
                 user_bubbles=page.eval_on_selector_all(".message.user", "els => els.length"),
                 assistant_bubbles=page.eval_on_selector_all(".message.assistant", "els => els.length"),
                 tools=page.eval_on_selector_all(".tool-card", "els => els.length"))
            report["metrics"]["prompt_roundtrip_ms"] = run_ms
            page.wait_for_timeout(800)
            page.screenshot(path=str(SHOTS / "04-after-reply.png"))
            page.screenshot(path=str(SHOTS / "04-after-reply-full.png"), full_page=True)

            # ── 6. dialog path probe: /model in the child ───────────────
            page.fill("#message-input", "/model")
            page.click("#send-btn")
            got_dialog = False
            try:
                page.wait_for_selector("#dialog-container:not(.hidden) .dialog", timeout=15000)
                got_dialog = True
                page.screenshot(path=str(SHOTS / "05-dialog.png"))
                title = page.text_content(".dialog-title")
                # cancel the dialog (keeps the child calm)
                page.click("#dialog-cancel")
                page.wait_for_selector("#dialog-container.hidden", timeout=5000)
                step("dialog-cancel", title=title)
            except Exception:
                step("dialog-probe", got=False, note="no dialog for /model")
            if got_dialog:
                step("dialog-shown")
            page.wait_for_timeout(500)

            # ── 7. reload → same session rejoined, no duplicate ─────────
            before_hash = page.evaluate("() => location.hash")
            page.reload(wait_until="load")
            page.wait_for_function(
                """() => {
                    const els = [...document.querySelectorAll('.message.assistant')];
                    return els.some(el => el.textContent.includes('PONG'));
                }""",
                timeout=30000,
            )
            page.wait_for_function(
                "() => (document.getElementById('status-text')||{}).textContent.includes('Connected')",
                timeout=20000,
            )
            after_hash = page.evaluate("() => location.hash")
            step("reload-rejoin", same_hash=before_hash == after_hash, hash=after_hash,
                 user_bubbles=page.eval_on_selector_all(".message.user", "els => els.length"))
            page.screenshot(path=str(SHOTS / "06-after-reload.png"))

            # ── 8. settings (server pane) ───────────────────────────────
            page.click("#settings-btn")
            page.wait_for_selector("#settings-panel:not(.hidden)", timeout=10000)
            page.click('#settings-tabs .settings-tab[data-tab="server"]')
            page.wait_for_selector('#settings-server-section:not(.hidden)', timeout=5000)
            for _ in range(40):
                v = page.text_content("#server-version")
                if v and v != "—":
                    break
                page.wait_for_timeout(250)
            page.wait_for_timeout(1500)
            proc_rows = page.eval_on_selector_all("#proc-list .proc-row", "els => els.length")
            step("settings-server", version=page.text_content("#server-version"),
                 uptime=page.text_content("#server-uptime"), proc_rows=proc_rows)
            page.screenshot(path=str(SHOTS / "07-settings-server.png"))
            page.click("#settings-close")

            # ── 9. command palette ──────────────────────────────────────
            page.keyboard.press("Control+k")
            page.wait_for_selector("#command-palette:not(.hidden)", timeout=5000)
            page.wait_for_timeout(1000)
            step("command-palette", items=page.eval_on_selector_all(".command-item", "els => els.length"))
            page.screenshot(path=str(SHOTS / "08-palette.png"))
            page.keyboard.press("Escape")

            # ── 10. file sidebar + viewer (needs a session rooted under $HOME) ──
            # The /tmp-rooted test session is outside the fs allowlist by design;
            # pick a real HOME session so the explorer + viewer get a real root.
            home_item = page.evaluate(
                """() => {
                    const items = [...document.querySelectorAll('#session-list .session-item')];
                    const f = items.find(el => (el.dataset.filePath || '').includes('/--home-'))
                        || items.find(el => el !== items[0]);
                    if (!f) return false;
                    f.click();
                    return true;
                }"""
            )
            if home_item:
                page.wait_for_timeout(2500)
                step("switch-to-home-session", hash=page.evaluate("() => location.hash"))
            page.click("#file-sidebar-toggle")
            page.wait_for_selector("#file-sidebar:not(.collapsed)", timeout=5000)
            page.wait_for_function(
                "() => document.querySelectorAll('#file-list .file-item').length > 0",
                timeout=20000,
            )
            page.screenshot(path=str(SHOTS / "09-file-sidebar.png"))
            # find a non-directory item and open the viewer
            opened = page.evaluate(
                """() => {
                    const items = [...document.querySelectorAll('#file-list .file-item')];
                    const f = items.find(el => el.dataset.isDirectory === 'false');
                    if (!f) return false;
                    f.click();
                    return true;
                }"""
            )
            if opened:
                page.wait_for_selector("#file-viewer:not(.hidden)", timeout=10000)
                page.wait_for_timeout(1200)
                step("file-viewer", file=page.text_content("#fv-name"))
                page.screenshot(path=str(SHOTS / "10-file-viewer.png"))
                page.click("#fv-close")
            else:
                step("file-viewer", skipped=True)
            page.click("#file-sidebar-close")

            # ── 11. live TUI section: preview (read-only) then cancel ────
            page.wait_for_function(
                "() => document.querySelectorAll('#live-section .live-row').length > 0",
                timeout=20000,
            )
            live_rows = page.eval_on_selector_all("#live-section .live-row", "els => els.length")
            page.screenshot(path=str(SHOTS / "11-live-section.png"))
            previewed = page.evaluate(
                """() => {
                    const btn = document.querySelector('#live-section .live-btn[data-action="attach"]');
                    if (!btn) return false;
                    btn.click();
                    return true;
                }"""
            )
            if previewed:
                page.wait_for_function(
                    "() => !document.getElementById('session-banner').classList.contains('hidden')",
                    timeout=10000,
                )
                page.wait_for_timeout(1500)
                step("live-preview", banner=page.text_content("#session-banner"), rows=live_rows)
                page.screenshot(path=str(SHOTS / "11b-live-preview.png"))
                page.click('#session-banner .sb-btn[data-action="cancel"]')
                page.wait_for_timeout(800)
                step("live-preview-cancelled")
            else:
                step("live-preview", skipped=True, rows=live_rows)

            # ── 12. logout / login round trip ───────────────────────────
            page.click("#settings-btn")
            page.wait_for_selector("#settings-panel:not(.hidden)", timeout=10000)
            page.click('#settings-tabs .settings-tab[data-tab="server"]')
            page.click("#btn-logout")
            page.wait_for_function(
                "() => !document.getElementById('login-overlay').classList.contains('hidden')",
                timeout=10000,
            )
            page.fill("#login-user", USER)
            page.fill("#login-pass", PASS)
            page.click("#login-submit")
            page.wait_for_function(
                "() => document.getElementById('login-overlay').classList.contains('hidden')",
                timeout=15000,
            )
            page.wait_for_timeout(1500)
            step("logout-login-roundtrip")

            # ── 13. navigation timing + DOM weight ──────────────────────
            nav = page.evaluate(
                """() => {
                    const n = performance.getEntriesByType('navigation')[0] || {};
                    return {
                        dcl: Math.round(n.domContentLoadedEventEnd || 0),
                        load: Math.round(n.loadEventEnd || 0),
                        transfer: n.transferSize || 0,
                        domNodes: document.getElementsByTagName('*').length,
                        msgs: document.querySelectorAll('.message').length,
                    };
                }"""
            )
            report["metrics"]["navigation"] = nav
            step("nav-timing", **nav)

            # ── 14. mobile viewport ────────────────────────────────────
            mctx = browser.new_context(
                viewport={"width": 390, "height": 844},
                is_mobile=True, has_touch=True,
                user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36",
            )
            mpage = mctx.new_page()
            mpage_errors = []
            mpage.on("pageerror", lambda e: mpage_errors.append(str(e)))
            mpage.goto(base + "/" + page.evaluate("() => location.hash"), wait_until="load")
            mpage.wait_for_timeout(1500)
            # fresh context has no cookie: log in first, then check layout
            mpage.wait_for_function(
                "() => !document.getElementById('login-overlay').classList.contains('hidden')",
                timeout=15000,
            )
            mpage.fill("#login-user", USER)
            mpage.fill("#login-pass", PASS)
            mpage.click("#login-submit")
            mpage.wait_for_function(
                "() => document.getElementById('login-overlay').classList.contains('hidden')",
                timeout=15000,
            )
            mpage.wait_for_timeout(4000)
            # sidebar should be collapsed on mobile
            collapsed = mpage.evaluate("() => document.getElementById('sidebar').classList.contains('collapsed')")
            input_visible = mpage.evaluate("() => { const el = document.getElementById('message-input'); const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 10; }")
            overflow = mpage.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            mpage.screenshot(path=str(SHOTS / "11-mobile-chat.png"))
            mpage.click("#sidebar-toggle")
            mpage.wait_for_timeout(700)
            mpage.screenshot(path=str(SHOTS / "12-mobile-sidebar.png"))
            step("mobile", sidebar_collapsed=collapsed, input_visible=input_visible,
                 horiz_overflow_px=overflow, pageerrors=mpage_errors)
            if mpage_errors:
                report["pageerrors"].extend([f"mobile: {e}" for e in mpage_errors])
            mctx.close()

            page.wait_for_timeout(500)
            report["metrics"]["console_errors"] = len(wired["console"])
            report["metrics"]["pageerrors"] = len(wired["errors"])
            report["metrics"]["request_failed"] = len(wired["failed"])
            page.screenshot(path=str(SHOTS / "99-final-desktop.png"))
            ctx.close()
            browser.close()
            browser = None
    except Exception as e:
        report["errors"].append(f"EXCEPTION: {e}")
        report["traceback"] = traceback.format_exc()
        log(report["traceback"])
    finally:
        try:
            if browser:
                browser.close()
        except Exception:
            pass
        if hub.pid:
            kill_tree(hub.pid)
        try:
            tail.kill()
        except Exception:
            pass
        time.sleep(1.0)
        try:
            subprocess.run(["pkill", "-P", str(hub.pid)], timeout=5)
            os.kill(hub.pid, signal.SIGKILL)
        except Exception:
            pass

    report["elapsed_s"] = round(time.time() - START, 1)
    (OUT / "deep-ui-report.json").write_text(json.dumps(report, indent=2))
    log(json.dumps({k: v for k, v in report.items() if k not in ("steps",)})[:4000])
    log(f"steps: {len(report['steps'])}  report: {OUT/'deep-ui-report.json'}")
    return 0 if not report["errors"] and not report["pageerrors"] else 1


if __name__ == "__main__":
    sys.exit(main())
