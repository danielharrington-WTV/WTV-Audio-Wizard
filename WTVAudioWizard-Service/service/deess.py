"""Click/pop repair and sibilance reduction for the Clean dialogue stem.

De-essing runs after dialogue compression on every Clean audio job. Optional
click/pop repair (`deess_declick` setting) runs after de-essing when enabled.
Both operate on the dialogue stem only before mix().
"""
import numpy as np
from scipy.signal import lfilter, butter, sosfiltfilt

# Click/pop repair: flag impulsive outliers in a per-block linear-prediction
# (LPC) residual, then linearly interpolate short runs. An LPC whitening
# filter (unlike a plain median filter) predicts narrowband/harmonic content
# -- including high-frequency sibilance -- almost exactly, so it does not
# mistake real dialogue energy for clicks; only genuine broadband
# discontinuities produce a large residual. Constants are internal (not
# user-exposed).
LPC_ORDER = 8
LPC_BLOCK_MS = 20
MAD_MULTIPLIER = 8.0
RESIDUAL_FLOOR = 1e-4
# A real pop measured on a test clip produced two separate flagged runs --
# 3.354ms then, after a ~1.02ms dip back under threshold, another 0.708ms --
# instead of one continuous ~5.08ms run. With the old MERGE_GAP_MS=1.0 the
# two stayed separate: only the material *inside* each short run got
# interpolated, so the still-loud material in the gap and tail between them
# (part of the same audible pop) passed through untouched. MERGE_GAP_MS=1.2
# bridges that gap into one run; MAX_RUN_MS=5.5 gives headroom above the
# resulting ~5.08ms merged run. Neither change touches MAD_MULTIPLIER (the
# sensitivity knob), which is the lever that caused runaway false positives
# when tried instead.
MAX_RUN_MS = 5.5
MERGE_GAP_MS = 1.2
MAX_REPORTED_REPAIRS = 200
# Least-Squares AR (LSAR) reconstruction of the flagged gap (Vaseghi & Rayner
# 1990; Godsill & Rayner 1992/1995; Janssen, Veldhuis & Vries 1986) -- the
# standard classical-DSP click-repair reconstruction, used in tools like
# iZotope RX/CEDAR for decades. A plain straight-line fill (the previous
# approach here) ignores the signal's own character through the gap, which
# leaves an audible dip/discontinuity on anything but the shortest, flattest
# clicks. LSAR instead fits an AR model to the clean audio immediately
# surrounding the gap, then solves for the missing samples that make that
# model's own prediction error as close to zero as possible -- so the filled
# region continues the actual oscillating waveform instead of a flat line.
# Order is higher than LPC_ORDER (used only for outlier *detection*) because
# reconstructing a plausible waveform needs more spectral detail than
# flagging an outlier does; context is capped as a compute/stability bound,
# not tuned per-signal.
LSAR_ORDER = 16
LSAR_CONTEXT_SAMPLES = 200
# The AR model above enforces prediction-error continuity (waveform *shape*),
# not absolute level -- so when the real audio just before a gap is quiet and
# just after it is much louder (e.g. trailing off from one sound into the
# onset of a louder one, which is exactly what a click landing on a rising
# attack looks like), a single model fit to both sides can land on a filled
# region noticeably quieter than either side, rather than continuing the
# rise. On a real test pop this was audible as a distinct tick right at the
# start of the repair, even though the waveform itself had no discontinuity
# there -- the *energy trajectory* through the gap didn't match what the
# surrounding real audio was doing. ENVELOPE_MATCH_WINDOW_SAMPLES/
# ENVELOPE_SMOOTH_SAMPLES control the envelope-matching correction applied
# after the AR solve (see _match_envelope); ENVELOPE_GAIN_CLAMP bounds it so
# it can only ever rescale the AR fit's own shape, never invent new energy.
ENVELOPE_MATCH_WINDOW_SAMPLES = 96
ENVELOPE_SMOOTH_SAMPLES = 24
ENVELOPE_GAIN_CLAMP = 6.0
# Only correct the envelope when before/after actually differ substantially
# in level -- on a stationary signal (level roughly equal on both sides,
# the common case), the raw AR fit's own level is already representative and
# this smoothing can only flatten real texture (e.g. beating between two
# tones) that the fit had correctly captured, for no benefit.
ENVELOPE_MISMATCH_RATIO = 1.15
# A sharp click impulse can excite a brief, smoothly-decaying resonance ("ring")
# in the mic capsule/pop filter/room -- measured on a real test pop, this rang
# at ~800Hz for several ms after the initial transient, reaching peaks nearly
# as loud (~75% amplitude) as the transient itself, and was still clearly
# audible after the transient alone was repaired. Because that ring is smooth
# and highly self-predictable, the LPC residual above (by design) stays low
# there -- it is *not* a click by the residual test -- so it never gets
# flagged, and repairing only the flagged run leaves an audible tail right at
# the repair's own boundary. _extend_for_ring extends a flagged run forward
# over that tail by following its own energy envelope, independent of (and
# after) the residual-based detection above; RING_ENERGY_RATIO/RING_BLOCK_MS
# tune how aggressively/coarsely it follows the decay, RING_EXTEND_MAX_MS caps
# it so a genuinely loud word right after a click can't be eaten into.
RING_ENERGY_RATIO = 2.5
RING_BLOCK_MS = 0.3
RING_EXTEND_MAX_MS = 6.0
RING_BASELINE_SAMPLES = 200
# A confirmed click's own huge residual sits in the same LPC_BLOCK_MS=20ms
# block as whatever loud dialogue follows it, which inflates that block's MAD
# and therefore its flagging threshold -- exactly the mechanism that let a
# real client pop's smaller *companion* glitch (found ~7.5ms after the main
# click, its own residual clearly standing out from its immediate surroundings
# but well under the block-wide 8x-MAD threshold) go completely undetected
# and unrepaired, even though it was audible on its own as a distinct tick.
# Lowering MAD_MULTIPLIER globally to catch this reintroduces false positives
# elsewhere in the file (per the comment above it); instead, once a click is
# confirmed, _find_masked_companions looks for smaller anomalies in a short
# window right after it using a *local* baseline (not the polluted block
# MAD), bounded tightly enough (SECONDARY_SEARCH_MS/SECONDARY_MAX_RUN_MS) that
# it cannot run away into ordinary speech far from a real click.
SECONDARY_MAD_MULTIPLIER = 4.0
SECONDARY_SEARCH_MS = 10.0
SECONDARY_MAX_RUN_MS = 2.0

# De-essing: split-band dynamic gain reduction over the sibilance range.
SIBILANCE_LOW_HZ = 4000
SIBILANCE_HIGH_HZ = 9000
SIBILANCE_ORDER = 4
DEESS_THRESHOLD_DBFS = -32.0
DEESS_MAX_REDUCTION_DB = 12.0
DEESS_ATTACK_MS = 5.0
DEESS_RELEASE_MS = 60.0
DEESS_BLOCK_MS = 10.0

def _levinson(autocorr, order):
    """Levinson-Durbin recursion. Returns FIR whitening-filter taps [1, a1..ap]
    such that residual[n] = x[n] + sum_{k=1}^{p} a[k] * x[n-k]."""
    a = np.zeros(order + 1)
    a[0] = 1.0
    error = autocorr[0]
    if error <= 1e-20:
        return a  # No detectable energy in this block; leave residual == x (harmless on silence).
    for i in range(1, order + 1):
        acc = autocorr[i] + np.dot(a[1:i], autocorr[i - 1:0:-1])
        reflection = -acc / error
        previous = a[1:i].copy()
        a[1:i] = previous + reflection * previous[::-1]
        a[i] = reflection
        error *= (1 - reflection ** 2)
        if error <= 1e-20:
            error = 1e-20
    return a

def _lpc_residual(x, rate):
    """Per-block LPC whitening residual. Blocks are analyzed independently so
    the filter adapts to each block's own spectral content (including any
    strong high-frequency/sibilant energy), then applied using each sample's
    true preceding history so blocks join without edge artifacts."""
    n = len(x)
    order = LPC_ORDER
    block = max(order + 1, round(rate * LPC_BLOCK_MS / 1000))
    residual = np.empty(n)
    for start in range(0, n, block):
        end = min(n, start + block)
        segment = x[start:end]
        if len(segment) <= order:
            residual[start:end] = segment
            continue
        autocorr = np.array([np.dot(segment[:len(segment) - lag], segment[lag:]) for lag in range(order + 1)])
        taps = _levinson(autocorr, order)
        history = x[max(0, start - order):start]
        if len(history) < order:
            # No real history at the very start of the channel: repeat the first
            # available sample instead of zero-padding, so the whitening filter
            # is not fed an artificial jump discontinuity at sample 0.
            pad_value = history[0] if len(history) else segment[0]
            history = np.concatenate([np.full(order - len(history), pad_value), history])
        padded = np.concatenate([history, segment])
        residual[start:end] = lfilter(taps, [1.0], padded)[order:]
    return residual

def _mad_threshold(residual, rate):
    block = max(1, round(rate * LPC_BLOCK_MS / 1000))
    n = len(residual)
    padded = np.pad(residual, (0, (-n) % block))
    blocks = padded.reshape(-1, block)
    mad = np.median(np.abs(blocks - np.median(blocks, axis=1, keepdims=True)), axis=1)
    # 1.4826x makes MAD a consistent estimator of Gaussian sigma; floor avoids
    # flagging near-silent/noiseless audio where MAD is ~0.
    scale = np.maximum(mad * 1.4826 * MAD_MULTIPLIER, RESIDUAL_FLOOR)
    return np.repeat(scale, block)[:n]

def _flag_runs(mask, rate):
    merge_gap = max(1, round(rate * MERGE_GAP_MS / 1000))
    idx = np.flatnonzero(mask)
    if not len(idx):
        return []
    runs, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev <= merge_gap:
            prev = i
            continue
        runs.append((int(start), int(prev + 1)))
        start = prev = i
    runs.append((int(start), int(prev + 1)))
    return runs

def _lsar_interpolate(x, start, end, order):
    """Reconstruct x[start:end] via Least-Squares AR interpolation. Falls back
    to linear interpolation when there isn't enough clean context to fit a
    model, the fit finds no structure (e.g. near-silence, where a straight
    line is just as valid), or the solve is numerically unstable."""
    length = end - start
    fallback = np.interp(np.arange(start, end), [start - 1, end], [x[start - 1], x[end]])
    context = np.concatenate([x[max(0, start - LSAR_CONTEXT_SAMPLES):start], x[end:end + LSAR_CONTEXT_SAMPLES]])
    if len(context) <= order * 2:
        return fallback
    autocorr = np.array([np.dot(context[:len(context) - lag], context[lag:]) for lag in range(order + 1)])
    taps = _levinson(autocorr, order)
    if np.allclose(taps[1:], 0):
        return fallback

    # Godsill & Rayner's LSAR system: one row per AR prediction-error term
    # e[n] = sum_k taps[k]*x[n-k] that touches at least one unknown sample
    # (n from start to end+order-1); solve for the unknowns that drive those
    # prediction errors to ~0, i.e. make the gap look like the AR model
    # predicts the surrounding clean audio should.
    rows = length + order
    A = np.zeros((rows, length))
    b = np.zeros(rows)
    for row, n in enumerate(range(start, end + order)):
        for k in range(order + 1):
            sample_index = n - k
            if start <= sample_index < end:
                A[row, sample_index - start] += taps[k]
            elif 0 <= sample_index < len(x):
                b[row] -= taps[k] * x[sample_index]
    try:
        solution, *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return fallback
    # Safety net: a repair should never end up louder than its surroundings.
    # If it is, the solve is numerically off; don't risk making the artifact
    # worse than the one it's replacing.
    guard = max(np.max(np.abs(context)), 1e-6) * 3
    if not np.all(np.isfinite(solution)) or np.max(np.abs(solution)) > guard:
        return fallback
    matched = _match_envelope(solution, x, start, end)
    if not np.all(np.isfinite(matched)) or np.max(np.abs(matched)) > guard:
        return solution  # Envelope match misbehaved; the un-matched AR fit is still safe.
    return matched

def _match_envelope(solution, x, start, end):
    """Rescale `solution` so its short-term energy bridges the real audio
    level just before the gap to the real level just after it, instead of
    whatever level the AR fit's own before/after compromise happened to
    land on (see the comment above ENVELOPE_MATCH_WINDOW_SAMPLES). Preserves
    the AR fit's own fine waveform shape; only its overall envelope moves."""
    length = len(solution)
    before = x[max(0, start - ENVELOPE_MATCH_WINDOW_SAMPLES):start]
    after = x[end:end + ENVELOPE_MATCH_WINDOW_SAMPLES]
    before_level = np.sqrt(np.mean(before ** 2)) if len(before) else 0.0
    after_level = np.sqrt(np.mean(after ** 2)) if len(after) else 0.0
    if before_level <= 1e-6 and after_level <= 1e-6:
        return solution  # Genuine silence on both sides; nothing to match.
    lo, hi = min(before_level, after_level), max(before_level, after_level)
    if lo <= 1e-6 or hi / lo < ENVELOPE_MISMATCH_RATIO:
        return solution  # Levels already agree; the raw AR fit's own level is fine as-is.
    floor = max(before_level, after_level, 1e-4) * 1e-2
    b, a = max(before_level, floor), max(after_level, floor)
    frac = (np.arange(length) + 0.5) / length
    target_env = b * (a / b) ** frac  # Geometric (log-domain) interpolation: no jump at either edge.

    window = min(ENVELOPE_SMOOTH_SAMPLES, length)
    kernel = np.ones(window) / window
    source_env = np.sqrt(np.maximum(np.convolve(solution ** 2, kernel, mode='same'), 0))
    gain = np.clip(target_env / np.maximum(source_env, floor), 1 / ENVELOPE_GAIN_CLAMP, ENVELOPE_GAIN_CLAMP)
    return solution * gain

def _extend_for_ring(x, start, end, rate):
    """Extend a flagged run's end forward over a smoothly-decaying resonant
    tail that the residual-based detector missed (see RING_* constants).
    Follows the run's own local energy envelope in short blocks, stopping as
    soon as it drops back within RING_ENERGY_RATIO of the pre-click baseline,
    capped at RING_EXTEND_MAX_MS so real dialogue right after a click is left
    alone."""
    block = max(1, round(rate * RING_BLOCK_MS / 1000))
    baseline_context = x[max(0, start - RING_BASELINE_SAMPLES):start]
    if not len(baseline_context):
        return end
    baseline = np.sqrt(np.mean(baseline_context ** 2))
    if baseline <= 1e-9:
        return end
    max_end = min(len(x), end + max(1, round(rate * RING_EXTEND_MAX_MS / 1000)))
    cursor = end
    while cursor + block <= max_end:
        chunk_rms = np.sqrt(np.mean(x[cursor:cursor + block] ** 2))
        if chunk_rms <= baseline * RING_ENERGY_RATIO:
            break
        cursor += block
    return cursor

def _find_masked_companions(residual, after, rate, x_len):
    """Look for a smaller anomaly in the residual within a short window right
    after a confirmed (and ring-extended) click, using a baseline local to
    that search window instead of the block-wide MAD (see SECONDARY_*
    constants above for why). The baseline is computed from the search
    window itself -- starting at `after`, i.e. strictly past the confirmed
    click and its ring, it should already be free of the click's own huge
    residual, and a short companion glitch is too small a fraction of
    SECONDARY_SEARCH_MS to skew a median-based estimate. Returns a list of
    (start, end) sample ranges, relative to the full channel, each short
    enough to plausibly be a companion glitch rather than ordinary speech."""
    search_end = min(x_len, after + round(rate * SECONDARY_SEARCH_MS / 1000))
    window = residual[after:search_end]
    if len(window) < 10:
        return []
    baseline_scale = max(np.median(np.abs(window - np.median(window))) * 1.4826, RESIDUAL_FLOOR)
    local_thresh = baseline_scale * SECONDARY_MAD_MULTIPLIER
    window_mask = np.abs(window) > local_thresh
    max_len = round(rate * SECONDARY_MAX_RUN_MS / 1000)
    return [(after + s, after + e) for s, e in _flag_runs(window_mask, rate) if e - s <= max_len]

def _repair_channel(x, rate):
    """Repair impulsive clicks in one channel. Returns (repaired, kept_runs)."""
    if len(x) <= LPC_ORDER:
        return x.copy(), []
    residual = _lpc_residual(x, rate)
    mask = np.abs(residual) > _mad_threshold(residual, rate)
    # The very first samples of a channel have no true preceding history to
    # predict from (the padding above is only an approximation), so skip
    # click detection there rather than risk flagging a startup artifact.
    mask[:LPC_ORDER] = False
    max_len = max(1, round(rate * MAX_RUN_MS / 1000))
    repaired = x.copy()
    kept_runs = []
    for start, end in _flag_runs(mask, rate):
        if end - start > max_len:
            continue  # Likely a real transient (plosive/consonant), not a click.
        if start - 1 < 0:
            continue  # Can't safely interpolate at the very edge of the signal.
        end = _extend_for_ring(x, start, end, rate)
        if end >= len(x):
            continue  # Can't safely interpolate at the very edge of the signal.
        repaired[start:end] = _lsar_interpolate(x, start, end, LSAR_ORDER)
        kept_runs.append((start, end))
        for c_start, c_end in _find_masked_companions(residual, end, rate, len(x)):
            if c_start - 1 < 0:
                continue
            c_end = _extend_for_ring(repaired, c_start, c_end, rate)
            if c_end >= len(x):
                continue
            repaired[c_start:c_end] = _lsar_interpolate(repaired, c_start, c_end, LSAR_ORDER)
            kept_runs.append((c_start, c_end))
    return repaired, kept_runs

def _merge_channel_runs(channel_runs, rate):
    """Merge overlapping/adjacent runs across channels into single timeline events."""
    merge_gap = max(1, round(rate * MERGE_GAP_MS / 1000))
    tagged = sorted((start, end, ch) for ch, runs in enumerate(channel_runs) for start, end in runs)
    events = []
    for start, end, ch in tagged:
        merged = False
        for event in events:
            if start <= event[1] + merge_gap and end >= event[0] - merge_gap:
                event[0], event[1] = min(event[0], start), max(event[1], end)
                event[2].add(ch)
                merged = True
                break
        if not merged:
            events.append([start, end, {ch}])
    events.sort(key=lambda e: e[0])
    return events

def _deess_channel(x, rate):
    """Split-band de-esser: attenuate only the sibilance band, rest of spectrum untouched."""
    sos = butter(SIBILANCE_ORDER, [SIBILANCE_LOW_HZ, SIBILANCE_HIGH_HZ], btype='band', fs=rate, output='sos')
    band = sosfiltfilt(sos, x)
    block = max(1, round(rate * DEESS_BLOCK_MS / 1000))
    padded = np.pad(band, (0, (-len(band)) % block))
    levels = np.sqrt(np.mean(padded.reshape(-1, block) ** 2, axis=1))
    threshold = 10 ** (DEESS_THRESHOLD_DBFS / 20)
    floor_gain = 10 ** (-DEESS_MAX_REDUCTION_DB / 20)
    target = np.where(levels > threshold, np.maximum(threshold / np.maximum(levels, 1e-12), floor_gain), 1.0)
    envelope, previous = np.empty_like(target), 1.0
    for i, value in enumerate(target):
        ms = DEESS_ATTACK_MS if value < previous else DEESS_RELEASE_MS
        alpha = np.exp(-1000 * block / (rate * ms))
        previous = alpha * previous + (1 - alpha) * value
        envelope[i] = previous
    env = np.interp(np.arange(len(x)), np.arange(len(envelope)) * block, envelope)
    gain_db = 20 * np.log10(np.maximum(env, 1e-12))
    return x - band + band * env, gain_db

def deess(x, rate):
    """Reduce sibilance on a (samples, channels) float32 array."""
    cleaned = np.empty_like(x)
    gain_db_stack = np.empty((len(x), x.shape[1]))
    for c in range(x.shape[1]):
        cleaned[:, c], gain_db_stack[:, c] = _deess_channel(x[:, c], rate)
    active_gain = gain_db_stack[gain_db_stack < -0.01]
    report = {
        'algorithm': 'split-band-deess-v1',
        'avg_gain_reduction_db': float(np.mean(active_gain)) if len(active_gain) else 0.0,
        'max_gain_reduction_db': float(np.min(gain_db_stack)) if gain_db_stack.size else 0.0,
        'applied': bool(len(active_gain)),
    }
    return cleaned.astype(x.dtype, copy=False), report


def declick(x, rate):
    """Repair click/pop artifacts on a (samples, channels) float32 array."""
    channels = x.shape[1]
    repaired = np.empty_like(x)
    channel_runs = []
    for c in range(channels):
        repaired[:, c], runs = _repair_channel(x[:, c], rate)
        channel_runs.append(runs)
    events = _merge_channel_runs(channel_runs, rate)
    report = {
        'clicks_repaired': len(events),
        'samples_repaired': int(sum(end - start for start, end, _ in events)),
        'repairs': [{'start_seconds': float(start / rate), 'duration_seconds': float((end - start) / rate), 'channels': sorted(chset)}
                    for start, end, chset in events[:MAX_REPORTED_REPAIRS]],
        'repairs_truncated': len(events) > MAX_REPORTED_REPAIRS,
    }
    return repaired.astype(x.dtype, copy=False), report


def deess_declick(x, rate):
    """Repair click/pop artifacts, then reduce sibilance, on a (samples, channels) float32 array.

    Returns (cleaned, report) where report describes what was repaired and where,
    for surfacing in the plugin's Click/pop report (see service/schema.py deess_declick flag).
    """
    repaired, click_report = declick(x, rate)
    cleaned, deess_report = deess(repaired, rate)
    report = {
        **click_report,
        'avg_gain_reduction_db': deess_report['avg_gain_reduction_db'],
        'max_gain_reduction_db': deess_report['max_gain_reduction_db'],
    }
    return cleaned, report
