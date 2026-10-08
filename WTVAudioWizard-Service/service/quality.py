"""DNSMOS P.835 CPU inference for the authenticated WTV service.

Model/calibration: Microsoft DNS-Challenge, dnsmos_local.py (MIT).
See research/DIALOGUE-QUALITY.md for attribution and model license links.
"""
import hashlib
import math
import os
from pathlib import Path
import urllib.request

REVISION = '591184a9fcb2cbdec02520fed81a32bbbf9d73ff'
MODEL_BLOB = '814b8dc6dafa729c0b821a64bef2e7156dc0c01a'
ROOT = Path(os.environ.get('WTV_DATA_DIR', Path(__file__).resolve().parents[3] / 'work' / 'wtv-data'))
MODEL = ROOT / 'models' / 'dnsmos' / 'sig_bak_ovr.onnx'
RATE = 16000
WINDOW = 9.01


def valid_model(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() == MODEL_BLOB


def setup():
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    if MODEL.exists() and valid_model(MODEL.read_bytes()):
        return
    url = f'https://raw.githubusercontent.com/microsoft/DNS-Challenge/{REVISION}/DNSMOS/DNSMOS/sig_bak_ovr.onnx'
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(2_000_000)
    if not valid_model(data):
        raise ValueError('DNSMOS download failed integrity verification')
    MODEL.write_bytes(data)


def calibrated(values):
    sig, bak, overall = map(float, values)
    result = dict(speech=-.08397278*sig*sig+1.22083953*sig+.0052439,
                  background=-.13166888*bak*bak+1.60915514*bak-.39604546,
                  overall=-.06766283*overall*overall+1.11546468*overall+.04602535)
    if not all(math.isfinite(v) for v in result.values()):
        raise ValueError('Model returned invalid scores')
    return result


def merge_flags(windows, threshold):
    regions = []
    for w in windows:
        if w['overall'] >= threshold:
            continue
        if regions and w['start'] <= regions[-1]['end']:
            r = regions[-1]
            r['end'] = max(r['end'], w['end'])
            for key in ('speech', 'background', 'overall'):
                r[key] = min(r[key], w[key])
        else:
            regions.append(dict(w))
    return regions


class Analyzer:
    def __init__(self):
        import onnxruntime as ort
        setup()  # First scan downloads the pinned model; later scans work offline.
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(MODEL), sess_options=options,
                                           providers=['CPUExecutionProvider'])

    def analyze(self, path, threshold=1.5, progress=lambda p: None, cancel=lambda: False):
        import numpy as np
        import soundfile as sf
        from scipy.signal import resample_poly
        if not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 1 <= threshold <= 5:
            raise ValueError('Review threshold must be between 1 and 5')
        windows, skipped = [], 0
        with sf.SoundFile(path) as audio:
            duration = len(audio) / audio.samplerate
            if not .4 <= duration <= 10800 or audio.channels not in (1, 2) or audio.samplerate != 48000:
                raise ValueError('Expected a mono/stereo 48 kHz WAV, 0.4 seconds to 3 hours')
            # Include the final tail, and repeat short clips as the reference does.
            starts = list(range(max(1, math.floor(duration-WINDOW)+1)))
            if duration > WINDOW and duration-WINDOW > starts[-1]+.001:
                starts.append(duration-WINDOW)
            for index, start in enumerate(starts):
                if cancel():
                    raise InterruptedError('Quality scan cancelled')
                audio.seek(round(start*audio.samplerate))
                frames = audio.read(round(WINDOW*audio.samplerate), dtype='float32', always_2d=True)
                if not np.isfinite(frames).all():
                    raise ValueError('Audio contains non-finite samples')
                # Assess channels independently; avoid stereo phase cancellation.
                scores = []
                for channel in frames.T:
                    if np.sqrt(np.mean(channel.astype('float64')**2)) < 10**(-60/20):
                        continue
                    samples = resample_poly(channel, 1, 3).astype('float32')
                    samples = np.tile(samples, math.ceil(round(WINDOW*RATE)/len(samples)))[:round(WINDOW*RATE)]
                    raw = self.session.run(None, {'input_1': samples[None, :]})[0][0]
                    scores.append(calibrated(raw))
                if scores:
                    worst = min(scores, key=lambda s: s['overall'])
                    windows.append(dict(start=float(start), end=min(duration, start+WINDOW), **worst))
                else:
                    skipped += 1
                progress(round(100*(index+1)/len(starts)))
        regions = merge_flags(windows, threshold)
        return dict(model='DNSMOS P.835', provider='CPUExecutionProvider', duration=duration,
                    threshold=threshold, windows=len(windows), skipped_silent_windows=skipped,
                    regions=regions[:500], truncated=len(regions)>500, window_seconds=WINDOW,
                    note='Review aid, not intelligibility or compliance certification. Silence below -60 dBFS skipped; no speech detector. Worst stereo channel; region scores are minima.')

