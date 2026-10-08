"""Sidon speech restoration (sarulab-speech/sidon-v0.1, MIT), exact sample alignment.

Sidon regenerates the voice without noise and room sound: a w2v-BERT 2.0
feature predictor plus a HiFi-GAN vocoder, both shipped as CUDA TorchScript.
Input is 16 kHz, output 48 kHz. The model is fed fixed 25 s windows (as in
the authors' cleansing scripts, plus 1 s of trailing silence) stepped every 20 s, with the 5 s overlaps
crossfaded. Tested on an RTX 5080 with torch 2.8.0+cu128 (Derev-Test,
2026-09-29): about 2 GB VRAM, timing within 5 ms of the input.
"""
import argparse
import json
from pathlib import Path
import sys
import time

FILES = ('feature_extractor_cuda.pt', 'decoder_cuda.pt')
IN_RATE, OUT_RATE = 16000, 48000
CHUNK_S, HOP_S = 25.0, 20.0
# Each window is fed with 1 s of extra silence after it, so the decoder's
# output (whose length can differ from the input by a frame or so) always
# covers the whole window before it is trimmed. The authors' cleansing script
# zero-pads short clips the same way and pads/trims the output to length.
TAIL_S = 1.0

_LOADED = None


def main():
    global _LOADED
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--models', required=True)
    args = parser.parse_args()
    source, output, models = Path(args.input).resolve(), Path(args.output).resolve(), Path(args.models).resolve()
    missing = [name for name in FILES if not (models / name).is_file()]
    if missing:
        raise RuntimeError(f'Sidon model files missing: {", ".join(missing)}')
    import numpy as np
    import soundfile as sf
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('Sidon requires an NVIDIA GPU (CUDA)')
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from sidon_features import extract_seamless_m4t_features

    x, sr = sf.read(source, dtype='float32', always_2d=True)
    if sr != OUT_RATE or x.shape[1] not in (1, 2) or not len(x) or not np.isfinite(x).all():
        raise ValueError('Restoration expects finite mono/stereo 48 kHz dialogue')
    device = torch.device('cuda')
    torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    if _LOADED is None:
        print('Loading Sidon', flush=True)
        _LOADED = tuple(torch.jit.load(str(models / name), map_location=device).eval() for name in FILES)
    feature_extractor, decoder = _LOADED

    def restore_block(block16):
        with torch.inference_mode():
            feats = extract_seamless_m4t_features([block16], return_tensors='pt', padding_value=1.0, device=str(device))
            hidden = feature_extractor(feats['input_features'].to(device))['last_hidden_state']
            return decoder(hidden.transpose(1, 2)).float().cpu().view(-1).numpy()

    restored = np.zeros_like(x)
    # Dual-mono camera/recorder audio: restore once and copy. Channels that
    # differ by less than -90 dBFS anywhere count as identical.
    identical = x.shape[1] == 2 and float(np.max(np.abs(x[:, 0] - x[:, 1]))) < 10 ** (-90 / 20)
    channels = [0] if identical else range(x.shape[1])
    channels = list(channels)
    for done, channel in enumerate(channels):
        signal = x[:, channel]
        # Progress lines on stdout are relayed to the job by runners/worker.py.
        report = lambda fraction, done=done: print(json.dumps({'progress': round(100 * (done + fraction) / len(channels), 1)}), flush=True)
        if np.max(np.abs(signal)) > 1e-8:
            restored[:, channel] = restore_channel(signal, restore_block, report)
        report(1.0)
    if identical:
        restored[:, 1] = restored[:, 0]
    if not np.isfinite(restored).all():
        raise ValueError('Sidon returned non-finite samples')
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output, restored, OUT_RATE, subtype='FLOAT')
    torch.cuda.synchronize()
    report = {'model': 'sidon-v0.1', 'samples': len(x), 'sample_rate': OUT_RATE, 'channels': x.shape[1],
              'dual_mono_processed_once': bool(identical), 'elapsed_seconds': time.perf_counter() - start,
              'peak_allocated_mib': torch.cuda.max_memory_allocated() / 2**20,
              'peak_reserved_mib': torch.cuda.max_memory_reserved() / 2**20}
    output.with_suffix('.json').write_text(json.dumps(report, indent=2))


def restore_channel(signal, restore_block, progress=None):
    """48 kHz mono in, 48 kHz mono out of exactly the same length."""
    import numpy as np
    import torch
    import torchaudio
    wav16 = torchaudio.functional.resample(torch.from_numpy(np.ascontiguousarray(signal)).float(), OUT_RATE, IN_RATE)
    return windowed(wav16, len(signal), restore_block, progress)


def windowed(wav16, out_len, restore_block, progress=None):
    import numpy as np
    import torch
    ratio = OUT_RATE // IN_RATE
    chunk, hop = int(CHUNK_S * IN_RATE), int(HOP_S * IN_RATE)
    fade = int((CHUNK_S - HOP_S) * OUT_RATE)
    total = max(out_len, len(wav16) * ratio)
    out = np.zeros(total, dtype=np.float64)
    weight = np.zeros(total, dtype=np.float64)
    starts = list(range(0, max(len(wav16) - (chunk - hop), 1), hop)) or [0]
    for i, s in enumerate(starts):
        piece = wav16[s: s + chunk]
        padded = torch.zeros(chunk + int(TAIL_S * IN_RATE))
        padded[: len(piece)] = piece
        y = np.asarray(restore_block(padded), dtype=np.float64).reshape(-1)
        want = len(piece) * ratio
        if len(y) < want - 2 * 960 or not np.isfinite(y).all():  # 960 = one 20 ms feature frame
            raise ValueError('Sidon returned invalid samples or duration')
        y = y[:want] if len(y) >= want else np.pad(y, (0, want - len(y)))
        w = np.ones(len(y))
        if i > 0:
            w[:fade] = np.linspace(0, 1, fade, endpoint=False)[: len(w)]
        if i < len(starts) - 1:
            w[-fade:] = np.minimum(w[-fade:], np.linspace(1, 0, fade, endpoint=False))
        a = s * ratio
        out[a: a + len(y)] += y * w
        weight[a: a + len(y)] += w
        if progress: progress((i + 1) / len(starts))
    covered = weight[:out_len]
    if not np.all(covered > 0):
        raise ValueError('Restoration left uncovered samples')
    return (out[:out_len] / covered).astype(np.float32)


if __name__ == '__main__':
    main()
