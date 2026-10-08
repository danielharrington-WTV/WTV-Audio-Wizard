"""Inference-only integration with the unmodified official Bandit v2 model.
Loads a trusted, checksum-verified checkpoint. Keeps full audio off the GPU.
Mono model is applied independently to L/R; spatial quality needs auditioning.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

_LOADED = None

def main():
    global _LOADED
    p = argparse.ArgumentParser()
    p.add_argument('--repo', required=True)
    p.add_argument('--checkpoint', required=True)
    p.add_argument('--input', required=True)
    p.add_argument('--output', required=True)
    p.add_argument('--chunk-seconds', type=float, default=8)
    p.add_argument('--hop-seconds', type=float, default=1)
    p.add_argument('--stems', nargs='+', choices=['speech', 'music', 'sfx'], default=['speech', 'music', 'sfx'])
    args = p.parse_args()
    os.environ['NUMBA_CACHE_DIR'] = str(Path(args.output).resolve().parent / 'numba-cache')
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
    import yaml
    sys.path.insert(0, str(Path(args.repo).resolve()))
    from src.models.bandit.bandit import Bandit
    if not torch.cuda.is_available():
        raise RuntimeError('Bandit v2 runner requires a CUDA GPU')
    torch.set_num_threads(4)
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    if _LOADED is None:
        kwargs = yaml.safe_load((Path(args.repo) / 'configs/models/bandit-mus64.yaml').read_text())['kwargs']
        model = Bandit(fs=48000, stems=['speech', 'music', 'sfx'], **kwargs)
        checkpoint = torch.load(args.checkpoint, map_location='cpu', weights_only=True)
        state = {k.removeprefix('model.'): v for k, v in checkpoint['state_dict'].items() if k.startswith('model.')}
        model.load_state_dict(state, strict=True)
        del checkpoint, state
        # Load all pinned keys strictly first; heads are independent after shared encoding.
        model.mask_estim = torch.nn.ModuleDict({k:v for k,v in model.mask_estim.items() if k in args.stems})
        model = model.eval().cuda()
        _LOADED = model
    model = _LOADED
    audio, sr = sf.read(args.input, dtype='float32', always_2d=True)
    if audio.shape[1] not in (1, 2) or not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Expected finite mono/stereo input')
    x = torch.from_numpy(audio.T.copy())
    if sr != 48000:
        x = torchaudio.functional.resample(x, sr, 48000)
    length = x.shape[-1]
    chunk, hop = round(args.chunk_seconds * 48000), round(args.hop_seconds * 48000)
    if not 0 < hop <= chunk or chunk < 2048:
        raise ValueError('Invalid chunk/hop size')
    padding = chunk
    x = torch.nn.functional.pad(x, (padding, padding))
    window = torch.hann_window(chunk).numpy()
    weights = np.zeros(x.shape[-1], np.float32)
    result = {k: np.zeros((audio.shape[1], x.shape[-1]), np.float32) for k in args.stems}
    starts = list(range(0, x.shape[-1] - chunk + 1, hop))
    with torch.inference_mode():
        for index, start in enumerate(starts):
            for channel in range(audio.shape[1]):
                batch = {'mixture': {'audio': x[channel:channel+1, start:start+chunk][None].cuda()}}
                estimates = model(batch)['estimates']
                for stem, item in estimates.items():
                    if stem not in result:
                        continue
                    result[stem][channel, start:start+chunk] += item['audio'][0, 0].float().cpu().numpy() * window
                del batch, estimates
            weights[start:start+chunk] += window
            print(json.dumps({'progress': round(100 * (index + 1) / len(starts))}), flush=True)
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    for stem, data in result.items():
        data = data[:, padding:padding+length] / weights[padding:padding+length].clip(1e-8)
        # Always label the actual 48 kHz samples correctly (upstream inference.py uses the input rate here).
        sf.write(out / f'{stem}.wav', data.T, 48000, subtype='FLOAT')
    torch.cuda.synchronize()
    metrics = {'elapsed_seconds': time.perf_counter() - started,
               'audio_seconds': len(audio) / sr, 'channels': audio.shape[1],
               'chunk_seconds': args.chunk_seconds, 'hop_seconds': args.hop_seconds,
               'peak_allocated_mib': torch.cuda.max_memory_allocated() / 2**20,
               'peak_reserved_mib': torch.cuda.max_memory_reserved() / 2**20,
               'gpu': torch.cuda.get_device_name(), 'torch': torch.__version__,
               'parameters': sum(v.numel() for v in model.parameters())}
    (out / 'benchmark.json').write_text(json.dumps(metrics, indent=2))
    print(json.dumps(metrics), flush=True)

if __name__ == '__main__':
    main()
