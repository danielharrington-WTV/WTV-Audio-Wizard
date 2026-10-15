"""Dialogue compressor settings exposed in 0.7.3 (2026-10-15): attack, release,
knee and max reduction reach the gain curve (they were accepted but ignored
before), and the defaults reproduce the earlier output exactly."""
import numpy as np
import pytest
from service.compressor import compress_dialogue
from service.schema import Settings
from test_youtube_loudness import speechlike


@pytest.fixture(scope='module')
def clip():
    return speechlike(seconds=6) * 4


def test_defaults_match_the_schema_and_the_old_constants():
    s = Settings()
    assert (s.compressor_attack_ms, s.compressor_release_ms, s.compressor_knee_db, s.compressor_max_reduction_db) == (3, 60, 12, 24)


def test_each_setting_changes_the_result(clip):
    base, _ = compress_dialogue(clip, 48000, target_dbfs=-12)
    for kwargs in ({'attack_ms': 30}, {'release_ms': 400}, {'knee_width_db': 2}):
        other, report = compress_dialogue(clip, 48000, target_dbfs=-12, **kwargs)
        assert np.max(np.abs(other - base)) > 1e-4, kwargs
    hot = np.clip(clip * 6, -1, 1)  # needs well over 3 dB of reduction
    a, _ = compress_dialogue(hot, 48000, target_dbfs=-12)
    b, _ = compress_dialogue(hot, 48000, target_dbfs=-12, max_reduction_db=3)
    assert np.max(np.abs(a - b)) > 1e-4
    _, report = compress_dialogue(clip, 48000, target_dbfs=-12, attack_ms=30, release_ms=400, knee_width_db=6)
    assert (report['attack_ms'], report['release_ms'], report['knee_dbfs']) == (30, 400, -18)


def test_out_of_range_settings_are_refused():
    for field, value in (('compressor_attack_ms', 0.1), ('compressor_release_ms', 5000), ('compressor_knee_db', 30), ('compressor_max_reduction_db', 50)):
        with pytest.raises(ValueError):
            Settings(**{field: value})
