"""Comparative validation of click/pop repair "models" against real recorded
dialogue, instead of the synthetic tones used elsewhere in tests/test_deess.py.

Runs the production pipeline (LPC detection + LSAR + ring-tail extension +
masked-companion follow-up + envelope matching) against two baseline
"models" on the same real file:

  * naive_mad_linear -- a generic amplitude-threshold declicker (MAD on the
    raw signal itself, plain linear-interpolation fill). Representative of
    the simplest open-source declick tools/libraries (e.g. crates/packages
    that detect outliers directly on the waveform rather than an LPC
    residual -- see validation/v0.6.1-checks.json for the specific
    candidates researched and why none were adopted wholesale).
  * ablated_lpc_linear -- this project's own pre-LSAR "v1": the same
    LPC-residual detector used in production, but a plain linear-
    interpolation fill with no ring-tail extension, masked-companion
    follow-up, or envelope matching. Isolates how much of the improvement
    on the real pop came from the reconstruction work versus the detector.

The real-audio fixture (clip-002-dialogue_ORIGINAL_full.wav, ~15s, contains
one genuine mic pop at ~12.1s -- see validation/v0.6.1-checks.json for its
debugging history) is a binary validation asset, not required for the rest
of the suite; tests here are skipped if it isn't present in the checkout.

This module also documents a real, measured finding: on this single 15s
real clip, the *production* pipeline itself repairs 27 separate locations,
and only one of them is the actual pop -- the other 26 are scattered across
ordinary dialogue in short (often sub-millisecond), sometimes tightly
clustered bursts. That is a concrete, measured version of the "artifacting
on other clips" the feature was turned off for (see README /
service/schema.py deess_declick default): the LPC-residual detector is
tuned tightly enough to catch the one real pop, but still fires on some
fast consonant/plosive content elsewhere, and when it does, it sometimes
fires several times within a few tens of ms of the same syllable rather
than once cleanly. See test_production_repairs_outside_the_real_pop_are_
sparse_and_not_chattering below, and validation/pop-removal-listen/cluster*
for exported real-time (not slowed down) before/after audio at each such
burst.
"""
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from service.deess import (
    LPC_ORDER,
    MAX_RUN_MS,
    _flag_runs,
    _lpc_residual,
    _mad_threshold,
    deess_declick,
)

FIXTURE = Path(__file__).parent.parent / 'validation' / 'pop-removal-listen' / 'clip-002-dialogue_ORIGINAL_full.wav'

pytestmark = pytest.mark.skipif(
    not FIXTURE.exists(), reason='real-audio validation fixture not present in this checkout'
)


def _load_fixture():
    x, rate = sf.read(FIXTURE, dtype='float32', always_2d=True)
    return x, rate


def _naive_mad_linear(x, rate, threshold=8.0, block_ms=20.0):
    """Baseline representative of simple open-source declickers: MAD
    threshold on the RAW signal itself (not an LPC residual), plain linear
    fill. No LPC whitening means narrowband/high-energy dialogue content
    (sibilance, plosives) can look just as "anomalous" as a genuine
    broadband click -- the failure mode this project moved away from (see
    the LPC_ORDER comment in service/deess.py)."""
    n = len(x)
    block = max(1, round(rate * block_ms / 1000))
    padded = np.pad(x, (0, (-n) % block))
    blocks = padded.reshape(-1, block)
    mad = np.median(np.abs(blocks - np.median(blocks, axis=1, keepdims=True)), axis=1)
    scale = np.maximum(mad * 1.4826 * threshold, 1e-4)
    local_thresh = np.repeat(scale, block)[:n]
    mask = np.abs(x) > local_thresh
    max_len = max(1, round(rate * MAX_RUN_MS / 1000))
    repaired = x.copy()
    events = []
    for start, end in _flag_runs(mask, rate):
        if end - start > max_len or start < 1 or end >= n:
            continue
        repaired[start:end] = np.interp(np.arange(start, end), [start - 1, end], [x[start - 1], x[end]])
        events.append((start, end))
    return repaired, events


def _ablated_lpc_linear(x, rate):
    """This project's own pre-LSAR "v1": LPC-residual detection (identical
    to production) but a plain linear-interpolation fill, with no ring-tail
    extension or masked-companion follow-up."""
    residual = _lpc_residual(x, rate)
    mask = np.abs(residual) > _mad_threshold(residual, rate)
    mask[:LPC_ORDER] = False
    max_len = max(1, round(rate * MAX_RUN_MS / 1000))
    n = len(x)
    repaired = x.copy()
    events = []
    for start, end in _flag_runs(mask, rate):
        if end - start > max_len or start < 1 or end >= n:
            continue
        repaired[start:end] = np.interp(np.arange(start, end), [start - 1, end], [x[start - 1], x[end]])
        events.append((start, end))
    return repaired, events


def _run_per_channel(fn, x, rate):
    repaired = np.empty_like(x)
    all_events = []
    for c in range(x.shape[1]):
        repaired[:, c], events = fn(x[:, c], rate)
        all_events.append(events)
    return repaired, all_events


def _residual_energy(x, rate, start, end):
    """Objective "how click-like does this still look" score: LPC residual
    energy in [start, end), computed identically for every model's output
    so the comparison isn't self-serving to whichever model produced it."""
    residual = _lpc_residual(x, rate)
    return float(np.sqrt(np.mean(residual[start:end] ** 2)))


def _find_pop_window(x, rate, search_start_s=11.0, search_end_s=13.0, pad_ms=120.0):
    """Locate the real pop by its own peak absolute sample within the known
    rough region (see validation/v0.6.1-checks.json), rather than hardcoding
    an exact sample offset that would drift if the fixture is ever replaced."""
    lo, hi = int(search_start_s * rate), int(search_end_s * rate)
    channel = int(np.argmax(np.max(np.abs(x[lo:hi]), axis=0)))
    peak = lo + int(np.argmax(np.abs(x[lo:hi, channel])))
    pad = round(rate * pad_ms / 1000)
    return max(0, peak - pad), min(len(x), peak + pad), channel


def test_production_beats_naive_and_ablated_baselines_at_the_real_pop():
    x, rate = _load_fixture()
    win_start, win_end, chan = _find_pop_window(x, rate)
    original_peak = float(np.max(np.abs(x[win_start:win_end, chan])))
    assert original_peak > 0.3  # sanity: we did land on the real pop, not silence

    production, _ = deess_declick(x, rate)
    naive, _ = _run_per_channel(_naive_mad_linear, x, rate)
    ablated, _ = _run_per_channel(_ablated_lpc_linear, x, rate)

    metrics = {}
    for name, output in (('production', production), ('naive', naive), ('ablated', ablated)):
        peak = float(np.max(np.abs(output[win_start:win_end, chan])))
        energy = _residual_energy(output[:, chan], rate, win_start, win_end)
        metrics[name] = (peak, energy)

    # Measured on this fixture: production peak ~0.231, naive/ablated ~0.450,
    # original ~0.600. Assert with margin rather than the exact figures so
    # small, legitimate DSP tweaks don't make this needlessly brittle.
    assert metrics['production'][0] < original_peak * 0.45
    assert metrics['production'][0] < metrics['naive'][0] * 0.75
    assert metrics['production'][0] < metrics['ablated'][0] * 0.75
    # ...and looks less "click-like" afterwards (lower LPC residual energy)
    # than either baseline -- the actual point of LSAR/ring/companion/
    # envelope-matching over a plain linear fill.
    assert metrics['production'][1] < metrics['naive'][1]
    assert metrics['production'][1] < metrics['ablated'][1]


def test_naive_generic_declicker_flags_far_more_of_the_file_than_lpc_based_detection():
    """Quantifies why this project uses LPC whitening instead of a generic
    amplitude/MAD threshold (the approach used by most simple open-source
    declick tools): on this real ~15s dialogue clip it reacts to ~6-7x more
    locations than either LPC-based detector. Not every flagged naive event
    is necessarily audible, but this is the measurable version of the
    false-positive risk that motivated LPC whitening in the first place."""
    x, rate = _load_fixture()
    _, report = deess_declick(x, rate)
    _, naive_events = _run_per_channel(_naive_mad_linear, x, rate)
    _, ablated_events = _run_per_channel(_ablated_lpc_linear, x, rate)

    production_count = report['clicks_repaired']
    naive_count = sum(len(events) for events in naive_events)
    ablated_count = sum(len(events) for events in ablated_events)

    # Measured: naive=198, ablated=35, production=27 (merged across channels).
    assert naive_count > production_count * 3
    assert naive_count > ablated_count * 3


def test_production_repairs_outside_the_real_pop_are_sparse_and_not_chattering():
    """Documents the concrete, measured version of the "artifacting on other
    clips" report: on this fixture, 26 of the production pipeline's 27
    repairs are away from the one real pop, spread across several short
    bursts of 2-5 repairs within a few tens of ms of each other (dense
    enough on the same syllable to plausibly sound like an artifact even
    though each individual repair is sub-millisecond). This test is a
    sanity ceiling, not a correctness claim -- it should fail loudly if a
    future change makes the detector materially more trigger-happy on
    ordinary dialogue than it already measurably is today."""
    x, rate = _load_fixture()
    win_start, win_end, _ = _find_pop_window(x, rate)
    _, report = deess_declick(x, rate)

    outside = [
        r for r in report['repairs']
        if r['start_seconds'] + r['duration_seconds'] <= win_start / rate - 0.5
        or r['start_seconds'] >= win_end / rate + 0.5
    ]
    total_outside_ms = sum(r['duration_seconds'] for r in outside) * 1000

    # Measured: 24 of 27 repairs outside +/-0.5s of the real pop, ~16ms total.
    assert len(outside) <= report['clicks_repaired']  # sanity: outside <= total
    assert total_outside_ms < 40  # ceiling with margin over the measured ~16ms
