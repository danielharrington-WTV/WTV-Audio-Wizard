"""Age-based cleanup of the service's data folder (standard library only).

The service keeps every upload, job result and dialogue-cache entry so reruns
can reuse them. This removes what has not been used for `retention_days`
(local-config.json; default 14; 0 = never delete). "Last used" is the file's
modification time: the service refreshes it when a job is reused, a result or
upload is downloaded, an upload feeds a new job, or a cache entry is hit.

Only the data folder is touched. The panel's own copies of results (the
project export folder that Premiere imports) are never seen by the service and
are never deleted; no path in here comes from the panel.

Never deleted: queued or running jobs and the uploads they use, uploads being
analysed (pinned), token.txt, model-speed.json and anything not named the way
the service names its own files.

Report only (deletes nothing):  python -m service.storage_cleanup
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import time

DEFAULT_RETENTION_DAYS = 14
LEFTOVER_SECONDS = 24 * 3600  # Half-written files and crash leftovers.
DAY = 24 * 3600
ID = re.compile(r'[0-9a-f]{32}')
KEY = re.compile(r'[0-9a-f]{64}')
ACTIVE = ('queued', 'running')


def retention_days(config):
    """Days to keep from local-config.json's `retention_days` (number >= 0)."""
    value = config.get('retention_days', DEFAULT_RETENTION_DAYS)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        raise ValueError(f'retention_days must be a number of days, 0 or more (got {value!r})')
    return value


def touch(path):
    """Mark something as just used. Missing files are ignored."""
    try:
        os.utime(path)
    except OSError:
        pass


def _mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _size(path):
    try:
        if path.is_dir():
            return sum(p.stat().st_size for p in path.rglob('*') if p.is_file())
        return path.stat().st_size
    except OSError:
        return 0


def _assets_of(record):
    return {t.get('asset_id') for t in record.get('request', {}).get('tracks', []) if t.get('asset_id')}


def plan(root, days, now=None, busy=(), pinned=()):
    """What would be removed. `busy`: job ids still in use; `pinned`: upload ids in use."""
    root, now = Path(root), time.time() if now is None else now
    found = {'jobs': [], 'uploads': [], 'cache': [], 'leftovers': [], 'paths': []}
    if not days or not root.is_dir():
        return found
    cutoff, stale = now - days * DAY, now - LEFTOVER_SECONDS
    busy, pinned = set(busy), set(pinned)

    records, keep = {}, set()
    for path in root.glob('job-*.json'):
        jid = path.stem[4:]
        if not ID.fullmatch(jid):
            continue
        try:
            record = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue  # Unreadable record: leave it for a person to look at.
        records[jid] = record
        used = _mtime(path)
        if record.get('status') in ACTIVE or jid in busy or used is None or used >= cutoff:
            keep |= _assets_of(record)
            continue
        found['jobs'].append(jid)
        found['paths'] += [path, root / jid]

    for path in root.glob('*.json'):
        aid = path.stem
        if not ID.fullmatch(aid) or aid in keep or aid in pinned:
            continue
        used = _mtime(path)
        if used is not None and used < cutoff:
            found['uploads'].append(aid)
            found['paths'] += [path, root / f'{aid}.wav']

    for path in root.glob('*.wav'):  # Upload with no description: an interrupted upload.
        if ID.fullmatch(path.stem) and path.stem not in pinned and not path.with_suffix('.json').exists():
            used = _mtime(path)
            if used is not None and used < stale:
                found['leftovers'].append(path.name)
                found['paths'].append(path)

    for path in root.iterdir():
        used = _mtime(path)
        if used is None or used >= stale:
            continue
        if path.is_dir() and ID.fullmatch(path.name) and path.name not in records and path.name not in busy:
            found['leftovers'].append(path.name)  # Job folder whose record is gone.
            found['paths'].append(path)
        elif path.is_file() and path.suffix == '.tmp':
            found['leftovers'].append(path.name)
            found['paths'].append(path)

    cache = root / 'stage-cache'
    if cache.is_dir():
        for path in cache.iterdir():
            used = _mtime(path)
            if used is None:
                continue
            if KEY.fullmatch(path.name) and used < cutoff:
                found['cache'].append(path.name)
                found['paths'].append(path)
            elif ('.tmp-' in path.name or '.invalid-' in path.name or '.old-' in path.name) and used < stale:
                found['leftovers'].append('stage-cache/' + path.name)
                found['paths'].append(path)
    return found


def execute(found):
    """Delete what plan() found. Returns (bytes freed, paths that could not be removed)."""
    freed, failed = 0, []
    for path in found['paths']:
        if not path.exists():
            continue
        size = _size(path)
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            freed += size
        except OSError:
            failed.append(path)
    return freed, failed


def size_of(found):
    return sum(_size(p) for p in found['paths'] if p.exists())


def summary(found, freed, days, dry_run=False):
    counts = [f'{len(found["jobs"])} jobs', f'{len(found["uploads"])} uploads',
              f'{len(found["cache"])} cache entries', f'{len(found["leftovers"])} leftovers']
    verb = 'would free' if dry_run else 'freed'
    return f'Cleanup (keeping {days:g} days): {", ".join(counts)}, {verb} {freed / 2**30:.2f} GB'


def main(argv=None):
    from .workspace import find_workspace
    base = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description='Report what the service cleanup would remove (deletes nothing).')
    parser.add_argument('--days', type=float, help='override retention_days from local-config.json')
    parser.add_argument('--data', type=Path, help='data folder (default: as the service finds it)')
    args = parser.parse_args(argv)
    root = args.data or Path(os.environ.get('WTV_DATA_DIR') or find_workspace(base) / 'work' / 'wtv-data')
    config_path = Path(os.environ.get('WTV_CONFIG', base / 'local-config.json'))
    config = json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}
    days = args.days if args.days is not None else retention_days(config)
    found = plan(root, days)
    print(f'Data folder: {root.resolve()}')
    print(summary(found, size_of(found), days, dry_run=True))
    for name in ('jobs', 'uploads', 'cache', 'leftovers'):
        for item in found[name]:
            print(f'  {name}: {item}')


if __name__ == '__main__':
    main()
