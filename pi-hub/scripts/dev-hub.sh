#!/usr/bin/env bash
# Dev hub on the LAN without auth — TEST ONLY. Never use for the public tunnel.
#
#   scripts/dev-hub.sh start|stop|restart|status [port]
#
# Singleton (ADR-021): the dev hub shares the default advert file, so it
# refuses to start while the prod hub is up (and vice versa) — stop one
# first. A custom PI_HUB_ADVERT_FILE would scope it apart, but then mirrors
# and browsers no longer converge on one hub, which is the point.
#
# Binds to the machine's primary LAN IPv4 (not 0.0.0.0), serves the UI with
# auth disabled, and keeps a pid + log under /tmp. Use `PI_HUB_ALLOW_ANY_HOST=1`
# only if the UI must be reachable by hostname.
set -u
PORT="${2:-8292}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="/tmp/pi-hub-dev-$PORT.pid"
OUTFILE="/tmp/pi-hub-dev-$PORT.log"
HUBDIR="/tmp/pi-hub-dev-$PORT"
PI_BIN="${PI_BIN:-$HOME/.pi/agent/bin/pi}"

lan_ip() {
  ip -4 addr show 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {sub(/\/.*/, "", $2); print $2; exit}'
}

stop() {
  if [ -f "$PIDFILE" ]; then
    PID=$(cat "$PIDFILE")
    pkill -P "$PID" 2>/dev/null
    kill "$PID" 2>/dev/null
    rm -f "$PIDFILE"
    echo "stopped (pid $PID)"
  else
    echo "not running"
  fi
}

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "already running on pid $(cat "$PIDFILE")"
    return 0
  fi
  IP=$(lan_ip)
  if [ -z "$IP" ]; then echo "no LAN IPv4 found; set PI_HUB_HOST manually" >&2; exit 1; fi
  mkdir -p "$HUBDIR"
  rm -rf "$HUBDIR/jiti" 2>/dev/null
  nohup sh -c "tail -f /dev/null | env \
    TAU_DISABLED=1 \
    PI_HUB_PORT=$PORT PI_HUB_HOST=$IP \
    PI_HUB_DIR=$HUBDIR PI_HUB_LOG_FILE=$HUBDIR/hub.log \
    PI_HUB_STATIC_DIR=$ROOT/public PI_HUB_PI_BIN=$PI_BIN \
    pi -e $ROOT --mode rpc" > "$OUTFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do
    if curl -s -m 2 "http://$IP:$PORT/api/health" >/dev/null 2>&1; then
      echo "pi-hub dev on http://$IP:$PORT  (pid $(cat "$PIDFILE"), auth off, log $HUBDIR/hub.log)"
      return 0
    fi
    sleep 0.5
  done
  echo "failed to start; see $OUTFILE" >&2
  tail -5 "$OUTFILE" >&2
  exit 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 0.5; start ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running pid $(cat "$PIDFILE") on port $PORT ($(lan_ip))"
    else
      echo "not running"
    fi
    ;;
  *) echo "usage: $0 start|stop|restart|status [port]" >&2; exit 1 ;;
esac
