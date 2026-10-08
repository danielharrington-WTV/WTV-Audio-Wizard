import numpy as np

import pytest



from service.compressor import compress_dialogue, normalize_sparse_dialogue





def tone(rate=48000, amp=0.01, freq=440, seconds=1):

    t = np.arange(int(rate * seconds)) / rate

    return (amp * np.sin(2 * np.pi * freq * t))[:, None].astype('float32')





def peak_db(x):

    return float(20 * np.log10(max(np.max(np.abs(x)), 1e-15)))





def block_peak_db(x, rate):

    from service.audio import block_levels

    from service.compressor import _block_peaks

    _, size = block_levels(x, rate)

    peaks = _block_peaks(x, size)

    active = peaks > 10 ** (-60 / 20)

    return float(20 * np.log10(np.median(peaks[active])))





def test_quiet_sections_boost_and_loud_peaks_are_limited():

    rate = 48000

    quiet = tone(rate, amp=0.008, seconds=0.5)

    loud = tone(rate, amp=0.5, seconds=0.5)

    x = np.vstack([quiet, loud])

    y, report = compress_dialogue(x, rate, target_dbfs=-12)

    assert block_peak_db(y[: len(quiet)], rate) >= block_peak_db(quiet, rate)

    assert peak_db(y) <= -11.5

    assert report['output_peak_dbfs'] <= -11.5

    assert report['algorithm'] == 'dialogue-multiband-peak-v4'

    assert report['applied']





def test_louder_input_gets_more_reduction():

    rate = 48000

    moderate = tone(rate, amp=0.08, seconds=0.4)

    hot = tone(rate, amp=0.5, seconds=0.4)

    _, moderate_report = compress_dialogue(moderate, rate, target_dbfs=-12)

    _, hot_report = compress_dialogue(hot, rate, target_dbfs=-12)

    assert hot_report['air_min_gain_db'] < moderate_report['air_min_gain_db']





def test_very_quiet_blocks_are_not_boosted():

    rate = 48000

    breathy = tone(rate, amp=0.001, seconds=1.0)

    _, report = compress_dialogue(breathy, rate, target_dbfs=-12)

    assert report['body_peak_gain_db'] <= 1.0





def test_silence_is_unchanged():

    x = np.zeros((48000, 2), dtype='float32')

    y, report = compress_dialogue(x, 48000)

    np.testing.assert_array_equal(y, x)

    assert not report['applied']

    assert report['input_active_rms_dbfs'] is None





def test_stereo_channels_stay_linked():

    mono = tone(amp=0.02)

    x = np.repeat(mono, 2, axis=1)

    y, _ = compress_dialogue(x, 48000)

    np.testing.assert_array_equal(y[:, 0], y[:, 1])





def test_preserves_shape_and_dtype():

    x = tone(amp=0.03)

    y, _ = compress_dialogue(x, 48000)

    assert y.shape == x.shape and y.dtype == x.dtype


def test_sparse_normalize_skips_dense_clip_after_compress():

    rate = 48000

    x = tone(rate, amp=0.08, seconds=1.0)

    compressed, _ = compress_dialogue(x, rate, target_dbfs=-12)

    _, report = normalize_sparse_dialogue(compressed, rate, target_peak_dbfs=-12)

    assert report['sparse_normalize_applied'] is False


def test_sparse_normalize_lifts_sparse_whisper_layout():

    rate = 48000

    quiet = tone(rate, amp=0.002, seconds=2.0)

    spike = tone(rate, amp=0.9, seconds=0.05)

    x = np.vstack([quiet, spike, quiet])

    compressed, _ = compress_dialogue(x, rate, target_dbfs=-12, max_boost_db=8)

    out, report = normalize_sparse_dialogue(compressed, rate, target_peak_dbfs=-12, max_boost_db=8)

    assert report['sparse_normalize_applied']

    assert report['output_active_rms_dbfs'] > report['level_reference_active_rms_dbfs'] + 3

    assert peak_db(out) <= -11.5


