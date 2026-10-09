"""Install Sidon speech restoration for the WTVAudioWizard service. Standard library only.

Run on the machine that runs the service (it needs an NVIDIA GPU), usually by
double-clicking setup-sidon.bat. Safe to run again; finished steps are skipped.

  1. Checks the NVIDIA GPU with nvidia-smi.
  2. Creates a private Python environment in <workspace>/work/sidon-env with
     PyTorch 2.8.0 + torchaudio for CUDA 12.8 (RTX 50-series capable).
  3. Puts Sidon's two TorchScript files (sarulab-speech/sidon-v0.1, MIT,
     pinned revision) in <workspace>/work/sidon-models. Copies them from
     Derev-Test/models if that test already downloaded them, otherwise
     downloads about 1 GB from Hugging Face.
  4. Records the files' SHA-256 and adds a "sidon" entry to local-config.json
     (the old file is kept as local-config.json.bak-<time>). The service checks
     these hashes before every model load.
  5. Restores 3 seconds of test audio on the GPU to prove it works.

Then restart the service and reconnect the panel.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from service.workspace import find_workspace  # noqa: E402  (standard library only)
# Environments and models live in <workspace>/work (see service/workspace.py).
WORKSPACE = find_workspace(PROJECT)
ENV = WORKSPACE / 'work' / 'sidon-env'
MODELS = WORKSPACE / 'work' / 'sidon-models'
CONFIG = Path(os.environ.get('WTV_CONFIG', PROJECT / 'local-config.json'))
REPO = 'sarulab-speech/sidon-v0.1'
REVISION = 'b3b02d8bbd55fdbc410e6e46e76ef95ace4fbf52'
FILES = ('feature_extractor_cuda.pt', 'decoder_cuda.pt')
TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
TORCH = ['torch==2.8.0', 'torchaudio==2.8.0']
PACKAGES = ['numpy>=1.26', 'soundfile>=0.12']


def say(msg):
    print(f'[setup-sidon] {msg}', flush=True)


def fail(msg):
    print(f'\n[setup-sidon] ERROR: {msg}\n', flush=True)
    sys.exit(1)


def run(cmd, **kw):
    say(' '.join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], **kw)


def env_python():
    return ENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as file:
        for block in iter(lambda: file.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def gpu_name():
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version', '--format=csv,noheader'],
                             capture_output=True, text=True, timeout=30)
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


def torch_ok(py):
    code = 'import torch,torchaudio;print(torch.__version__, torch.cuda.is_available())'
    out = subprocess.run([str(py), '-c', code], capture_output=True, text=True)
    parts = out.stdout.split()
    return out.returncode == 0 and len(parts) == 2 and parts[0].startswith('2.8.0') and parts[1] == 'True'


def install_env():
    py = env_python()
    if not py.exists():
        say(f'Creating private Python environment in {ENV}')
        ENV.parent.mkdir(parents=True, exist_ok=True)
        if run([sys.executable, '-m', 'venv', ENV]).returncode:
            fail('Could not create a virtual environment.')
    if torch_ok(py):
        say('PyTorch 2.8.0 with CUDA already installed.')
    else:
        say('Installing PyTorch 2.8.0 + torchaudio for CUDA 12.8 (about 3 GB download) ...')
        if run([py, '-m', 'pip', 'install', '--disable-pip-version-check', *TORCH, '--index-url', TORCH_INDEX]).returncode:
            fail('Could not install PyTorch. Check the internet connection.')
    if run([py, '-m', 'pip', 'install', '--disable-pip-version-check', *PACKAGES]).returncode:
        fail('Could not install numpy/soundfile.')
    if not torch_ok(py):
        fail('PyTorch is installed but cannot see the GPU. Update the NVIDIA driver and run this again.')
    return py


def fetch_models():
    MODELS.mkdir(parents=True, exist_ok=True)
    derev = PROJECT / 'Derev-Test' / 'models' / 'hf' / f'models--{REPO.replace("/", "--")}' / 'snapshots' / REVISION
    for name in FILES:
        target = MODELS / name
        if target.is_file() and target.stat().st_size > 0:
            say(f'{name}: already present.')
            continue
        temp = target.with_suffix('.part')
        cached = derev / name
        if cached.is_file():
            say(f'{name}: copying from Derev-Test ...')
            shutil.copyfile(cached, temp)
        else:
            url = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}'
            say(f'{name}: downloading {url} ...')
            try:
                with urllib.request.urlopen(url, timeout=120) as response, open(temp, 'wb') as file:
                    total = int(response.headers.get('Content-Length') or 0)
                    done, shown = 0, -1
                    for block in iter(lambda: response.read(1 << 20), b''):
                        file.write(block)
                        done += len(block)
                        pct = int(100 * done / total) if total else -1
                        if pct != shown and pct % 10 == 0:
                            say(f'  {pct}% of {total / 2**20:.0f} MB')
                            shown = pct
            except OSError as error:
                temp.unlink(missing_ok=True)
                fail(f'Could not download {name}: {error}')
        temp.replace(target)
    hashes = {}
    for name in FILES:
        say(f'Hashing {name} ...')
        hashes[name] = sha256(MODELS / name)
    return hashes


def write_config(py, hashes):
    config = json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else {}
    entry = {'python': str(py), 'models': str(MODELS), 'checkpoint_hashes': hashes,
             'source': f'https://huggingface.co/{REPO}', 'revision': REVISION}
    if config.get('sidon') == entry:
        say('local-config.json already has this Sidon entry.')
        return
    if CONFIG.exists():
        backup = CONFIG.with_name(f'{CONFIG.name}.bak-{time.strftime("%Y%m%d-%H%M%S")}')
        shutil.copyfile(CONFIG, backup)
        say(f'Backed up the old config to {backup.name}')
    config['sidon'] = entry
    temp = CONFIG.with_suffix('.tmp')
    temp.write_text(json.dumps(config, indent=2), encoding='utf-8')
    temp.replace(CONFIG)
    say(f'Added "sidon" to {CONFIG}')


def smoke_test(py):
    say('Test: restoring 3 seconds of audio on the GPU ...')
    code = (
        'import sys, tempfile, runpy, json\n'
        'from pathlib import Path\n'
        'import numpy as np, soundfile as sf\n'
        'runner, models = sys.argv[1], sys.argv[2]\n'
        'folder = Path(tempfile.mkdtemp())\n'
        'rate = 48000\n'
        't = np.arange(3 * rate) / rate\n'
        'x = (0.1 * np.sin(2 * np.pi * 180 * t) * (1 + np.sin(2 * np.pi * 3 * t)) / 2).astype(np.float32)\n'
        "sf.write(folder / 'in.wav', x, rate, subtype='FLOAT')\n"
        "sys.argv = [runner, '--input', str(folder / 'in.wav'), '--output', str(folder / 'out.wav'), '--models', models]\n"
        "runpy.run_path(runner, run_name='__main__')\n"
        "y, sr = sf.read(folder / 'out.wav', dtype='float32')\n"
        "report = json.loads((folder / 'out.json').read_text())\n"
        "assert sr == rate and len(y) == len(x) and np.isfinite(y).all(), 'bad output'\n"
        "print('SMOKE_OK', round(report['elapsed_seconds'], 2), round(report['peak_allocated_mib']))\n"
    )
    out = subprocess.run([str(py), '-c', code, str(PROJECT / 'runners' / 'sidon.py'), str(MODELS)],
                         capture_output=True, text=True)
    lines = [line for line in out.stdout.splitlines() if not line.startswith('{')]
    if out.returncode or not any(line.startswith('SMOKE_OK') for line in lines):
        print(out.stdout[-3000:], out.stderr[-3000:], sep='\n')
        fail('The GPU test failed; see the messages above.')
    _, seconds, mib = next(line for line in lines if line.startswith('SMOKE_OK')).split()
    say(f'Test passed: {seconds} s including model load, {mib} MiB VRAM.')


def main():
    if sys.version_info < (3, 10):
        fail('Python 3.10 or newer is required.')
    gpu = gpu_name()
    if not gpu:
        fail('nvidia-smi did not report a GPU. Sidon needs an NVIDIA GPU on the service machine.')
    say(f'GPU: {gpu}')
    py = install_env()
    hashes = fetch_models()
    smoke_test(py)
    write_config(py, hashes)
    say('Done. Restart the service (start-service.ps1), then click Connect in the panel. Restore Speech is ready.')


if __name__ == '__main__':
    main()
