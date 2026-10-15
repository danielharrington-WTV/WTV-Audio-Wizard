"""Learn noise / Remove noise (2026-10-15): service/denoise.py and the
/v1/noise-profile endpoint plus the denoise_* job settings."""
import json
import numpy as np
import pytest
import soundfile as sf
from service.denoise import learn_profile, remove_noise, check_profile, N_FFT
from service.schema import Settings, JobRequest
from test_service import client, upload, wait  # noqa: F401  (fixture)

RATE = 48000


def noise(n, seed=1, channels=2):
    rng = np.random.default_rng(seed)
    hum = 0.005 * np.sin(2 * np.pi * 60 * np.arange(n) / RATE)
    return (0.01 * rng.standard_normal((n, channels)) + hum[:, None]).astype(np.float32)


def rms_db(a):
    return float(20 * np.log10(np.sqrt(np.mean(np.square(a, dtype=np.float64)))))


def with_tone(seed=2):
    t = np.arange(RATE * 3) / RATE
    tone = (0.2 * np.sin(2 * np.pi * 440 * t) * ((t > 1) & (t < 2)))[:, None]
    return (noise(len(t), seed) + tone).astype(np.float32)


def test_learned_noise_is_turned_down_and_speech_band_tone_is_kept():
    profile = learn_profile(noise(RATE * 2), RATE)
    assert len(profile['mean_db']) == N_FFT // 2 + 1 and profile['sample_rate'] == RATE
    assert -42 < profile['noise_rms_dbfs'] < -37
    json.dumps(profile)  # Stored as JSON.
    x = with_tone()
    y, report = remove_noise(x, RATE, profile, reduction_db=12, threshold_db=6)
    assert y.shape == x.shape and y.dtype == x.dtype and report['applied']
    quiet, tone = slice(0, RATE // 2), slice(int(1.2 * RATE), int(1.8 * RATE))
    assert rms_db(x[quiet]) - rms_db(y[quiet]) > 9          # Noise down about 12 dB.
    assert abs(rms_db(x[tone]) - rms_db(y[tone])) < 0.5     # Tone untouched.


def test_more_reduction_removes_more_and_zero_is_bypass():
    profile = learn_profile(noise(RATE), RATE)
    x = with_tone()
    light, _ = remove_noise(x, RATE, profile, reduction_db=6)
    heavy, _ = remove_noise(x, RATE, profile, reduction_db=24)
    assert rms_db(heavy[:RATE // 2]) < rms_db(light[:RATE // 2]) - 10
    same, report = remove_noise(x, RATE, profile, reduction_db=0)
    assert np.array_equal(same, x) and not report['applied']


def test_tiny_reduction_reconstructs_the_input():
    profile = learn_profile(noise(RATE), RATE)
    x = with_tone()
    y, _ = remove_noise(x, RATE, profile, reduction_db=1e-4)
    assert np.max(np.abs(y - x)) < 1e-4


def test_mono_and_other_sample_rate_are_handled():
    profile = learn_profile(noise(RATE, channels=1), RATE)
    x = noise(44100, seed=5, channels=1)
    y, report = remove_noise(x, 44100, profile)
    assert y.shape == x.shape and not report['rate_matched']
    assert rms_db(y) < rms_db(x) - 6


def test_learn_rejects_too_short_and_remove_rejects_a_damaged_print():
    with pytest.raises(ValueError, match='at least'):
        learn_profile(noise(RATE // 4), RATE)
    profile = learn_profile(noise(RATE), RATE)
    with pytest.raises(ValueError, match='learn noise again'):
        check_profile({**profile, 'mean_db': profile['mean_db'][:-1]})
    with pytest.raises(ValueError):
        remove_noise(noise(RATE), RATE, profile, reduction_db=41)


def test_settings_validation():
    pid = 'a' * 32
    s = Settings(enhancer='none', dialogue_postprocess=False, denoise_profile_id=pid)
    assert s.denoise_reduction_db == 12 and s.denoise_threshold_db == 6
    assert Settings().denoise_profile_id is None
    for bad in ({'enhancer': 'sidon'}, {'enhancer': 'none', 'separate_music': True}):
        with pytest.raises(ValueError, match='raw audio only'):
            Settings(**bad, denoise_profile_id=pid)
    for bad in ({'denoise_profile_id': 'nope'}, {'denoise_reduction_db': 50}, {'denoise_threshold_db': -7}):
        with pytest.raises(ValueError):
            Settings(enhancer='none', **bad)


def test_learn_then_remove_noise_job_end_to_end(client):
    c, app = client
    assert 'noise_profile_v1' in c.get('/v1/health').json()['capabilities']
    learned = c.post('/v1/noise-profile', json={'asset_id': upload(c, noise(RATE * 2))})
    assert learned.status_code == 200, learned.text
    pid = learned.json()['profile_id']
    assert learned.json()['summary']['seconds'] == 2.0
    stored = app.ROOT / 'noise-profiles' / f'{pid}.json'
    assert stored.is_file() and not app.ASSET_PINS
    # The noise-print folder is not something storage cleanup touches.
    found = app.storage_cleanup.plan(app.ROOT, 1, now=10 ** 12)
    assert stored not in found['paths'] and stored.parent not in found['paths']

    x = with_tone()
    settings = {'enhancer': 'none', 'dialogue_postprocess': False, 'deess': False, 'level_dialogue': False,
                'separate_music': False, 'separate_ambience': False, 'denoise_profile_id': pid}
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': upload(c, x)}], 'settings': settings})
    assert response.status_code == 202, response.text
    job = wait(c, response.json()['job_id'])
    assert job['status'] == 'done', job
    assert job['result']['denoise']['applied'] and job['result']['denoise']['profile_id'] == pid
    out = c.get(f"/v1/jobs/{job['job_id']}/result/dialogue")
    import io
    y, rate = sf.read(io.BytesIO(out.content), dtype='float32', always_2d=True)
    assert rate == RATE and rms_db(x[:RATE // 2]) - rms_db(y[:RATE // 2]) > 9


def test_unknown_print_and_short_sample_are_refused(client):
    c, _ = client
    settings = {'enhancer': 'none', 'dialogue_postprocess': False, 'denoise_profile_id': 'b' * 32}
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': upload(c, noise(RATE))}], 'settings': settings})
    assert response.status_code == 404 and 'Learn noise again' in response.text
    short = c.post('/v1/noise-profile', json={'asset_id': upload(c, noise(RATE // 10))})
    assert short.status_code == 422 and 'at least' in short.text
    assert c.post('/v1/noise-profile', json={'asset_id': 'c' * 32}).status_code == 404
