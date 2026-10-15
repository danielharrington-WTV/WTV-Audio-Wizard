"""YouTube preset levels (2026-10-15): speech level -16 dBFS and dialogue peaks
-4 dBFS through the real leveler and compressor land near -14 LUFS with true
peaks under -1 dBTP. Calibrated on a raw interview clip (-14.1 LUFS, -2.6 dBTP);
this checks the same chain on synthetic speech-like bursts."""
import numpy as np
import pyloudnorm as pyln
from scipy.signal import resample_poly, butter, sosfilt
from service.schema import Settings, Stem
from service.leveler import level_dialogue
from service.compressor import compress_dialogue, normalize_sparse_dialogue
import pytest


def speechlike(rate=48000, seconds=12, seed=3):
    rng = np.random.default_rng(seed)
    n = rate * seconds
    noise = sosfilt(butter(4, [120, 5000], btype='band', fs=rate, output='sos'), rng.standard_normal(n))
    t = np.arange(n) / rate
    syllables = 0.5 + 0.5 * np.sin(2 * np.pi * 4.3 * t) ** 2          # ~4 syllables/s
    phrases = (np.sin(2 * np.pi * 0.23 * t) > -0.3).astype(float)      # pauses between phrases
    words = rng.uniform(0.3, 1.0, size=n // 2400 + 1).repeat(2400)[:n]  # word-level variation
    x = 0.05 * noise * syllables * phrases * words
    return np.stack([x, x], axis=1).astype(np.float32)


def true_peak_db(y):
    return float(20 * np.log10(np.max(np.abs(resample_poly(y, 4, 1, axis=0)))))


def test_youtube_levels_reach_about_minus_14_lufs_under_minus_1_dbtp():
    rate = 48000
    x = speechlike(rate)
    y, _ = level_dialogue(x, rate, target_dbfs=-16)
    y, _ = compress_dialogue(y, rate, target_dbfs=-4, max_boost_db=8)
    y, _ = normalize_sparse_dialogue(y, rate, target_peak_dbfs=-4, max_boost_db=8)
    lufs = pyln.Meter(rate).integrated_loudness(y)
    assert -15.5 <= lufs <= -12.5, lufs
    assert true_peak_db(y) <= -1.0


def test_stem_targets_go_up_to_minus_3_dbfs_and_speech_level_to_minus_12():
    stems = [Stem(name='dialogue', target=-4), Stem(name='music', target=-20, duck=True), Stem(name='effects', target=-3)]
    s = Settings(stems=stems, dialogue_level_dbfs=-16)
    assert s.dialogue_level_dbfs == -16
    with pytest.raises(ValueError):
        Stem(name='dialogue', target=-2)
    with pytest.raises(ValueError):
        Settings(dialogue_level_dbfs=-11)
