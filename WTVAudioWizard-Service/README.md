# WTVAudioWizard-Service

The audio service for the WTVAudioWizard Premiere panel: an authenticated FastAPI job service plus the GPU model workers. It was split out of the `WTVAudioWizard` folder on 2026-10-05 so it can be deployed on its own. The panel (`WTVAudioWizard/plugin`) talks to it only over HTTP; nothing here needs the plugin's files, and the plugin needs nothing from here.

Status: runs on Windows (Dan's RTX 5080 PC). Linux (Debian) start and install scripts were added on 2026-10-05; the service itself is tested on Linux, the model environments have not yet been installed on a Linux GPU machine. See the plan at the top of `WTVAudioWizard/HANDOFF.md`.

## Contents

- `service/`: the job service (uploads, jobs, cache, levelling, de-ess, music analysis, quality check, progress).
- `runners/`: Bandit v2, MossFormer2, GAP-URGENet and Sidon workers, started by the service in each model's own Python environment.
- `scripts/`: `setup_linux.py` (Linux installer behind `setup-linux.sh`), `setup_sidon.py` (Windows installer behind `setup-sidon.bat`) and `validate_restore.py` / `validate-restore.bat` (end-to-end GPU check of Rebuild Speech; pass a WAV file).
- `requirements/`: exact package lists for the model environments, copied from the working Windows environments.
- `vendor/gap-urgenet-overlay/`: the two GAP-URGENet model files that differ from upstream on the Windows PC.
- `tests/`: Python tests.
- `requirements.lock.txt`: packages for the service's own environment (Python 3.12).
- `start-service.ps1` / `start-service.sh`: start the service on Windows / Linux.
- `local-config.json`: this machine's model environments, checkpoints and pinned checksums. Per machine and not committed; `local-config.example.json` shows the shape.

## Per-machine pieces

These stay outside this folder and are never copied between machines:

- Workspace: `<workspace>/work`. The workspace is the nearest folder above this one that has `work/service-env`, so this folder can sit beside the plugin, inside it, or deeper. If none exists yet it is two folders up on Windows and the folder containing this one on Linux. `WTV_WORKSPACE` overrides all of this. The start scripts print the workspace they chose (`service/workspace.py` holds the rule). It holds `service-env` (the service's Python environment), `sidon-env`, `sidon-models`, and by default the data folder.
- Data folder: `<workspace>/work/wtv-data` (uploads, jobs, stage cache, pairing token, model speed history). `WTV_DATA_DIR` overrides it.
- Storage cleanup: anything in the data folder not used for `retention_days` (in `local-config.json`; default 14, the Debian installer sets 7 for the shared machine, 0 = keep everything) is removed at service start and then hourly while no job is running: finished jobs with their results, uploads no remaining job uses, dialogue-cache entries, and crash leftovers older than a day. "Used" means created, reused, downloaded or hit in the cache. Never removed: queued or running jobs and their uploads, uploads being analysed, the pairing token and the speed history. The panel's own copies of results (the project export folder Premiere imports) are outside the service and never touched; a cleaned-up job is simply processed again on rerun. The service window prints one line per cleanup. To see what would go without deleting anything: `python -m service.storage_cleanup` (with the service's Python, from this folder; `--days N` to try another value). Code: `service/storage_cleanup.py`.
- Fresh jobs: a job submitted with `"fresh": true` (the panel's "Don't use cached files") is never answered with an earlier job and ignores stage-cache hits; its results replace the cached ones. A final job that needs the dialogue pass its own stage job just made still reads it. Advertised as capability `fresh_jobs_v1`. `max_boost_db` and `enhancer_wet` (raw blend) were already settings; the panel now sends both.
- Configuration: `local-config.json` in this folder. `WTV_CONFIG` overrides it.

## Start (Windows)

```powershell
& '.\start-service.ps1'
```

It prints the panel token and listens on `http://127.0.0.1:8756`. In the panel, enter that address and token and click Connect.

To create the service environment: make a Python 3.12 virtual environment at `<workspace>\work\service-env` and install `requirements.lock.txt`. The model environments are referenced by `local-config.json`. Rebuild Speech's model is installed by double-clicking `setup-sidon.bat` (needs an NVIDIA GPU).

## Install and start (Debian)

1. Install the NVIDIA driver (Debian: enable `contrib non-free non-free-firmware`, then `sudo apt install nvidia-driver`, reboot) and check that `nvidia-smi` shows the card.
2. `sudo apt install python3 python3-venv git build-essential`
3. Copy this folder to the machine, for example to `~/wtv/WTVAudioWizard-Service`. Do not copy `local-config.json` from another machine.
4. `bash setup-linux.sh`
5. `bash start-service.sh`

`setup-linux.sh` creates four Python environments under `<workspace>/work`, clones GAP-URGENet and Bandit v2 at the commits the Windows PC uses, downloads the weights, checks every weight file against its pinned SHA-256 and writes `local-config.json`. It needs internet access to PyPI, download.pytorch.org, GitHub, huggingface.co and zenodo.org, and roughly 30 GB of free disk space. It can be run again; finished steps are skipped.

- `bash setup-linux.sh --plan` prints every step without changing anything.
- `--only service sidon` installs just those parts (`service`, `gap_urgenet`, `bandit_v2`, `mossformer2`, `sidon`).
- `--from-dir /path` copies weight files from a folder (for example a USB drive filled from the Windows PC) instead of downloading them. Hashes are still checked.
- The PyTorch build follows the NVIDIA driver: 570 or newer gets `cu128`, 528 to 569 gets `cu126`. `--cuda` overrides it.

The environments use Python 3.10 and 3.12, which the installer fetches itself (through `uv`); the system Python only runs the installer.

## Tests

```powershell
& ..\..\work\service-env\Scripts\python.exe -m pytest tests -q
```

On Linux: `../work/service-env/bin/python -m pytest tests -q`

Two music tests fail on every machine so far (`test_music_peak_guard_stops_clipping_without_rendering_new_media`, `test_music_analysis_and_temporary_asset_cleanup`); they failed before the split too. Tests that need real-audio fixtures or PyTorch skip when those are absent.

## Notes

- The service accepts connections from this machine only (bind address and Host check). Office-network access is planned, not built.
- The stage cache key includes this folder's path, so the first run after moving the folder reprocesses clips once instead of reusing cached model output.
