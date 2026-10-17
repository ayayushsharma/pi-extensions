# pi-hub deployment (Termux / runit, myserver)

Mirrors the existing `tau-web` service layout in
`myserver/stow/services/`, with pi-hub env names. The hub runs as a
supervised runit service on `127.0.0.1:12045`; remote access only through
the cloudflared tunnel and always behind cookie auth.

## Files

```text
deploy/runit/run          # service run script (copy to $PREFIX/var/service/pi-hub/run)
deploy/runit/log/run      # svlogd logger
```

Stow them like the tau-web service:

```sh
# on the phone, from the myserver checkout
cp -r deploy/runit "$PREFIX/var/service/pi-hub"     # or stow/services/pi-hub
chmod +x "$PREFIX/var/service/pi-hub/run" "$PREFIX/var/service/pi-hub/log/run"
```

`~/.env` (mode 600) must provide at least:

```sh
PI_HUB_USER=...
PI_HUB_PASS=...
# optional: PI_HUB_PORT, PI_HUB_MAX_HEADLESS (default 3 in the run script)
```

## Runtime assumptions (learned on the F12)

- `pi` MUST be exec'd via `node $BUNDLE` — runsv has no LD_PRELOAD and
  Android has no `/usr/bin/env`, so a bare `pi` shebang dies with ENOENT.
  The run script does this for the hub and sets
  `PI_HUB_PI_BIN=$HOME/scripts/pi-node.sh` for headless children.
- `pi --mode rpc` treats stdin EOF as orderly shutdown and runsv gives
  `/dev/null`, so the script feeds a FIFO held by a `sleep infinity`
  sibling and waits on the hub pid only.
- The canonical port is asserted free before binding: the tunnel points at
  `:12045`, so a silent port bump would be an outage. `sv restart pi-hub`
  retries.
- `TAU_DISABLED=1` keeps an installed tau-web inert while both packages
  are present; children also get `PI_HUB_DISABLED=1` from the hub.

## Flip from tau-web (and rollback)

```sh
sv down tau-web
sv up pi-hub         # or: sv restart pi-hub after installing the service
sv status pi-hub
curl -s http://127.0.0.1:12045/api/health    # expect mode:"hub"
```

Then remove `tau-web` from `~/.pi/agent/settings.json` `packages` and
restart the TUI. Rollback is the reverse: `sv down pi-hub && sv up tau-web`
(no files are deleted either way).

## Verify

- `pi.sharmaayush.com` serves the login overlay, then the UI.
- A live TUI (any `pi -e pi-hub` process) appears under **Live terminal
  sessions**; preview → Attach & Drive works.
- History loads from the phone's own session store.
- `node pi-hub/tests/run.mjs --firefox` runs the cross-platform smoke on
  the phone when system Firefox is installed (`pkg install firefox
  ttf-dejavu`).
