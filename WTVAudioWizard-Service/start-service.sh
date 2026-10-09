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
echo "Workspace: $WTV_WORKSPACE"
"$PY" -c "from service.app import TOKEN; print('Panel token: ' + TOKEN)"
exec "$PY" -m uvicorn service.app:app --host 127.0.0.1 --port 8756 --workers 1
