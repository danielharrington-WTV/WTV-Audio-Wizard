#!/usr/bin/env bash
# Starts the WTVAudioWizard service on Linux. The workspace (the folder that
# holds "work": environments, models, data) defaults to the folder containing
# this service folder; set WTV_WORKSPACE to use another.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
export WTV_WORKSPACE="${WTV_WORKSPACE:-$(cd .. && pwd)}"
PY="$WTV_WORKSPACE/work/service-env/bin/python"
if [ ! -x "$PY" ]; then
  echo "Service environment not found at $PY. Run: bash setup-linux.sh" >&2
  exit 1
fi
"$PY" -c "from service.app import TOKEN; print('Panel token: ' + TOKEN)"
exec "$PY" -m uvicorn service.app:app --host 127.0.0.1 --port 8756 --workers 1
