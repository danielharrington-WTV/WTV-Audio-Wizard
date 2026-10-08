from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from service.deplosive import attenuate_pop, SEARCH_MS


def quiet_tone(seconds=2.0, rate=48000, freq=220, amp=0.01, channels=2):
    t = np.arange(round(rate * seconds)) / rate
    x = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.repeat(x[:, None], channels, axis=1)


def add_decaying_burst(x, rate, seed_seconds, burst_hz=50, peak_amp=0.5, decay_ms=150, cycles=6):
    """Injects a decaying low-frequency oscillation (models a real
    plosive/mic-pop resonance: an abrupt onset then several cycles of a
    dying-out low tone, with genuine troughs between its own peaks -- not a
    single smooth exponential envelope) into a copy of x, starting at
    seed_seconds."""
    x = x.copy()
    start = round(seed_seconds * rate)
    n = round(decay_ms / 1000 * rate)
    t = np.arange(n) / rate
    envelope = peak_amp * np.exp(-t / (decay_ms / 1000 / 3))
    burst = envelope * np.sin(2 * np.pi * burst_hz * t)
    end = min(len(x), start + n)
    x[start:end, :] += burst[:end - start, None]
    return x, start, end


def test_burst_is_substantially_attenuated_and_window_is_reported():
    rate = 48000
    x = quiet_tone(rate=rate)
    x, start, end = add_decaying_burst(x, rate, seed_seconds=1.0)
    orig_peak = float(np.max(np.abs(x[start:end])))
    orig_rms = float(np.sqrt(np.mean(x[start:end] ** 2)))

    cleaned, report = attenuate_pop(x, rate, seed_seconds=1.0)
    new_peak = float(np.max(np.abs(cleaned[start:end])))
    new_rms = float(np.sqrt(np.mean(cleaned[start:end] ** 2)))

    assert new_peak < orig_peak * 0.5
    assert new_rms < orig_rms * 0.5
    assert report['seed_seconds'] == pytest.approx(1.0)
    # The detected window should bracket the injected burst (not just its first few ms).
    assert report['start_seconds'] <= 1.0 + 0.02
    assert report['end_seconds'] >= (start + round(0.6 * (end - start))) / rate
    assert report['max_reduction_db'] > 0


def test_audio_well_outside_the_window_is_untouched():
    rate = 48000
    x = quiet_tone(rate=rate, seconds=3.0)
    x, start, end = add_decaying_burst(x, rate, seed_seconds=1.5)
    cleaned, report = attenuate_pop(x, rate, seed_seconds=1.5)
    far_before = round(0.5 * rate)
    far_after = round(2.5 * rate)
    np.testing.assert_allclose(cleaned[:far_before], x[:far_before])
    np.testing.assert_allclose(cleaned[far_after:], x[far_after:])


def test_oscillating_decay_is_not_cut_short_at_the_first_trough():
    """A decaying oscillation dips toward baseline between its own peaks
    (see service/deplosive.py's MISS_TOLERANCE_BLOCKS comment, and the real
    measured case it documents: 33ms detected vs. ~180ms true extent without
    tolerating those troughs). Verify the reported window covers most of a
    multi-cycle decaying burst, not just its first cycle."""
    rate = 48000
    x = quiet_tone(rate=rate)
    x, start, end = add_decaying_burst(x, rate, seed_seconds=1.0, burst_hz=45, decay_ms=200, cycles=8)
    _, report = attenuate_pop(x, rate, seed_seconds=1.0)
    detected_ms = (report['end_seconds'] - report['start_seconds']) * 1000
    assert detected_ms > 100  # true burst is ~200ms; a naive first-trough stop would land near ~1 cycle (~22ms)


def test_seed_near_the_very_start_of_the_signal_does_not_crash():
    rate = 48000
    x = quiet_tone(rate=rate)
    x, start, end = add_decaying_burst(x, rate, seed_seconds=0.01)
    cleaned, report = attenuate_pop(x, rate, seed_seconds=0.01)
    assert cleaned.shape == x.shape
    assert report['start_seconds'] >= 0.0


def test_seed_near_the_very_end_of_the_signal_does_not_crash():
    rate = 48000
    seconds = 2.0
    x = quiet_tone(rate=rate, seconds=seconds)
    seed = seconds - 0.02
    cleaned, report = attenuate_pop(x, rate, seed_seconds=seed)
    assert cleaned.shape == x.shape
    assert report['end_seconds'] <= seconds


def test_seed_outside_the_signal_duration_raises():
    rate = 48000
    x = quiet_tone(rate=rate, seconds=1.0)
    with pytest.raises(ValueError):
        attenuate_pop(x, rate, seed_seconds=5.0)
    with pytest.raises(ValueError):
        attenuate_pop(x, rate, seed_seconds=-0.5)


def test_mono_signal_is_supported():
    rate = 48000
    x = quiet_tone(rate=rate, channels=1)
    x, start, end = add_decaying_burst(x, rate, seed_seconds=1.0)
    cleaned, report = attenuate_pop(x, rate, seed_seconds=1.0)
    assert cleaned.shape[1] == 1
    assert len(report['channels']) == 1


def test_window_extension_is_bounded_by_search_ms_even_on_near_silent_input():
    """On a near-silent signal the pre-seed baseline is tiny, so almost any
    residual noise could nominally exceed RETURN_RATIO * baseline -- this
    checks the SEARCH_MS cap still bounds the affected window rather than
    it running away across a long file."""
    rate = 48000
    x = np.zeros((round(4.0 * rate), 2), np.float32)
    rng = np.random.default_rng(0)
    x += (rng.standard_normal(x.shape) * 1e-5).astype(np.float32)
    _, report = attenuate_pop(x, rate, seed_seconds=2.0)
    assert report['duration_seconds'] <= (SEARCH_MS / 1000) * 2 + 0.1  # forward cap + generous backward slack


def test_different_burst_shapes_all_get_meaningfully_attenuated_with_unchanged_defaults():
    """Mirrors the real validation (2026-09-10, Audiotest2.wav): the same
    function with unmodified default parameters was applied, unchanged, to
    three different real plosives (61-78% peak reduction, 69-81% RMS
    reduction). This is the synthetic analogue: several different
    burst_hz/decay_ms/peak_amp combinations, same defaults throughout."""
    rate = 48000
    for burst_hz, decay_ms, peak_amp in [(35, 120, 0.3), (60, 220, 0.6), (90, 80, 0.45)]:
        x = quiet_tone(rate=rate, seconds=3.0)
        x, start, end = add_decaying_burst(x, rate, seed_seconds=1.5, burst_hz=burst_hz, decay_ms=decay_ms, peak_amp=peak_amp)
        orig_rms = float(np.sqrt(np.mean(x[start:end] ** 2)))
        cleaned, _ = attenuate_pop(x, rate, seed_seconds=1.5)
        new_rms = float(np.sqrt(np.mean(cleaned[start:end] ** 2)))
        assert new_rms < orig_rms * 0.6, f'burst_hz={burst_hz} decay_ms={decay_ms} peak_amp={peak_amp} was not attenuated enough'


# Real-audio validation, matching the tests/test_deess_real_audio.py pattern:
# a genuine external recording, skipped if not present in this checkout
# (this one is intentionally never committed -- see its own path comment).
FIXTURE = Path(r"C:\Users\Dan\Documents\Codex\2026-09-01\referenced-chatgpt-conversation-this-is-an\outputs\Audiotest2.wav")

pytestmark_real = pytest.mark.skipif(not FIXTURE.exists(), reason='real-audio validation fixture not present on this machine')


@pytestmark_real
def test_real_audio_three_measured_plosives_are_each_reduced_by_at_least_half():
    """Regression for the 2026-09-10 validation: the same unmodified
    function, run against three different real plosive events in one file,
    each measured a peak reduction of 61-78% and RMS reduction of 69-81%
    within its own auto-sized window. Re-asserts a conservative floor (50%)
    against future changes to this module's defaults."""
    x, rate = sf.read(FIXTURE, dtype='float32', always_2d=True)
    for seed_seconds in (13.53, 15.82, 19.151):
        seed = round(seed_seconds * rate)
        pre = x[max(0, seed - round(0.5 * rate)):seed]
        cleaned, report = attenuate_pop(x, rate, seed_seconds)
        s, e = round(report['start_seconds'] * rate), round(report['end_seconds'] * rate)
        orig_peak = float(np.max(np.abs(x[s:e])))
        new_peak = float(np.max(np.abs(cleaned[s:e])))
        assert new_peak < orig_peak * 0.5, f'seed={seed_seconds}s: peak only reduced {100*(1-new_peak/orig_peak):.0f}%'
