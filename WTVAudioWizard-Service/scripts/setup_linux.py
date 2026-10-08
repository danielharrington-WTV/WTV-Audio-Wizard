"""Install the WTVAudioWizard service on a Linux GPU machine (written for Debian).

Creates the Python environments, fetches the model code and weights, checks
every weight file against its pinned SHA-256, and writes local-config.json.
Standard library only. Safe to run again: finished steps are skipped.

    bash setup-linux.sh                      # everything
    bash setup-linux.sh --plan               # show what would be done, change nothing
    bash setup-linux.sh --only service sidon # just these parts
    bash setup-linux.sh --from-dir /media/usb/weights   # copy weights instead of downloading

Layout (workspace = WTV_WORKSPACE, default: the folder containing this service folder):

    <workspace>/work/tools-env        uv, used to create the environments
    <workspace>/work/service-env      the service itself (Python 3.12)
    <workspace>/work/gapurgenet-env   GAP-URGENet and Bandit v2 (Python 3.10)
    <workspace>/work/clearvoice-env   MossFormer2 (Python 3.10)
    <workspace>/work/sidon-env        Rebuild Speech (Python 3.12)
    <workspace>/work/repos, checkpoints, mossformer-runtime, sidon-models
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = Path(os.environ.get('WTV_WORKSPACE') or PROJECT.parent).resolve()
WORK = WORKSPACE / 'work'
CONFIG = Path(os.environ.get('WTV_CONFIG') or PROJECT / 'local-config.json')
PARTS = ('service', 'gap_urgenet', 'bandit_v2', 'mossformer2', 'sidon')
CHUNK = 4 * 2**20

# Model code, pinned to what the Windows PC runs.
GAP_REPO = ('https://github.com/Xiaobin-Rong/gap-urgenet.git', 'fbf467378fbfd27dd8fd8d0318c05a98eb926705')
BANDIT_REPO = ('https://github.com/kwatcharasupat/bandit-v2.git', 'd5563d9031e95fdaa3e5a73d5020b9a0df61adb6')

# Weights: (url, bytes or None, sha256). A wrong hash is never accepted.
GAP_HF = 'https://huggingface.co/Xiaobin-Rong/gap-urgenet/resolve/f1916ff86b83777e2c3e7ecae8752a04b8d88d41/'
GAP_FILES = {
    'DeWavLM-Omni.pt': (1261995206, '117a0ced06a2ccc41f5766bcc8da6aa43f98fdc336feb5997a5e5dfea1426738'),
    'Adapter.pt': (520092014, '63473a9f764e4a97971530e4d7b987f9472d7b431aee6a982f25f91bcb4d48c6'),
    'Vocoder.pt': (454994736, '6881d02168698de3d1083becb6b0c30d4468323f8cfed61f02afb675f4fd81b0'),
    'Predictor.pt': (88469158, '1e58c270c12ab953e4df32a34e4b580f780d016bee9bf5580684d6c982f77866'),
    'PostNet.pt': (19170170, 'd401c7572451341d1482bf35a1bc2c590b9fe8c21d17f0b4b1268e0d88d1c066'),
    'config.json': (33, 'faba0c6f14ef6066eebf93568c4914e70d03ab66fc9c969b796aed5067bc8371'),
}
BANDIT_URL = 'https://zenodo.org/records/12701995/files/checkpoint-multi.ckpt?download=1'
BANDIT_FILE = ('bandit-v2-multi.ckpt', 446680129, 'abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc')
BANDIT_ALIASES = ('bandit-v2-multi.ckpt', 'checkpoint-multi.ckpt')
MOSS_URL = 'https://huggingface.co/alibabasglab/MossFormer2_SE_48K/resolve/eff8c97925c8bec812af707814b3e5d777fd4503/last_best_checkpoint.pt'
MOSS_FILE = ('last_best_checkpoint.pt', 221552019, '03692b9f773bbd6bb43b9c5a41f96b1e28affd66e13796b7bec66ad3d8b227c6')
SIDON_REVISION = 'b3b02d8bbd55fdbc410e6e46e76ef95ace4fbf52'
SIDON_HF = f'https://huggingface.co/sarulab-speech/sidon-v0.1/resolve/{SIDON_REVISION}/'
SIDON_FILES = {
    'feature_extractor_cuda.pt': (None, 'c3739c332da4ce00cc9019a328bcb19ee8f863ac5eb0b52386672772aab836ce'),
    'decoder_cuda.pt': (None, 'a789c71f54ca7db4b28becdc87c5e8b9260cb568cca462d502c54900db74a1cc'),
}

# Environments: name -> (python, torch packages, pinned list, import check).
ENVS = {
    'service-env': ('3.12', None, 'requirements.lock.txt',
                    'import fastapi, uvicorn, numpy, scipy, soundfile, pyloudnorm, onnxruntime'),
    'gapurgenet-env': ('3.10', ['torch==2.11.0', 'torchaudio==2.11.0'], 'requirements/gapurgenet.txt',
                       'import torch, torchaudio, espnet2, librosa, yaml, soundfile, einops'),
    'clearvoice-env': ('3.10', ['torch==2.7.1', 'torchaudio==2.7.1', 'torchvision==0.22.1'], 'requirements/clearvoice.txt',
                       'import torch, torchaudio, soundfile; from clearvoice import ClearVoice'),
    'sidon-env': ('3.12', ['torch==2.8.0', 'torchaudio==2.8.0'], 'requirements/sidon.txt',
                  'import torch, torchaudio, numpy, soundfile'),
}
PLAN = False


def say(message):
    print(f'[setup] {message}', flush=True)


def fail(message):
    print(f'\n[setup] ERROR: {message}\n', flush=True)
    sys.exit(1)


def run(command, check=True, **kwargs):
    command = [str(part) for part in command]
    say('$ ' + ' '.join(command))
    if PLAN:
        return None
    result = subprocess.run(command, **kwargs)
    if check and result.returncode:
        fail(f'Command failed ({result.returncode}): {" ".join(command)}')
    return result


def cuda_tag(driver):
    """PyTorch wheel build for an NVIDIA driver version string, or None if too old."""
    try:
        major = int(str(driver).strip().split('.')[0])
    except ValueError:
        return None
    if major >= 570:
        return 'cu128'
    if major >= 528:
        return 'cu126'
    return None


def gpu():
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode or not out.stdout.strip():
        return None
    name, driver, memory = (part.strip() for part in out.stdout.strip().splitlines()[0].split(','))
    return {'name': name, 'driver': driver, 'memory': memory}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as file:
        for block in iter(lambda: file.read(CHUNK), b''):
            digest.update(block)
    return digest.hexdigest()


def find_local(folder, names):
    if not folder:
        return None
    for name in names:
        for path in sorted(Path(folder).rglob(name)):
            if path.is_file():
                return path
    return None


def download(url, target, size):
    """Resumable download to target.part, then rename."""
    part = target.with_name(target.name + '.part')
    for attempt in range(1, 6):
        have = part.stat().st_size if part.exists() else 0
        if size and have > size:
            part.unlink()
            have = 0
        if size and have == size:
            break
        request = urllib.request.Request(url, headers={'User-Agent': 'WTVAudioWizard-setup/1.0'})
        if have:
            request.add_header('Range', f'bytes={have}-')
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                if have and response.status != 206:
                    have = 0
                total = size or (have + int(response.headers.get('Content-Length') or 0))
                shown = -1
                with open(part, 'ab' if have else 'wb') as file:
                    for block in iter(lambda: response.read(CHUNK), b''):
                        file.write(block)
                        have += len(block)
                        percent = int(10 * have / total) * 10 if total else -1
                        if percent != shown:
                            say(f'  {target.name}: {percent}% of {total / 2**20:.0f} MB')
                            shown = percent
            if not size or part.stat().st_size == size:
                break
        except (OSError, urllib.error.URLError) as error:
            say(f'  {target.name}: attempt {attempt} stopped ({error}); retrying')
            time.sleep(3 * attempt)
    else:
        fail(f'Could not download {url}')
    part.replace(target)


def fetch(target, url, size, digest, from_dir=None, aliases=None):
    """Make sure target exists with the pinned hash: keep, copy from --from-dir, or download."""
    target = Path(target)
    if target.is_file() and (not size or target.stat().st_size == size):
        if PLAN:
            say(f'{target.name}: present (hash is checked on a real run).')
            return
        if sha256(target) == digest:
            say(f'{target.name}: present and verified.')
            return
        bad = target.with_name(target.name + '.bad')
        target.replace(bad)
        say(f'{target.name}: wrong checksum; set aside as {bad.name}.')
    local = find_local(from_dir, aliases or (target.name,))
    if PLAN:
        say(f'{target.name}: would {"copy from " + str(local) if local else "download " + url} -> {target}')
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    if local:
        say(f'{target.name}: copying from {local}')
        shutil.copyfile(local, target)
    else:
        say(f'{target.name}: downloading {url}')
        download(url, target, size)
    if sha256(target) != digest:
        target.replace(target.with_name(target.name + '.bad'))
        fail(f'{target.name} does not match its pinned SHA-256; it was set aside as {target.name}.bad and will not be used.')
    say(f'{target.name}: verified.')


def uv():
    tool = WORK / 'tools-env' / 'bin' / 'uv'
    if tool.exists():
        return tool
    say('Installing uv (creates the Python environments) into work/tools-env')
    run([sys.executable, '-m', 'venv', WORK / 'tools-env'])
    run([WORK / 'tools-env' / 'bin' / 'python', '-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'uv'])
    return tool


def env_ok(python, check, needs_cuda):
    if not Path(python).exists():
        return False
    code = check + ('\nimport torch; assert torch.cuda.is_available(), "no CUDA"' if needs_cuda else '')
    return subprocess.run([str(python), '-c', code], capture_output=True, text=True).returncode == 0


def make_env(name, tag, gpu_check=True):
    version, torch, requirements, check = ENVS[name]
    folder = WORK / name
    python = folder / 'bin' / 'python'
    needs_cuda = bool(torch) and gpu_check
    if not PLAN and env_ok(python, check, needs_cuda):
        say(f'{name}: already installed and working.')
        return python
    tool = uv() if not PLAN else WORK / 'tools-env' / 'bin' / 'uv'
    if PLAN or not python.exists():
        run([tool, 'venv', '--python', version, folder])
    if torch:
        say(f'{name}: installing {" ".join(torch)} for {tag} (large download)')
        run([tool, 'pip', 'install', '--python', python, *torch, '--index-url', f'https://download.pytorch.org/whl/{tag}'])
        # A list with pinned versions is the complete Windows package set: install it exactly.
        exact = '==' in (PROJECT / requirements).read_text()
        run([tool, 'pip', 'install', '--python', python, *(['--no-deps'] if exact else []), '-r', PROJECT / requirements])
    else:
        run([tool, 'pip', 'install', '--python', python, '-r', PROJECT / requirements])
    if not PLAN:
        code = check + ('\nimport torch; assert torch.cuda.is_available(), "PyTorch cannot see the GPU"' if needs_cuda else '')
        result = subprocess.run([str(python), '-c', code], capture_output=True, text=True)
        if result.returncode:
            print(result.stderr[-3000:])
            fail(f'{name} was installed but its import check failed; see the message above.')
        say(f'{name}: ready.')
    return python


def clone(url, commit, folder):
    folder = Path(folder)
    if (folder / '.git').exists():
        if PLAN:
            say(f'{folder.name}: checkout present.')
            return
        head = subprocess.run(['git', '-C', str(folder), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
        if head == commit:
            say(f'{folder.name}: already at {commit[:10]}.')
            return
        run(['git', '-C', folder, 'fetch', 'origin'])
    else:
        if not PLAN:
            folder.parent.mkdir(parents=True, exist_ok=True)
        run(['git', 'clone', url, folder])
    run(['git', '-C', folder, 'checkout', '--detach', commit])


def overlay(source, target):
    for path in sorted(Path(source).rglob('*.py')):
        destination = Path(target) / path.relative_to(source)
        say(f'overlay: {path.relative_to(source)}')
        if not PLAN:
            shutil.copyfile(path, destination)


def import_check(python, repo, statement, label):
    if PLAN:
        return
    code = f'import sys; sys.path.insert(0, {str(repo)!r}); {statement}'
    result = subprocess.run([str(python), '-c', code], capture_output=True, text=True, cwd=str(repo))
    if result.returncode:
        print(result.stderr[-3000:])
        fail(f'{label}: the model code does not import in its environment; see the message above.')
    say(f'{label}: model code imports.')


def write_config(entries):
    if PLAN:
        say(f'would write {", ".join(entries)} to {CONFIG}')
        return
    config = json.loads(CONFIG.read_text(encoding='utf-8')) if CONFIG.exists() else {}
    merged = {**config, **entries}
    if merged == config:
        say('local-config.json is already up to date.')
        return
    if CONFIG.exists():
        backup = CONFIG.with_name(f'{CONFIG.name}.bak-{time.strftime("%Y%m%d-%H%M%S")}')
        shutil.copyfile(CONFIG, backup)
        say(f'Backed up the old config to {backup.name}')
    temp = CONFIG.with_name(CONFIG.name + '.tmp')
    temp.write_text(json.dumps(merged, indent=2), encoding='utf-8')
    temp.replace(CONFIG)
    say(f'Wrote {", ".join(entries)} to {CONFIG}')


def main():
    global PLAN
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--only', nargs='+', choices=PARTS, default=list(PARTS), help='install only these parts')
    parser.add_argument('--from-dir', help='folder (searched recursively) holding weight files to copy instead of downloading')
    parser.add_argument('--cuda', choices=['cu126', 'cu128'], help='PyTorch CUDA build; default is chosen from the NVIDIA driver')
    parser.add_argument('--skip-gpu-check', action='store_true', help='install without an NVIDIA GPU present (the models will not run)')
    parser.add_argument('--plan', action='store_true', help='print the steps without changing anything')
    args = parser.parse_args()
    PLAN = args.plan
    if sys.version_info < (3, 9):
        fail('Python 3.9 or newer is required to run this installer.')
    if os.name == 'nt':
        fail('This installer is for Linux. On Windows see README.md.')
    parts = set(args.only)
    say(f'Service folder: {PROJECT}')
    say(f'Workspace: {WORKSPACE} (environments, models and data go in {WORK})')

    tag = args.cuda
    card = gpu()
    if card:
        say(f'GPU: {card["name"]}, {card["memory"]}, driver {card["driver"]}')
        tag = tag or cuda_tag(card['driver'])
        if not tag:
            fail(f'NVIDIA driver {card["driver"]} is too old; install driver 528 or newer.')
    elif parts - {'service'} and not args.skip_gpu_check and not PLAN:
        fail('nvidia-smi did not report a GPU. Install the NVIDIA driver (Debian: the nvidia-driver package from non-free), '
             'reboot, and run this again. Use --skip-gpu-check to install anyway.')
    tag = tag or 'cu126'
    gpu_check = bool(card) and not args.skip_gpu_check
    if parts - {'service'}:
        say(f'PyTorch build: {tag}')

    if not PLAN:
        WORK.mkdir(parents=True, exist_ok=True)
    entries = {}
    if 'service' in parts:
        make_env('service-env', tag)
    if parts & {'gap_urgenet', 'bandit_v2'}:
        python = make_env('gapurgenet-env', tag, gpu_check)
        if 'gap_urgenet' in parts:
            repo, checkpoints = WORK / 'repos' / 'gap-urgenet', WORK / 'checkpoints' / 'gap-urgenet'
            clone(*GAP_REPO, repo)
            overlay(PROJECT / 'vendor' / 'gap-urgenet-overlay', repo)
            for name, (size, digest) in GAP_FILES.items():
                fetch(checkpoints / name, GAP_HF + name, size, digest, args.from_dir)
            import_check(python, repo, 'from models.gap_urgenet import GAP_URGENet', 'GAP-URGENet')
            entries['gap_urgenet'] = {'python': str(python), 'repo': str(repo), 'checkpoints': str(checkpoints),
                                      'checkpoint_hashes': {name: digest for name, (_, digest) in GAP_FILES.items()}}
        if 'bandit_v2' in parts:
            repo = WORK / 'repos' / 'bandit-v2'
            name, size, digest = BANDIT_FILE
            clone(*BANDIT_REPO, repo)
            fetch(WORK / 'checkpoints' / name, BANDIT_URL, size, digest, args.from_dir, BANDIT_ALIASES)
            import_check(python, repo, 'from src.models.bandit.bandit import Bandit', 'Bandit v2')
            entries['bandit_v2'] = {'python': str(python), 'repo': str(repo), 'checkpoint': str(WORK / 'checkpoints' / name),
                                    'checkpoint_sha256': digest, 'repo_commit': BANDIT_REPO[1]}
    if 'mossformer2' in parts:
        python = make_env('clearvoice-env', tag, gpu_check)
        runtime = WORK / 'mossformer-runtime'
        folder = runtime / 'checkpoints' / 'MossFormer2_SE_48K'
        name, size, digest = MOSS_FILE
        fetch(folder / name, MOSS_URL, size, digest, args.from_dir)
        if not PLAN:
            (folder / 'last_best_checkpoint').write_text(name + '\n')
        entries['mossformer2'] = {'python': str(python), 'runtime': str(runtime), 'checkpoint_sha256': digest}
    if 'sidon' in parts:
        python = make_env('sidon-env', tag, gpu_check)
        models = WORK / 'sidon-models'
        for name, (size, digest) in SIDON_FILES.items():
            fetch(models / name, SIDON_HF + name, size, digest, args.from_dir)
        entries['sidon'] = {'python': str(python), 'models': str(models),
                            'checkpoint_hashes': {name: digest for name, (_, digest) in SIDON_FILES.items()},
                            'source': 'https://huggingface.co/sarulab-speech/sidon-v0.1', 'revision': SIDON_REVISION}
    if entries:
        write_config(entries)
    say('Plan complete; nothing was changed.' if PLAN else 'Done. Start the service with: bash start-service.sh')


if __name__ == '__main__':
    main()
