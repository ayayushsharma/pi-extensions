# pi-ctx-limit

Force **early** auto-compaction by lowering the effective context window:

```
model.contextWindow = min(manual_ctx_limit, original_contextWindow)
```

Pi compacts when context exceeds `contextWindow − compaction.reserveTokens`. The
extension changes only `contextWindow`, so Pi's **own** automatic compaction runs
earlier — same cut point, same keep-tail, same summary format, same file tracking,
and, crucially, the **same continuation** (Pi keeps the run going across the
compaction, exactly as it does for its stock threshold).

## Why not `ctx.compact()`?

`ctx.compact()` is the *manual* compaction path. It calls `AgentSession.abort()`
first and never continues the interrupted turn (Pi documents this explicitly:
"Manual compaction never retries or continues the interrupted agent turn"). A
watchdog built on it compacts and then leaves the agent stopped — the agent does
not continue. This extension therefore never calls `ctx.compact()`; it lets core's
automatic path do the work by shrinking the window core reads.

## Install

```bash
pi install ./ctx-limit
# once published:
# pi install npm:pi-ctx-limit
```

## Usage

```bash
# one run with a 128k cap
pi --extension ./ctx-limit/extensions/ctx-limit.ts --context-size 128000

# inside Pi
/ctx-status        # manual / model / effective / compacts-at / current usage
/ctx-set 64000     # session-only override (does not edit config files)
/ctx-set off       # disable for this session
/ctx-set clear     # drop the session override, back to config resolution
```

## Configuration

Precedence (highest wins):

```
 /ctx-set  >  --context-size  >  CTX_LIMIT_TOKENS  >
 project .pi/settings.json  >  agent ~/.pi/agent/settings.json
```

**Nothing is enabled by default.** With no manual limit configured anywhere, the
extension stays inert and Pi's own auto-compaction behaviour is untouched.

Settings-file block (agent or project scope):

```json
{
  "ctxLimit": {
    "maxTokens": 128000,
    "minTokens": 5000,
    "notify": true
  }
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `maxTokens` | *(unset)* | Manual limit. Absent = the extension does nothing. |
| `minTokens` | *(unset)* | Optional floor. When set, lower values are clamped (config) or refused (`/ctx-set`). |
| `notify` | `true` | `ctx.ui.notify()` when Pi compacts. |

Environment override: `CTX_LIMIT_TOKENS=64000 pi`.

The compaction **headroom** is Pi's own `compaction.reserveTokens` (default
`16384`) — set it in settings directly if you want to tune it. Only the effective
window is changed here.

## No-extension equivalent (one fixed model)

For a single known model window, core settings alone express the same trigger:

```json
{ "compaction": { "reserveTokens": 170000 } }
```

i.e. `reserveTokens = modelWindow − desiredLimit` (200000 − 128000). Per-model:
`compaction.modelOverrides`. The extension exists so `min()` is computed at
runtime across model switches instead of by hand.

## Notes

- Cross-platform: pure Node `fs`/`path`/`os` — no shell, no `child_process`, no `__dirname`. Works on macOS, Linux, Windows, and Termux. `PI_CODING_AGENT_DIR` supports `~` and relative paths, and `settings.json` files are read with a leading UTF-8 BOM stripped (common on Windows).
- The original window is remembered per `provider/id` and restored when the limit is disabled or the session ends — nothing is persisted, and switching models gives the old model its real window back.
- `keepRecentTokens`, the summary pipeline, and continuation are untouched — post-compact context is still summary + core's configured tail, and the run resumes the way stock Pi resumes it.
- A limit that leaves no room after Pi's reserve is **not** applied (with a note in `/ctx-status`) instead of compacting every turn.
- Re-asserted on `session_start`, `model_select`, and `before_agent_start` (the registry can swap the live model object without a `model_select`).
- **Virtual models:** Pi compacts against the physical model each request routes to, not the virtual model's declared window, so the cap is display-only for a virtual selection. Physical models are fully supported.
- Works in all modes; no status-bar / footer UI — use `/ctx-status` for usage.

## Development

```bash
pi -e .
rm -rf $TMPDIR/jiti   # after .ts changes, then restart Pi
```

## License

MIT
