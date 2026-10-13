#!/usr/bin/env bash
# Starts the WTVAudioWizard service on Linux. The workspace (the folder that
# holds "work": environments, models, data) is WTV_WORKSPACE if set, otherwise
# the nearest folder above this one with work/service-env, otherwise the folder
# containing this one. Same rule as service/workspace.py.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
if [ -z "${WTV_WORKSPACE:-}" ]; then
  folder="$(cd .. && pwd)"
  while :; do
    if [ -e "$folder/work/service-env/bin/python" ]; then WTV_WORKSPACE="$folder"; break; fi
    [ "$folder" = "/" ] && break
    folder="$(dirname "$folder")"
  done
  WTV_WORKSPACE="${WTV_WORKSPACE:-$(cd .. && pwd)}"
fi
export WTV_WORKSPACE
PY="$WTV_WORKSPACE/work/service-env/bin/python"
if [ ! -x "$PY" ]; then
  echo "Service environment not found at $PY. Run: bash setup-linux.sh" >&2
  exit 1
fi
# Listening address: WTV_HOST if set, else WTV_HOST in service.env beside this
# script (a one-line, git-ignored local setting, e.g. WTV_HOST=192.168.0.176 on
# the GPU server), else 127.0.0.1 (this computer only). There is no pairing
# token: the service itself accepts only loopback and private-LAN clients.
if [ -z "${WTV_HOST:-}" ] && [ -f service.env ]; then
  WTV_HOST="$(sed -n 's/^[[:space:]]*WTV_HOST[[:space:]]*=[[:space:]]*\([^[:space:]#]*\).*/\1/p' service.env | tail -n 1)"
fi
WTV_HOST="${WTV_HOST:-127.0.0.1}"
if ! printf '%s' "$WTV_HOST" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  echo "WTV_HOST must be an IPv4 address (got '$WTV_HOST')." >&2
  exit 1
fi
echo "Workspace: $WTV_WORKSPACE"
echo "Service URL for the panel: http://$WTV_HOST:8756 (no token needed)"
# One worker only (jobs and models live in this process). No proxy headers, so
# the client address the service checks is the real socket peer.
exec "$PY" -m uvicorn service.app:app --host "$WTV_HOST" --port 8756 --workers 1 --no-proxy-headers
