import numpy as np
import pytest
import service.deess as deess
from service.deess import deess_declick, _flag_runs, _lsar_interpolate, LSAR_ORDER

def tone(seconds=2, rate=48000, freq=440, amp=.05, channels=1):
    t = np.arange(round(rate * seconds)) / rate
    x = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.repeat(x[:, None], channels, axis=1)

def test_clean_tone_is_left_alone():
    x = tone()
    cleaned, report = deess_declick(x, 48000)
    assert report['clicks_repaired'] == 0
    assert report['repairs'] == []
    assert report['repairs_truncated'] is False
    np.testing.assert_allclose(cleaned, x, atol=2e-3)

def test_silence_is_untouched():
    x = np.zeros((48000, 2), np.float32)
    cleaned, report = deess_declick(x, 48000)
    assert report['clicks_repaired'] == 0
    assert not cleaned.any()

def test_click_is_repaired_and_located():
    rate = 48000
    x = tone(rate=rate, channels=2)
    click_index = round(1.234 * rate)
    x[click_index, :] += .8
    cleaned, report = deess_declick(x, rate)
    # The impulse amplitude should be substantially reduced...
    assert abs(cleaned[click_index, 0] - x[click_index, 0]) > .5
    # ...while nearby, unaffected samples are essentially unchanged.
    np.testing.assert_allclose(cleaned[click_index - 100:click_index - 10], x[click_index - 100:click_index - 10], atol=2e-3)
    assert report['clicks_repaired'] == 1
    assert report['samples_repaired'] >= 1
    repair = report['repairs'][0]
    assert repair['start_seconds'] == pytest.approx(1.234, abs=.01)
    assert repair['channels'] == [0, 1]

def test_click_on_single_channel_is_reported_for_that_channel_only():
    rate = 48000
    x = tone(rate=rate, channels=2)
    click_index = round(.5 * rate)
    x[click_index, 0] += .8  # Channel 0 only.
    _, report = deess_declick(x, rate)
    assert report['clicks_repaired'] == 1
    assert report['repairs'][0]['channels'] == [0]

def test_lsar_interpolation_beats_linear_through_a_gap():
    # A plain straight-line fill (the original approach) ignores the signal's
    # own character through the gap, leaving an audible dip on anything but
    # the shortest, flattest clicks -- this was the root cause of a real pop
    # still being clearly audible after run-length/merge-gap fixes alone.
    # LSAR (Vaseghi & Rayner 1990; Godsill & Rayner 1992) fits an AR model to
    # the clean audio around the gap and solves for the missing samples that
    # best satisfy that model, so it should reconstruct a real multi-tone
    # signal through a several-ms gap noticeably better than a straight line.
    rate = 48000
    t = np.arange(round(rate * .5)) / rate
    true_signal = (.3 * np.sin(2 * np.pi * 440 * t) + .1 * np.sin(2 * np.pi * 1200 * t)).astype(np.float32)
    start = round(.25 * rate)
    end = start + round(rate * .005)  # 5ms, near MAX_RUN_MS.
    x = true_signal.copy()
    x[start:end] = 0  # Values inside the gap are never read by the interpolator.

    lsar = _lsar_interpolate(x, start, end, LSAR_ORDER)
    linear = np.interp(np.arange(start, end), [start - 1, end], [x[start - 1], x[end]])

    mse_lsar = np.mean((lsar - true_signal[start:end]) ** 2)
    mse_linear = np.mean((linear - true_signal[start:end]) ** 2)
    assert mse_lsar < mse_linear * .6

def test_lsar_falls_back_to_linear_on_silence():
    # No structure to exploit in silence: LSAR should recognize this (via the
    # all-zero AR taps check) and fall back rather than risk an unstable fit.
    rate = 48000
    x = np.zeros(rate, np.float32)
    start, end = round(.5 * rate), round(.5 * rate) + 100
    result = _lsar_interpolate(x, start, end, LSAR_ORDER)
    np.testing.assert_allclose(result, 0, atol=1e-6)

def test_repairs_are_truncated_but_count_stays_accurate():
    rate = 48000
    x = np.zeros((rate * 3, 1), np.float32)
    count = 250
    for i in range(count):
        x[400 * (i + 1), 0] = .5
    cleaned, report = deess_declick(x, rate)
    assert report['clicks_repaired'] == count
    assert len(report['repairs']) == 200
    assert report['repairs_truncated'] is True

def test_long_transient_is_not_treated_as_a_click():
    # A smooth-onset burst longer than the click cap (~3 ms) should be left
    # alone: it is more likely real dialogue content (e.g. a consonant) than
    # an impulsive artifact. Onset/offset are windowed (no step discontinuity)
    # so this only exercises run-length, not edge-of-burst detection.
    rate = 48000
    x = tone(rate=rate)
    start = round(1 * rate)
    length = round(rate * .02)  # 20 ms, well beyond the click cap.
    end = start + length
    window = np.sin(np.linspace(0, np.pi, length)) ** 2  # Raised-cosine envelope: zero at both edges.
    x[start:end, 0] += .6 * window
    cleaned, report = deess_declick(x, rate)
    assert report['clicks_repaired'] == 0
    np.testing.assert_allclose(cleaned[start:end], x[start:end], atol=1e-3)

def test_borderline_length_pop_is_repaired():
    # A real client dialogue clip had a mechanical pop whose LPC-flagged run
    # was 3.354 ms -- just over the old 3.0ms click cap, so it was correctly
    # detected but then discarded before interpolation, leaving the audible
    # pop completely unrepaired. MAX_RUN_MS=4.0 exists specifically to catch
    # runs of this length; this reproduces that borderline case with a short
    # broadband burst (a genuine click/pop, not a tonal/harmonic transient)
    # sized so its flagged run lands on the same side of the old vs. new cap.
    rate = 48000
    x = tone(seconds=3, rate=rate, channels=2)
    length = round(rate * .0036)  # ~3.6 ms: over the old cap, under the new one.
    ramp = max(1, round(rate * .0002))
    envelope = np.ones(length)
    envelope[:ramp] = np.linspace(0, 1, ramp)
    envelope[-ramp:] = np.linspace(1, 0, ramp)
    noise = np.random.default_rng(0).uniform(-1, 1, length)
    pop = (.4 * envelope * noise).astype(np.float32)
    pop_index = round(1.5 * rate)
    x[pop_index:pop_index + length, 0] += pop
    x[pop_index:pop_index + length, 1] += pop
    peak_sample = pop_index + int(np.argmax(np.abs(pop)))

    def covers_peak(report):
        return any(
            r['start_seconds'] * rate - 1 <= peak_sample <= (r['start_seconds'] + r['duration_seconds']) * rate + 1
            for r in report['repairs']
        )

    original_cap = deess.MAX_RUN_MS
    try:
        deess.MAX_RUN_MS = 3.0
        _, old_report = deess_declick(x, rate)
        assert not covers_peak(old_report), 'burst no longer reproduces the borderline case the 3.0ms cap misses'
    finally:
        deess.MAX_RUN_MS = original_cap

    cleaned, report = deess_declick(x, rate)
    assert covers_peak(report), f'no repaired run covers the pop peak at MAX_RUN_MS={deess.MAX_RUN_MS}; repairs={report["repairs"]}'
    assert cleaned[peak_sample, 0] != x[peak_sample, 0]

def test_nearby_flagged_runs_merge_across_the_real_pops_gap():
    # A real pop's LPC residual dipped back under threshold for ~1.02ms in
    # the middle of an otherwise continuous ~5ms anomaly, producing two
    # separate flagged runs (3.354ms, then 0.708ms) instead of one. Kept
    # separate, only the samples *inside* each short run get interpolated;
    # the still-loud material in the untouched gap/tail between them --
    # part of the same audible pop -- passed straight through, which is why
    # that pop was still clearly audible even after MAX_RUN_MS was raised.
    # MERGE_GAP_MS=1.2 (not 1.0) exists to bridge gaps like this.
    rate = 48000
    span1 = round(rate * .00335)  # matches the measured first run.
    gap = round(rate * .00102)  # matches the measured gap between them.
    span2 = round(rate * .00071)  # matches the measured second run.
    mask = np.zeros(span1 + gap + span2 + 20, bool)
    mask[10:10 + span1] = True
    mask[10 + span1 + gap:10 + span1 + gap + span2] = True

    original = deess.MERGE_GAP_MS
    try:
        deess.MERGE_GAP_MS = 1.0
        old_runs = _flag_runs(mask, rate)
    finally:
        deess.MERGE_GAP_MS = original
    new_runs = _flag_runs(mask, rate)

    assert len(old_runs) == 2, f'expected the old 1.0ms merge gap to keep these separate; got {old_runs}'
    assert len(new_runs) == 1, f'expected MERGE_GAP_MS={deess.MERGE_GAP_MS} to bridge this gap into one run; got {new_runs}'
    assert new_runs[0] == (10, 10 + span1 + gap + span2)

def test_ring_after_click_is_extended_and_repaired():
    # On a real client pop, the sharp onset excited a smooth ~800Hz decaying
    # resonance for several ms afterward. That ring is highly predictable
    # (low LPC residual), so the residual-based detector correctly never
    # flags it as a click -- but it was still loud enough (peaks nearly as
    # high as the click itself) to be clearly audible right at the repaired
    # click's own boundary, even after MAX_RUN_MS/MERGE_GAP_MS/LSAR fixes.
    # _extend_for_ring follows the flagged run's own energy envelope forward
    # over exactly this kind of decaying tail; this reproduces that shape
    # synthetically and checks both that the reported repair grows to cover
    # it and that the ring itself ends up repaired, not just the click.
    rate = 48000
    x = tone(rate=rate, freq=300, amp=.02, channels=1)
    click_start = round(1 * rate)
    click_len = round(rate * .001)  # 1ms broadband click.
    rng = np.random.default_rng(0)
    x[click_start:click_start + click_len, 0] += .8 * rng.uniform(-1, 1, click_len)

    ring_len = round(rate * .004)  # 4ms decaying ring right after the click.
    t_ring = np.arange(ring_len) / rate
    decay = np.exp(-t_ring / .0015)
    ring = (.5 * decay * np.sin(2 * np.pi * 800 * t_ring)).astype(np.float32)
    ring_start = click_start + click_len
    x[ring_start:ring_start + ring_len, 0] += ring

    original_ring, original_search = deess.RING_EXTEND_MAX_MS, deess.SECONDARY_SEARCH_MS
    try:
        deess.RING_EXTEND_MAX_MS = 0.001  # Effectively disables extension.
        deess.SECONDARY_SEARCH_MS = 0.001  # Also disable masked-companion detection, which
        # would otherwise independently pick up part of this same synthetic ring and
        # confound isolation of ring-extension's own contribution.
        cleaned_no_extend, report_no_extend = deess_declick(x, rate)
    finally:
        deess.RING_EXTEND_MAX_MS, deess.SECONDARY_SEARCH_MS = original_ring, original_search
    cleaned, report = deess_declick(x, rate)

    assert len(report_no_extend['repairs']) == 1
    assert len(report['repairs']) == 1
    duration_no_extend = report_no_extend['repairs'][0]['duration_seconds']
    duration_with_extend = report['repairs'][0]['duration_seconds']
    assert duration_with_extend > duration_no_extend * 1.3, (
        'expected ring-following to extend the repair well past the bare click; '
        f'no_extend={duration_no_extend * 1000:.2f}ms with_extend={duration_with_extend * 1000:.2f}ms'
    )

    ring_region = slice(ring_start, ring_start + ring_len)
    peak_no_extend = np.max(np.abs(cleaned_no_extend[ring_region, 0]))
    peak_with_extend = np.max(np.abs(cleaned[ring_region, 0]))
    assert peak_with_extend < peak_no_extend * .5, (
        'expected the ring itself to end up repaired, not just the click; '
        f'peak_no_extend={peak_no_extend:.3f} peak_with_extend={peak_with_extend:.3f}'
    )

def test_ring_extension_does_not_eat_into_a_loud_word_right_after_a_click():
    # RING_EXTEND_MAX_MS/RING_ENERGY_RATIO must stay well clear of genuine
    # dialogue: a click immediately followed by ordinary loud speech (not a
    # decaying resonance) should not have that speech pulled into the repair.
    rate = 48000
    x = tone(rate=rate, freq=300, amp=.02, channels=1)
    click_start = round(1 * rate)
    click_len = round(rate * .001)
    rng = np.random.default_rng(1)
    x[click_start:click_start + click_len, 0] += .8 * rng.uniform(-1, 1, click_len)
    # Sustained loud speech-like tone (not decaying) starting right after the
    # click, with smooth fades at both ends so neither the word's onset nor
    # its offset is itself an impulsive edge that the residual detector
    # would separately flag (only ring-following behavior is under test).
    word_start = click_start + click_len
    word_len = round(rate * .05)  # 50ms word, far past any reasonable ring.
    fade = round(rate * .003)
    t_word = np.arange(word_len) / rate
    envelope = np.ones(word_len)
    envelope[:fade] = np.linspace(0, 1, fade)
    envelope[-fade:] = np.linspace(1, 0, fade)
    word = (.3 * envelope * np.sin(2 * np.pi * 220 * t_word)).astype(np.float32)
    x[word_start:word_start + word_len, 0] += word

    cleaned, report = deess_declick(x, rate)
    click_repair = next(r for r in report['repairs'] if r['start_seconds'] < 1.01)
    duration_ms = click_repair['duration_seconds'] * 1000
    max_allowed_ms = click_len / rate * 1000 + deess.RING_EXTEND_MAX_MS + 1
    assert duration_ms < max_allowed_ms, (
        f'ring extension ate further into sustained speech than its own cap allows: {duration_ms:.2f}ms'
    )
    # The sustained middle of the word, well clear of either fade edge (which
    # can legitimately be flagged as their own tiny transients -- that's a
    # separate, correct detection, not what this test is about), must
    # survive completely untouched.
    middle = slice(word_start + round(rate * .01), word_start + word_len - round(rate * .01))
    np.testing.assert_allclose(cleaned[middle, 0], x[middle, 0], atol=1e-3)

def test_sibilance_band_is_reduced_while_other_bands_are_preserved():
    rate = 48000
    duration = 2
    t = np.arange(rate * duration) / rate
    low = (.05 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
    burst = np.zeros_like(low)
    start, end = round(.5 * rate), round(1.5 * rate)
    burst[start:end] = .3 * np.sin(2 * np.pi * 6000 * t[start:end])
    x = (low + burst)[:, None]
    cleaned, report = deess_declick(x, rate)
    from scipy.signal import butter, sosfiltfilt
    sos = butter(4, [4000, 9000], btype='band', fs=rate, output='sos')
    before_band = sosfiltfilt(sos, x[start:end, 0])
    after_band = sosfiltfilt(sos, cleaned[start:end, 0])
    assert np.sqrt(np.mean(after_band ** 2)) < np.sqrt(np.mean(before_band ** 2)) * .7
    sos_low = butter(4, 1000, btype='low', fs=rate, output='sos')
    before_low = sosfiltfilt(sos_low, x[:round(.4 * rate), 0])
    after_low = sosfiltfilt(sos_low, cleaned[:round(.4 * rate), 0])
    np.testing.assert_allclose(after_low, before_low, atol=5e-3)
    assert report['avg_gain_reduction_db'] < 0
    assert report['max_gain_reduction_db'] < report['avg_gain_reduction_db'] or report['max_gain_reduction_db'] == pytest.approx(report['avg_gain_reduction_db'])

def test_envelope_matching_avoids_an_unnatural_dip_between_different_levels():
    # On a real click that landed right as dialogue was rising from a quiet
    # trailing-off sound into a louder onset, the raw LSAR fit (built from an
    # AR model spanning both the quiet "before" and louder "after" context)
    # dipped to near-silence in the middle of the gap rather than continuing
    # the rise -- audible as a distinct tick even though the waveform itself
    # had no sample-level discontinuity. This reproduces that quiet-to-loud
    # transition synthetically and checks the filled gap's own energy sits
    # sensibly between the two real levels instead of undershooting both.
    rate = 48000
    quiet = tone(seconds=.02, rate=rate, freq=300, amp=.02, channels=1)[:, 0]
    loud = tone(seconds=.02, rate=rate, freq=300, amp=.12, channels=1)[:, 0]
    x = np.concatenate([quiet, loud])[:, None]
    start = len(quiet)
    end = start + round(rate * .0065)  # ~6.5ms, matching the real repair this models.
    lsar = _lsar_interpolate(x[:, 0], start, end, LSAR_ORDER)
    gap_rms = np.sqrt(np.mean(lsar ** 2))
    quiet_rms = np.sqrt(np.mean(quiet[-200:] ** 2))
    loud_rms = np.sqrt(np.mean(loud[:200] ** 2))
    # The gap's own energy should land within (a lightly padded) range spanned
    # by the two real sides, not collapse well below the quieter of the two.
    assert gap_rms > quiet_rms * .5, (
        f'gap dipped to {gap_rms:.4f} RMS, well under the quieter side ({quiet_rms:.4f}) it should bridge from'
    )
    assert gap_rms < loud_rms * 1.5

def test_envelope_matching_leaves_a_stationary_gap_alone():
    # When before/after levels already agree (the common case, and what the
    # multi-tone LSAR-vs-linear benchmark above exercises), envelope-matching
    # must not fire and perturb an already-representative AR fit.
    rate = 48000
    t = np.arange(round(rate * .04)) / rate
    signal = (.2 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)
    start = round(rate * .02)
    end = start + round(rate * .005)
    x = signal.copy()
    x[start:end] = 0
    # The mismatch ratio on this stationary signal should be well under the
    # trigger threshold, so _match_envelope returns its input unchanged.
    before_level = np.sqrt(np.mean(signal[start - deess.ENVELOPE_MATCH_WINDOW_SAMPLES:start] ** 2))
    after_level = np.sqrt(np.mean(signal[end:end + deess.ENVELOPE_MATCH_WINDOW_SAMPLES] ** 2))
    ratio = max(before_level, after_level) / min(before_level, after_level)
    assert ratio < deess.ENVELOPE_MISMATCH_RATIO

def test_masked_companion_click_is_found_and_repaired():
    # A big click's own residual dominates the LPC_BLOCK_MS block it shares
    # with whatever dialogue follows, inflating that block's MAD and thus its
    # flagging threshold enough to let a second, smaller click sitting nearby
    # (found on a real test file, previously masked by the main pop's own
    # loudness) go completely undetected by the primary block-wide pass. This
    # reproduces that shape: one big click, then a smaller second click a few
    # ms later sitting on top of louder ongoing speech.
    rate = 48000
    x = tone(rate=rate, freq=300, amp=.15, channels=1)  # Loud ongoing "speech".
    big_click = round(1 * rate)
    x[big_click, 0] += .8
    small_click = big_click + round(rate * .006)  # 6ms later, still same loud block.
    x[small_click, 0] += .25  # Too small to clear the block-wide 8x-MAD threshold there.

    cleaned, report = deess_declick(x, rate)
    repairs = sorted(report['repairs'], key=lambda r: r['start_seconds'])
    assert len(repairs) == 2, f'expected the big click and its masked companion both repaired, got {repairs}'
    companion_start = repairs[1]['start_seconds'] * rate
    assert abs(companion_start - small_click) < rate * .001
    # The companion's own +.25 outlier should be pulled back toward the
    # underlying tone's actual (uncorrupted) value at that sample, not left
    # sitting at (or near) the corrupted value.
    expected_tone = .15 * np.sin(2 * np.pi * 300 * small_click / rate)
    corrupted_error = abs(x[small_click, 0] - expected_tone)
    cleaned_error = abs(cleaned[small_click, 0] - expected_tone)
    assert cleaned_error < corrupted_error * .5

def test_masked_companion_search_does_not_reach_into_unrelated_speech():
    # The companion search must stay tightly bounded: nothing should be
    # flagged far from a real click just because ordinary speech has some
    # natural residual variation.
    rate = 48000
    x = tone(rate=rate, freq=300, amp=.1, channels=1)
    click = round(1 * rate)
    x[click, 0] += .8
    cleaned, report = deess_declick(x, rate)
    assert len(report['repairs']) == 1
    far = slice(click + round(rate * .05), click + round(rate * .1))
    np.testing.assert_allclose(cleaned[far, 0], x[far, 0], atol=1e-3)
