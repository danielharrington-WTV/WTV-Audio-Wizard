"""Multiband peak dialogue compression toward a target peak ceiling.

Runs after neural cleanup (or raw dialogue ingest) and before de-essing,
optional de-click, and mix(). Splits body (150 Hz–4 kHz) and air (4 kHz+):
body carries most leveling with restrained quiet boost; air is limited more
aggressively with almost no boost. A final peak ceiling enforces the target.

Sparse whisper clips (few hot peaks, mostly quiet speech) get an extra pass
after compression: tame outlier spikes, lift active level toward a typical
dialogue RMS, then sample-clip at the peak target so mix()'s peak cap does not
block the lift.
"""
import numpy as np
from scipy.signal import butter, sosfiltfilt

from .audio import block_levels

ACTIVE_FLOOR_DB = -60
BOOST_MIN_PEAK_DB = -54
RMS_DRIVE_OFFSET_DB = 3.0
ATTACK_MS = 3
RELEASE_MS = 60
KNEE_WIDTH_DB = 12
MAX_REDUCTION_DB = 24
HPF_HZ = 80
BODY_LOW_HZ = 150
SPLIT_HZ = 4000
FILTER_ORDER = 4
DEFAULT_MAX_BOOST_AIR = 2

SPARSE_PEAK_RMS_GAP_DB = 18.0
SPARSE_SPIKE_MARGIN_DB = 6.0
# Typical mixed dialogue active RMS sits below the peak target (validated on
# Bear bait / C0021 fixtures 2026-09-15).
SPARSE_ACTIVE_RMS_OFFSET_DB = 13.0
SPARSE_MIN_MAX_BOOST_DB = 16.0


def _active_rms_db(levels):
    active = levels[levels > 10 ** (ACTIVE_FLOOR_DB / 20)]
    if not len(active):
        return None
    return float(20 * np.log10(np.sqrt(np.mean(active ** 2))))


def _peak_dbfs(x):
    return float(20 * np.log10(max(float(np.max(np.abs(x))), 1e-15)))


def _block_peaks(x, size):
    padded = np.pad(x, ((0, (-len(x)) % size), (0, 0)))
    blocks = padded.reshape(-1, size, x.shape[1])
    return np.max(np.max(np.abs(blocks), axis=2), axis=1)


def _block_rms(x, size):
    padded = np.pad(x, ((0, (-len(x)) % size), (0, 0)))
    blocks = padded.reshape(-1, size, x.shape[1])
    return np.sqrt(np.mean(blocks ** 2, axis=(1, 2)))


def _highpass(x, rate, cutoff=HPF_HZ):
    sos = butter(FILTER_ORDER, cutoff, btype='highpass', fs=rate, output='sos')
    return sosfiltfilt(sos, x, axis=0)


def _split_bands(x, rate):
    sos_body = butter(FILTER_ORDER, [BODY_LOW_HZ, SPLIT_HZ], btype='band', fs=rate, output='sos')
    body = sosfiltfilt(sos_body, x, axis=0)
    air = x - body
    return body.astype(x.dtype), air.astype(x.dtype)


def _desired_peak_db(peak_db, target_peak_dbfs, knee_db, max_boost_db):
    if peak_db <= ACTIVE_FLOOR_DB:
        return peak_db
    if peak_db < BOOST_MIN_PEAK_DB:
        return peak_db
    if peak_db < knee_db:
        return min(target_peak_dbfs, peak_db + min(max_boost_db, target_peak_dbfs - peak_db))
    if peak_db <= target_peak_dbfs:
        span = max(target_peak_dbfs - knee_db, 1e-6)
        t = (peak_db - knee_db) / span
        return knee_db + span * (t ** 2)
    return target_peak_dbfs


def _peak_gain_db(peak_db, target_peak_dbfs, knee_db, max_boost_db, max_reduction_db):
    desired = _desired_peak_db(peak_db, target_peak_dbfs, knee_db, max_boost_db)
    return float(np.clip(desired - peak_db, -max_reduction_db, max_boost_db))


def _smooth_gains(block_gains, size, rate, attack_ms=ATTACK_MS, release_ms=RELEASE_MS):
    smoothed = np.zeros_like(block_gains)
    previous = 0.0
    for i, gain in enumerate(block_gains):
        ms = attack_ms if gain < previous else release_ms
        alpha = np.exp(-1000 * size / (rate * ms))
        previous = alpha * previous + (1 - alpha) * gain
        smoothed[i] = previous
    return smoothed


def _apply_peak_curve(x, rate, target_peak_dbfs, max_boost_db, max_reduction_db=MAX_REDUCTION_DB, use_rms_drive=False,
                      attack_ms=ATTACK_MS, release_ms=RELEASE_MS, knee_width_db=KNEE_WIDTH_DB):
    _, size = block_levels(x, rate)
    peaks = _block_peaks(x, size)
    peak_db = 20 * np.log10(np.maximum(peaks, 1e-15))
    if use_rms_drive:
        rms = _block_rms(x, size)
        rms_db = 20 * np.log10(np.maximum(rms, 1e-15))
        drive_db = np.maximum(peak_db, rms_db + RMS_DRIVE_OFFSET_DB)
    else:
        drive_db = peak_db
    knee_db = target_peak_dbfs - knee_width_db
    block_gains = np.array([
        _peak_gain_db(db, target_peak_dbfs, knee_db, max_boost_db, max_reduction_db)
        for db in drive_db
    ], dtype=np.float64)
    smoothed = _smooth_gains(block_gains, size, rate, attack_ms=attack_ms, release_ms=release_ms)
    centers = np.arange(len(smoothed)) * size + size / 2
    linear = 10 ** (np.interp(np.arange(len(x)), centers, smoothed) / 20)
    return (x * linear[:, None]).astype(x.dtype), smoothed


def _apply_ceiling(x, target_dbfs):
    ceiling = 10 ** (target_dbfs / 20)
    peak = float(np.max(np.abs(x)))
    if peak > ceiling:
        return (x * (ceiling / peak)).astype(x.dtype)
    return x


def _limit_samples(x, target_dbfs):
    ceiling = 10 ** (target_dbfs / 20)
    return np.clip(x, -ceiling, ceiling).astype(x.dtype)


def tame_sparse_spikes(x, rate, margin_db=SPARSE_SPIKE_MARGIN_DB):
    _, size = block_levels(x, rate)
    peaks = _block_peaks(x, size)
    active = peaks > 10 ** (-50 / 20)
    if not np.any(active):
        return x, 0.0
    peak_db = 20 * np.log10(np.maximum(peaks, 1e-15))
    ref = float(np.percentile(peak_db[active], 90))
    block_gains = np.zeros(len(peaks), dtype=np.float64)
    for i in np.where(active)[0]:
        excess = peak_db[i] - (ref + margin_db)
        if excess > 0:
            block_gains[i] = -excess
    if not np.any(block_gains):
        return x, 0.0
    smoothed = _smooth_gains(block_gains, size, rate, attack_ms=2, release_ms=40)
    centers = np.arange(len(smoothed)) * size + size / 2
    linear = 10 ** (np.interp(np.arange(len(x)), centers, smoothed) / 20)
    return (x * linear[:, None]).astype(x.dtype), float(np.min(smoothed))


def normalize_sparse_dialogue(x, rate, target_peak_dbfs=-12, max_boost_db=8):
    """Lift C0021-class sparse whisper clips after compression; no-op on dense clips."""
    levels, _ = block_levels(x, rate)
    active_rms = _active_rms_db(levels)
    peak = _peak_dbfs(x)
    gap = None if active_rms is None else peak - active_rms
    report = {'sparse_normalize_applied': False, 'peak_rms_gap_db': gap}
    if active_rms is None or gap is None or gap < SPARSE_PEAK_RMS_GAP_DB:
        return x, report
    y, spike_cut_db = tame_sparse_spikes(x, rate)
    ref_rms = _active_rms_db(block_levels(y, rate)[0])
    target_rms = target_peak_dbfs - SPARSE_ACTIVE_RMS_OFFSET_DB
    sparse_cap = min(24.0, max(float(max_boost_db), SPARSE_MIN_MAX_BOOST_DB))
    gain_db = min(max(0.0, target_rms - ref_rms), sparse_cap) if ref_rms is not None else 0.0
    report.update(
        sparse_normalize_applied=True,
        spike_tame_min_block_gain_db=spike_cut_db,
        level_reference_active_rms_dbfs=ref_rms,
        sparse_target_active_rms_dbfs=target_rms,
        sparse_gain_db=gain_db,
    )
    if gain_db > 0:
        y = (y * 10 ** (gain_db / 20)).astype(y.dtype)
    y = _limit_samples(y, target_peak_dbfs)
    report['output_peak_dbfs'] = _peak_dbfs(y)
    report['output_active_rms_dbfs'] = _active_rms_db(block_levels(y, rate)[0])
    return y, report


def compress_dialogue(x, rate, target_dbfs=-12, max_boost_db=8, max_reduction_db=MAX_REDUCTION_DB,
                      attack_ms=ATTACK_MS, release_ms=RELEASE_MS, knee_width_db=KNEE_WIDTH_DB,
                      max_boost_air_db=DEFAULT_MAX_BOOST_AIR):
    if x.ndim != 2 or x.shape[1] not in (1, 2) or not len(x) or not np.isfinite(x).all():
        raise ValueError('Expected finite mono or stereo audio')
    body_boost = float(max_boost_db)
    filtered = _highpass(x, rate)
    body, air = _split_bands(filtered, rate)
    # attack/release/knee were accepted but ignored before 0.7.3 (module
    # constants were used); they are now passed through. Defaults unchanged.
    curve = dict(attack_ms=attack_ms, release_ms=release_ms, knee_width_db=knee_width_db)
    body, body_gains = _apply_peak_curve(body, rate, target_dbfs, body_boost, max_reduction_db, use_rms_drive=True, **curve)
    air, air_gains = _apply_peak_curve(air, rate, target_dbfs, min(max_boost_air_db, body_boost / 4), max_reduction_db, **curve)
    out = _apply_ceiling((body + air).astype(x.dtype), target_dbfs)
    _, size = block_levels(out, rate)
    out_peaks = _block_peaks(out, size)
    active = out_peaks > 10 ** (ACTIVE_FLOOR_DB / 20)
    report = {
        'algorithm': 'dialogue-multiband-peak-v4',
        'target_peak_dbfs': target_dbfs,
        'knee_dbfs': target_dbfs - knee_width_db,
        'boost_min_peak_dbfs': BOOST_MIN_PEAK_DB,
        'body_band_hz': [BODY_LOW_HZ, SPLIT_HZ],
        'air_band_hz': [SPLIT_HZ, rate // 2],
        'attack_ms': attack_ms,
        'release_ms': release_ms,
        'max_boost_body_db': body_boost,
        'max_boost_air_db': min(max_boost_air_db, body_boost / 4),
        'max_reduction_db': max_reduction_db,
        'input_active_rms_dbfs': _active_rms_db(block_levels(x, rate)[0]),
        'output_active_rms_dbfs': _active_rms_db(block_levels(out, rate)[0]),
        'input_peak_dbfs': _peak_dbfs(x),
        'output_peak_dbfs': _peak_dbfs(out),
        'output_block_peak_median_dbfs': float(20 * np.log10(np.median(out_peaks[active]))) if np.any(active) else None,
        'body_peak_gain_db': float(np.max(body_gains)),
        'air_min_gain_db': float(np.min(air_gains)),
        'applied': bool(np.max(np.abs(out - x)) > 1e-8),
    }
    return out, report
