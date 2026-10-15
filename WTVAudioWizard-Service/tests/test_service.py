import importlib
import io
import json
import threading
import time
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from service.schema import Settings, JobRequest
from service.audio import mix, read_audio

def wav(x, rate=48000):
    file = io.BytesIO()
    sf.write(file, x, rate, format='WAV', subtype='FLOAT')
    return file.getvalue()

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('WTV_DATA_DIR', str(tmp_path))
    app = importlib.import_module('service.app')
    monkeypatch.setattr(app, 'ROOT', tmp_path)
    monkeypatch.setattr(app, 'JOBS', {})
    monkeypatch.setattr(app, 'CANCEL', {})
    monkeypatch.setattr(app, 'CONFIG', {})
    with TestClient(app.app, base_url='http://192.168.0.176:8756', client=('192.168.25.252', 50000)) as c:
        yield c, app

def upload(c, x):
    response = c.post('/v1/assets', content=wav(x), headers={'content-type': 'audio/wav'})
    assert response.status_code == 201, response.text
    return response.json()['asset_id']

def wait(c, jid):
    deadline = time.time() + 15
    while time.time() < deadline:
        job = c.get(f'/v1/jobs/{jid}').json()
        if job['status'] not in ('queued', 'running'):
            return job
        time.sleep(.02)
    raise AssertionError('Job did not finish')

def test_lan_boundary_without_token(client):
    # Token removed 2026-10-12: a LAN client (the Mac at 192.168.25.252) reaches
    # the GPU server at 192.168.0.176 with no Authorization header at all.
    c, app = client
    assert 'authorization' not in {k.lower() for k in c.headers}
    health = c.get('/v1/health')
    assert health.status_code == 200 and health.json()['service_version'] == '0.7.3'
    assert c.get('/v1/defaults').status_code == 200
    assert c.get('/v1/health', headers={'Authorization': 'Bearer anything'}).status_code == 200
    assert not hasattr(app, 'TOKEN') and not hasattr(app, 'auth')
    # Browser pages are refused, whatever their address.
    assert c.get('/v1/health', headers={'Origin': 'https://example.com'}).status_code == 403
    assert c.get('/v1/health', headers={'Origin': 'http://192.168.0.176:8756'}).status_code == 403
    assert c.get('/v1/health', headers={'Origin': 'null'}).status_code == 200
    # Host must be a loopback/LAN literal or localhost (no DNS rebinding).
    for host in ('attacker.example', '192.168.0.176.nip.io', '8.8.8.8:8756', '[2001:db8::1]:8756', '192.168.0.176:x', '', 'testserver'):
        assert c.get('/v1/health', headers={'Host': host}).status_code == 403, host
    for host in ('192.168.0.176:8756', '127.0.0.1:8756', 'localhost:8756', '10.1.2.3', '172.20.0.1:8756', '[::1]:8756'):
        assert c.get('/v1/health', headers={'Host': host}).status_code == 200, host

@pytest.mark.parametrize('peer, allowed', [
    ('127.0.0.1', True), ('192.168.25.252', True), ('192.168.0.205', True), ('10.0.0.9', True), ('172.31.0.2', True), ('::1', True), ('::ffff:192.168.25.252', True),
    ('8.8.8.8', False), ('172.32.0.1', False), ('100.64.0.1', False), ('169.254.1.1', False), ('192.0.2.1', False), ('2001:db8::1', False), ('fd00::1', False), ('testclient', False)])
def test_peer_address_policy_is_exactly_loopback_and_rfc1918(tmp_path, monkeypatch, peer, allowed):
    app = importlib.import_module('service.app')
    monkeypatch.setattr(app, 'ROOT', tmp_path)
    monkeypatch.setattr(app, 'JOBS', {})
    monkeypatch.setattr(app, 'CANCEL', {})
    monkeypatch.setattr(app, 'CONFIG', {})
    with TestClient(app.app, base_url='http://192.168.0.176:8756', client=(peer, 50000)) as c:
        assert c.get('/v1/health').status_code == (200 if allowed else 403)
        # Refused before any mutation: nothing is stored for a public peer.
        response = c.post('/v1/assets', content=wav(np.zeros(4800)), headers={'content-type': 'audio/wav'})
        assert response.status_code == (201 if allowed else 403)
        assert c.get('/v1/health', headers={'X-Forwarded-For': '8.8.8.8'}).status_code == (200 if allowed else 403)
    if not allowed:
        assert not list(tmp_path.glob('*.wav'))

def test_music_analysis_and_temporary_asset_cleanup(client):
    c, app = client
    t=np.arange(48000)/48000
    x=.1*np.sin(2*np.pi*440*t)
    music=upload(c,x); dialogue=upload(c,np.zeros_like(x))
    probe=upload(c,x*10**((-3-6*t)/20))
    body={'music_asset':music,'dialogue_asset':dialogue,'probe_asset':probe}
    assert c.post('/v1/music-analysis',json=body,headers={'Host': 'attacker.example'}).status_code == 403
    result=c.post('/v1/music-analysis',json=body)
    assert result.status_code==200,result.text
    assert result.json()['calibration']['passed']
    assert result.json()['baseline_gain_db']==pytest.approx(-4.9897,abs=.001)
    assert not list(app.ROOT.glob('*/result/*.wav'))
    assert c.delete(f'/v1/assets/{music}',headers={'Host': 'attacker.example'}).status_code == 403
    app.JOBS['test']={'request':{'tracks':[{'asset_id':music}]}}
    assert c.delete(f'/v1/assets/{music}').status_code==409
    app.JOBS.clear()
    for aid in (music,dialogue,probe):
        assert c.delete(f'/v1/assets/{aid}').status_code==200
        assert not (app.ROOT/f'{aid}.wav').exists()
    assert c.post('/v1/music-analysis',json=body).status_code==404

def test_deplosive_attenuates_a_seeded_burst_and_result_is_downloadable(client):
    c, app = client
    rate = 48000
    t = np.arange(round(2 * rate)) / rate
    x = .01 * np.sin(2 * np.pi * 220 * t)
    seed_i = round(1.0 * rate)
    n = round(.15 * rate)
    tb = np.arange(n) / rate
    burst = .5 * np.exp(-tb / .05) * np.sin(2 * np.pi * 50 * tb)
    x[seed_i:seed_i + n] += burst
    aid = upload(c, x.astype(np.float32))
    assert c.post('/v1/deplosive', json={'asset_id': aid, 'seed_seconds': 1.0}, headers={'Host': 'attacker.example'}).status_code == 403
    response = c.post('/v1/deplosive', json={'asset_id': aid, 'seed_seconds': 1.0})
    assert response.status_code == 200, response.text
    body = response.json()
    report = body['report']
    assert report['seed_seconds'] == pytest.approx(1.0)
    assert report['duration_seconds'] > 0
    download = c.get(f"/v1/assets/{body['result_asset_id']}/download")
    assert download.status_code == 200
    cleaned, sr = sf.read(io.BytesIO(download.content), dtype='float32', always_2d=True)
    assert sr == rate
    s, e = round(report['start_seconds'] * rate), round(report['end_seconds'] * rate)
    assert float(np.max(np.abs(cleaned[s:e]))) < float(np.max(np.abs(x[s:e].astype(np.float32)))) * .6
    # Original asset is untouched by the operation (a new, separate asset was created).
    assert (app.ROOT / f'{aid}.wav').exists()
    np.testing.assert_allclose(sf.read(app.ROOT / f'{aid}.wav', dtype='float32', always_2d=True)[0], x.astype(np.float32)[:, None], atol=1e-6)

def test_deplosive_unknown_asset_404(client):
    c, _ = client
    assert c.post('/v1/deplosive', json={'asset_id': '0' * 32, 'seed_seconds': 1.0}).status_code == 404

def test_deplosive_seed_outside_signal_duration_returns_422_not_500(client):
    c, _ = client
    aid = upload(c, np.zeros(48000, dtype=np.float32))
    response = c.post('/v1/deplosive', json={'asset_id': aid, 'seed_seconds': 5.0})
    assert response.status_code == 422

def test_download_unknown_asset_404(client):
    c, _ = client
    assert c.get(f"/v1/assets/{'0'*32}/download").status_code == 404
    assert c.get(f"/v1/assets/{'0'*32}/download", headers={'Host': 'attacker.example'}).status_code == 403

def test_deplosive_unpins_the_source_asset_after_completion(client):
    c, _ = client
    aid = upload(c, np.zeros(48000, dtype=np.float32) + .01)
    response = c.post('/v1/deplosive', json={'asset_id': aid, 'seed_seconds': 0.5})
    assert response.status_code == 200
    # If the source asset were left pinned, this delete would 409.
    assert c.delete(f'/v1/assets/{aid}').status_code == 200

def test_unavailable_models_do_not_fake_success(client):
    c, _ = client
    aid = upload(c, np.zeros(48000))
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {'separator': 'bandit_v2', 'separate_music': True}})
    assert response.status_code == 409
    # AV-CASS was dropped as an option; the schema now rejects it outright.
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {'separator': 'av_cass', 'separate_music': True}})
    assert response.status_code == 422


def test_analysis_reads_do_not_hold_job_lock_and_assets_stay_pinned(client,monkeypatch):
    c,app=client
    aid=upload(c,np.ones(48000,dtype=np.float32)*.01)
    entered=threading.Event();resume=threading.Event();results=[]
    original=app.read_audio
    def delayed(*args):
        entered.set();resume.wait(3)
        return original(*args)
    monkeypatch.setattr(app,'read_audio',delayed)
    thread=threading.Thread(target=lambda:results.append(c.post('/v1/music-analysis',json={'music_asset':aid,'dialogue_asset':aid})))
    thread.start()
    try:
        assert entered.wait(3)
        started=time.perf_counter()
        assert c.delete('/v1/assets/'+aid).status_code==409
        assert time.perf_counter()-started<1
    finally:
        resume.set();thread.join(5)
    assert results[0].status_code==200 and not app.ASSET_PINS
    assert c.delete('/v1/assets/'+aid).status_code==200


def test_worker_release_is_authenticated(client):
    c,app=client
    assert c.post('/v1/workers/release',headers={'Host': 'attacker.example'}).status_code == 403
    assert c.post('/v1/workers/release').json()=={'released':True}

def test_upload_rejects_invalid_and_surround(client):
    c, _ = client
    assert c.post('/v1/assets', content=b'not wav').status_code == 422
    assert c.post('/v1/assets', content=wav(np.zeros((48000, 6)))).status_code == 422

@pytest.mark.parametrize('enhancer,label', [('mossformer2','MossFormer2'), ('gap_urgenet','GAP-URGENet')])
def test_missing_cleanup_does_not_silently_return_uncleaned_dialogue(client, enhancer, label):
    c, _ = client
    aid = upload(c, np.zeros(48000))
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid, 'role': r} for r in ('dialogue','music','effects')],
                                       'settings': {'separator': 'provided_stems', 'enhancer': enhancer}})
    assert response.status_code == 409
    assert label in response.text

@pytest.mark.parametrize('music,ambience', [(False,False),(True,False),(False,True),(True,True)])
@pytest.mark.parametrize('enhancer', ['mossformer2', 'gap_urgenet'])
def test_dialogue_worker_receives_raw_audio_without_bandit_speech(client, monkeypatch, tmp_path, enhancer, music, ambience):
    import hashlib
    import sys
    from pathlib import Path
    c, app = client
    checkpoint = tmp_path / 'checkpoints/MossFormer2_SE_48K/last_best_checkpoint.pt'
    checkpoint.parent.mkdir(parents=True)
    checkpoint.write_bytes(b'pinned test checkpoint')
    checkpoint.with_name('last_best_checkpoint').write_text(checkpoint.name)
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    cfg = {'python':sys.executable,'repo':str(tmp_path),'checkpoint':str(checkpoint),'checkpoint_sha256':digest,
           'runtime':str(tmp_path),'checkpoints':str(checkpoint.parent),'checkpoint_hashes':{checkpoint.name:digest}}
    monkeypatch.setattr(app, 'CONFIG', {name:cfg for name in ('bandit_v2','mossformer2','gap_urgenet')})
    monkeypatch.setattr(app, 'bandit_ready', lambda:bool(music or ambience))
    if not (music or ambience): app.CONFIG.pop('bandit_v2')
    monkeypatch.setattr(app, 'mossformer_ready', lambda:True)
    monkeypatch.setattr(app, 'gap_ready', lambda:True)
    signal = (.2 * np.sin(2*np.pi*320*np.arange(48000)/48000)).astype(np.float32)
    received = []
    class Worker:
        returncode = 0
        def __init__(self, args, **kwargs):
            output = Path(args[args.index('--output')+1])
            if args[1].endswith('bandit_v2.py'):
                output.mkdir()
                # No speech.wav exists: dialogue must not depend on it.
                for stem in ('music','sfx'): sf.write(output/f'{stem}.wav', signal*.01, 48000, subtype='FLOAT')
                (output/'benchmark.json').write_text('{}')
            else:
                assert args[1].endswith(f'{enhancer}.py')
                raw, sr = sf.read(args[args.index('--input')+1], dtype='float32')
                received.append(raw)
                sf.write(output, raw*.5, sr, subtype='FLOAT')
                output.with_suffix('.json').write_text(json.dumps({'model':enhancer}))
        def poll(self): return 0
    def run_worker(key,args,log,check,verify,progress=None):
        check();verify();Worker(args)
        return {'worker_reused':False}
    monkeypatch.setattr(app, 'run_worker', run_worker)
    aid = upload(c, signal)
    request = {'tracks':[{'asset_id':aid}], 'settings':{'enhancer':enhancer, 'separate_music':music, 'separate_ambience':ambience}}
    response = c.post('/v1/jobs', json=request)
    assert response.status_code == 202, response.text
    job = wait(c, response.json()['job_id'])
    assert job['status'] == 'done', job
    np.testing.assert_array_equal(received[0], signal)
    assert job['result']['enhancement']['input_source'] == 'raw_audio'
    expected_stems = ['dialogue'] + (['effects'] if ambience else []) + (['music'] if music else [])
    assert job['result']['stems'] == expected_stems + ['mix']
    for absent in set(['music','effects']) - set(expected_stems):
        assert c.get(f"/v1/jobs/{job['job_id']}/result/{absent}").status_code == 404
    assert c.post('/v1/jobs', json=request).json()['job_id'] == job['job_id']
    request['settings'].update(enhancer_wet=.5, dialogue_postprocess=False)
    blended = wait(c, c.post('/v1/jobs', json=request).json()['job_id'])
    assert blended['status'] == 'done', blended
    assert blended['result']['stage_cache']['dialogue'] is True
    audio, _ = sf.read(io.BytesIO(c.get(f"/v1/jobs/{blended['job_id']}/result/dialogue").content), dtype='float32')
    np.testing.assert_allclose(audio, signal*.75, atol=1e-6)
    assert blended['result']['enhancement']['wet_mix'] == .5
    request['settings'].update(enhancer_wet=1, dialogue_postprocess=True)
    request['settings']['max_boost_db'] = 17
    refinished = wait(c, c.post('/v1/jobs', json=request).json()['job_id'])
    assert refinished['status'] == 'done', refinished
    assert refinished['result']['stage_cache']['dialogue'] is True
    if music or ambience: assert refinished['result']['stage_cache']['separation'] is True
    assert len(received) == 1  # Finishing changes must not run cleanup again.
    request['settings']['deess_declick'] = True
    repaired = wait(c, c.post('/v1/jobs', json=request).json()['job_id'])
    assert repaired['status'] == 'done' and repaired['result']['stage_cache']['dialogue'] is True
    assert len(received) == 1
    if music or ambience:
        request['settings'].update(separate_music=False,separate_ambience=False)
        dialogue_only = wait(c, c.post('/v1/jobs', json=request).json()['job_id'])
        assert dialogue_only['status'] == 'done'
        assert dialogue_only['result']['stage_cache'] == {'dialogue':True}
        assert dialogue_only['result']['stems'] == ['dialogue','mix'] and len(received) == 1
    enhancer = 'gap_urgenet' if enhancer == 'mossformer2' else 'mossformer2'
    request['settings']['enhancer'] = enhancer
    switched = c.post('/v1/jobs', json=request).json()['job_id']
    assert switched != job['job_id']
    assert wait(c, switched)['status'] == 'done'
    np.testing.assert_array_equal(received[1], signal)

def test_end_to_end_stems_and_content_cache(client):
    c, _ = client
    x = .02 * np.sin(2 * np.pi * 300 * np.arange(48000) / 48000)
    tracks = [{'asset_id': upload(c, x), 'role': role} for role in ('dialogue', 'music', 'effects')]
    request = {'tracks': tracks, 'settings': {'separator': 'provided_stems', 'enhancer': 'none', 'separate_music': True, 'separate_ambience': True}}
    response = c.post('/v1/jobs', json=request)
    assert response.status_code == 202, response.text
    jid = response.json()['job_id']
    job = wait(c, jid)
    assert job['status'] == 'done', job
    arrays = []
    for stem in ('dialogue', 'music', 'effects', 'mix'):
        result = c.get(f'/v1/jobs/{jid}/result/{stem}')
        audio, sr = sf.read(io.BytesIO(result.content), always_2d=True)
        assert audio.shape == (48000, 1) and sr == 48000
        arrays.append(audio)
    np.testing.assert_allclose(sum(arrays[:3]), arrays[3], atol=1e-6)
    request['tracks'][0]['asset_id'] = upload(c, x)
    assert c.post('/v1/jobs', json=request).json()['job_id'] == jid
    request['settings']['duck_db'] = 11
    assert c.post('/v1/jobs', json=request).json()['job_id'] != jid
    assert c.get(f'/v1/jobs/{jid}/result/unknown').status_code == 404

def test_deess_declick_toggle_and_cache_identity(client):
    c, _ = client
    x = .02 * np.sin(2 * np.pi * 300 * np.arange(48000) / 48000)
    tracks = lambda: [{'asset_id': upload(c, x), 'role': role} for role in ('dialogue', 'music', 'effects')]
    request = {'tracks': tracks(), 'settings': {'separator': 'provided_stems', 'enhancer': 'none', 'deess_declick': True}}
    response = c.post('/v1/jobs', json=request)
    assert response.status_code == 202, response.text
    jid = response.json()['job_id']
    job = wait(c, jid)
    assert job['status'] == 'done', job
    assert set(job['result']['deess']) >= {'algorithm', 'avg_gain_reduction_db', 'max_gain_reduction_db', 'applied'}
    assert job['result']['deess_declick'] is not None
    assert set(job['result']['deess_declick']) >= {'clicks_repaired', 'samples_repaired', 'repairs', 'repairs_truncated'}
    request['tracks'] = tracks()
    request['settings']['deess_declick'] = False
    off = c.post('/v1/jobs', json=request)
    assert off.status_code == 202, off.text
    off_job = wait(c, off.json()['job_id'])
    assert off_job['status'] == 'done', off_job
    assert off_job['result']['deess_declick'] is None
    assert off_job['result']['deess']['applied'] in (True, False)
    assert off_job['job_id'] != jid

def test_lowend_enhances_a_whole_clip_and_result_is_downloadable(client):
    c, app = client
    rate = 48000
    x = .05 * np.sin(2 * np.pi * 100 * np.arange(2 * rate) / rate).astype(np.float32)  # inside lowend.LOWPASS_HZ
    aid = upload(c, x)
    assert c.post('/v1/lowend', json={'asset_id': aid}, headers={'Host': 'attacker.example'}).status_code == 403
    response = c.post('/v1/lowend', json={'asset_id': aid})
    assert response.status_code == 200, response.text
    body = response.json()
    report = body['report']
    assert set(report) >= {'algorithm', 'body_band_hz', 'safety_gain_db', 'applied', 'channels'}
    assert report['applied'] is True
    download = c.get(f"/v1/assets/{body['result_asset_id']}/download")
    assert download.status_code == 200
    enhanced, sr = sf.read(io.BytesIO(download.content), dtype='float32', always_2d=True)
    assert sr == rate and enhanced.shape == x[:, None].shape
    assert not np.allclose(enhanced, x[:, None])  # something was actually added
    # Original asset is untouched by the operation (a new, separate asset was created).
    assert (app.ROOT / f'{aid}.wav').exists()
    np.testing.assert_allclose(sf.read(app.ROOT / f'{aid}.wav', dtype='float32', always_2d=True)[0], x[:, None], atol=1e-6)

def test_lowend_unknown_asset_404(client):
    c, _ = client
    assert c.post('/v1/lowend', json={'asset_id': '0' * 32}).status_code == 404

def test_lowend_unpins_the_source_asset_after_completion(client):
    c, _ = client
    aid = upload(c, np.zeros(48000, dtype=np.float32) + .01)
    assert c.post('/v1/lowend', json={'asset_id': aid}).status_code == 200
    # If the source asset were left pinned, this delete would 409.
    assert c.delete(f'/v1/assets/{aid}').status_code == 200

def test_cache_reuse_is_busted_by_a_dsp_code_change(client, monkeypatch):
    # A prior version of the cache fingerprint tracked settings/inputs/config
    # but not the DSP module's own content, so a purely internal fix to
    # deess.py/audio.py (no settings or API change) left the fingerprint --
    # and therefore any already-completed job for the same input+settings --
    # unchanged. Resubmitting after the fix then matched that stale job and
    # came back near-instantly via 'reused: true', silently serving the
    # pre-fix output instead of reprocessing. This locks in the fix: the same
    # request must be reused while DSP_CODE_SHA256 is stable, and must NOT be
    # reused once it changes (simulating an edit to deess.py/audio.py).
    c, app = client
    x = .02 * np.sin(2 * np.pi * 300 * np.arange(48000) / 48000)
    tracks = lambda: [{'asset_id': upload(c, x), 'role': role} for role in ('dialogue', 'music', 'effects')]
    request = {'tracks': tracks(), 'settings': {'separator': 'provided_stems', 'enhancer': 'none', 'deess_declick': True}}
    first = c.post('/v1/jobs', json=request)
    assert first.status_code == 202, first.text
    first_jid = first.json()['job_id']
    wait(c, first_jid)

    request['tracks'] = tracks()
    same_code = c.post('/v1/jobs', json=request)
    assert same_code.status_code == 202, same_code.text
    assert same_code.json() == {'job_id': first_jid, 'reused': True}, (
        'expected an identical resubmission (same inputs/settings, unchanged DSP code) to reuse the completed job'
    )

    monkeypatch.setattr(app, 'DSP_CODE_SHA256', 'simulated-post-fix-hash')
    request['tracks'] = tracks()
    changed_code = c.post('/v1/jobs', json=request)
    assert changed_code.status_code == 202, changed_code.text
    changed_body = changed_code.json()
    assert changed_body['job_id'] != first_jid and changed_body['reused'] is False, (
        'a DSP code change must bust the cache even when settings/inputs are identical, else it silently serves stale pre-fix output'
    )

def test_fresh_job_is_not_reused_and_is_advertised(client):
    # Panel "Don't use cached files" (2026-10-09): fresh:true runs again.
    c, app = client
    assert 'fresh_jobs_v1' in c.get('/v1/health').json()['capabilities']
    x = .02 * np.sin(2 * np.pi * 300 * np.arange(48000) / 48000)
    tracks = lambda: [{'asset_id': upload(c, x), 'role': role} for role in ('dialogue', 'music', 'effects')]
    request = {'tracks': tracks(), 'settings': {'separator': 'provided_stems', 'enhancer': 'none', 'deess_declick': True}}
    first = c.post('/v1/jobs', json=request).json()
    wait(c, first['job_id'])
    request['tracks'] = tracks()
    again = c.post('/v1/jobs', json={**request, 'fresh': True}).json()
    assert again['reused'] is False and again['job_id'] != first['job_id']
    assert wait(c, again['job_id'])['status'] == 'done'

def test_cancel_queued_job(client, monkeypatch):
    c, app = client
    gate = threading.Event()
    app.POOL.submit(gate.wait, 3)
    aid = upload(c, np.zeros(48000))
    request = {'tracks': [{'asset_id': aid, 'role': r} for r in ('dialogue', 'music', 'effects')], 'settings': {'separator': 'provided_stems', 'enhancer': 'none', 'separate_music': True, 'separate_ambience': True}}
    jid = c.post('/v1/jobs', json=request).json()['job_id']
    assert c.get(f'/v1/jobs/{jid}/result/mix').status_code == 409
    assert c.delete(f'/v1/jobs/{jid}').json()['cancellation_requested']
    gate.set()
    assert wait(c, jid)['status'] == 'cancelled'

def test_restart_marks_unfinished_failed(tmp_path, monkeypatch):
    app = importlib.import_module('service.app')
    monkeypatch.setattr(app, 'ROOT', tmp_path)
    monkeypatch.setattr(app, 'JOBS', {})
    monkeypatch.setattr(app, 'CANCEL', {})
    (tmp_path / 'job-abc.json').write_text(json.dumps({'job_id': 'abc', 'status': 'running'}))
    with TestClient(app.app):
        assert app.JOBS['abc']['status'] == 'failed'

def test_schema_rejects_bad_roles_and_nonfinite():
    with pytest.raises(ValueError):
        Settings(duck_db=float('nan'))
    with pytest.raises(ValueError):
        Settings(stems=[])
    with pytest.raises(ValueError):
        JobRequest(tracks=[{'asset_id': 'a'*32, 'role': 'dialogue'}])

def test_silence_and_duration(tmp_path):
    stems = {k: np.zeros((48000, 2), np.float32) for k in ('dialogue', 'music', 'effects')}
    report = mix(stems, Settings(), tmp_path)
    assert report['normalization']['dialogue']['measured'] is None
    assert not read_audio(tmp_path / 'mix.wav', 48000).any()
    stems['effects'] = stems['effects'][:-1]
    with pytest.raises(ValueError, match='durations'):
        mix(stems, Settings(), tmp_path)

def test_ducking_reduces_music_and_releases(tmp_path):
    rate = 48000
    t = np.arange(rate * 4) / rate
    tone = (.03 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)[:, None]
    dialogue = tone.copy()
    dialogue[:rate//2] = 0
    dialogue[rate*2:] = 0
    stems = {'dialogue': dialogue, 'music': tone, 'effects': tone*0}
    mix(stems, Settings(release_ms=200), tmp_path)
    music = read_audio(tmp_path / 'music.wav', rate)
    rms = lambda x: float(np.sqrt(np.mean(x*x)))
    quiet = rms(music[:rate//3])
    ducked = rms(music[rate:rate+rate//2])
    released = rms(music[3*rate:])
    assert ducked < quiet * .4
    assert released > quiet * .95

def test_peak_safety(tmp_path):
    rate = 48000
    tone = (.8 * np.sin(2*np.pi*1000*np.arange(rate)/rate)).astype(np.float32)[:, None]
    s = Settings(stems=[{'name': k, 'target': -6} for k in ('dialogue', 'music', 'effects')])
    report = mix({k: tone.copy() for k in ('dialogue', 'music', 'effects')}, s, tmp_path)
    from scipy.signal import resample_poly
    assert np.max(np.abs(resample_poly(read_audio(tmp_path/'mix.wav', rate), 4, 1, axis=0))) <= 10**(-1.19/20)
    assert report['safety_gain_db'] < 0


def test_mix_does_not_boost_dialogue_past_peak_target(tmp_path):
    rate = 48000
    quiet = (.01 * np.sin(2 * np.pi * 440 * np.arange(rate * 2) / rate)).astype(np.float32)[:, None]
    compressed, _ = __import__('service.compressor', fromlist=['compress_dialogue']).compress_dialogue(quiet, rate, target_dbfs=-12)
    report = mix({'dialogue': compressed}, Settings(), tmp_path)
    out = read_audio(tmp_path / 'dialogue.wav', rate)
    assert report['normalization']['dialogue']['measured'] < -12
    assert float(20 * np.log10(max(np.max(np.abs(out)), 1e-15))) <= -11.9


def test_mix_skips_dialogue_normalization_when_postprocess_disabled(tmp_path):
    x = (.2 * np.sin(2 * np.pi * 440 * np.arange(4800) / 48000)).astype(np.float32)[:, None]
    settings = Settings(dialogue_postprocess=False)
    report = mix({'dialogue': x.copy()}, settings, tmp_path)
    assert report['normalization']['dialogue']['skipped'] == 'dialogue_postprocess_off'
    out = read_audio(tmp_path / 'dialogue.wav', 48000)
    np.testing.assert_allclose(out, x, rtol=0, atol=1e-6)


def test_job_with_no_enabled_stages_rejected(client):
    c, _ = client
    aid = upload(c, np.zeros(4800, dtype=np.float32))
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {
        'enhancer': 'none', 'dialogue_postprocess': False, 'deess_declick': False,
        'separate_music': False, 'separate_ambience': False,
    }})
    assert response.status_code == 422


def test_lowend_intensity_request_validation_and_forwarding(client, monkeypatch):
    c, app = client
    aid = upload(c, np.zeros(4800, dtype='float32'))
    seen = []
    def enhance(x, rate, intensity):
        seen.append(intensity)
        return x, {'intensity': intensity, 'applied': False}
    monkeypatch.setattr(app, 'enhance_low_end', enhance)
    for intensity in [.2, 1., 3.]:
        response = c.post('/v1/lowend', json={'asset_id': aid, 'intensity': intensity})
        assert response.status_code == 200
        assert response.json()['report']['intensity'] == intensity
    assert seen == [.2, 1., 3.]
    for intensity in [.1, 3.1]:
        assert c.post('/v1/lowend', json={'asset_id': aid, 'intensity': intensity}).status_code == 422


def test_grouped_batch_uses_raw_for_both_models_and_preserves_finishing(client, monkeypatch):
    from pathlib import Path
    c, app = client
    cfg = {'python':'test','repo':'test','checkpoint':'test','checkpoints':'test'}
    monkeypatch.setattr(app,'CONFIG',{'gap_urgenet':cfg,'bandit_v2':cfg})
    monkeypatch.setattr(app,'gap_ready',lambda:True)
    monkeypatch.setattr(app,'bandit_ready',lambda:True)
    monkeypatch.setattr(app,'model_identity',lambda base,name,cfg:name)
    monkeypatch.setattr(app,'verify_model',lambda *args:None)
    calls=[]; sources=[]
    def worker(key,args,log,check,verify,progress=None):
        raw,rate=sf.read(args[args.index('--input')+1],dtype='float32')
        model=Path(args[1]).stem;calls.append(model);sources.append(raw.copy())
        out=Path(args[args.index('--output')+1])
        if model=='gap_urgenet':
            sf.write(out,raw*.5,rate,subtype='FLOAT');out.with_suffix('.json').write_text('{}')
        else:
            out.mkdir();sf.write(out/'sfx.wav',raw*.1,rate,subtype='FLOAT');(out/'benchmark.json').write_text('{}')
        return {'worker_reused':len(calls)>1 and calls[-1]==calls[-2]}
    monkeypatch.setattr(app,'run_worker',worker)
    signals=[(.1*n*np.sin(2*np.pi*300*np.arange(4800)/48000)).astype(np.float32) for n in (1,2)]
    assets=[upload(c,x) for x in signals]
    def submit(a,**extra):
        settings={'enhancer':'gap_urgenet','separate_ambience':extra.get('stage_mode')!='dialogue_cache'}
        response=c.post('/v1/jobs',json={'tracks':[{'asset_id':a}], 'settings':settings,**extra})
        assert response.status_code==202,response.text
        return wait(c,response.json()['job_id'])
    for a in assets:
        j=submit(a,stage_mode='dialogue_cache');assert j['status']=='done',j
        assert j['result']['stems']==[]
        assert not (app.ROOT/j['job_id']/'result').exists()
    # Retrying an interrupted first pass must reuse native cache without inference.
    for a in assets:
        assert submit(a,stage_mode='dialogue_cache')['result']['stage_cache']['dialogue'] is True
    assert calls==['gap_urgenet','gap_urgenet']
    finals=[submit(a,require_dialogue_cache=True) for a in assets]
    assert all(j['status']=='done' for j in finals),finals
    assert calls==['gap_urgenet','gap_urgenet','bandit_v2','bandit_v2']
    for actual,expected in zip(sources,signals+signals):np.testing.assert_array_equal(actual,expected)
    for a,grouped in zip(assets,finals):
        ordinary=submit(a)
        assert ordinary['status']=='done',ordinary
        for stem in ('dialogue','effects','mix'):
            np.testing.assert_array_equal(sf.read(app.ROOT/grouped['job_id']/'result'/f'{stem}.wav')[0],sf.read(app.ROOT/ordinary['job_id']/'result'/f'{stem}.wav')[0])
    # A lost cache must not unexpectedly switch back to GAP mid-Bandit pass.
    original_get=app.StageCache.get
    monkeypatch.setattr(app.StageCache,'get',lambda self,key,names:None if names==['dialogue.wav'] else original_get(self,key,names))
    lost=submit(upload(c,signals[0]*.9),require_dialogue_cache=True)
    assert lost['status']=='failed' and 'cache is missing' in lost['error']['message']
    assert calls.count('gap_urgenet')==2
    retry=submit(assets[0],stage_mode='dialogue_cache')
    assert retry['status']=='done' and calls.count('gap_urgenet')==3
