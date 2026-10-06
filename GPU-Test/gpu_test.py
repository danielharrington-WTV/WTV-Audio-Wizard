"""One-command GPU test for GAP-URGENet. Standard library only.

What it does:
  1. Reads your NVIDIA driver/GPU with nvidia-smi.
  2. Creates a private Python environment in GPU-Test/.venv (nothing global is touched).
  3. Installs a CUDA build of PyTorch that matches your driver, plus numpy + soundfile.
  4. Downloads (or copies) the ~2.34 GB of checkpoints and verifies SHA-256.
  5. Runs benchmark.py and saves a JSON report in GPU-Test/results/.

Usage (run_gpu_test.bat / run_gpu_test.sh call this for you):
    python gpu_test.py
    python gpu_test.py --from-dir "D:\\GAP-URGENet\\checkpoints"   # copy weights you already have
    python gpu_test.py --seconds 1 --channels 1                    # extra args go to benchmark.py
"""
import argparse
import os
from pathlib import Path
import platform
import re
import subprocess
import sys

HERE = Path(__file__).resolve().parent
VENV = HERE / '.venv'
TORCH_INDEX = 'https://download.pytorch.org/whl/'
DEFAULT_TORCH = '2.11.0'   # the version validated with this model on an RTX 5080 (cu128)


def say(msg):
    print(f'[gpu-test] {msg}', flush=True)


def fail(msg):
    print(f'\n[gpu-test] ERROR: {msg}\n', flush=True)
    sys.exit(1)


def gpu_info():
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total,compute_cap',
                              '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        fail('nvidia-smi was not found. This test needs an NVIDIA GPU with the NVIDIA driver installed.')
    rows = [r for r in out.stdout.strip().splitlines() if r.strip()]
    if out.returncode or not rows:
        fail(f'nvidia-smi did not report a GPU:\n{out.stdout}{out.stderr}')
    name, driver, mem, cc = [p.strip() for p in rows[0].split(',')]
    try:
        cc = float(cc)
    except ValueError:
        cc = None
    return {'name': name, 'driver': driver, 'memory_mib': mem, 'compute_cap': cc, 'count': len(rows)}


def pick_cuda_wheel(driver, cc):
    """Choose the PyTorch CUDA flavour for this driver. Returns (tag, torch_version)."""
    major = float(re.match(r'(\d+(?:\.\d+)?)', driver).group(1))
    blackwell = cc is not None and cc >= 10.0
    if major >= 570:
        return 'cu128', DEFAULT_TORCH
    if blackwell:
        fail(f'Your GPU (compute capability {cc}) needs NVIDIA driver 570 or newer; you have {driver}. '
             'Update the driver from nvidia.com and rerun.')
    if major >= 528:        # CUDA 12.x minor-version compatibility floor (Windows 528.33 / Linux 525.60)
        return 'cu126', DEFAULT_TORCH
    if major >= 452:        # CUDA 11.8 minor-version compatibility floor; newest torch with cu118 wheels
        return 'cu118', '2.7.1'
    fail(f'NVIDIA driver {driver} is too old for current PyTorch. Please update the driver and rerun.')


def venv_python():
    return VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def run(cmd, **kw):
    say(' '.join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], **kw)


def probe_torch(py):
    code = ('import json,torch;ok=torch.cuda.is_available();'
            'cc=torch.cuda.get_device_capability(0) if ok else None;'
            'arch=torch.cuda.get_arch_list() if ok else [];'
            'print(json.dumps({"v":torch.__version__,"cuda":torch.version.cuda,"ok":ok,'
            '"sm":("sm_%d%d"%cc) if cc else None,"arch":arch}))')
    out = subprocess.run([str(py), '-c', code], capture_output=True, text=True)
    if out.returncode:
        return None
    import json
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None


def ensure_env(args, gpu):
    if args.use_current_python:
        return Path(sys.executable)
    py = venv_python()
    if not py.exists():
        say(f'Creating private Python environment in {VENV}')
        if run([sys.executable, '-m', 'venv', VENV]).returncode:
            fail('Could not create a virtual environment (on Linux: install python3-venv).')
    tag, version = pick_cuda_wheel(gpu['driver'], gpu['compute_cap'])
    if args.torch_cuda:
        tag = args.torch_cuda
    if args.torch_version:
        version = args.torch_version
    state = None if args.reinstall_torch else probe_torch(py)
    good = state and state['ok'] and (not state['sm'] or state['sm'] in state['arch'] or
                                      any(a.startswith('compute_') for a in state['arch']))
    if good:
        say(f'PyTorch {state["v"]} (CUDA {state["cuda"]}) already installed and sees the GPU.')
    else:
        say(f'Installing PyTorch {version} for {tag} (about 2.5-3 GB download) ...')
        cmd = [py, '-m', 'pip', 'install', '--disable-pip-version-check', f'torch=={version}',
               '--index-url', TORCH_INDEX + tag]
        if args.reinstall_torch:
            cmd.insert(4, '--force-reinstall')
        if run(cmd).returncode:
            say(f'torch=={version} not available for {tag}; trying the newest torch for {tag} ...')
            cmd[cmd.index(f'torch=={version}')] = 'torch'
            if run(cmd).returncode:
                fail(f'Could not install PyTorch for {tag}. Check your internet connection / Python version '
                     f'(3.10-3.13 recommended). You are on Python {platform.python_version()}.')
    if run([py, '-m', 'pip', 'install', '--disable-pip-version-check', '-r', HERE / 'requirements.txt']).returncode:
        fail('Could not install numpy/soundfile.')
    state = probe_torch(py)
    if not state or not state['ok']:
        fail('PyTorch installed but cannot use the GPU. Try: run_gpu_test --reinstall-torch')
    return py


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--from-dir', help='copy checkpoints from this local folder instead of downloading')
    ap.add_argument('--base-url', help='download checkpoints from this URL prefix instead of the default')
    ap.add_argument('--torch-cuda', choices=['cu118', 'cu126', 'cu128', 'cu129', 'cu130'],
                    help='force a PyTorch CUDA flavour (default: chosen from your driver)')
    ap.add_argument('--torch-version', help=f'force a torch version (default {DEFAULT_TORCH})')
    ap.add_argument('--reinstall-torch', action='store_true', help='reinstall PyTorch even if one works')
    ap.add_argument('--use-current-python', action='store_true',
                    help='skip the .venv and use this Python as-is (it must already have CUDA torch, numpy, soundfile)')
    args, bench_args = ap.parse_known_args()

    if sys.version_info < (3, 10):
        fail(f'Python 3.10+ is required (you have {platform.python_version()}).')
    if sys.version_info >= (3, 14):
        say(f'Warning: Python {platform.python_version()} is newer than what this test was validated on (3.10-3.13).')

    gpu = gpu_info()
    say(f'GPU: {gpu["name"]}  |  driver {gpu["driver"]}  |  {gpu["memory_mib"]} MiB  |  compute {gpu["compute_cap"]}')

    sys.path.insert(0, str(HERE))
    import fetch_checkpoints
    if not fetch_checkpoints.fetch(base_url=args.base_url, from_dir=args.from_dir):
        fail('Checkpoints are missing or corrupt; see messages above.')

    py = ensure_env(args, gpu)
    say('Running benchmark ...')
    code = run([py, HERE / 'benchmark.py', *bench_args], cwd=HERE).returncode
    sys.exit(code)


if __name__ == '__main__':
    main()
