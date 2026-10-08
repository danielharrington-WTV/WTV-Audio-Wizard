"""MossFormer2 SE cleanup of dialogue only, with exact sample alignment."""
import argparse
import json
import os
from pathlib import Path
import time

_LOADED = None

def main():
    global _LOADED
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--runtime', required=True)
    args = parser.parse_args()
    source, output = Path(args.input).resolve(), Path(args.output).resolve()
    runtime = Path(args.runtime).resolve()
    checkpoint = runtime / 'checkpoints/MossFormer2_SE_48K'
    if not (checkpoint / 'last_best_checkpoint.pt').is_file() or not (checkpoint / 'last_best_checkpoint').is_file():
        raise RuntimeError('MossFormer checkpoint is missing')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['NUMBA_CACHE_DIR'] = str(runtime / 'numba-cache')
    os.chdir(runtime)
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(4)
    print('Loading ClearVoice runtime', flush=True)
    from clearvoice import ClearVoice
    if not torch.cuda.is_available():
        raise RuntimeError('Configured MossFormer runner requires CUDA')
    x, sr = sf.read(source, dtype='float32', always_2d=True)
    if sr != 48000 or x.shape[1] not in (1, 2) or not len(x) or not np.isfinite(x).all():
        raise ValueError('Cleanup expects finite mono/stereo 48 kHz dialogue')
    torch.cuda.reset_peak_memory_stats()
    start = time.perf_counter()
    print('Loading MossFormer2 checkpoint', flush=True)
    if _LOADED is None:
        model = ClearVoice(task='speech_enhancement', model_names=['MossFormer2_SE_48K'])
        from clearvoice.utils.decode import decode_one_audio_mossformer2_se_48k
        worker = model.models[0]
        # ClearVoice's default loader tolerates missing keys. Require the complete
        # pinned weights rather than allowing randomly initialized layers.
        weights = torch.load(checkpoint / 'last_best_checkpoint.pt', map_location='cpu', weights_only=True)
        weights = weights.get('model', weights)
        strict_state = {}
        for key, value in worker.model.state_dict().items():
            candidates = [key, key.removeprefix('module.'), 'module.' + key]
            match = next((k for k in candidates if k in weights and weights[k].shape == value.shape), None)
            if match is None:
                raise ValueError(f'MossFormer checkpoint is missing compatible weights for {key}')
            strict_state[key] = weights[match]
        worker.model.load_state_dict(strict_state, strict=True)
        worker.model.eval()
        del weights, strict_state
        _LOADED = (worker, decode_one_audio_mossformer2_se_48k)
    worker, decode_one_audio_mossformer2_se_48k = _LOADED
    cleaned = np.zeros_like(x)
    with torch.inference_mode():
        for channel in range(x.shape[1]):
            signal = x[:, channel]
            if np.max(np.abs(signal)) > 1e-8:
                # Bound GPU memory and crossfade the overlap. The bundled batch
                # decoder has inconsistent input shapes; use its file decoder
                # on short numpy blocks, bypassing PCM writes and long-clip padding.
                def decode(block):
                    return decode_one_audio_mossformer2_se_48k(worker.model, worker.device, block[None].copy(), worker.args)
                # Progress lines on stdout are relayed to the job by runners/worker.py.
                report = lambda f, c=channel: print(json.dumps({'progress': round(100 * (c + f) / x.shape[1], 1)}), flush=True)
                cleaned[:, channel] = enhance_channel(signal, decode, progress=report)
            print(json.dumps({'progress': round(100 * (channel + 1) / x.shape[1])}), flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output, cleaned, sr, subtype='FLOAT')
    torch.cuda.synchronize()
    report = {'model': 'MossFormer2_SE_48K', 'samples': len(x), 'sample_rate': sr,
              'channels': x.shape[1], 'elapsed_seconds': time.perf_counter() - start,
              'peak_allocated_mib': torch.cuda.max_memory_allocated() / 2**20,
              'peak_reserved_mib': torch.cuda.max_memory_reserved() / 2**20}
    output.with_suffix('.json').write_text(json.dumps(report, indent=2))

def enhance_channel(signal, decode, window=192000, overlap=48000, progress=None):
    import numpy as np
    summed = np.zeros(len(signal), dtype=np.float64)
    weight = np.zeros(len(signal), dtype=np.float64)
    step = window - overlap
    for start in range(0, len(signal), step):
        size = min(window, len(signal) - start)
        block = np.pad(signal[start:start + size], (0, window - size))
        result = np.asarray(decode(block)).reshape(-1)
        if len(result) != window or not np.isfinite(result).all():
            raise ValueError('MossFormer returned invalid samples or duration')
        blend = np.ones(window)
        if start:
            blend[:overlap] = np.linspace(0, 1, overlap, endpoint=False)
        if start + window < len(signal):
            blend[-overlap:] = np.linspace(1, 0, overlap, endpoint=False)
        summed[start:start + size] += result[:size] * blend[:size]
        weight[start:start + size] += blend[:size]
        if progress: progress(min(1.0, (start + size) / len(signal)))
        if start + window >= len(signal):
            break
    if not np.all(weight > 0):
        raise ValueError('Cleanup left uncovered samples')
    return (summed / weight).astype(np.float32)

if __name__ == '__main__':
    main()
