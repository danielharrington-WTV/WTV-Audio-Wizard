"""Age-based cleanup of the service data folder (service/storage_cleanup.py)."""
import json
import os
import time

import pytest

from service import storage_cleanup as sc

DAY = 24 * 3600
NOW = 1_800_000_000.0


def aged(path, days, now=NOW):
    os.utime(path, (now - days * DAY, now - days * DAY))
    return path


def upload(root, aid, days, now=NOW):
    (root / f'{aid}.wav').write_bytes(b'RIFF' + b'0' * 100)
    (root / f'{aid}.json').write_text('{}')
    return aged(root / f'{aid}.json', days, now)


def job(root, jid, days, assets, status='done'):
    folder = root / jid / 'result'
    folder.mkdir(parents=True)
    (folder / 'dialogue.wav').write_bytes(b'0' * 1000)
    record = {'job_id': jid, 'status': status, 'request': {'tracks': [{'asset_id': a, 'role': 'mixture'} for a in assets]}}
    (root / f'job-{jid}.json').write_text(json.dumps(record))
    aged(root / jid, days)
    return aged(root / f'job-{jid}.json', days)


def ids(n):
    return f'{n:032x}'


@pytest.fixture
def root(tmp_path):
    for name in ('token.txt', 'model-speed.json'):
        (tmp_path / name).write_text('x')
        aged(tmp_path / name, 400)
    return tmp_path


def test_old_job_and_its_upload_go_recent_ones_stay(root):
    old_job, new_job, old_up, new_up, shared = ids(1), ids(2), ids(3), ids(4), ids(5)
    upload(root, old_up, 20); upload(root, new_up, 20); upload(root, shared, 20)
    job(root, old_job, 20, [old_up]); job(root, new_job, 3, [new_up, shared])
    found = sc.plan(root, 14, now=NOW)
    assert found['jobs'] == [old_job] and found['uploads'] == [old_up]
    freed, failed = sc.execute(found)
    assert freed > 0 and not failed
    assert not (root / old_job).exists() and not (root / f'job-{old_job}.json').exists()
    assert not (root / f'{old_up}.wav').exists() and not (root / f'{old_up}.json').exists()
    for kept in (root / new_job, root / f'{new_up}.wav', root / f'{shared}.wav', root / 'token.txt', root / 'model-speed.json'):
        assert kept.exists()


def test_running_queued_busy_and_pinned_are_never_removed(root):
    a, b, c, d = ids(1), ids(2), ids(3), ids(4)
    for aid in (a, b, c, d):
        upload(root, aid, 30)
    job(root, ids(11), 30, [a], status='running')
    job(root, ids(12), 30, [b], status='queued')
    job(root, ids(13), 30, [c], status='done')
    found = sc.plan(root, 14, now=NOW, busy={ids(13)}, pinned={d})
    assert found['jobs'] == [] and found['uploads'] == []


def test_zero_days_keeps_everything(root):
    upload(root, ids(1), 999); job(root, ids(2), 999, [ids(1)])
    assert sc.plan(root, 0, now=NOW)['paths'] == []


def test_leftovers_older_than_a_day(root):
    (root / 'job-x.tmp').write_text('{'); aged(root / 'job-x.tmp', 2)
    (root / ids(7)).mkdir(); aged(root / ids(7), 2)                      # job folder, record gone
    (root / f'{ids(8)}.wav').write_bytes(b'0'); aged(root / f'{ids(8)}.wav', 2)  # interrupted upload
    (root / f'{ids(9)}.wav').write_bytes(b'0'); aged(root / f'{ids(9)}.wav', 0)  # upload in progress now
    (root / 'notes').mkdir(); aged(root / 'notes', 50)                    # not ours: left alone
    found = sc.plan(root, 14, now=NOW)
    assert sorted(found['leftovers']) == sorted(['job-x.tmp', ids(7), f'{ids(8)}.wav'])


def test_stage_cache_by_last_hit(root):
    cache = root / 'stage-cache'; cache.mkdir()
    old, fresh = 'a' * 64, 'b' * 64
    for key, days in ((old, 20), (fresh, 1)):
        (cache / key).mkdir(); aged(cache / key, days)
    (cache / ('c' * 64 + '.tmp-1')).mkdir(); aged(cache / ('c' * 64 + '.tmp-1'), 2)
    found = sc.plan(root, 14, now=NOW)
    assert found['cache'] == [old] and found['leftovers'] == ['stage-cache/' + 'c' * 64 + '.tmp-1']


def test_touch_keeps_an_old_item(root):
    upload(root, ids(1), 30)
    sc.touch(root / f'{ids(1)}.json')
    assert sc.plan(root, 14)['uploads'] == []


def test_retention_setting():
    assert sc.retention_days({}) == 14 and sc.retention_days({'retention_days': 7}) == 7
    for bad in (-1, 'seven', True):
        with pytest.raises(ValueError):
            sc.retention_days({'retention_days': bad})


def test_report_only_command(root, capsys):
    upload(root, ids(1), 30, now=time.time())
    sc.main(['--data', str(root), '--days', '14'])
    out = capsys.readouterr().out
    assert 'would free' in out and ids(1) in out and (root / f'{ids(1)}.wav').exists()


def test_service_cleans_at_start_and_forgets_removed_jobs(tmp_path, monkeypatch):
    import importlib
    from fastapi.testclient import TestClient
    now = time.time()
    old, recent = ids(21), ids(22)
    upload(tmp_path, ids(31), 20, now); upload(tmp_path, ids(32), 20, now)
    job(tmp_path, old, 20, [ids(31)]); job(tmp_path, recent, 1, [ids(32)])
    aged(tmp_path / f'job-{old}.json', 20, now); aged(tmp_path / f'job-{recent}.json', 1, now)
    monkeypatch.setenv('WTV_DATA_DIR', str(tmp_path))
    app = importlib.import_module('service.app')
    for name, value in (('ROOT', tmp_path), ('JOBS', {}), ('CANCEL', {}), ('CONFIG', {}), ('RETENTION_DAYS', 14)):
        monkeypatch.setattr(app, name, value)
    with TestClient(app.app, base_url='http://192.168.0.176:8756', client=('192.168.25.252', 50000)) as c:
        assert c.get(f'/v1/jobs/{old}').status_code == 404
        assert c.get(f'/v1/jobs/{recent}').status_code == 200
    assert not (tmp_path / f'{ids(31)}.wav').exists() and (tmp_path / f'{ids(32)}.wav').exists()


def test_fresh_jobs_skip_reuse_and_replace_the_stage_cache(tmp_path):
    from service.stage_cache import StageCache
    from service.schema import JobRequest
    assert JobRequest(tracks=[{'asset_id': 'a' * 32}], fresh=True).fresh is True
    assert JobRequest(tracks=[{'asset_id': 'a' * 32}]).fresh is False
    cache, key = StageCache(tmp_path), 'f' * 64
    for text in ('old', 'new'):
        (tmp_path / 'x.wav').write_text(text)
        cache.put(key, {'x.wav': tmp_path / 'x.wav'}, {}, lambda: None, replace=(text == 'new'))
    assert (cache.get(key, ['x.wav'])['folder'] / 'x.wav').read_text() == 'new'
    assert not list((tmp_path / 'stage-cache').glob('*.old-*'))
