import math
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

def read_audio(path, rate):
    x, sr = sf.read(path, dtype='float32', always_2d=True)
    if not len(x) or x.shape[1] not in (1, 2) or not np.isfinite(x).all():
        raise ValueError('Expected finite mono or stereo audio')
    return resample_audio(x, sr, rate)

def resample_audio(x, sr, rate):
    if sr != rate:
        g = math.gcd(sr, rate)
        n = round(len(x) * rate / sr)
        x = resample_poly(x, rate // g, sr // g, axis=0)[:n]
    return x

def block_levels(x, rate):
    size = max(1, round(rate * .01))
    padded = np.pad(x, ((0, (-len(x)) % size), (0, 0)))
    rms = np.sqrt(np.mean(padded.reshape(-1, size, x.shape[1]) ** 2, axis=(1, 2)))
    return rms, size

def mix(stems, settings, out):
    rate = settings.output_rate
    lengths = {len(x) for x in stems.values()}
    if len(lengths) != 1:
        raise ValueError('Stem durations differ; refusing to stretch or silently trim audio')
    channels = max(x.shape[1] for x in stems.values())
    stems = {k: np.repeat(v, channels, axis=1) if v.shape[1] == 1 and channels == 2 else v.copy() for k, v in stems.items()}
    report = {'normalization': {}, 'warnings': []}
    for spec in settings.stems:
        if spec.name not in stems:
            continue
        x = stems[spec.name]
        levels, _ = block_levels(x, rate)
        active = levels[levels > 10 ** (-60 / 20)]
        gain = 0.0
        measured = None
        if spec.name == 'dialogue' and not settings.dialogue_postprocess:
            report['normalization'][spec.name] = {'measured': None, 'gain_db': 0.0, 'skipped': 'dialogue_postprocess_off'}
            continue
        if len(active):
            measured = float(20 * np.log10(np.sqrt(np.mean(active ** 2))))
            if np.isfinite(measured):
                gain = min(spec.target - measured, settings.max_boost_db)
                if spec.name == 'dialogue':
                    peak_db = float(20 * np.log10(max(np.max(np.abs(x)), 1e-15)))
                    gain = min(gain, spec.target - peak_db)
                x *= 10 ** (gain / 20)
            else:
                measured = None
        report['normalization'][spec.name] = {'measured': measured, 'gain_db': gain}
    if any(spec.duck and spec.name in stems for spec in settings.stems):
        levels, size = block_levels(stems['dialogue'], rate)
        target = (levels > 10 ** (settings.threshold_dbfs / 20)).astype(float)
        envelope = np.zeros_like(target)
        previous = 0.0
        for i, value in enumerate(target):
            ms = settings.attack_ms if value > previous else settings.release_ms
            alpha = np.exp(-1000 * size / (rate * ms))
            previous = alpha * previous + (1 - alpha) * value
            envelope[i] = previous
        env = np.interp(np.arange(len(stems['dialogue'])), np.arange(len(envelope)) * size, envelope)
        for spec in settings.stems:
            if spec.duck and spec.name in stems:
                stems[spec.name] *= (10 ** (-settings.duck_db * env / 20))[:, None]
    summed = stems['effects'] if settings.ambience_only else sum(stems.values())
    # Conservative global attenuation measured at 4x. No claim of a certified true-peak limiter.
    peak = float(np.max(np.abs(resample_poly(summed, 4, 1, axis=0))))
    safety = min(1.0, 10 ** (-1.2 / 20) / max(peak, 1e-12))
    report['safety_gain_db'] = float(20 * np.log10(safety))
    report['peak_method'] = '4x oversampled peak, global attenuation to -1.2 dBFS; not a certified dBTP limiter'
    out.mkdir(parents=True, exist_ok=True)
    for name, x in stems.items():
        if settings.ambience_only and name != 'effects': continue
        sf.write(out / f'{name}.wav', x * safety, rate, subtype='FLOAT')
    sf.write(out / 'mix.wav', summed * safety, rate, subtype='FLOAT')
    report.update(samples=len(summed), sample_rate=rate, channels=channels)
    return report


def blend_dialogue(dry, wet, amount):
    """Linear model blend at output sample rate, before the finishing chain."""
    if not np.isfinite(amount) or not 0 <= amount <= 1:
        raise ValueError('Model wet mix must be between 0 and 1')
    if dry.shape != wet.shape:
        raise ValueError('Dry and model audio must be aligned before blending')
    if amount == 0:
        return dry
    if amount == 1:
        return wet
    return dry * (1 - amount) + wet * amount
