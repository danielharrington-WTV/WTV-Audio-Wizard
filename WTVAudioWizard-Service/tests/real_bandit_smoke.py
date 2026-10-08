"""Opt-in: exercises actual checkpoint via HTTP test client, not a model mock."""
import io
import json
from pathlib import Path
import time
import sys
import numpy as np
import soundfile as sf
from fastapi.testclient import TestClient
from service.app import app, TOKEN
enhancer = sys.argv[1] if len(sys.argv) > 1 else 'gap_urgenet'
selection = sys.argv[2] if len(sys.argv) > 2 else 'none'
options = {'separate_music':selection in ('music','both'), 'separate_ambience':selection in ('ambience','both')}
expected_stems = ['dialogue'] + (['effects'] if options['separate_ambience'] else []) + (['music'] if options['separate_music'] else [])

with TestClient(app) as client:
    client.headers['Authorization'] = f'Bearer {TOKEN}'
    t = np.arange(44100) / 44100
    x = (.025 * np.sin(2*np.pi*400*t)).astype(np.float32)
    file = io.BytesIO()
    sf.write(file, x, 44100, format='WAV', subtype='FLOAT')
    uploaded = client.post('/v1/assets', content=file.getvalue())
    assert uploaded.status_code == 201, uploaded.text
    submitted = client.post('/v1/jobs', json={'tracks': [{'asset_id': uploaded.json()['asset_id']}], 'settings': {'output_rate': 44100, 'enhancer': enhancer, **options}})
    assert submitted.status_code == 202, submitted.text
    jid = submitted.json()['job_id']
    deadline = time.time() + 600
    while time.time() < deadline:
        job = client.get(f'/v1/jobs/{jid}').json()
        if job['status'] not in ('queued', 'running'):
            break
        time.sleep(.5)
    assert job['status'] == 'done', job
    assert job['result']['samples'] == 44100
    assert job['result']['enhancement']['model'] == ('GAP-URGENet' if enhancer == 'gap_urgenet' else 'MossFormer2_SE_48K')
    assert job['result']['enhancement']['input_source'] == 'raw_audio'
    assert job['result']['stems'] == expected_stems + ['mix']
    assert ('benchmark' in job['result']) == (selection != 'none')
    outputs = []
    for stem in expected_stems + ['mix']:
        response = client.get(f'/v1/jobs/{jid}/result/{stem}')
        assert response.status_code == 200
        audio, rate = sf.read(io.BytesIO(response.content))
        assert rate == 44100 and len(audio) == 44100 and np.isfinite(audio).all()
        outputs.append(audio)
    np.testing.assert_allclose(sum(outputs[:-1]), outputs[-1], atol=1e-6)
    report = {'test': f'real raw dialogue ({enhancer}), optional stems: {selection}, 44.1 kHz mono, one second', 'passed': True, 'result': job['result']}
    Path(f'validation/real-optional-{enhancer}-{selection}.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
