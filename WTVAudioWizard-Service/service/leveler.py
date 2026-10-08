"""Per-clip static speech leveling (speech-level-v1).

Runs on the cleaned dialogue *before* compress_dialogue() and de-essing.
One gain per clip: measure the clip's active-speech RMS and move it to a
common target. A whispered take and a full-voice take on the same timeline
then arrive at the compressor at the same absolute level, so the
compressor's absolute thresholds (its -42 dBFS "don't lift" floor, its knee
and -12 dBFS peak ceiling) treat both alike. Intra-clip dynamics are left to
the compressor; this stage never changes gain within a clip.

Why RMS and not peak: whispers are noise-like with a much lower crest factor
than voiced speech, so matching sample peaks makes them sound *louder* than
dialogue at the same peak. Matching active-speech RMS is what "the same
volume" means to a listener.

Why before compression, not in mix(): mix()'s per-stem normalizer (kept for
music/ambience) capped dialogue boost at max_boost_db (8 dB) and at the -12
peak target, i.e. it was really "boost until the peak hits -12", which
cannot bring a -40 dBFS whisper anywhere near a -12 dBFS take. With
level_dialogue on, mix() leaves the dialogue stem's level alone.

Measurement: 10 ms block RMS (audio.block_levels), blocks above -60 dBFS and
within RELATIVE_GATE_DB of the clip's loud speech (95th percentile block).
The relative gate keeps residual room tone the neural model left behind
from dragging the measurement down and over-boosting a clip.

In per-clip mode this is per timeline clip (one service job each). In Full
sequence mode it is a single gain over the whole export; it does not level
clips against each other there.
"""
import numpy as np

from .audio import block_levels

ACTIVE_FLOOR_DB = -60
RELATIVE_GATE_DB = 30
LOUD_PERCENTILE = 95
MAX_BOOST_DB = 30
MAX_CUT_DB = 30


def active_speech_rms_db(x, rate):
    levels, _ = block_levels(x, rate)
    db = 20 * np.log10(np.maximum(levels, 1e-15))
    loud = db[db > ACTIVE_FLOOR_DB]
    if not len(loud):
        return None, None
    gate = float(max(ACTIVE_FLOOR_DB, np.percentile(loud, LOUD_PERCENTILE) - RELATIVE_GATE_DB))
    active = levels[db > gate]
    return float(20 * np.log10(np.sqrt(np.mean(active ** 2)))), gate


def level_dialogue(x, rate, target_dbfs=-23):
    if x.ndim != 2 or x.shape[1] not in (1, 2) or not len(x) or not np.isfinite(x).all():
        raise ValueError('Expected finite mono or stereo audio')
    input_peak = float(20 * np.log10(max(np.max(np.abs(x)), 1e-15)))
    measured, gate = active_speech_rms_db(x, rate)
    report = {
        'algorithm': 'speech-level-v1',
        'target_dbfs': target_dbfs,
        'measured_active_rms_dbfs': measured,
        'gate_dbfs': gate,
        'active_floor_dbfs': ACTIVE_FLOOR_DB,
        'relative_gate_db': RELATIVE_GATE_DB,
        'max_boost_db': MAX_BOOST_DB,
        'max_cut_db': MAX_CUT_DB,
        'input_peak_dbfs': input_peak,
    }
    if measured is None:
        report.update(gain_db=0.0, clamped=False, applied=False, output_peak_dbfs=input_peak,
                      reason=f'no audio above {ACTIVE_FLOOR_DB} dBFS')
        return x, report
    wanted = target_dbfs - measured
    gain = float(np.clip(wanted, -MAX_CUT_DB, MAX_BOOST_DB))
    out = (x * 10 ** (gain / 20)).astype(x.dtype)
    report.update(gain_db=gain, clamped=bool(abs(wanted - gain) > 1e-9), applied=bool(abs(gain) > 1e-9),
                  output_peak_dbfs=float(20 * np.log10(max(np.max(np.abs(out)), 1e-15))))
    return out, report
