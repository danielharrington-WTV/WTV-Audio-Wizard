"""Whisper body: boost existing 150–500 Hz audio, without pitch synthesis."""
import numpy as np
from scipy.signal import butter, sosfiltfilt, resample_poly


def peak4(x, rate):
    peak = 0.0
    for start in range(0, len(x), rate*2):
        end = min(len(x), start+rate*2)
        lo, hi = max(0, start-128), min(len(x), end+128)
        up = resample_poly(x[lo:hi], 4, 1, axis=0)
        peak = max(peak, float(np.max(np.abs(up[(start-lo)*4:(end-lo)*4]))))
    return peak


def enhance_low_end(x, rate, intensity=1.0):
    if not np.isfinite(intensity) or not .2 <= intensity <= 3:
        raise ValueError('Low-end intensity must be between 0.2 and 3.0')
    if x.ndim != 2 or x.shape[1] not in (1, 2) or not len(x) or not np.isfinite(x).all() or not 8000 <= rate <= 96000:
        raise ValueError('Expected finite mono/stereo audio at 8–96 kHz')
    # Zero-phase parallel filtering retains alignment; tiny clips bypass EQ.
    body = np.zeros_like(x, dtype=np.float64)
    if len(x) > 27:
        body = sosfiltfilt(butter(2, [150, 500], fs=rate, btype='bandpass', output='sos'), x, axis=0)
    out = x.astype(np.float64) + intensity*body
    measured = peak4(out, rate)
    ceiling = 10**(-1/20)
    safety = min(1.0, ceiling/max(measured, 1e-15))
    out = (out*safety).astype(x.dtype)
    report = {
        'algorithm': 'whisper-body-v1', 'intensity': intensity,
        'body_band_hz': [150, 500],
        'nominal_center_boost_db': float(20*np.log10(1+intensity)),
        'safety_gain_db': float(20*np.log10(safety)),
        'output_peak_dbfs': float(20*np.log10(max(measured*safety, 1e-15))),
        'peak_method': '4x oversampled estimate; linked global attenuation to -1 dBFS',
        'applied': bool(np.max(np.abs(out-x)) > 1e-8),
        'channels': [{'applied': bool(np.max(np.abs(out[:, c]-x[:, c])) > 1e-8)} for c in range(x.shape[1])],
    }
    return out, report
