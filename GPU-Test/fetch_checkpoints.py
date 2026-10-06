"""Get the GAP-URGENet checkpoints into ./checkpoints and verify their SHA-256.

Standard library only, so it runs before any packages are installed.

    python fetch_checkpoints.py                      # download missing files (resumable)
    python fetch_checkpoints.py --from-dir D:\\ckpts   # copy from a local folder instead
    python fetch_checkpoints.py --verify-only        # just check what is already there
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
CKPT_DIR = HERE / 'checkpoints'
MANIFEST = json.loads((CKPT_DIR / 'manifest.json').read_text(encoding='utf-8'))
CACHE = CKPT_DIR / '.verified.json'
CHUNK = 8 * 2**20


def _fmt(n):
    return f'{n / 2**30:.2f} GiB' if n >= 2**30 else f'{n / 2**20:.1f} MiB'


def _progress(label, done, total, started):
    rate = done / max(time.perf_counter() - started, 1e-6)
    pct = 100 * done / total if total else 0
    sys.stdout.write(f'\r  {label:<16} {pct:5.1f}%  {_fmt(done)} / {_fmt(total)}  {_fmt(rate)}/s   ')
    sys.stdout.flush()


def sha256_file(path, label=None):
    h = hashlib.sha256()
    total = path.stat().st_size
    done, started = 0, time.perf_counter()
    with open(path, 'rb') as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                break
            h.update(block)
            done += len(block)
            if label and total > 64 * 2**20:
                _progress(label, done, total, started)
    if label and total > 64 * 2**20:
        sys.stdout.write('\n')
    return h.hexdigest()


def _load_cache():
    try:
        return json.loads(CACHE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def verify(full=False, quiet=False):
    """Return {name: 'ok' | 'missing' | 'wrong-size' | 'bad-hash'}.

    Hashes are cached per (size, mtime) so later runs are instant; pass full=True
    to re-hash everything regardless.
    """
    cache = {} if full else _load_cache()
    status, new_cache = {}, {}
    for name, info in MANIFEST['files'].items():
        path = CKPT_DIR / name
        if not path.is_file():
            status[name] = 'missing'
            continue
        st = path.stat()
        if st.st_size != info['bytes']:
            status[name] = 'wrong-size'
            continue
        key = [st.st_size, st.st_mtime_ns]
        cached = cache.get(name)
        if cached and cached.get('stat') == key and cached.get('sha256') == info['sha256']:
            digest = cached['sha256']
        else:
            if not quiet:
                print(f'  hashing {name} ...', flush=True)
            digest = sha256_file(path, None if quiet else name)
        if digest == info['sha256']:
            status[name] = 'ok'
            new_cache[name] = {'stat': key, 'sha256': digest}
        else:
            status[name] = 'bad-hash'
    try:
        CACHE.write_text(json.dumps(new_cache, indent=2), encoding='utf-8')
    except OSError:
        pass
    return status


def _download(url, dest, expected_bytes, label, retries=5):
    part = dest.with_name(dest.name + '.part')
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        if have > expected_bytes:
            part.unlink()
            have = 0
        if have == expected_bytes:
            break
        req = urllib.request.Request(url, headers={'User-Agent': 'WTV-GPU-Test/1.0'})
        if have:
            req.add_header('Range', f'bytes={have}-')
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                if have and resp.status != 206:  # server ignored Range: start over
                    have = 0
                mode = 'ab' if have else 'wb'
                started, done = time.perf_counter(), have
                with open(part, mode) as out:
                    while True:
                        block = resp.read(CHUNK)
                        if not block:
                            break
                        out.write(block)
                        done += len(block)
                        _progress(label, done, expected_bytes, started)
            sys.stdout.write('\n')
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            sys.stdout.write('\n')
            print(f'  download interrupted ({error}); retry {attempt}/{retries} in 5 s', flush=True)
            time.sleep(5)
    if not part.exists() or part.stat().st_size != expected_bytes:
        raise RuntimeError(f'Could not download {dest.name} from {url}')
    os.replace(part, dest)


def _copy(src, dest, label):
    total = src.stat().st_size
    part = dest.with_name(dest.name + '.part')
    started, done = time.perf_counter(), 0
    with open(src, 'rb') as fin, open(part, 'wb') as fout:
        while True:
            block = fin.read(CHUNK)
            if not block:
                break
            fout.write(block)
            done += len(block)
            if total > 64 * 2**20:
                _progress(label, done, total, started)
    if total > 64 * 2**20:
        sys.stdout.write('\n')
    shutil.copystat(src, part)
    os.replace(part, dest)


def fetch(base_url=None, from_dir=None):
    status = verify()
    todo = [n for n, s in status.items() if s != 'ok']
    if not todo:
        print('All checkpoints present and verified.')
        return True
    for name in todo:
        if status[name] in ('wrong-size', 'bad-hash'):
            bad = CKPT_DIR / name
            print(f'  {name}: {status[name]} -> moving aside to {name}.bad')
            os.replace(bad, bad.with_name(name + '.bad'))
    base_url = base_url or os.environ.get('GPU_TEST_CHECKPOINT_URL') or MANIFEST['source']['base_url']
    if base_url and not base_url.endswith('/'):
        base_url += '/'
    need = sum(MANIFEST['files'][n]['bytes'] for n in todo)
    print(f'Fetching {len(todo)} file(s), {_fmt(need)} total, '
          f'{"from " + str(from_dir) if from_dir else "from " + base_url}')
    for name in todo:
        dest = CKPT_DIR / name
        if from_dir:
            src = Path(from_dir) / name
            if not src.is_file():
                raise FileNotFoundError(f'{src} not found')
            _copy(src, dest, name)
        else:
            _download(base_url + name, dest, MANIFEST['files'][name]['bytes'], name)
    status = verify(full=False)
    bad = {n: s for n, s in status.items() if s != 'ok'}
    if bad:
        print('Checkpoint verification FAILED:', bad)
        return False
    print('All checkpoints present and verified.')
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--from-dir', help='copy checkpoints from this local folder instead of downloading')
    ap.add_argument('--base-url', help='download from this URL prefix (file names are appended)')
    ap.add_argument('--verify-only', action='store_true', help='only verify, do not fetch')
    ap.add_argument('--full-verify', action='store_true', help='ignore the hash cache and re-hash every file')
    args = ap.parse_args()
    CKPT_DIR.mkdir(exist_ok=True)
    if args.verify_only:
        status = verify(full=args.full_verify)
        for name, s in status.items():
            print(f'  {name:<16} {s}')
        sys.exit(0 if all(s == 'ok' for s in status.values()) else 1)
    if args.full_verify:
        CACHE.unlink(missing_ok=True)
    sys.exit(0 if fetch(args.base_url, args.from_dir) else 1)


if __name__ == '__main__':
    main()
