"""End-to-end check of Restore Speech's service path on this machine's GPU.

Runs the real service app in-process (no port, separate temporary data
folder, so a running service is not disturbed): upload -> /v1/jobs with the
panel's Restore Speech settings -> real Sidon worker -> download. Writes the
result and report.json under validation/restore-speech/<time>/.

    <workspace>/work/service-env/Scripts/python.exe scripts/validate_restore.py [clip.wav]
"""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
data = Path(tempfile.mkdtemp(prefix='wtv-restore-check-'))
os.environ['WTV_DATA_DIR'] = str(data)

import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from service import app as service

source = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT / 'Derev-Test' / 'input' / 'genre_search_draft_1.wav'
out = PROJECT / 'validation' / 'restore-speech' / time.strftime('%Y%m%d-%H%M%S')
out.mkdir(parents=True)
report = {'source': source.name}
# Loopback client: no token since service 0.7.2.
with TestClient(service.app, base_url='http://127.0.0.1:8756', client=('127.0.0.1', 50000)) as client:
    health = client.get('/v1/health').json()
    sidon = next(m for m in health['models'] if m['id'] == 'sidon')
    report['sidon_available'] = sidon['available']
    if not sidon['available']:
        sys.exit('Sidon is not available; run setup-sidon.bat first.')
    info = sf.info(source)
    asset = client.post('/v1/assets', content=source.read_bytes()).json()
    settings = client.get('/v1/defaults').json()
    settings.update(enhancer='sidon', enhancer_wet=1, separator='bandit_v2', ambience_only=False, separate_ambience=False,
                    separate_music=False, dialogue_postprocess=False, deess_declick=False, level_dialogue=False,
                    output_rate=info.samplerate)
    runs = []
    for attempt in ('first (loads Sidon)', 'repeat (cached result)'):
        started = time.perf_counter()
        submitted = client.post('/v1/jobs', json={'tracks': [{'asset_id': asset['asset_id'], 'role': 'mixture'}], 'settings': settings})
        submitted.raise_for_status()
        jid = submitted.json()['job_id']
        seen = []
        while True:
            job = client.get(f'/v1/jobs/{jid}').json()
            if not seen or seen[-1][1] != job['progress']:
                seen.append((round(time.perf_counter() - started, 1), job['progress']))
            if job['status'] not in ('queued', 'running'):
                break
            time.sleep(.5)
        runs.append({'run': attempt, 'status': job['status'], 'reused': submitted.json()['reused'], 'progress_seen': seen,
                     'seconds': round(time.perf_counter() - started, 2), 'error': job.get('error')})
        if job['status'] != 'done':
            break
    report['runs'] = runs
    if job['status'] == 'done':
        wav = client.get(f'/v1/jobs/{jid}/result/dialogue').content
        (out / 'restored.wav').write_bytes(wav)
        y, rate = sf.read(io.BytesIO(wav), dtype='float32', always_2d=True)
        x, _ = sf.read(source, dtype='float32', always_2d=True)
        a, b = x[:, 0], y[:, 0]
        hop = rate // 200
        env = lambda s: np.log(np.sqrt((s[: len(s) // hop * hop].reshape(-1, hop) ** 2).mean(1) + 1e-12))
        ea, eb = env(a), env(b)
        best = max(range(-50, 51), key=lambda lag: np.corrcoef(ea[max(0, -lag): len(ea) - max(0, lag)], eb[max(0, lag): len(eb) - max(0, -lag)])[0, 1])
        report.update(result={k: job['result'][k] for k in ('samples', 'sample_rate', 'channels', 'enhancement', 'timings', 'safety_gain_db')},
                      input_samples=len(x), output_samples=len(y), same_length=len(x) == len(y),
                      lag_ms=best * 5, finite=bool(np.isfinite(y).all()),
                      peak_dbfs=round(float(20 * np.log10(np.abs(y).max() + 1e-12)), 1))
(out / 'report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
print(f'\nWritten to {out}')
