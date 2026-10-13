import importlib
import io
import threading
import time
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient


@pytest.fixture
def api(tmp_path, monkeypatch):
    app = importlib.import_module('service.app')
    monkeypatch.setattr(app, 'ROOT', tmp_path)
    monkeypatch.setattr(app, 'JOBS', {})
    monkeypatch.setattr(app, 'CANCEL', {})
    monkeypatch.setattr(app, 'ASSET_PINS', {})
    with TestClient(app.app, base_url='http://192.168.0.176:8756', client=('192.168.25.252', 50000)) as client:
        yield client, app


def asset(client):
    data=io.BytesIO()
    sf.write(data, .1*np.sin(np.arange(48000)*2*np.pi*180/48000), 48000, format='WAV')
    response=client.post('/v1/assets',content=data.getvalue())
    assert response.status_code==201
    return response.json()['asset_id']


def wait(client,jid):
    deadline=time.monotonic()+20
    while time.monotonic()<deadline:
        response=client.get('/v1/quality-jobs/'+jid)
        assert response.status_code==200
        job=response.json()
        if job['status'] not in ('queued','running'):return job
        time.sleep(.02)
    raise AssertionError('Quality job did not finish')


def test_real_cpu_api_and_disposable_upload(api):
    client,app=api
    aid=asset(client)
    response=client.post('/v1/quality-jobs',json={'asset_id':aid,'threshold':5,'delete_asset_when_done':True})
    assert response.status_code==202,response.text
    job=wait(client,response.json()['job_id'])
    assert job['status']=='done',job
    assert job['result']['provider']=='CPUExecutionProvider'
    assert job['result']['windows']==1
    assert not app.ASSET_PINS
    assert not (app.ROOT/f'{aid}.wav').exists()


def test_auth_validation_and_unknown_asset(api):
    client,app=api
    payload={'asset_id':'a'*32}
    assert client.post('/v1/quality-jobs',json=payload,headers={'Host': 'attacker.example'}).status_code == 403
    assert client.post('/v1/quality-jobs',json={'asset_id':'../secret'}).status_code==422
    assert client.post('/v1/quality-jobs',json={**payload,'threshold':6}).status_code==422
    assert client.post('/v1/quality-jobs',json=payload).status_code==404
    assert client.get('/v1/quality-jobs/'+'a'*32).status_code==404
    assert 'dnsmos_quality_v1' in client.get('/v1/health').json()['capabilities']


def test_cancel_pin_and_queue_limit(api,monkeypatch):
    client,app=api
    class SlowAnalyzer:
        def analyze(self,path,threshold,progress,cancel):
            while not cancel():time.sleep(.01)
            raise InterruptedError()
    monkeypatch.setattr(app,'QualityAnalyzer',SlowAnalyzer)
    aid=asset(client)
    first=client.post('/v1/quality-jobs',json={'asset_id':aid,'delete_asset_when_done':True}).json()['job_id']
    second=client.post('/v1/quality-jobs',json={'asset_id':aid,'delete_asset_when_done':True}).json()['job_id']
    assert client.delete('/v1/assets/'+aid).status_code==409
    assert client.post('/v1/quality-jobs',json={'asset_id':aid}).status_code==429
    client.delete('/v1/quality-jobs/'+second)
    client.delete('/v1/quality-jobs/'+first)
    assert wait(client,first)['status']=='cancelled'
    assert wait(client,second)['status']=='cancelled'
    assert not app.ASSET_PINS
    assert not (app.ROOT/f'{aid}.wav').exists()


def test_model_failure_releases_input(api,monkeypatch):
    client,app=api
    def fail():raise RuntimeError('Model load failed')
    monkeypatch.setattr(app,'QualityAnalyzer',fail)
    aid=asset(client)
    jid=client.post('/v1/quality-jobs',json={'asset_id':aid,'delete_asset_when_done':True}).json()['job_id']
    assert wait(client,jid)['error']=='Model load failed'
    assert not app.ASSET_PINS
    assert not (app.ROOT/f'{aid}.wav').exists()
