"""A/B prototype for proposed dialogue leveling (compressor v4) — not production code.

Compares current compress_dialogue + mix() against a local v4 prototype on real
fixtures before changing service/compressor.py.

Usage (from WTVAudioWizard):
  ..\\work\\service-env\\Scripts\\python.exe research/evaluate_dialogue_leveling.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from service.audio import block_levels, mix, read_audio, resample_audio  # noqa: E402
from service.compressor import compress_dialogue, normalize_sparse_dialogue  # noqa: E402
from service.schema import Settings  # noqa: E402

BEAR_BAIT = Path(
    r"\\nas_server\Storage\Dans Stuff\WildTV\Prairie Pursuit\PP9001 Greg SpringBear"
    r"\Footage\Grace bear hunt\Day 2\card 2\Bear bait Camera Audio Extracted_2.wav"
)
C0021 = Path(
    r"\\nas_server\Storage\Dans Stuff\WildTV\Prairie Pursuit\PP9001 Greg SpringBear"
    r"\Footage\Grace bear hunt\Day 1\cam 2\C0021 Audio Extracted_6.wav"
)
OUT = ROOT / "validation" / "dialogue-leveling-prototype.json"

TARGET_DBFS = -12.0
MAX_BOOST_DB = 8.0
RATE = 48000

# Sparse whisper clips: a few blocks sit at the peak ceiling while most speech stays
# very quiet — mix()'s peak cap blocks RMS lift. Only run extra normalization when
# peak minus active RMS exceeds this (after compression).
SPARSE_PEAK_RMS_GAP_DB = 18.0
SPARSE_SPIKE_MARGIN_DB = 6.0
SPARSE_LEVEL_PERCENTILE = 75
SPARSE_MAX_BOOST_DB = 16.0  # prototype; production may cap lower
# Match lifted whisper clips to typical mixed-dialogue active RMS (Bear bait after compress).
SPARSE_TARGET_ACTIVE_RMS_DBFS = -25.0

LISTEN = ROOT / "validation" / "dialogue-leveling-listening"

# --- Proposed v4 (prototype only) -------------------------------------------

V4_BOOST_MIN_PEAK_DB = -54.0
V4_RMS_DRIVE_OFFSET_DB = 3.0  # body gain driven by max(peak, rms+offset) per 10 ms block


def _block_peaks(x, size):
    padded = np.pad(x, ((0, (-len(x)) % size), (0, 0)))
    blocks = padded.reshape(-1, size, x.shape[1])
    return np.max(np.max(np.abs(blocks), axis=2), axis=1)


def _block_rms(x, size):
    padded = np.pad(x, ((0, (-len(x)) % size), (0, 0)))
    blocks = padded.reshape(-1, size, x.shape[1])
    return np.sqrt(np.mean(blocks ** 2, axis=(1, 2)))


def _highpass(x, rate, cutoff=80):
    from scipy.signal import butter, sosfiltfilt

    sos = butter(4, cutoff, btype="highpass", fs=rate, output="sos")
    return sosfiltfilt(sos, x, axis=0)


def _split_bands(x, rate):
    from scipy.signal import butter, sosfiltfilt

    sos_body = butter(4, [150, 4000], btype="band", fs=rate, output="sos")
    body = sosfiltfilt(sos_body, x, axis=0)
    air = x - body
    return body.astype(x.dtype), air.astype(x.dtype)


def _desired_peak_db(peak_db, target_peak_dbfs, knee_db, max_boost_db, boost_min_peak_db):
    if peak_db <= -60:
        return peak_db
    if peak_db < boost_min_peak_db:
        return peak_db
    if peak_db < knee_db:
        return min(target_peak_dbfs, peak_db + min(max_boost_db, target_peak_dbfs - peak_db))
    if peak_db <= target_peak_dbfs:
        span = max(target_peak_dbfs - knee_db, 1e-6)
        t = (peak_db - knee_db) / span
        return knee_db + span * (t ** 2)
    return target_peak_dbfs


def _peak_gain_db(peak_db, target_peak_dbfs, knee_db, max_boost_db, max_reduction_db, boost_min_peak_db):
    desired = _desired_peak_db(peak_db, target_peak_dbfs, knee_db, max_boost_db, boost_min_peak_db)
    return float(np.clip(desired - peak_db, -max_reduction_db, max_boost_db))


def _smooth_gains(block_gains, size, rate, attack_ms=3, release_ms=60):
    smoothed = np.zeros_like(block_gains)
    previous = 0.0
    for i, gain in enumerate(block_gains):
        ms = attack_ms if gain < previous else release_ms
        alpha = math.exp(-1000 * size / (rate * ms))
        previous = alpha * previous + (1 - alpha) * gain
        smoothed[i] = previous
    return smoothed


def _apply_peak_curve_v4(x, rate, target_peak_dbfs, max_boost_db, use_rms_drive=False):
    _, size = block_levels(x, rate)
    peaks = _block_peaks(x, size)
    peak_db = 20 * np.log10(np.maximum(peaks, 1e-15))
    if use_rms_drive:
        rms = _block_rms(x, size)
        rms_db = 20 * np.log10(np.maximum(rms, 1e-15))
        drive_db = np.maximum(peak_db, rms_db + V4_RMS_DRIVE_OFFSET_DB)
    else:
        drive_db = peak_db
    knee_db = target_peak_dbfs - 12
    block_gains = np.array(
        [
            _peak_gain_db(db, target_peak_dbfs, knee_db, max_boost_db, 24, V4_BOOST_MIN_PEAK_DB)
            for db in drive_db
        ],
        dtype=np.float64,
    )
    smoothed = _smooth_gains(block_gains, size, rate)
    centers = np.arange(len(smoothed)) * size + size / 2
    linear = 10 ** (np.interp(np.arange(len(x)), centers, smoothed) / 20)
    return (x * linear[:, None]).astype(x.dtype), smoothed


def compress_dialogue_v4(x, rate, target_dbfs=TARGET_DBFS, max_boost_db=MAX_BOOST_DB):
    filtered = _highpass(x, rate)
    body, air = _split_bands(filtered, rate)
    body, _ = _apply_peak_curve_v4(body, rate, target_dbfs, max_boost_db, use_rms_drive=True)
    air, _ = _apply_peak_curve_v4(air, rate, target_dbfs, min(2.0, max_boost_db / 4), use_rms_drive=False)
    ceiling = 10 ** (target_dbfs / 20)
    out = body + air
    peak = float(np.max(np.abs(out)))
    if peak > ceiling:
        out = (out * (ceiling / peak)).astype(x.dtype)
    return out.astype(x.dtype)


def compress_dialogue_v4_wrapped(x, rate, target_dbfs=TARGET_DBFS, max_boost_db=MAX_BOOST_DB):
    return compress_dialogue_v4(x, rate, target_dbfs, max_boost_db), {"algorithm": "dialogue-multiband-peak-v4-prototype"}


def _limit_samples(x, target_dbfs):
    """Clip hot samples only — do not scale the whole file (preserves whisper lift)."""
    ceiling = 10 ** (target_dbfs / 20)
    return np.clip(x, -ceiling, ceiling).astype(x.dtype)


def _percentile_block_rms_db(x, rate, pct):
    levels, _ = block_levels(x, rate)
    active = levels[levels > 10 ** (-50 / 20)]
    if len(active) < 5:
        return active_rms_db(x)
    return float(20 * np.log10(np.percentile(active, pct)))


def tame_sparse_spikes(x, rate, margin_db=SPARSE_SPIKE_MARGIN_DB):
    """Pull down only outlier 10 ms blocks so whisper lift is not undone by one peak."""
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


def normalize_sparse_whisper_clip(x, rate, target_dbfs=TARGET_DBFS, max_boost_db=SPARSE_MAX_BOOST_DB):
    """Whole-clip lift keyed to speech percentile — only for sparse peak/RMS layouts."""
    pk, rms = peak_dbfs(x), active_rms_db(x)
    report = {"sparse_normalize_applied": False, "peak_rms_gap_db": None if rms is None else pk - rms}
    if rms is None or pk - rms < SPARSE_PEAK_RMS_GAP_DB:
        return x, report
    y, spike_cut_db = tame_sparse_spikes(x, rate)
    ref_rms = active_rms_db(y)
    gain_db = min(max(0.0, SPARSE_TARGET_ACTIVE_RMS_DBFS - ref_rms), max_boost_db) if ref_rms is not None else 0.0
    report.update(
        sparse_normalize_applied=True,
        spike_tame_min_block_gain_db=spike_cut_db,
        level_reference_active_rms_dbfs=ref_rms,
        sparse_target_active_rms_dbfs=SPARSE_TARGET_ACTIVE_RMS_DBFS,
        sparse_gain_db=gain_db,
    )
    if gain_db > 0:
        y = (y * 10 ** (gain_db / 20)).astype(y.dtype)
    y = _limit_samples(y, target_dbfs)
    report["output_peak_dbfs"] = peak_dbfs(y)
    report["output_active_rms_dbfs"] = active_rms_db(y)
    return y, report


def pipeline_v4_sparse(_compress_fn, x, rate, tmp_dir):
    """Production path: v4 compress + sparse normalize (mix only when sparse skipped)."""
    y, _ = compress_dialogue(x, rate, target_dbfs=TARGET_DBFS, max_boost_db=MAX_BOOST_DB)
    y, sparse_report = normalize_sparse_dialogue(y, rate, target_peak_dbfs=TARGET_DBFS, max_boost_db=MAX_BOOST_DB)
    if not sparse_report.get("sparse_normalize_applied"):
        settings = Settings()
        mix_report = mix({"dialogue": y.copy()}, settings, tmp_dir)
        y = read_audio(tmp_dir / "dialogue.wav", rate)
        return y, {"sparse": sparse_report, "mix": mix_report.get("normalization", {}).get("dialogue")}
    return y, {"sparse": sparse_report, "mix": None}


def pipeline(compress_fn, x, rate, tmp_dir):
    y, creport = compress_fn(x, rate, target_dbfs=TARGET_DBFS, max_boost_db=MAX_BOOST_DB)
    settings = Settings()
    mix_report = mix({"dialogue": y.copy()}, settings, tmp_dir)
    out = read_audio(tmp_dir / "dialogue.wav", rate)
    return out, creport, mix_report


# --- Metrics ----------------------------------------------------------------

def active_rms_db(x):
    levels, _ = block_levels(x, RATE)
    active = levels[levels > 10 ** (-60 / 20)]
    if not len(active):
        return None
    return float(20 * np.log10(np.sqrt(np.mean(active ** 2))))


def peak_dbfs(x):
    return float(20 * np.log10(max(float(np.max(np.abs(x))), 1e-15)))


def window_stats(x, rate, start_s, end_s):
    a, b = int(start_s * rate), int(end_s * rate)
    seg = x[a:b]
    if not len(seg):
        return None
    return {
        "peak_dbfs": peak_dbfs(seg),
        "rms_dbfs": float(20 * np.log10(max(float(np.sqrt(np.mean(seg ** 2))), 1e-15))),
        "active_rms_dbfs": active_rms_db(seg),
    }


def block_peak_median_db(x, rate):
    _, size = block_levels(x, rate)
    peaks = _block_peaks(x, size)
    active = peaks[peaks > 10 ** (-60 / 20)]
    if not len(active):
        return None
    return float(20 * np.log10(np.median(active)))


def loudness_spread_db(x, rate):
    """Gap between quiet and loud 10 ms blocks (active only) — lower = more leveled."""
    _, size = block_levels(x, rate)
    peaks = _block_peaks(x, size)
    db = 20 * np.log10(np.maximum(peaks, 1e-15))
    active = db[peaks > 10 ** (-50 / 20)]
    if len(active) < 10:
        return None
    return float(np.percentile(active, 90) - np.percentile(active, 10))


def summarize_path(label, path, breath_center_s=7.0):
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != RATE:
        x = resample_audio(x, sr, RATE)
    return {"label": label, "path": str(path), "duration_s": len(x) / RATE, **summarize_signal(label, x, breath_center_s)}


def summarize_signal(label, x, breath_center_s=7.0):
    import tempfile

    breath_half = 0.25
    b0, b1 = breath_center_s - breath_half, breath_center_s + breath_half
    row = {
        "input": {
            "peak_dbfs": peak_dbfs(x),
            "active_rms_dbfs": active_rms_db(x),
            "block_spread_p90_p10_db": loudness_spread_db(x, RATE),
            f"breath_{breath_center_s}s": window_stats(x, RATE, b0, b1),
        },
    }
    for name, fn, pipe in (
        ("current", compress_dialogue, pipeline),
        ("proposed_v4", compress_dialogue_v4_wrapped, pipeline),
        ("proposed_v4_sparse", compress_dialogue_v4_wrapped, pipeline_v4_sparse),
    ):
        with tempfile.TemporaryDirectory() as td:
            if pipe is pipeline:
                out, _, mreport = pipe(fn, x, RATE, Path(td))
                extra = {"mix_gain_db": mreport.get("normalization", {}).get("dialogue", {}).get("gain_db"),
                         "sparse": None}
            else:
                out, meta = pipe(fn, x, RATE, Path(td))
                extra = {"mix_gain_db": (meta.get("mix") or {}).get("gain_db"), "sparse": meta.get("sparse")}
            breath_after = window_stats(out, RATE, b0, b1)
            breath_in = row["input"].get(f"breath_{breath_center_s}s") or {}
            breath_delta = None
            if breath_in and breath_after:
                breath_delta = breath_after["peak_dbfs"] - breath_in["peak_dbfs"]
            row[name] = {
                "peak_dbfs": peak_dbfs(out),
                "active_rms_dbfs": active_rms_db(out),
                "block_spread_p90_p10_db": loudness_spread_db(out, RATE),
                "mix_measured_rms_dbfs": active_rms_db(out),
                f"breath_{breath_center_s}s": breath_after,
                "breath_peak_delta_db": breath_delta,
                **extra,
            }
    return row


def export_listening(x, label):
    LISTEN.mkdir(parents=True, exist_ok=True)
    import tempfile

    sf.write(LISTEN / f"{label}_input.wav", x, RATE, subtype="FLOAT")
    for suffix, pipe in (
        ("current", pipeline),
        ("proposed_v4_sparse", pipeline_v4_sparse),
    ):
        with tempfile.TemporaryDirectory() as td:
            if pipe is pipeline:
                out, _, _ = pipe(compress_dialogue, x, RATE, Path(td))
            else:
                out, _ = pipe(compress_dialogue_v4_wrapped, x, RATE, Path(td))
        sf.write(LISTEN / f"{label}_{suffix}.wav", out, RATE, subtype="FLOAT")


def main():
    if not BEAR_BAIT.is_file() or not C0021.is_file():
        print("Fixture WAV missing on NAS; check paths.", file=sys.stderr)
        sys.exit(1)

    for label, path in (("bear_bait", BEAR_BAIT), ("c0021", C0021)):
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        if sr != RATE:
            x = resample_audio(x, sr, RATE)
        export_listening(x, label)

    bear = summarize_path("bear_bait_mixed", BEAR_BAIT, breath_center_s=7.0)
    whisper = summarize_path("c0021_whisper", C0021, breath_center_s=7.0)

    inter = {}
    for key in ("current", "proposed_v4", "proposed_v4_sparse"):
        a, b = bear[key]["active_rms_dbfs"], whisper[key]["active_rms_dbfs"]
        if a is not None and b is not None:
            inter[f"active_rms_gap_db_{key}"] = abs(a - b)

    report = {
        "goal": "C0021-class whispers match Bear bait active level (~within a few dB), breath ~7s on Bear bait not exaggerated",
        "note": "No neural clean. proposed_v4_sparse = v4 compress + sparse normalize (spike tame + active-RMS lift to -25 + sample clip at -12 peak) when peak-RMS gap >= 18 dB.",
        "target_dbfs": TARGET_DBFS,
        "max_boost_db": MAX_BOOST_DB,
        "sparse_max_boost_db": SPARSE_MAX_BOOST_DB,
        "clips": [bear, whisper],
        "inter_clip": inter,
        "acceptance_hints": {
            "inter_clip_primary": "compare active_rms_gap_db_proposed_v4_sparse to current (~15 dB); target roughly <= 4 dB after listening",
            "breath_7s_bear_bait": "breath_peak_delta_db on proposed_v4_sparse should stay near current (not positive boost > ~3 dB)",
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"\nWrote {OUT}\nListening: {LISTEN}")


if __name__ == "__main__":
    main()
