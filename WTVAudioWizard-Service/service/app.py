"""Single-user loopback service. Run one Uvicorn process/worker only."""
from .audio import blend_dialogue
import asyncio
from contextlib import asynccontextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import soundfile as sf
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import FileResponse
from .schema import JobRequest, Settings, DeplosiveRequest, LowEndRequest, QualityRequest
from .quality import Analyzer as QualityAnalyzer
from .audio import read_audio, resample_audio, mix
from .stage_cache import StageCache, identity, model_identity, digest_file
from .worker_pool import ModelWorker
from .progress import SpeedHistory, StageProgress
from starlette.concurrency import run_in_threadpool
from .deess import deess, declick, deess_declick
from .compressor import compress_dialogue, normalize_sparse_dialogue
from .leveler import level_dialogue
from .lowend import enhance_low_end
from .deplosive import attenuate_pop
from .music import MusicAnalysis, analyze as analyze_music

BASE = Path(__file__).resolve().parents[1]
# Data folder: WTV_DATA_DIR, else <workspace>/work/wtv-data. The workspace is
# WTV_WORKSPACE, else two folders above this one (the original Windows layout).
ROOT = Path(os.environ.get('WTV_DATA_DIR') or Path(os.environ.get('WTV_WORKSPACE') or BASE.parents[1]) / 'work' / 'wtv-data').resolve()
ROOT.mkdir(parents=True, exist_ok=True)
TOKEN_PATH = ROOT / 'token.txt'
if not TOKEN_PATH.exists():
    TOKEN_PATH.write_text(secrets.token_urlsafe(32))
TOKEN = TOKEN_PATH.read_text().strip()
CONFIG_PATH = Path(os.environ.get('WTV_CONFIG', BASE / 'local-config.json'))
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}

def _hash_files(*paths):
    """SHA-256 over the concatenated bytes of the given files. Included in the
    job cache fingerprint below so that any edit to this DSP code -- even a
    purely internal fix with no settings/API change -- automatically busts
    cached results, instead of relying on someone remembering to bump the
    hand-maintained 'pipeline' version string. (A real de-click/de-ess fix
    once shipped without that bump; a since-completed job for the same input
    + settings kept matching the new request's fingerprint and got served
    back via 'reused: true', silently returning the pre-fix output.)"""
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.read_bytes())
    return digest.hexdigest()

DSP_CODE_SHA256 = _hash_files(Path(__file__).with_name('deess.py'), Path(__file__).with_name('audio.py'), Path(__file__).with_name('compressor.py'))
LOCK = threading.RLock()
JOBS, CANCEL = {}, {}
POOL = None
MAX_BYTES = 1536 * 1024 * 1024
WORKER = ModelWorker()
ASSET_PINS = {}
QUALITY_JOBS, QUALITY_CANCEL = {}, {}
QUALITY_POOL = None
QUALITY_ANALYZER = None

def save(job):
    destination = ROOT / f"job-{job['job_id']}.json"
    temp = destination.with_suffix('.tmp')
    temp.write_text(json.dumps(job, indent=2, allow_nan=False))
    temp.replace(destination)

def update(jid, **fields):
    with LOCK:
        JOBS[jid].update(fields)
        save(JOBS[jid])

@asynccontextmanager
async def lifespan(app):
    global POOL, QUALITY_POOL, QUALITY_ANALYZER
    POOL = ThreadPoolExecutor(max_workers=1)
    QUALITY_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='dnsmos')
    QUALITY_JOBS.clear()
    QUALITY_CANCEL.clear()
    QUALITY_ANALYZER = None
    for path in ROOT.glob('job-*.json'):
        job = json.loads(path.read_text())
        if job['status'] in ('queued', 'running'):
            job.update(status='failed', error={'code': 'service_restarted', 'message': 'Service stopped before job completion; submit again.'})
            save(job)
        JOBS[job['job_id']] = job
    yield
    for event in CANCEL.values():
        event.set()
    for event in QUALITY_CANCEL.values():
        event.set()
    await asyncio.to_thread(QUALITY_POOL.shutdown, wait=True)
    await asyncio.to_thread(POOL.shutdown, wait=True, cancel_futures=True)
    WORKER.release_idle()

app = FastAPI(title='WTVAudioWizard', version='0.7.1', lifespan=lifespan)

@app.middleware('http')
async def local_boundary(request, call_next):
    # The launcher binds loopback. Reject browser origins and unexpected Host headers.
    from fastapi.responses import JSONResponse
    host = request.headers.get('host', '').split(':')[0]
    if host not in ('127.0.0.1', 'localhost', 'testserver') or request.headers.get('origin') not in (None, 'null'):
        return JSONResponse({'detail': 'Local client required'}, status_code=403)
    return await call_next(request)

def auth(request: Request):
    if not secrets.compare_digest(request.headers.get('authorization', ''), f'Bearer {TOKEN}'):
        raise HTTPException(401, 'Enter the local service token in the panel')

def bandit_ready():
    cfg = CONFIG.get('bandit_v2', {})
    return all(Path(cfg.get(k, '__missing__')).is_file() for k in ('python', 'checkpoint')) and Path(cfg.get('repo', '__missing__'), 'src/models/bandit/bandit.py').is_file()

def gap_ready():
    cfg = CONFIG.get('gap_urgenet', {})
    return Path(cfg.get('python', '__missing__')).is_file() and Path(cfg.get('repo', '__missing__'), 'models/gap_urgenet.py').is_file() and all(Path(cfg.get('checkpoints', '__missing__'), name).is_file() for name in ('DeWavLM-Omni.pt','Adapter.pt','Vocoder.pt','Predictor.pt','PostNet.pt','config.json'))

def mossformer_ready():
    cfg = CONFIG.get('mossformer2', {})
    root = Path(cfg.get('runtime', '__missing__')) / 'checkpoints/MossFormer2_SE_48K'
    return Path(cfg.get('python', '__missing__')).is_file() and all((root / name).is_file() for name in ('last_best_checkpoint', 'last_best_checkpoint.pt'))

SIDON_FILES = ('feature_extractor_cuda.pt', 'decoder_cuda.pt')

def sidon_ready():
    cfg = CONFIG.get('sidon', {})
    return Path(cfg.get('python', '__missing__')).is_file() and all(Path(cfg.get('models', '__missing__'), name).is_file() for name in SIDON_FILES)

@app.get('/v1/health', dependencies=[Depends(auth)])
def health():
    return {'status': 'ok', 'capabilities': ['grouped_model_batch_v1', 'dnsmos_quality_v1', 'sidon_restore_v1'], 'api_version': 1, 'service_version': '0.7.1', 'models': [
        {'id': 'bandit_v2', 'default': True, 'available': bandit_ready(), 'native_rate': 48000, 'native_channels': 1, 'stereo_policy': 'independent_channels'},
        {'id': 'gap_urgenet', 'available': gap_ready(), 'task': 'raw_dialogue_cleanup'},
        {'id': 'mossformer2', 'available': mossformer_ready(), 'task': 'dialogue_cleanup'},
        {'id': 'sidon', 'available': sidon_ready(), 'task': 'speech_restoration', 'requires': 'cuda'},
        {'id': 'provided_stems', 'available': True}]}

@app.get('/v1/defaults', dependencies=[Depends(auth)])
def defaults():
    return Settings().model_dump()


def run_quality(jid, body):
    global QUALITY_ANALYZER
    event = QUALITY_CANCEL[jid]
    terminal = {}
    try:
        if event.is_set():
            raise InterruptedError('Quality scan cancelled')
        with LOCK:
            QUALITY_JOBS[jid].update(status='running', stage='Loading DNSMOS on the service CPU')
        if QUALITY_ANALYZER is None:
            QUALITY_ANALYZER = QualityAnalyzer()
        def progress(percent):
            with LOCK:
                QUALITY_JOBS[jid].update(progress=percent, stage='Analyzing dialogue quality')
        result = QUALITY_ANALYZER.analyze(ROOT / f'{body.asset_id}.wav', body.threshold, progress, event.is_set)
        if event.is_set():
            raise InterruptedError('Quality scan cancelled')
        terminal = dict(status='done', progress=100, result={'ok': True, **result})
    except InterruptedError:
        terminal = dict(status='cancelled', error='Quality scan cancelled')
    except Exception as error:
        terminal = dict(status='failed', error=str(error))
    finally:
        with LOCK:
            ASSET_PINS[body.asset_id] -= 1
            if not ASSET_PINS[body.asset_id]:
                del ASSET_PINS[body.asset_id]
            if body.delete_asset_when_done and not ASSET_PINS.get(body.asset_id) and not any(
                any(t.get('asset_id') == body.asset_id for t in j.get('request', {}).get('tracks', [])) for j in JOBS.values()
            ):
                for suffix in ('wav', 'json'):
                    try: (ROOT / f'{body.asset_id}.{suffix}').unlink(missing_ok=True)
                    except OSError: pass  # User can retry asset deletion; don't strand job status.
            # Terminal means input is no longer in use, allowing safe deletion.
            QUALITY_JOBS[jid].update(**terminal)


@app.post('/v1/quality-jobs', dependencies=[Depends(auth)], status_code=202)
def submit_quality(body: QualityRequest):
    with LOCK:
        if QUALITY_POOL is None:
            raise HTTPException(503, 'Service is not ready')
        if sum(j['status'] in ('queued', 'running') for j in QUALITY_JOBS.values()) >= 2:
            raise HTTPException(429, 'Quality queue is full')
        if not (ROOT / f'{body.asset_id}.json').is_file() or not (ROOT / f'{body.asset_id}.wav').is_file():
            raise HTTPException(404, 'Unknown quality analysis asset')
        # Retain a bounded number of terminal reports; no audio in reports.
        terminal = [key for key, job in QUALITY_JOBS.items() if job['status'] not in ('queued', 'running')]
        for key in terminal[:-30]:
            QUALITY_JOBS.pop(key, None)
            QUALITY_CANCEL.pop(key, None)
        jid = uuid.uuid4().hex
        QUALITY_JOBS[jid] = dict(job_id=jid, status='queued', progress=0, stage='Queued')
        QUALITY_CANCEL[jid] = threading.Event()
        ASSET_PINS[body.asset_id] = ASSET_PINS.get(body.asset_id, 0) + 1
        try:
            QUALITY_POOL.submit(run_quality, jid, body)
        except Exception:
            ASSET_PINS[body.asset_id] -= 1
            if not ASSET_PINS[body.asset_id]: del ASSET_PINS[body.asset_id]
            QUALITY_JOBS.pop(jid, None)
            QUALITY_CANCEL.pop(jid, None)
            raise
        return {'job_id': jid}


@app.get('/v1/quality-jobs/{jid}', dependencies=[Depends(auth)])
def get_quality(jid: str):
    with LOCK:
        if jid not in QUALITY_JOBS: raise HTTPException(404, 'Unknown quality job; the service may have restarted. Rerun the scan.')
        return dict(QUALITY_JOBS[jid])


@app.delete('/v1/quality-jobs/{jid}', dependencies=[Depends(auth)])
def cancel_quality(jid: str):
    with LOCK:
        if jid not in QUALITY_JOBS: raise HTTPException(404, 'Unknown quality job')
        QUALITY_CANCEL[jid].set()
        return {'cancel_requested': True}

def write_upload_chunk(file, digest, chunk):
    digest.update(chunk)
    file.write(chunk)

def validate_upload(path, aid, file_hash):
    info = sf.info(path)
    if info.format not in ('WAV', 'WAVEX', 'RF64') or info.channels not in (1, 2) or not 8000 <= info.samplerate <= 96000 or info.duration <= 0:
        raise HTTPException(422, 'Use a mono/stereo WAV at 44.1–96 kHz with duration greater than zero')
    import numpy as np
    audio_digest = hashlib.sha256(f'{info.samplerate}:{info.channels}:{info.frames}'.encode())
    for block in sf.blocks(path, blocksize=65536, dtype='float32', always_2d=True):
        if not np.isfinite(block).all():
            raise HTTPException(422, 'WAV contains non-finite samples')
        audio_digest.update(block.astype('<f4', copy=False).tobytes())
    metadata = {'asset_id': aid, 'sha256': audio_digest.hexdigest(), 'file_sha256': file_hash, 'samples': info.frames, 'sample_rate': info.samplerate, 'channels': info.channels}
    (ROOT / f'{aid}.json').write_text(json.dumps(metadata))
    return metadata

@app.post('/v1/assets', dependencies=[Depends(auth)], status_code=201)
async def upload(request: Request):
    aid = uuid.uuid4().hex
    path = ROOT / f'{aid}.wav'
    digest, total = hashlib.sha256(), 0
    try:
        with path.open('wb') as file:
            async for chunk in request.stream():
                total += len(chunk)
                if total > MAX_BYTES:
                    raise HTTPException(413, 'Upload limit is 1536 MiB')
                await run_in_threadpool(write_upload_chunk, file, digest, chunk)
        return await run_in_threadpool(validate_upload, path, aid, digest.hexdigest())
    except BaseException as error:
        path.unlink(missing_ok=True)
        if isinstance(error, HTTPException):
            raise
        if isinstance(error, Exception):
            raise HTTPException(422, 'Cannot read a complete WAV file') from error
        raise

def get_job(jid):
    with LOCK:
        if jid not in JOBS:
            raise HTTPException(404, 'Unknown job')
        return dict(JOBS[jid])

@app.post('/v1/music-analysis', dependencies=[Depends(auth)])
def music_analysis(body: MusicAnalysis):
    def read(aid):
        if not (ROOT / f'{aid}.json').is_file(): raise HTTPException(404, 'Unknown analysis asset')
        return read_audio(ROOT / f'{aid}.wav', 48000)
    aids = [body.music_asset, body.dialogue_asset] + ([body.probe_asset] if body.probe_asset else [])
    with LOCK:
        if any(not (ROOT / f'{aid}.json').is_file() for aid in aids): raise HTTPException(404, 'Unknown analysis asset')
        for aid in aids: ASSET_PINS[aid] = ASSET_PINS.get(aid,0)+1
    try:
        music, dialogue = read(body.music_asset), read(body.dialogue_asset)
        probe = read(body.probe_asset) if body.probe_asset else None
        return analyze_music(music,dialogue,48000,body,probe)
    except ValueError as error:
        raise HTTPException(422,str(error)) from error
    finally:
        with LOCK:
            for aid in aids:
                ASSET_PINS[aid] -= 1
                if not ASSET_PINS[aid]: del ASSET_PINS[aid]

@app.get('/v1/assets/{aid}/download', dependencies=[Depends(auth)])
def download_asset(aid: str):
    if not (ROOT / f'{aid}.json').is_file():
        raise HTTPException(404, 'Unknown asset')
    return FileResponse(ROOT / f'{aid}.wav', media_type='audio/wav', filename=f'{aid}.wav')

@app.post('/v1/deplosive', dependencies=[Depends(auth)])
def deplosive(body: DeplosiveRequest):
    """Seeded, single-location plosive/pop attenuation (service.deplosive) on
    an already-uploaded asset -- e.g. a clean dialogue clip the panel exports
    from the Premiere playhead's clip/offset. No whole-file detection; see
    service/deplosive.py's module docstring for why. Always synchronous (this
    is CPU DSP on typically a few seconds of audio, not a model job) and
    never cached: unlike /v1/jobs, every call is a fresh, explicit,
    user-seeded edit, not a re-runnable pipeline stage."""
    if not (ROOT / f'{body.asset_id}.json').is_file():
        raise HTTPException(404, 'Unknown uploaded asset')
    with LOCK:
        ASSET_PINS[body.asset_id] = ASSET_PINS.get(body.asset_id, 0) + 1
    try:
        x, rate = sf.read(ROOT / f'{body.asset_id}.wav', dtype='float32', always_2d=True)
        try:
            cleaned, report = attenuate_pop(x, rate, body.seed_seconds)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        result_id = uuid.uuid4().hex
        out_path = ROOT / f'{result_id}.wav'
        sf.write(out_path, cleaned, rate, subtype='FLOAT')
        validate_upload(out_path, result_id, hashlib.sha256(out_path.read_bytes()).hexdigest())
        return {'result_asset_id': result_id, 'report': report}
    finally:
        with LOCK:
            ASSET_PINS[body.asset_id] -= 1
            if not ASSET_PINS[body.asset_id]: del ASSET_PINS[body.asset_id]

@app.post('/v1/lowend', dependencies=[Depends(auth)])
def lowend(body: LowEndRequest):
    """Psychoacoustic low-end enhancement (service.lowend) on an already-
    uploaded asset -- e.g. a clip the panel exports directly from whatever
    is currently selected on the Premiere timeline. A whole-file effect, no
    seed needed (contrast with /v1/deplosive above, which needs one).
    Always synchronous and never cached, for the same reasons /v1/deplosive
    is: a fresh, explicit, user-triggered edit each time, not a re-runnable
    pipeline stage."""
    if not (ROOT / f'{body.asset_id}.json').is_file():
        raise HTTPException(404, 'Unknown uploaded asset')
    with LOCK:
        ASSET_PINS[body.asset_id] = ASSET_PINS.get(body.asset_id, 0) + 1
    try:
        x, rate = sf.read(ROOT / f'{body.asset_id}.wav', dtype='float32', always_2d=True)
        enhanced, report = enhance_low_end(x, rate, body.intensity)
        result_id = uuid.uuid4().hex
        out_path = ROOT / f'{result_id}.wav'
        sf.write(out_path, enhanced, rate, subtype='FLOAT')
        validate_upload(out_path, result_id, hashlib.sha256(out_path.read_bytes()).hexdigest())
        return {'result_asset_id': result_id, 'report': report}
    finally:
        with LOCK:
            ASSET_PINS[body.asset_id] -= 1
            if not ASSET_PINS[body.asset_id]: del ASSET_PINS[body.asset_id]


@app.delete('/v1/assets/{aid}', dependencies=[Depends(auth)])
def delete_analysis_asset(aid: str):
    import re
    if not re.fullmatch(r'[0-9a-f]{32}',aid): raise HTTPException(404,'Unknown asset')
    with LOCK:
        if ASSET_PINS.get(aid): raise HTTPException(409,'Asset is being analyzed')
        if any(any(t.get('asset_id') == aid for t in j.get('request',{}).get('tracks',[])) for j in JOBS.values()):
            raise HTTPException(409,'Asset belongs to a processing job')
        for suffix in ('wav','json'): (ROOT / f'{aid}.{suffix}').unlink(missing_ok=True)
    return {'deleted':True}

@app.post('/v1/jobs', dependencies=[Depends(auth)], status_code=202)
def submit(body: JobRequest):
    needs_separation = body.settings.separate_music or body.settings.separate_ambience
    if needs_separation and body.settings.separator == 'bandit_v2' and not bandit_ready():
        raise HTTPException(409, 'Bandit v2 runtime/checkpoint missing; configure local-config.json')
    if body.settings.enhancer == 'mossformer2' and not mossformer_ready():
        raise HTTPException(409, 'MossFormer2 runtime/checkpoint missing; configure local-config.json')
    if body.settings.enhancer == 'sidon' and not sidon_ready():
        raise HTTPException(409, 'Sidon runtime/model files missing; run setup-sidon.bat on the service machine')
    if body.settings.enhancer == 'gap_urgenet' and not gap_ready():
        raise HTTPException(409, 'GAP-URGENet runtime/checkpoints missing; configure local-config.json')
    if (body.settings.enhancer == 'none' and not body.settings.dialogue_postprocess and not body.settings.deess_enabled
            and not body.settings.deess_declick and not needs_separation):
        raise HTTPException(422, 'Enable neural cleanup, level & compress, de-ess, de-click, or stem extraction')
    metadata = []
    with LOCK:
        for track in body.tracks:
            path = ROOT / f'{track.asset_id}.json'
            if not path.exists():
                raise HTTPException(404, 'Unknown uploaded asset')
            metadata.append({'role': track.role, **json.loads(path.read_text())})
    models = {}
    if needs_separation and body.settings.separator == 'bandit_v2': models['bandit_v2'] = model_identity(BASE,'bandit_v2',CONFIG['bandit_v2'])
    if body.settings.enhancer != 'none': models[body.settings.enhancer] = model_identity(BASE,body.settings.enhancer,CONFIG[body.settings.enhancer])
    fingerprint = {'settings':body.settings.model_dump(), 'sources':sorted((m['role'],m['sha256']) for m in metadata),
                   'stage_mode':body.stage_mode, 'require_dialogue_cache':body.require_dialogue_cache, 'models':models, 'pipeline':'finish-v2', 'dsp_code_sha256':DSP_CODE_SHA256}
    cache_key = hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
    with LOCK:
        if any(not (ROOT / f'{track.asset_id}.wav').is_file() for track in body.tracks):
            raise HTTPException(404, 'Uploaded asset was removed; upload again')
        for job in JOBS.values():
            if body.stage_mode != 'dialogue_cache' and job['cache_key'] == cache_key and job['status'] in ('queued', 'running', 'done'):
                if job['status'] != 'done' or all((ROOT / job['job_id'] / 'result' / f'{s}.wav').exists() for s in body.settings.output_stems + ['mix']):
                    return {'job_id': job['job_id'], 'reused': True}
        if sum(j['status'] in ('queued', 'running') for j in JOBS.values()) >= 8:
            raise HTTPException(429, 'Queue is full')
        jid = uuid.uuid4().hex
        JOBS[jid] = {'job_id': jid, 'status': 'queued', 'progress': 0, 'stage': 'queued', 'request': body.model_dump(), 'cache_key': cache_key, 'model_ids': models, 'created_at': time.time()}
        CANCEL[jid] = threading.Event()
        save(JOBS[jid])
        POOL.submit(run_job, jid)
    return {'job_id': jid, 'reused': False}

@app.get('/v1/jobs/{jid}', dependencies=[Depends(auth)])
def status(jid: str):
    return get_job(jid)

@app.delete('/v1/jobs/{jid}', dependencies=[Depends(auth)])
def cancel(jid: str):
    job = get_job(jid)
    if job['status'] in ('queued', 'running'):
        CANCEL[jid].set()
    return {'job_id': jid, 'cancellation_requested': job['status'] in ('queued', 'running')}

@app.get('/v1/jobs/{jid}/result/{stem}', dependencies=[Depends(auth)])
def result(jid: str, stem: str):
    job = get_job(jid)
    if stem not in ('dialogue', 'music', 'effects', 'mix'):
        raise HTTPException(404, 'Unknown result')
    if job['status'] != 'done':
        raise HTTPException(409, 'Result is not complete')
    if stem not in job.get('result', {}).get('stems', []):
        raise HTTPException(404, 'Stem was not requested')
    return FileResponse(ROOT / jid / 'result' / f'{stem}.wav', media_type='audio/wav', filename=f'{jid}-{stem}.wav')

class Cancelled(Exception):
    pass

def verify_model(name,cfg):
    if name == 'bandit_v2':
        files = [(Path(cfg['checkpoint']),cfg['checkpoint_sha256'])]
    elif name == 'mossformer2':
        checkpoint = Path(cfg['runtime'])/'checkpoints/MossFormer2_SE_48K/last_best_checkpoint.pt'
        if checkpoint.with_name('last_best_checkpoint').read_text().strip() != checkpoint.name:
            raise ValueError('Unexpected MossFormer checkpoint selector')
        files = [(checkpoint,cfg['checkpoint_sha256'])]
    elif name == 'sidon':
        files = [(Path(cfg['models'])/filename,cfg['checkpoint_hashes'][filename]) for filename in SIDON_FILES]
    else:
        files = [(Path(cfg['checkpoints'])/filename,expected) for filename,expected in cfg['checkpoint_hashes'].items()]
    for path,expected in files:
        if digest_file(path) != expected: raise ValueError(f'{name} checkpoint checksum differs from configuration')

def run_worker(key,args,log,check,verify,progress=None):
    return WORKER.run(key,args,log,check,verify,progress)

def model_run(jid,name,key,args,log,check,verify,source,start,end):
    """One model call with live job progress between start% and end%: runner
    reports where available, otherwise an estimate from clip length and this
    model's recorded speed (service/progress.py). Records the speed afterwards."""
    work=source['samples']/source['sample_rate']*source['channels']
    with WORKER.lock: cold=not (WORKER.process is not None and WORKER.process.poll() is None and WORKER.key==key)
    history=SpeedHistory(ROOT/'model-speed.json')
    progress=StageProgress(lambda percent:update(jid,progress=percent),start,end,history.expected_seconds(name,work,cold))
    t0=time.monotonic()
    status=run_worker(key,args,log,check,verify,progress=progress)
    history.record(name,work,time.monotonic()-t0,cold=not status.get('worker_reused',not cold))
    return status

@app.post('/v1/workers/release', dependencies=[Depends(auth)])
def release_worker():
    return {'released':WORKER.release_idle()}

def run_job(jid):
    import numpy as np
    started = time.perf_counter()
    timings, cache_status, worker_status = {}, {}, {}
    event = CANCEL[jid]
    def check():
        if event.is_set(): raise Cancelled()
    def unchanged_model(name):
        if model_identity(BASE,name,CONFIG[name]) != JOBS[jid]['model_ids'][name]:
            raise ValueError('Model code/configuration changed during this job; submit again')
    def aligned(x,expected,channels):
        if x.shape[1] != channels or abs(len(x)-expected)>1: raise ValueError('Model changed duration/channel layout')
        return np.pad(x,((0,max(0,expected-len(x))),(0,0)))[:expected]
    try:
        check()
        update(jid,status='running',stage='preparing',progress=5)
        body=JobRequest.model_validate(JOBS[jid]['request'])
        folder=ROOT/jid;folder.mkdir(exist_ok=True)
        cache=StageCache(ROOT)
        for model_name in JOBS[jid].get('model_ids',{}): unchanged_model(model_name)
        sources={t.role:json.loads((ROOT/f'{t.asset_id}.json').read_text()) for t in body.tracks}
        benchmark=None; enhancement=None
        if body.settings.separator == 'provided_stems':
            stems={t.role:read_audio(ROOT/f'{t.asset_id}.wav',body.settings.output_rate) for t in body.tracks if t.role in body.settings.output_stems}
        else:
            stems={}
            if body.settings.separate_music or body.settings.separate_ambience:
                t0=time.perf_counter();check()
                name='bandit_v2';cfg=CONFIG[name]
                heads=[v for v,on in [('music',body.settings.separate_music),('sfx',body.settings.separate_ambience)] if on]
                mid=JOBS[jid]['model_ids'][name]
                key=identity({'stage':'separate-v1','source':sources['mixture']['sha256'],'model':mid,'heads':heads,'window':8,'hop':1})
                names=[h+'.wav' for h in heads]
                hit=cache.get(key,names);cache_status['separation']=bool(hit)
                raw=hit['folder'] if hit else folder/'separated'
                if not hit:
                    update(jid,stage='separating',progress=10)
                    args=[cfg['python'],str(BASE/'runners/bandit_v2.py'),'--repo',cfg['repo'],'--checkpoint',cfg['checkpoint'],
                          '--input',str(ROOT/f'{body.tracks[0].asset_id}.wav'),'--output',str(raw),'--stems']+heads
                    worker_status[name]=model_run(jid,name,identity({'model':mid,'heads':heads}),args,folder/'runner.log',check,lambda:verify_model(name,cfg),
                        sources['mixture'],10,15 if body.settings.enhancer!='none' else 85)
                    benchmark=json.loads((raw/'benchmark.json').read_text())
                else: benchmark=hit['metadata']['benchmark']
                source=sources['mixture'];expected=round(source['samples']*body.settings.output_rate/source['sample_rate'])
                for role,head in [('music','music'),('effects','sfx')]:
                    if head in heads: stems[role]=aligned(read_audio(raw/(head+'.wav'),body.settings.output_rate),expected,source['channels'])
                unchanged_model(name)
                if not hit: cache.put(key,{n:raw/n for n in names},{'benchmark':benchmark},check)
                timings['separation_seconds']=time.perf_counter()-t0
            stems['dialogue']=read_audio(ROOT/f'{body.tracks[0].asset_id}.wav',body.settings.output_rate)
        check()
        if body.settings.enhancer != 'none':
            t0=time.perf_counter();name=body.settings.enhancer;cfg=CONFIG[name];mid=JOBS[jid]['model_ids'][name]
            source=sources['dialogue' if body.settings.separator=='provided_stems' else 'mixture']
            # Output rate belongs here because the existing conversion policy is
            # source -> output rate -> 48k. Level, repair and stem options do not.
            key=identity({'stage':'clean-v1','source':source['sha256'],'model':mid,'conversion_rate':body.settings.output_rate})
            hit=cache.get(key,['dialogue.wav']);cache_status['dialogue']=bool(hit)
            output_file=hit['folder']/'dialogue.wav' if hit else folder/'dialogue-clean.wav'
            if not hit and body.require_dialogue_cache:
                raise ValueError('Prepared dialogue cache is missing or changed. Retry Clean audio to rebuild the dialogue pass.')
            if not hit:
                input_file=folder/'dialogue-input.wav'
                sf.write(input_file,resample_audio(stems['dialogue'],body.settings.output_rate,48000),48000,subtype='FLOAT')
                # This model call is the dominant cost of the whole job. Since
                # 2026-09-29 model_run() moves the job from 15% to 80% while it
                # runs: the runner's own progress reports where it has them, an
                # estimate from clip length and recorded model speed otherwise.
                update(jid,stage='Sidon speech restoration' if name=='sidon' else f'{name} raw dialogue cleanup',progress=15)
                args=[cfg['python'],str(BASE/f'runners/{name}.py'),'--input',str(input_file),'--output',str(output_file)]
                if name=='mossformer2': args += ['--runtime',cfg['runtime']]
                elif name=='sidon': args += ['--models',cfg['models']]
                else: args += ['--repo',cfg['repo'],'--checkpoints',cfg['checkpoints']]
                worker_status[name]=model_run(jid,name,mid,args,folder/'dialogue.log',check,lambda:verify_model(name,cfg),source,15,80)
                enhancement=json.loads(output_file.with_suffix('.json').read_text())
                update(jid,stage=f'{name} raw dialogue cleanup',progress=80)
            else: enhancement=dict(hit['metadata']['enhancement'])
            cleaned=read_audio(output_file,body.settings.output_rate)
            cleaned=aligned(cleaned,len(stems['dialogue']),stems['dialogue'].shape[1])
            stems['dialogue']=blend_dialogue(stems['dialogue'],cleaned,body.settings.enhancer_wet)
            unchanged_model(name)
            if not hit: cache.put(key,{'dialogue.wav':output_file},{'enhancement':enhancement},check)
            if body.stage_mode == 'dialogue_cache':
                check()
                update(jid,status='done',stage='dialogue cached',progress=100,result={
                    'sample_rate':body.settings.output_rate,'channels':source['channels'],
                    'samples':len(cleaned),'stems':[], 'stage_cache':cache_status,'workers':worker_status,
                    'timings':{'cleanup_seconds':time.perf_counter()-t0,'total_seconds':time.perf_counter()-started}})
                return
            enhancement['wet_mix']=body.settings.enhancer_wet
            enhancement['input_source']='provided_dialogue' if body.settings.separator=='provided_stems' else 'raw_audio'
            timings['cleanup_seconds']=time.perf_counter()-t0
        check()
        compress_report=sparse_report=deess_report=None
        if body.settings.dialogue_postprocess:
            t0=time.perf_counter()
            dialogue_target=next(spec.target for spec in body.settings.stems if spec.name=='dialogue')
            update(jid,stage='compressing dialogue',progress=86)
            stems['dialogue'],compress_report=compress_dialogue(stems['dialogue'],body.settings.output_rate,
                target_dbfs=dialogue_target,max_boost_db=body.settings.max_boost_db)
            stems['dialogue'],sparse_report=normalize_sparse_dialogue(stems['dialogue'],body.settings.output_rate,
                target_peak_dbfs=dialogue_target,max_boost_db=body.settings.max_boost_db)
            compress_report['sparse_dialogue']=sparse_report
            timings['compress_seconds']=time.perf_counter()-t0
            check()
        if body.settings.deess_enabled:
            t0=time.perf_counter()
            update(jid,stage='de-essing dialogue',progress=91)
            stems['dialogue'],deess_report=deess(stems['dialogue'],body.settings.output_rate)
            timings['deess_seconds']=time.perf_counter()-t0
        check()
        t0=time.perf_counter();declick_report=None
        if body.settings.deess_declick:
            update(jid,stage='de-clicking dialogue',progress=93)
            stems['dialogue'],declick_report=declick(stems['dialogue'],body.settings.output_rate)
        timings['repair_seconds']=time.perf_counter()-t0
        check();t0=time.perf_counter()
        update(jid,stage='mixing',progress=95)
        report=mix(stems,body.settings,folder/'result')
        timings['mix_seconds']=time.perf_counter()-t0;timings['total_seconds']=time.perf_counter()-started
        report.update(enhancement=enhancement,compress_dialogue=compress_report,deess=deess_report,
            deess_declick=declick_report,stage_cache=cache_status,workers=worker_status,timings=timings)
        check()
        if benchmark is not None:
            report['benchmark']=benchmark
            if report['channels']==2: report['warnings'].append('Mono Bandit model applied independently to L/R; audition stereo image')
        update(jid,status='done',stage='complete',progress=100,result={**report,'stems':body.settings.output_stems+['mix']})
    except Cancelled:
        WORKER.release_idle()
        update(jid,status='cancelled',stage='cancelled')
    except Exception as error:
        WORKER.release_idle()
        update(jid,status='failed',stage='failed',error={'code':'processing_failed','message':str(error)})
