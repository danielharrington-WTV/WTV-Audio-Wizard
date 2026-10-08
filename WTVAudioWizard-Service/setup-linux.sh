#!/usr/bin/env bash
# Installs the WTVAudioWizard service on Debian/Ubuntu: Python environments,
# model code and model weights, then writes local-config.json. Safe to run
# again; finished steps are skipped. Options are passed to scripts/setup_linux.py
# (try --help, or --plan to see what it would do).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
missing=()
command -v python3 >/dev/null 2>&1 || missing+=(python3)
python3 -c 'import venv, ensurepip' >/dev/null 2>&1 || missing+=(python3-venv)
command -v git >/dev/null 2>&1 || missing+=(git)
command -v gcc >/dev/null 2>&1 || missing+=(build-essential)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing: ${missing[*]}" >&2
  echo "Install with: sudo apt install ${missing[*]}" >&2
  exit 1
fi
exec python3 scripts/setup_linux.py "$@"
