"""Seeded, single-location plosive/pop attenuation for the Clean dialogue
stem.

Unlike service/deess.py's click/pop repair (which scans an entire file for
outliers), this module does no detection at all: given a human-identified
approximate timestamp -- e.g. a Premiere playhead/in-point the user parked
on a pop they heard -- it auto-sizes and applies a precise attenuation
around that one point only, from the signal's own local energy envelope.

Why no whole-file scanning: real-world validation (2026-09-10, Audiotest2.wav)
showed the plosive a human flagged by ear ranked ~12th by raw energy-ratio
among moments in that same 34s file -- 10+ ordinary loud words ranked
"more anomalous" by every band definition tried (full-band, 40-150Hz,
150-4000Hz). Any automatic detector sensitive enough to catch it would also
fire on those ordinary loud moments -- the same false-positive failure mode
that got service/deess.py's click/pop repair turned off by default (see its
own module docstring and README's "De-click & de-ess dialogue" section).
Seeding from a human-identified location sidesteps that problem entirely by
not needing to distinguish "anomalous" from "just loud" in the first place.
"""
import numpy as np

# How far to search from the seed for where the burst's energy actually
# starts/ends, relative to a short pre-seed baseline. Real plosive
# resonances measured at ~150-250ms (Audiotest2.wav, three separate events);
# 400ms gives headroom without risking eating into an unrelated later word.
SEARCH_MS = 400.0
# Local baseline window: just before the seed, short enough to reflect the
# immediate pre-burst level rather than an average across a whole different
# passage, but long enough (0.4s) to be a stable RMS estimate.
BASELINE_WINDOW_S = 0.4
# Baseline window ends this far before the seed, not at the seed itself, so
# a slightly-early seed (the human's mark rarely lands exactly on the true
# onset) doesn't pull the burst's own rising edge into its own baseline.
BASELINE_GAP_S = 0.05
# Block size for the envelope walk. Too short and a plosive's own decaying
# oscillation (measured ~40-60Hz on a real burst -- see MISS_TOLERANCE_BLOCKS
# below) reads as multiple separate short events; too long and it can't
# localize the true edges precisely. 10ms is short enough to localize to
# roughly one oscillation cycle at those frequencies without being shorter
# than one.
BLOCK_MS = 10.0
# A burst is "still going" once its block RMS exceeds this multiple of the
# pre-seed baseline. 1.5x is deliberately loose -- the goal here is finding
# the full extent of an already-identified event, not deciding whether an
# event exists at all (that judgment is the human's, not this function's).
RETURN_RATIO = 1.5
# A decaying resonance oscillates, dipping briefly between its own peaks
# (the same phenomenon service/deess.py's _extend_for_ring exists for, on
# click ring-tails). Stopping at the very first under-threshold block cuts
# the window short mid-decay; tolerating a couple of consecutive misses
# before actually stopping was needed on a real measured burst (33ms
# detected vs. its true ~180ms extent without this).
MISS_TOLERANCE_BLOCKS = 2
# Attenuation depth and shape. 16dB matched real measured events well
# (61-78% peak reduction across three different real plosives) without the
# floor being so deep it risks sounding like a hard mute. Attack is fast
# (plosive onsets are abrupt); release is slower so the return to full
# level isn't itself audible as a new discontinuity.
MAX_REDUCTION_DB = 16.0
ATTACK_MS = 2.0
RELEASE_MS = 40.0


def _walk(x, seed, block, threshold, direction, limit):
    """Walk outward from `seed` in steps of `block` samples (direction -1
    for backward/start, +1 for forward/end), tracking the furthest boundary
    reached while blocks are still above `threshold`. Tolerates up to
    MISS_TOLERANCE_BLOCKS consecutive below-threshold blocks before giving
    up (see module docstring), returning the boundary as of the last
    confirmed above-threshold block -- not including the trailing run of
    misses that finally ended the walk."""
    pos = seed
    last_good = seed
    misses = 0
    while 0 <= pos <= len(x) and abs(pos - seed) < limit:
        lo, hi = (pos, pos + block) if direction > 0 else (pos - block, pos)
        lo, hi = max(0, lo), min(len(x), hi)
        if hi <= lo:
            break
        level = np.sqrt(np.mean(x[lo:hi] ** 2))
        pos += direction * block
        if level > threshold:
            misses = 0
            last_good = pos
        else:
            misses += 1
            if misses > MISS_TOLERANCE_BLOCKS:
                break
    return last_good


def _channel_window(x, rate, seed):
    """Auto-size the affected window for one channel by walking outward
    from `seed` (a sample index) while the local block RMS stays above
    RETURN_RATIO times the pre-seed baseline. Returns (start, end, baseline)."""
    block = max(1, round(rate * BLOCK_MS / 1000))
    baseline_samples = round(BASELINE_WINDOW_S * rate)
    gap_samples = round(BASELINE_GAP_S * rate)
    pre = x[max(0, seed - baseline_samples):max(0, seed - gap_samples)]
    baseline = max(float(np.sqrt(np.mean(pre ** 2))) if len(pre) else 1e-6, 1e-6)
    threshold = baseline * RETURN_RATIO
    search_samples = round(SEARCH_MS * rate / 1000)

    start = _walk(x, seed, block, threshold, direction=-1, limit=search_samples)
    end = _walk(x, seed, block, threshold, direction=+1, limit=search_samples)
    start, end = max(0, min(start, seed)), min(len(x), max(end, seed))
    return start, end, baseline


def _attenuation_envelope(length, rate):
    """Attack-hold-release gain envelope: dip quickly to the floor, hold at
    the floor for the full detected window, release back to unity only at
    the very end -- not attack-then-immediately-release, which would leave
    the bulk of a real (non-trivial-length) window back at full volume."""
    depth = 10 ** (-MAX_REDUCTION_DB / 20)
    attack_n = min(max(1, round(rate * ATTACK_MS / 1000)), length)
    release_n = min(max(1, round(rate * RELEASE_MS / 1000)), length - attack_n)
    env = np.full(length, depth)
    env[:attack_n] = np.linspace(1.0, depth, attack_n)
    if release_n > 0:
        env[length - release_n:] = np.linspace(depth, 1.0, release_n)
    return env


def attenuate_pop(x, rate, seed_seconds):
    """Attenuate a single human-identified plosive/pop in a (samples,
    channels) float32 array, centered near `seed_seconds`. No detection is
    performed elsewhere in the signal; only the auto-sized window around
    the seed is ever touched -- see module docstring for why.

    Returns (attenuated, report) where report describes the window actually
    applied per channel, for surfacing back to the caller/UI."""
    if not (0 <= seed_seconds <= len(x) / rate):
        raise ValueError(f'seed_seconds {seed_seconds} is outside the {len(x) / rate:.3f}s signal')
    seed = round(seed_seconds * rate)
    out = x.copy()
    windows = []
    for c in range(x.shape[1]):
        start, end, baseline = _channel_window(x[:, c], rate, seed)
        windows.append((start, end, baseline))
        length = end - start
        if length <= 0:
            continue
        out[start:end, c] = x[start:end, c] * _attenuation_envelope(length, rate)
    overall_start = min(w[0] for w in windows)
    overall_end = max(w[1] for w in windows)
    report = {
        'seed_seconds': float(seed_seconds),
        'start_seconds': float(overall_start / rate),
        'end_seconds': float(overall_end / rate),
        'duration_seconds': float((overall_end - overall_start) / rate),
        'max_reduction_db': MAX_REDUCTION_DB,
        'channels': [{'start_seconds': float(s / rate), 'end_seconds': float(e / rate), 'baseline_rms': float(b)} for s, e, b in windows],
    }
    return out.astype(x.dtype, copy=False), report
