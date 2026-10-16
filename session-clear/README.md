# pi-session-clear

True session wipe for Pi. `/new` starts a new session but leaves the old
session file on disk (still resumable via the picker). `/clear` deletes the
current session file and starts fresh — no history survives.

## Install

```bash
pi install ./session-clear        # local path
```

Or iterate on a single file without installing:

```bash
pi --extension ./session-clear/extensions/clear.ts
```

## Usage

- `/clear` — confirm, then delete the current session file and start fresh.
- `/clear --force` (or `-f`) — skip the confirmation.
- In non-interactive modes (`--print`, `--mode json`, RPC without UI),
  `/clear` refuses unless `--force` is given.

## Behavior notes

- The old file path is captured **before** switching; deletion happens only
  inside `withSession`, i.e. after the new session is active. A cancelled
  switch therefore never loses history.
- If the current session is ephemeral (`--no-session`, no file on disk),
  `/clear` just starts a fresh session and says so.
- Deletion uses `unlink` on the exact session file — the new session's file
  is never touched (paths are compared before deleting).
