"""Live job progress during model runs (2026-09-29)."""
import io
import json
from pathlib import Path
import shutil
import sys

import numpy as np
import pytest

from service import worker_pool
from service.progress import SpeedHistory, StageProgress, DEFAULT_COLD
from test_service import client, upload, wait  # noqa: F401  (pytest fixture)

ROOT = Path(__file__).resolve().parents[1]


class Clock:
    def __init__(self): self.t = 0.0
    def __call__(self): return self.t


def stage(expected=10.0, start=15, end=80):
    clock, shown = Clock(), []
    progress = StageProgress(shown.append, start, end, expected, clock=clock)
    return progress, clock, shown


def test_estimate_alone_advances_with_time_and_stops_at_ninety_percent_of_the_stage():
    progress, clock, shown = stage(expected=10)
    for t in (0, 2.5, 5, 9, 30, 300):
        clock.t = t; progress()
    assert shown[0] == 15
    assert shown == sorted(shown) and len(set(shown)) == len(shown)
    assert 15 < shown[1] < shown[2] < shown[3]
    assert shown[-1] == int(15 + 65 * .9)  # capped until the model returns


def test_real_reports_take_over_and_never_move_backwards():
    progress, clock, shown = stage(expected=100)
    clock.t = 1; progress(50)
    assert shown[-1] == int(15 + 65 * .5)
    clock.t = 2; progress(20)  # an out-of-order/lower report is ignored
    assert int(15 + 65 * .5) <= shown[-1] < int(15 + 65 * .6)
    clock.t = 3; progress(60)
    before = shown[-1]
    clock.t = 3.5; progress()  # between reports: carries on at the reported pace
    assert shown[-1] > before
    clock.t = 1000; progress()  # but never past halfway to the next report
    assert shown[-1] == int(15 + 65 * .8)
    clock.t = 1001; progress(100)
    assert shown[-1] == int(15 + 65 * .99)  # the stage end is only set when the model returns


def test_progress_callback_errors_never_escape():
    progress = StageProgress(lambda p: 1 / 0, 15, 80, 10, clock=Clock())
    progress(40); progress(None); progress('not a number')


def test_speed_history_learns_warm_rate_and_cold_start(tmp_path):
    history = SpeedHistory(tmp_path / 'speed.json', alpha=1)
    first = history.expected_seconds('sidon', 60, cold=True)
    assert first == pytest.approx(.25 * 60 + DEFAULT_COLD)
    history.record('sidon', 60, 12, cold=False)            # 0.2 s per audio-second
    history.record('sidon', 60, 12 + 30, cold=True)        # 30 s to load
    assert history.expected_seconds('sidon', 30, cold=False) == pytest.approx(6)
    assert history.expected_seconds('sidon', 30, cold=True) == pytest.approx(36)
    assert json.loads((tmp_path / 'speed.json').read_text())['sidon'] == {'rate': pytest.approx(.2), 'cold': pytest.approx(30)}
    (tmp_path / 'speed.json').write_text('not json')
    assert history.expected_seconds('gap_urgenet', 10, cold=False) == pytest.approx(2.5)


def test_worker_relays_only_exact_progress_lines():
    sys.path.insert(0, str(ROOT / 'runners'))
    import worker
    log, protocol = io.StringIO(), io.StringIO()
    out = worker.ProgressLog(log, protocol, 'r1')
    out.write('Loading model\n{"progress": 12.5}\n{"progress": 12.5}\n{"prog')
    out.write('ress": 40}\n{"window": 1, "windows": 3}\n{"progress": 140}\n{"progress": true}\n')
    assert log.getvalue().count('\n') == 7
    assert [json.loads(line) for line in protocol.getvalue().splitlines()] == [
        {'id': 'r1', 'progress': 12.5}, {'id': 'r1', 'progress': 40}]


@pytest.fixture
def reporting_worker(tmp_path, monkeypatch):
    runners = tmp_path / 'runners'; runners.mkdir()
    shutil.copyfile(ROOT / 'runners/worker.py', runners / 'worker.py')
    runner = runners / 'sidon.py'
    runner.write_text('import json,time\ndef main():\n    for p in (25,50,75,100):\n        print(json.dumps({"progress":p}),flush=True);time.sleep(.3)\n')
    monkeypatch.setattr(worker_pool, '__file__', str(tmp_path / 'service/worker_pool.py'))
    pool = worker_pool.ModelWorker(idle_seconds=60)
    yield pool, [sys.executable, str(runner)], tmp_path / 'job.log'
    pool.release_idle()


def test_model_worker_passes_runner_progress_and_poll_ticks_to_the_callback(reporting_worker):
    pool, args, log = reporting_worker
    seen = []
    assert pool.run('k', args, log, lambda: None, lambda: None, progress=seen.append) == {'worker_reused': False}
    assert [v for v in seen if v is not None] == [25, 50, 75, 100]
    assert None in seen  # quarter-second polls let the estimate advance
    assert '{"progress": 50}' in log.read_text()


def test_job_progress_moves_during_the_model_call_and_speed_is_recorded(client, tmp_path, monkeypatch):
    c, app = client
    import hashlib
    models = tmp_path / 'sidon-models'; models.mkdir()
    hashes = {}
    for name in ('feature_extractor_cuda.pt', 'decoder_cuda.pt'):
        (models / name).write_bytes(name.encode()); hashes[name] = hashlib.sha256(name.encode()).hexdigest()
    monkeypatch.setattr(app, 'CONFIG', {'sidon': {'python': sys.executable, 'models': str(models), 'checkpoint_hashes': hashes}})
    seen = []
    def run_worker(key, args, log, check, verify, progress=None):
        import soundfile as sf
        verify()
        for p in (10, 60):
            progress(p)
            seen.append(app.JOBS[next(iter(app.JOBS))]['progress'])
        x, rate = sf.read(args[args.index('--input') + 1], dtype='float32', always_2d=True)
        out = Path(args[args.index('--output') + 1])
        sf.write(out, x, rate, subtype='FLOAT'); out.with_suffix('.json').write_text('{}')
        return {'worker_reused': False}
    monkeypatch.setattr(app, 'run_worker', run_worker)
    aid = upload(c, (np.sin(np.arange(48000) / 10) * .1).astype(np.float32))
    job = wait(c, c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {'enhancer': 'sidon', 'dialogue_postprocess': False}}).json()['job_id'])
    assert job['status'] == 'done', job
    assert seen[0] >= int(15 + 65 * .1) and seen[1] >= int(15 + 65 * .6) and seen[1] < 80
    assert 'sidon' in json.loads((tmp_path / 'model-speed.json').read_text())
