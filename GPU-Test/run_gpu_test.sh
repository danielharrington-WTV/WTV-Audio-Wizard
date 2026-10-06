#!/usr/bin/env bash
# GAP-URGENet GPU test (Linux). Extra options are passed through, e.g.
#   ./run_gpu_test.sh --from-dir /data/gap-urgenet/checkpoints
#   ./run_gpu_test.sh --seconds 1 --channels 1
set -euo pipefail
cd "$(dirname "$0")"
for candidate in python3.12 python3.11 python3.10 python3.13 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && \
     "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then
    exec "$candidate" gpu_test.py "$@"
  fi
done
echo "Python 3.10 - 3.13 not found. Install it (plus python3-venv) and rerun." >&2
exit 1
