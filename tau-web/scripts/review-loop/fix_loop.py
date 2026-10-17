#!/usr/bin/env python3
"""
tau-web review-fix loop — deterministic coder/reviewer pi instances.

One iteration per task in scripts/review-loop/tasks.json:

  1. CODER   : `pi --print` (muse-spark-1.3-contributor, xhigh, 256k cap)
               edits the working tree and writes
               docs/review-loop/coder-comments<NN>.md
  2. REVIEWER: `pi --print` (deepseek-v4.1-flash, max thinking)
               reads the diff + coder comments, runs the test suite, writes
               docs/review-loop/reviewer-comments<NN>.md ending in
               `VERDICT: PASS | PASS-WITH-NITS | FAIL`.
  3. If FAIL and rounds remain, the coder gets the reviewer comments and
     retries. PASS (or PASS-WITH-NITS) commits the task when --commit is set
     and moves on. After the last round a FAIL is recorded and the loop
     continues with the next task (--stop-on-fail to abort instead).

State lives in <out-dir>/state.json so a rerun resumes where it stopped.
Rerun examples:

  python3 scripts/review-loop/fix_loop.py --list
  python3 scripts/review-loop/fix_loop.py --only T1 --dry-run
  python3 scripts/review-loop/fix_loop.py --all --commit --branch code-review-fixes
  python3 scripts/review-loop/fix_loop.py --only T4 --force          # redo one task
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DEFAULT = SCRIPT_DIR.parents[1]  # tau-web/
TASKS_DEFAULT = SCRIPT_DIR / "tasks.json"
PI_DEFAULT = shutil.which("pi") or os.path.expanduser("~/.pi/agent/bin/pi")
CTX_LIMIT_EXT = SCRIPT_DIR.parents[1].parent / "ctx-limit" / "extensions" / "ctx-limit.ts"

CODER_MODEL = "opencode-go/muse-spark-1.3-contributor"
CODER_THINKING = "xhigh"
REVIEWER_MODEL = "opencode-go/deepseek-v4.1-flash"
REVIEWER_THINKING = "max"
CTX_TOKENS = 262144  # 256k


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{now()}] {msg}", flush=True)


def load_tasks(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    tasks = data["tasks"] if isinstance(data, dict) else data
    return tasks


def select_tasks(all_tasks: list[dict], args) -> list[dict]:
    wanted = None
    if args.only:
        wanted = {s.strip().upper() for s in args.only.split(",") if s.strip()}
    out = []
    for t in all_tasks:
        tid = t["id"].upper()
        if wanted is not None and tid not in wanted:
            continue
        if args.skip and tid in {s.strip().upper() for s in args.skip.split(",")}:
            continue
        if args.from_task and tid < args.from_task.upper():
            continue
        out.append(t)
    return out


def pi_cmd(args, model: str, thinking: str, prompt: str) -> list[str]:
    return [
        args.pi,
        "--print",
        "--no-session",
        "--no-mcp",
        "--no-extensions",
        "-e", str(CTX_LIMIT_EXT),
        "--context-size", str(args.ctx),
        "--model", model,
        "--thinking", thinking,
        "--approve",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        prompt,
    ]


def run_pi(cmd: list[str], cwd: Path, log_path: Path, timeout_s: int) -> dict:
    """Run pi to completion, stream stdout+stderr into log_path, never orphan children."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with open(log_path, "w", encoding="utf-8") as lf:
        lf.write(f"$ {' '.join(cmd[:14])} …\n\n")
        lf.flush()
        proc = subprocess.Popen(
            cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", start_new_session=True,
        )

        killed = {"timeout": False}

        def watchdog() -> None:
            killed["timeout"] = True
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except Exception:
                pass
            time.sleep(10)
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass

        timer = threading.Timer(timeout_s, watchdog)
        timer.daemon = True
        timer.start()
        chunks: list[str] = []
        try:
            assert proc.stdout is not None
            while True:
                line = proc.stdout.readline()
                if line:
                    chunks.append(line)
                    lf.write(line)
                    continue
                if proc.poll() is not None:
                    break
            code = proc.returncode
        except Exception as e:  # pragma: no cover
            code = -1
            lf.write(f"\n[orchestrator] read error: {e}\n")
        finally:
            timer.cancel()
        timed_out = killed["timeout"]
        if proc.poll() is None:
            timed_out = True
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass
            proc.wait(timeout=10)
            code = proc.poll()
        lf.write(f"\n[orchestrator] exit={code} timeout={timed_out} elapsed={int(time.time() - t0)}s\n")
    return {
        "exit": code,
        "timeout": timed_out,
        "elapsed_s": int(time.time() - t0),
        "output": "".join(chunks),
        "log": str(log_path),
    }


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def write_if_missing(path: Path, text: str) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def parse_verdict(path: Path) -> str | None:
    text = read_text(path)
    matches = re_findall(r"(?im)^\s*VERDICT:\s*(PASS-WITH-NITS|PASS|FAIL)\b", text)
    return matches[-1].upper() if matches else None


def re_findall(pattern: str, text: str) -> list[str]:
    import re
    return [m.group(1) for m in re.finditer(pattern, text)]


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, check=check,
    )


def git_clean(repo: Path) -> bool:
    return git(repo, "status", "--porcelain").stdout.strip() == ""


def git_head(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD").stdout.strip()


def ensure_branch(repo: Path, branch: str) -> None:
    cur = git(repo, "branch", "--show-current").stdout.strip()
    if cur == branch:
        return
    exists = git(repo, "rev-parse", "--verify", f"refs/heads/{branch}", check=False).returncode == 0
    out = git(repo, "checkout", branch if exists else "-b", *( () if exists else (branch,) ))
    if out.returncode != 0:
        raise SystemExit(f"cannot switch to branch {branch}: {out.stderr.strip()}")


def commit(repo: Path, message: str, paths: list[str] | None = None) -> str | None:
    add = git(repo, "add", "-A").returncode == 0
    if not add:
        return None
    st = git(repo, "status", "--porcelain").stdout.strip()
    if not st:
        return None
    out = git(repo, "commit", "-m", message)
    if out.returncode != 0:
        log(f"  ! commit failed: {out.stderr.strip()}")
        return None
    return git_head(repo)


def preserve_failed(repo: Path, out: Path, tid: str) -> dict:
    """On a final FAIL, save the attempt as a patch and stash tracked changes so the
    next task cannot absorb them into its own commit. Untracked files (the review
    comments in docs/review-loop/) are deliberately left in place as evidence."""
    logs = out / "logs"
    logs.mkdir(exist_ok=True)
    diff = git(repo, "diff", check=False).stdout
    status = git(repo, "status", "--porcelain", check=False).stdout
    (logs / f"failed-{tid}.patch").write_text(diff, encoding="utf-8")
    (logs / f"failed-{tid}.status").write_text(status, encoding="utf-8")
    kept: dict = {
        "patch": f"logs/failed-{tid}.patch",
        "status": f"logs/failed-{tid}.status",
    }
    if status.strip():
        stash = git(repo, "stash", "push", "-m", f"review-loop {tid} failed attempt", check=False)
        out_lines = (stash.stdout + stash.stderr).strip().splitlines()
        kept["stash"] = out_lines[0] if out_lines else ""
        kept["stash_ok"] = stash.returncode == 0
    return kept


def coder_prompt(task: dict, repo: Path, out_rel: str, round_no: int, reviewer_file: Path | None) -> str:
    reqs = "\n".join(f"- {r}" for r in task["requirements"])
    accept = "\n".join(f"- {a}" for a in task.get("acceptance", []))
    tests = "\n".join(f"- `{t}`" for t in task.get("tests", []))
    files = ", ".join(f"`{f}`" for f in task.get("files", []))
    findings = ", ".join(task.get("findings", []))
    prev = ""
    if reviewer_file is not None:
        prev = (
            f"\n## Previous review (round {round_no - 1})\n\n"
            f"Read `{reviewer_file.relative_to(repo)}` and address every blocking issue in it. "
            f"Minor style notes may be left as-is.\n"
        )
    return f"""You are the CODER for task **{task['id']} — {task['title']}** of the tau-web review-fix loop.

Repository (your cwd): `{repo}`
Findings covered: {findings} (full text: `docs/code-review.md`)
Files usually involved: {files}

## Requirements

{reqs}

## Acceptance criteria

{accept}
{prev}
## Rules

- Make the minimal, correct change. Match the existing code style. No new dependencies.
- Do NOT commit. Do NOT modify `docs/code-review.md` or `tests/browser.mjs`. Do NOT touch other packages.
- Run the project tests ({tests or '- `node tests/run.mjs`'}) before you finish and paste the exact result summary.
- If a test cannot run in this environment, say exactly why in the comments file.
- The working tree may already contain changes from earlier loop tasks; keep them and build on them.
- If you need the real hub for a contract test, you may run `TEST_REAL_HUB=1 node tests/run.mjs --filter H6` (a real `pi` binary is available).

## Deliverable (required)

Write `{out_rel}/coder-comments{task['id'][1:].zfill(2)}.md` with:

1. What changed: files + a short before/after description (reference the code paths, not line numbers only).
2. How it was verified: every command and its result.
3. Anything the reviewer should double-check, and any residual risk or uncertainty.
4. If this is a retry round, explicitly list how each reviewer comment was addressed.

Finish your final chat message with a single line: `CODER DONE: <summary>`.
"""


def reviewer_prompt(task: dict, repo: Path, out_rel: str, coder_file: Path, head_before: str) -> str:
    accept = "\n".join(f"- {a}" for a in task.get("acceptance", []))
    reqs = "\n".join(f"- {r}" for r in task["requirements"])
    tests = "\n".join(f"- `{t}`" for t in task.get("tests", []))
    deep = (
        f"If `{repo}/scripts/review-loop/deep_ui.py` exists and a Playwright python is available "
        f"(try `~/.local/share/uv/tools/playwright/bin/python`), you MAY run it for a real-browser UX pass:\n"
        f"`TAU_REVIEW_OUT=/tmp/tau-loop-deep-ui TAU_REVIEW_REPO={repo} <playwright-python> {repo}/scripts/review-loop/deep_ui.py`\n"
        f"It boots its own hub on a random port; read the printed JSON report (pageerrors must be 0). "
        f"Do NOT open or attach screenshot/image files — this reviewer model cannot accept image content; rely on the JSON report and DOM/console output. "
        f"If it is unavailable, skip it and say so."
    )
    return f"""You are the independent REVIEWER for task **{task['id']} — {task['title']}**.

Repository (your cwd): `{repo}`
The coder changed the working tree for findings: {', '.join(task.get('findings', []))}.
Baseline commit before this task: `{head_before}` (the diff for this task is `git diff {head_before}` + untracked files).

## Task requirements as given to the coder

{reqs}

## Acceptance criteria

{accept}

## What to do

1. Inspect the ACTUAL code (`git diff {head_before}`, `git status --porcelain`, then read the changed files). Do not trust the coder's summary.
2. Read `{coder_file.relative_to(repo)}`.
3. Confirm the finding is really fixed and no existing functionality/UI regressed. Pay attention to the task's UX note: {task.get('ux', 'no visible change expected')}
4. Run the project tests ({tests or '- `node tests/run.mjs`'}) and paste the exact result.
5. {deep}

## Verdict policy

- FAIL only for: the finding is still exploitable/present, a functional or UX regression, or tests failing because of this change.
- PASS-WITH-NITS for correct-but-minor issues (style, extra hardening, small follow-ups) — list them so they can be picked up later.
- Ignore trivial differences.

## Deliverable (required)

Write `{out_rel}/reviewer-comments{task['id'][1:].zfill(2)}.md` with:

1. `VERDICT: PASS | PASS-WITH-NITS | FAIL` as a heading line.
2. Evidence: commands run + results, code paths inspected, what you checked for regressions.
3. Issues by severity (blocking vs nit), each with file + why.
4. If FAIL: the minimal list of changes the coder must make next round.

The LAST line of the file must be exactly `VERDICT: PASS`, `VERDICT: PASS-WITH-NITS`, or `VERDICT: FAIL`.

Do NOT edit product code. You are reviewing only.
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="tau-web coder/reviewer review-fix loop")
    ap.add_argument("--repo", default=str(REPO_DEFAULT))
    ap.add_argument("--tasks-file", default=str(TASKS_DEFAULT))
    ap.add_argument("--out-dir", default=None, help="default: <repo>/docs/review-loop")
    ap.add_argument("--only", default="", help="comma list, e.g. T1,T3")
    ap.add_argument("--skip", default="")
    ap.add_argument("--from", dest="from_task", default="")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="redo tasks already marked passed")
    ap.add_argument("--stop-on-fail", action="store_true")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--commit", action="store_true", help="commit each passing task")
    ap.add_argument("--branch", default="", help="checkout/create this branch before running (with --commit)")
    ap.add_argument("--all", action="store_true", help="explicitly run every task (default when no --only)")
    ap.add_argument("--pi", default=PI_DEFAULT)
    ap.add_argument("--coder-model", default=CODER_MODEL)
    ap.add_argument("--coder-thinking", default=CODER_THINKING)
    ap.add_argument("--reviewer-model", default=REVIEWER_MODEL)
    ap.add_argument("--reviewer-thinking", default=REVIEWER_THINKING)
    ap.add_argument("--ctx", type=int, default=CTX_TOKENS)
    ap.add_argument("--timeout-coder", type=int, default=2700)
    ap.add_argument("--timeout-reviewer", type=int, default=1800)
    args = ap.parse_args()

    repo = Path(args.repo).resolve()
    out = Path(args.out_dir).resolve() if args.out_dir else repo / "docs" / "review-loop"
    out.mkdir(parents=True, exist_ok=True)
    out_rel = str(out.relative_to(repo))
    (out / "logs").mkdir(exist_ok=True)
    (out / "prompts").mkdir(exist_ok=True)
    (out / ".gitignore").write_text("logs/\nprompts/\nstate.json\n", encoding="utf-8")

    tasks = load_tasks(Path(args.tasks_file))
    selected = select_tasks(tasks, args)
    if args.list:
        for t in selected:
            print(f"{t['id']}\t{t['title']}")
        return 0
    if not selected:
        log("no tasks selected")
        return 2
    if not Path(args.pi).exists() and not shutil.which(args.pi):
        log(f"pi binary not found: {args.pi}")
        return 2
    if not CTX_LIMIT_EXT.exists():
        log(f"ctx-limit extension not found: {CTX_LIMIT_EXT}")
        return 2

    state_path = out / "state.json"
    state = json.loads(read_text(state_path) or "{}")
    state.setdefault("tasks", {})
    state["started_at"] = state.get("started_at") or now()
    state["coder"] = {"model": args.coder_model, "thinking": args.coder_thinking, "ctx": args.ctx}
    state["reviewer"] = {"model": args.reviewer_model, "thinking": args.reviewer_thinking}

    if args.dry_run:
        log(f"DRY RUN — {len(selected)} task(s): {', '.join(t['id'] for t in selected)}")
        for t in selected[:2]:
            cp = out / "prompts" / f"coder-{t['id'][1:]}-r1.md"
            cp.write_text(coder_prompt(t, repo, out_rel, 1, None), encoding="utf-8")
            log(f"  wrote {cp}")
            log("  coder cmd: " + " ".join(pi_cmd(args, args.coder_model, args.coder_thinking, "<prompt>")[:16]) + " …")
        return 0

    if args.commit:
        if args.branch:
            ensure_branch(repo, args.branch)
        if not git_clean(repo) and not state["tasks"]:
            log("working tree is dirty (first run); committing baseline for the loop branch")
            commit(repo, "review-loop: baseline")
        elif not git_clean(repo):
            log("working tree is dirty and state exists — leaving it for the coder to build on")

    total = len(selected)
    for idx, task in enumerate(selected, 1):
        tid = task["id"]
        rec = state["tasks"].get(tid, {})
        if rec.get("status") == "passed" and not args.force:
            log(f"[{idx}/{total}] {tid} already passed — skipping (use --force to redo)")
            continue
        # T1 -> 01
        nn = tid[1:].zfill(2)
        coder_file = out / f"coder-comments{nn}.md"
        reviewer_file = out / f"reviewer-comments{nn}.md"
        head_before = git_head(repo)
        log(f"[{idx}/{total}] {tid} — {task['title']}  (HEAD {head_before[:8]})")

        verdict = None
        rounds: list[dict] = []
        for rnd in range(1, args.rounds + 1):
            log(f"  {tid} coder round {rnd}/{args.rounds} ({args.coder_model}, {args.coder_thinking}, ctx {args.ctx})")
            cp = out / "prompts" / f"coder-{nn}-r{rnd}.md"
            cp.write_text(coder_prompt(task, repo, out_rel, rnd, reviewer_file if rnd > 1 and reviewer_file.exists() else None), encoding="utf-8")
            coder = run_pi(pi_cmd(args, args.coder_model, args.coder_thinking, cp.read_text()),
                           repo, out / "logs" / f"coder-{nn}-r{rnd}.log", args.timeout_coder)
            log(f"  {tid} coder round {rnd} done: exit={coder['exit']} timeout={coder['timeout']} {coder['elapsed_s']}s")
            if not coder_file.exists() and rnd == 1:
                write_if_missing(coder_file, f"# coder-comments{nn} (auto-captured)\n\n"
                                             f"pi stdout/stderr follow. exit={coder['exit']}.\n\n```\n"
                                             + coder["output"][-20000:] + "\n```\n")
            if coder["exit"] != 0 or coder["timeout"]:
                rounds.append({"round": rnd, "coder_exit": coder["exit"], "coder_timeout": coder["timeout"]})
                if rnd < args.rounds:
                    continue
                verdict = "FAIL"
                break

            log(f"  {tid} reviewer round {rnd} ({args.reviewer_model}, {args.reviewer_thinking})")
            rp = out / "prompts" / f"reviewer-{nn}-r{rnd}.md"
            rp.write_text(reviewer_prompt(task, repo, out_rel, coder_file, head_before), encoding="utf-8")
            rev = run_pi(pi_cmd(args, args.reviewer_model, args.reviewer_thinking, rp.read_text()),
                         repo, out / "logs" / f"reviewer-{nn}-r{rnd}.log", args.timeout_reviewer)
            v = parse_verdict(reviewer_file)
            log(f"  {tid} reviewer round {rnd} done: exit={rev['exit']} timeout={rev['timeout']} verdict={v} {rev['elapsed_s']}s")
            rounds.append({"round": rnd, "coder_exit": coder["exit"], "reviewer_exit": rev["exit"],
                           "reviewer_timeout": rev["timeout"], "verdict": v})
            verdict = v
            if v in ("PASS", "PASS-WITH-NITS"):
                break
            if v is None and rev["exit"] != 0:
                break

        rec = {
            "title": task["title"], "findings": task.get("findings", []),
            "status": "passed" if verdict in ("PASS", "PASS-WITH-NITS") else "failed",
            "verdict": verdict, "rounds": rounds, "head_before": head_before,
            "updated_at": now(),
        }
        if rec["status"] == "passed" and args.commit:
            sha = commit(repo, f"tau-web: fix {', '.join(task.get('findings', []))} — {task['title']} (review-loop {tid})")
            rec["commit"] = sha
            log(f"  {tid} committed {sha[:8] if sha else '(nothing to commit)'}")
        elif rec["status"] != "passed":
            rec["failed_work"] = preserve_failed(repo, out, tid)
            log(f"  {tid} failed work preserved: {rec['failed_work']}")
        state["tasks"][tid] = rec
        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        if rec["status"] != "passed" and args.stop_on_fail:
            log(f"  {tid} failed — stopping (--stop-on-fail)")
            break

    passed = sum(1 for v in state["tasks"].values() if v.get("status") == "passed")
    failed = [k for k, v in state["tasks"].items() if v.get("status") == "failed"]
    log(f"loop done: {passed} passed, {len(failed)} failed ({', '.join(failed) if failed else 'none'})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
