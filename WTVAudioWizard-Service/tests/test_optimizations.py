import json
import shutil
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from service import worker_pool
from service.music import levels
from service.audio import read_audio, resample_audio
from service.stage_cache import StageCache, identity, model_identity


@pytest.mark.parametrize('channels', [1, 2])
@pytest.mark.parametrize('samples', [960, 960*257+137])
def test_bounded_levels_exact(channels, samples):
    x=np.random.default_rng(7).normal(0,.1,(samples,channels)).astype(np.float32)
    padded=np.pad(x,((0,(-samples)%960),(0,0)))
    expected=np.sqrt(np.mean(padded.reshape(-1,960,channels).astype(np.float64)**2,axis=(1,2)))
    np.testing.assert_array_equal(levels(x,48000),expected)


@pytest.mark.parametrize('rate', [44100,48000,96000])
def test_memory_conversion_matches_float_wav_roundtrip(tmp_path,rate):
    x=np.random.default_rng(9).normal(0,.1,(rate+137,2)).astype(np.float32)
    sf.write(tmp_path/'input.wav',x,rate,subtype='FLOAT')
    np.testing.assert_array_equal(resample_audio(x,rate,48000),read_audio(tmp_path/'input.wav',48000))


def test_cache_integrity_and_cancel(tmp_path):
    cache=StageCache(tmp_path);key=identity({'test':1});source=tmp_path/'source.wav'
    source.write_bytes(b'complete model output')
    cache.put(key,{'dialogue.wav':source},{'sample':1},lambda:None)
    hit=cache.get(key,['dialogue.wav']);assert hit['metadata']=={'sample':1}
    assert cache.get(key,['music.wav']) is None
    (hit['folder']/'dialogue.wav').write_bytes(b'corrupt')
    assert cache.get(key,['dialogue.wav']) is None
    cache.put(key,{'dialogue.wav':source},{'sample':2},lambda:None)
    assert cache.get(key,['dialogue.wav'])['metadata']=={'sample':2}
    calls=[]
    def cancel():
        calls.append(1)
        if len(calls)==2: raise RuntimeError('cancelled')
    other=identity({'test':2})
    with pytest.raises(RuntimeError,match='cancelled'): cache.put(other,{'dialogue.wav':source},{},cancel)
    assert cache.get(other,['dialogue.wav']) is None
    assert not list(cache.root.glob('*.tmp-*'))


def test_model_identity_tracks_source_config_and_pins(tmp_path):
    (tmp_path/'runners').mkdir();source=tmp_path/'runners/gap_urgenet.py';source.write_text('one')
    cfg={'checkpoint_sha256':'a'}
    first=model_identity(tmp_path,'gap_urgenet',cfg)
    source.write_text('two')
    second=model_identity(tmp_path,'gap_urgenet',cfg)
    assert first!=second
    assert second!=model_identity(tmp_path,'gap_urgenet',{'checkpoint_sha256':'b'})


@pytest.fixture
def worker(tmp_path,monkeypatch):
    runners=tmp_path/'runners';runners.mkdir()
    shutil.copyfile(Path(worker_pool.__file__).resolve().parents[1]/'runners/worker.py',runners/'worker.py')
    runner=runners/'gap_urgenet.py'
    runner.write_text('''import sys,time
count=0
def main():
    global count
    count+=1
    print('request',count,flush=True)
    if 'fail' in sys.argv: raise ValueError('test model failure')
    if 'slow' in sys.argv: time.sleep(10)
''')
    monkeypatch.setattr(worker_pool,'__file__',str(tmp_path/'service/worker_pool.py'))
    pool=worker_pool.ModelWorker(idle_seconds=60)
    yield pool,[sys.executable,str(runner)],tmp_path/'job.log'
    pool.release_idle()


def test_worker_reuses_model_and_reverifies_on_switch(worker):
    pool,args,log=worker;pins=[]
    verify=lambda:pins.append(1)
    assert pool.run('a',args,log,lambda:None,verify)=={'worker_reused':False}
    pid=pool.process.pid
    assert pool.run('a',args,log,lambda:None,verify)=={'worker_reused':True}
    assert 'request 2' in log.read_text() and pool.process.pid==pid and len(pins)==1
    assert pool.run('b',args,log,lambda:None,verify)=={'worker_reused':False}
    assert pool.process.pid!=pid and len(pins)==2 and 'request 1' in log.read_text()
    assert pool.release_idle() and pool.process is None


def test_worker_failure_discards_process(worker):
    pool,args,log=worker
    with pytest.raises(RuntimeError,match='test model failure'): pool.run('a',args+['fail'],log,lambda:None,lambda:None)
    assert pool.process is None and not pool.busy
    assert 'Traceback' in log.read_text()


def test_worker_cancel_and_busy_release(worker):
    pool,args,log=worker;cancel=threading.Event();errors=[]
    def check():
        if cancel.is_set(): raise RuntimeError('cancelled')
    def run():
        try: pool.run('a',args+['slow'],log,check,lambda:None)
        except Exception as error: errors.append(str(error))
    thread=threading.Thread(target=run);thread.start()
    deadline=time.monotonic()+5
    while not log.exists() and time.monotonic()<deadline: time.sleep(.01)
    assert not pool.release_idle()
    cancel.set();thread.join(5)
    assert not thread.is_alive() and errors==['cancelled'] and pool.process is None


def test_worker_idle_unload(worker):
    pool,args,log=worker;pool.idle_seconds=.05
    pool.run('a',args,log,lambda:None,lambda:None)
    deadline=time.monotonic()+3
    while pool.process is not None and time.monotonic()<deadline: time.sleep(.01)
    assert pool.process is None
