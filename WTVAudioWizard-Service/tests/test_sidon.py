"""Restore Speech (Sidon) service integration. The model itself needs CUDA and
is exercised by scripts/setup_sidon.py's GPU smoke test on the service machine;
here the worker is faked, as in test_service.py."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest
import soundfile as sf

from service.schema import Settings
from test_service import client, upload, wait  # noqa: F401  (pytest fixture)

ROOT = Path(__file__).resolve().parents[1]
RESTORE = {'enhancer': 'sidon', 'enhancer_wet': 1, 'separate_ambience': False, 'separate_music': False,
           'dialogue_postprocess': False, 'deess_declick': False}


def sidon_config(tmp_path):
    models = tmp_path / 'sidon-models'
    models.mkdir()
    hashes = {}
    for name in ('feature_extractor_cuda.pt', 'decoder_cuda.pt'):
        (models / name).write_bytes(name.encode())
        hashes[name] = hashlib.sha256(name.encode()).hexdigest()
    return {'python': sys.executable, 'models': str(models), 'checkpoint_hashes': hashes}


def test_schema_accepts_sidon():
    assert Settings(**RESTORE).enhancer == 'sidon'


def test_health_reports_sidon_unavailable_until_configured(client, tmp_path, monkeypatch):
    c, app = client
    health = c.get('/v1/health').json()
    assert 'sidon_restore_v1' in health['capabilities']
    sidon = next(m for m in health['models'] if m['id'] == 'sidon')
    assert sidon['available'] is False and sidon['task'] == 'speech_restoration'
    monkeypatch.setattr(app, 'CONFIG', {'sidon': sidon_config(tmp_path)})
    assert next(m for m in c.get('/v1/health').json()['models'] if m['id'] == 'sidon')['available'] is True


def test_restore_without_sidon_is_refused_with_setup_instructions(client):
    c, _ = client
    aid = upload(c, np.zeros(48000))
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': RESTORE})
    assert response.status_code == 409
    assert 'setup-sidon.bat' in response.text


def fake_worker(calls, gain=.5):
    def run_worker(key, args, log, check, verify, progress=None):
        check(); verify()
        calls.append(args)
        source = Path(args[args.index('--input') + 1])
        output = Path(args[args.index('--output') + 1])
        x, rate = sf.read(source, dtype='float32', always_2d=True)
        sf.write(output, x * gain, rate, subtype='FLOAT')
        output.with_suffix('.json').write_text(json.dumps({'model': 'sidon-v0.1'}))
        return {'worker_reused': False}
    return run_worker


@pytest.mark.parametrize('rate,channels', [(48000, 1), (44100, 2)])
def test_restore_job_returns_sidon_output_unfinished_and_sample_exact(client, tmp_path, monkeypatch, rate, channels):
    c, app = client
    monkeypatch.setattr(app, 'CONFIG', {'sidon': sidon_config(tmp_path)})
    calls = []
    monkeypatch.setattr(app, 'run_worker', fake_worker(calls))
    n = rate * 2 + 17
    t = np.arange(n) / rate
    signal = (.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
    if channels == 2:
        signal = np.stack([signal, signal * .5], axis=1)
    file = io.BytesIO(); sf.write(file, signal, rate, format='WAV', subtype='FLOAT')
    aid = c.post('/v1/assets', content=file.getvalue()).json()['asset_id']
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {**RESTORE, 'output_rate': rate}})
    assert response.status_code == 202, response.text
    job = wait(c, response.json()['job_id'])
    assert job['status'] == 'done', job
    assert job['result']['stems'] == ['dialogue', 'mix']
    assert job['result']['samples'] == n and job['result']['sample_rate'] == rate
    assert job['result']['normalization']['dialogue']['skipped'] == 'dialogue_postprocess_off'
    assert job['result']['compress_dialogue'] is None and job['result']['deess'] is None
    args = calls[0]
    assert Path(args[1]).name == 'sidon.py'
    assert args[args.index('--models') + 1] == app.CONFIG['sidon']['models']
    audio, got_rate = sf.read(io.BytesIO(c.get(f"/v1/jobs/{job['job_id']}/result/dialogue").content), dtype='float32', always_2d=True)
    assert got_rate == rate and audio.shape == (n, channels)
    # Sidon's output as-is: the only processing is the resample round trip.
    expected = signal.reshape(n, -1) * .5
    assert np.max(np.abs(audio[200:-200] - expected[200:-200])) < 2e-3
    # Rerunning the same clip reuses the finished job; nothing runs again.
    assert c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {**RESTORE, 'output_rate': rate}}).json()['reused'] is True
    assert len(calls) == 1


def test_restore_refuses_changed_model_files(client, tmp_path, monkeypatch):
    c, app = client
    cfg = sidon_config(tmp_path)
    cfg['checkpoint_hashes']['decoder_cuda.pt'] = '0' * 64
    monkeypatch.setattr(app, 'CONFIG', {'sidon': cfg})
    calls = []
    monkeypatch.setattr(app, 'run_worker', fake_worker(calls))
    aid = upload(c, np.zeros(48000, dtype=np.float32) + .01)
    job = wait(c, c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': RESTORE}).json()['job_id'])
    assert job['status'] == 'failed'
    assert 'sidon checkpoint checksum differs' in job['error']['message']
    assert not calls


def test_worker_accepts_the_sidon_runner_only_from_runners():
    worker = ROOT / 'runners' / 'worker.py'
    ok = subprocess.run([sys.executable, str(worker), str(ROOT / 'runners' / 'sidon.py')], input='', capture_output=True, text=True)
    assert ok.returncode == 0, ok.stderr
    bad = subprocess.run([sys.executable, str(worker), str(ROOT / 'runners' / 'sidon_features.py')], input='', capture_output=True, text=True)
    assert bad.returncode != 0 and 'Unsupported worker runner' in bad.stderr


def test_windowing_is_sample_exact_and_crossfades_to_unity():
    torch = pytest.importorskip('torch')
    pytest.importorskip('torchaudio')
    sys.path.insert(0, str(ROOT / 'runners'))
    import sidon
    upsample = lambda block: np.repeat(block.numpy(), 3)
    for n in (1, 47999, 48000, 30 * 48000 + 7, 46 * 48000 + 2):
        x = (np.random.default_rng(n).standard_normal(n) * .1).astype(np.float32)
        assert len(sidon.restore_channel(x, upsample)) == n
    flat = sidon.windowed(torch.ones(16000 * 61), 16000 * 61 * 3, upsample)
    assert np.allclose(flat, 1.0)
