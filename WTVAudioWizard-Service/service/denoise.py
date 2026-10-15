"""Learn a noise print and remove it (2026-10-15).

Learn noise: the panel renders a stretch of the timeline that holds only the
background noise (the sequence In/Out range) and posts it to /v1/noise-profile.
learn_profile() measures the average level of that noise in each frequency bin.

Remove noise: spectral gating. Each STFT bin of the dialogue is compared with
the learned noise level for its frequency. Bins that rise more than
threshold_db above the noise are kept; bins at or below the noise are turned
down by reduction_db. The keep/turn-down mask has a 6 dB soft edge and is
smoothed across neighbouring frames and bins, which avoids the "musical noise"
(chirping) a hard per-bin gate makes. Stereo channels share one mask so the
image does not wander. reduction_db 0 returns the input unchanged.

Not a neural model: it removes steady noise (hum, hiss, air conditioning, fridge,
camera fan) well and leaves changing noise (traffic, wind, voices) alone.
"""
import numpy as np
from scipy.ndimage import uniform_filter
from scipy.signal import istft, stft

N_FFT = 2048
HOP = 512
FLOOR_DB = -140.0
EDGE_DB = 6.0           # Width of the soft edge between "noise" and "keep".
SMOOTH_FRAMES = 5       # Mask smoothing: about 50 ms at 48 kHz ...
SMOOTH_BINS = 3         # ... and three bins (about 70 Hz at 48 kHz).
MIN_SECONDS = 0.5
MAX_SECONDS = 120.0
PROFILE_VERSION = 1


def _check_audio(x, rate):
    if x.ndim != 2 or x.shape[1] not in (1, 2) or not len(x) or not np.isfinite(x).all() or not 8000 <= rate <= 192000:
        raise ValueError('Expected finite mono/stereo audio at 8–192 kHz')


def _spectrum(x, rate):
    """Complex STFT, shape (channels, bins, frames)."""
    _, _, spec = stft(x.T.astype(np.float64), fs=rate, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP,
                      boundary='even', padded=True)
    return spec


def _db(power):
    return np.maximum(10 * np.log10(np.maximum(power, 1e-30)), FLOOR_DB)


def learn_profile(x, rate):
    """Noise print of x: the mean level (dB) of each frequency bin."""
    _check_audio(x, rate)
    seconds = len(x) / rate
    if seconds < MIN_SECONDS:
        raise ValueError(f'The noise sample is {seconds:.2f} s; use at least {MIN_SECONDS} s of noise only')
    if seconds > MAX_SECONDS:
        raise ValueError(f'The noise sample is {seconds:.0f} s; use at most {MAX_SECONDS:.0f} s')
    power = np.mean(np.abs(_spectrum(x, rate)) ** 2, axis=0)   # Channels averaged: (bins, frames).
    level_db = _db(power)
    mean_db = _db(np.mean(power, axis=1))
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return {
        'version': PROFILE_VERSION, 'algorithm': 'spectral-gate-v1', 'n_fft': N_FFT, 'hop': HOP,
        'sample_rate': int(rate), 'channels': int(x.shape[1]), 'seconds': round(seconds, 3),
        'noise_rms_dbfs': round(float(20 * np.log10(max(rms, 1e-15))), 2),
        'frequencies_hz': [round(float(f), 3) for f in np.fft.rfftfreq(N_FFT, 1 / rate)],
        'mean_db': [round(float(v), 3) for v in mean_db],
        # How steady the noise is: the spread of each bin over time, averaged.
        'variation_db': round(float(np.mean(np.std(level_db, axis=1))), 2),
    }


def check_profile(profile):
    try:
        freqs = np.asarray(profile['frequencies_hz'], dtype=np.float64)
        mean_db = np.asarray(profile['mean_db'], dtype=np.float64)
        ok = (profile.get('version') == PROFILE_VERSION and profile.get('n_fft') == N_FFT and freqs.ndim == 1
              and freqs.shape == mean_db.shape and len(freqs) == N_FFT // 2 + 1 and np.isfinite(freqs).all()
              and np.isfinite(mean_db).all() and np.all(np.diff(freqs) > 0))
    except (KeyError, TypeError, ValueError):
        ok = False
    if not ok:
        raise ValueError('The noise print is damaged or from another version; learn noise again')
    return freqs, mean_db


def remove_noise(x, rate, profile, reduction_db=12.0, threshold_db=6.0):
    """Turn steady noise matching `profile` down by reduction_db. Returns (audio, report)."""
    _check_audio(x, rate)
    if not np.isfinite(reduction_db) or not 0 <= reduction_db <= 40:
        raise ValueError('Noise reduction must be between 0 and 40 dB')
    if not np.isfinite(threshold_db) or not -6 <= threshold_db <= 24:
        raise ValueError('Noise threshold must be between -6 and 24 dB')
    freqs, mean_db = check_profile(profile)
    report = {'algorithm': 'spectral-gate-v1', 'reduction_db': float(reduction_db), 'threshold_db': float(threshold_db),
              'profile_sample_rate': profile.get('sample_rate'), 'sample_rate': int(rate),
              'noise_rms_dbfs': profile.get('noise_rms_dbfs')}
    if reduction_db == 0 or len(x) < HOP:
        return x.copy(), {**report, 'applied': False, 'attenuated_fraction': 0.0}
    spec = _spectrum(x, rate)
    bins = np.fft.rfftfreq(N_FFT, 1 / rate)
    # A different sample rate gives different bin frequencies: read the print by frequency.
    noise_db = np.interp(bins, freqs, mean_db)[:, None]
    level_db = _db(np.mean(np.abs(spec) ** 2, axis=0))
    keep = np.clip((level_db - (noise_db + threshold_db)) / EDGE_DB + 0.5, 0.0, 1.0)
    keep = uniform_filter(keep, size=(SMOOTH_BINS, SMOOTH_FRAMES), mode='nearest')
    floor = 10 ** (-reduction_db / 20)
    gain = floor + (1 - floor) * keep
    _, y = istft(spec * gain[None], fs=rate, window='hann', nperseg=N_FFT, noverlap=N_FFT - HOP, boundary=True)
    y = np.asarray(y).T[:len(x)]
    if len(y) < len(x):
        y = np.pad(y, ((0, len(x) - len(y)), (0, 0)))
    out = y.astype(x.dtype)
    report.update(applied=True, attenuated_fraction=round(float(np.mean(keep < 0.5)), 4),
                  mean_gain_db=round(float(20 * np.log10(max(np.mean(gain), 1e-15))), 2),
                  rate_matched=profile.get('sample_rate') == int(rate))
    return out, report
