"""GAP-URGENet dialogue from raw audio; isolated GPU worker, local weights only."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
from mossformer2 import enhance_channel

_LOADED = None

def main():
    global _LOADED
    parser = argparse.ArgumentParser()
    for name in ('input', 'output', 'repo', 'checkpoints'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['NUMBA_CACHE_DIR'] = str(output.parent.parent / 'wtv-numba-cache')
    sys.path.insert(0, str(Path(args.repo).resolve()))
    import numpy as np
    import soundfile as sf
    import torch
    torch.set_num_threads(4)
    from models.gap_urgenet import GAP_URGENet
    if not torch.cuda.is_available():
        raise RuntimeError('GAP-URGENet requires CUDA')
    source, rate = sf.read(args.input, dtype='float32', always_2d=True)
    if rate != 48000 or source.shape[1] not in (1, 2) or not len(source) or not np.isfinite(source).all():
        raise ValueError('Expected finite mono/stereo 48 kHz input')
    paths = {key + '_ckpt_path': str(Path(args.checkpoints).resolve() / filename) for key, filename in
             [('dewavlm','DeWavLM-Omni.pt'),('adapter','Adapter.pt'),('vocoder','Vocoder.pt'),('predictor','Predictor.pt'),('postnet','PostNet.pt')]}
    if not all(Path(p).is_file() for p in paths.values()):
        raise ValueError('GAP-URGENet checkpoints missing')
    start = time.perf_counter()
    torch.cuda.reset_peak_memory_stats()
    print('Loading GAP-URGENet', flush=True)
    if _LOADED is None:
        _LOADED = GAP_URGENet(**paths).cuda().eval()
    model = _LOADED
    result = np.zeros_like(source)
    with torch.inference_mode():
        for channel in range(source.shape[1]):
            signal = source[:, channel]
            if np.max(np.abs(signal)) > 1e-8:
                def decode(block):
                    return model(torch.from_numpy(block[None].copy()).cuda(), sr_in=rate, sr_out=rate,
                                 enable_plc=True).detach().cpu().numpy()
                # Progress lines on stdout are relayed to the job by runners/worker.py.
                report = lambda f, c=channel: print(json.dumps({'progress': round(100 * (c + f) / source.shape[1], 1)}), flush=True)
                result[:, channel] = enhance_channel(signal, decode, window=rate * 8, overlap=rate * 4, progress=report)
            print(json.dumps({'progress': round(100 * (channel + 1) / source.shape[1])}), flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output, result, rate, subtype='FLOAT')
    torch.cuda.synchronize()
    output.with_suffix('.json').write_text(json.dumps({'model':'GAP-URGENet', 'samples':len(source),
        'sample_rate':rate, 'channels':source.shape[1], 'elapsed_seconds':time.perf_counter()-start,
        'peak_allocated_mib':torch.cuda.max_memory_allocated()/2**20,
        'peak_reserved_mib':torch.cuda.max_memory_reserved()/2**20}, indent=2))

if __name__ == '__main__':
    main()
