#!/usr/bin/env bash
# Keeps the WTVAudioWizard service running after the SSH session ends, without
# root: start | stop | restart | status. One process, one Uvicorn worker, the
# same launcher (start-service.sh, which reads WTV_HOST from service.env).
# Log: <workspace>/work/service.log. PID: <workspace>/work/service.pid.
# It does not start again after a reboot; run "start" again.
set -euo pipefail
SERVICE_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
if [ -z "${WTV_WORKSPACE:-}" ]; then
  folder="$(cd "$SERVICE_DIR/.." && pwd)"
  while :; do
    if [ -e "$folder/work/service-env/bin/python" ]; then WTV_WORKSPACE="$folder"; break; fi
    [ "$folder" = "/" ] && break
    folder="$(dirname "$folder")"
  done
  WTV_WORKSPACE="${WTV_WORKSPACE:-$(cd "$SERVICE_DIR/.." && pwd)}"
fi
export WTV_WORKSPACE
LOG="$WTV_WORKSPACE/work/service.log"
PIDFILE="$WTV_WORKSPACE/work/service.pid"

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'uvicorn service.app:app' && echo "$pid"
}

start() {
  if pid="$(running_pid)"; then echo "Already running (PID $pid)."; return 0; fi
  if pgrep -f 'uvicorn service.app:app' >/dev/null; then
    echo "A service is already running outside this script (PID $(pgrep -f 'uvicorn service.app:app' | tr '\n' ' ')). Stop it first (Ctrl+C in its terminal)." >&2
    return 1
  fi
  mkdir -p "$(dirname "$LOG")"
  echo "=== start $(date '+%F %T') ===" >> "$LOG"
  setsid nohup bash "$SERVICE_DIR/start-service.sh" >> "$LOG" 2>&1 < /dev/null &
  echo $! > "$PIDFILE"
  sleep 4
  if pid="$(running_pid)"; then echo "Started (PID $pid). Log: $LOG"; tail -n 6 "$LOG"; else echo "Did not start; see $LOG" >&2; tail -n 20 "$LOG" >&2; return 1; fi
}

stop() {
  if ! pid="$(running_pid)"; then echo "Not running (from this script)."; rm -f "$PIDFILE"; return 0; fi
  kill -TERM "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then echo "Still stopping after 30 s (PID $pid); check again or kill it." >&2; return 1; fi
  rm -f "$PIDFILE"; echo "Stopped."
}

status() {
  if pid="$(running_pid)"; then echo "Running (PID $pid)."; else echo "Not running (from this script)."; fi
  if command -v ss >/dev/null; then ss -ltnp 2>/dev/null | grep ':8756' || echo "Nothing listening on port 8756."; fi
  [ -f "$LOG" ] && tail -n 8 "$LOG"
  return 0
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) status ;;
  *) echo "Usage: bash scripts/service-ctl.sh start|stop|restart|status" >&2; exit 2 ;;
esac
