"""GAP-URGENet GPU benchmark (VRAM + inference speed).

Mirrors the WTVAudioWizard production call pattern exactly:
  * 48 kHz float32 audio, each channel processed independently
  * 8-second blocks with 4-second crossfades (overlap-add), last block zero-padded
  * per block: model(torch.from_numpy(block[None]).cuda(), sr_in=48000, sr_out=48000, enable_plc=True)
    inside torch.inference_mode()
  * model built once: GAP_URGENet(<5 checkpoint paths>).cuda().eval()

Measurements:
  * cold  = model load + first full inference (timer starts before load)
  * warm  = second full inference in the same process (model already resident)
  * torch.cuda.reset_peak_memory_stats() is called right before loading; after each run
    max_memory_allocated() / max_memory_reserved() are reported in MiB (bytes / 2**20)

Run it through run_gpu_test.bat / run_gpu_test.sh (they set up Python for you), or directly:
    python benchmark.py                       # 10 s synthetic stereo clip (default, comparable)
    python benchmark.py --seconds 1 --channels 1
    python benchmark.py --input my_clip.wav   # any 48 kHz mono/stereo file
"""
import os

# Must be set before anything that might import huggingface_hub.
os.environ['HF_HUB_OFFLINE'] = '1'

import argparse
import datetime as _dt
import json
import platform
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback

HERE = Path(__file__).resolve().parent
REPO = HERE / 'gap_urgenet'          # contains models/gap_urgenet.py
CKPT_DIR = HERE / 'checkpoints'
RESULTS = HERE / 'results'
RATE = 48000

sys.path.insert(0, str(REPO))        # before importing models.gap_urgenet
sys.path.insert(0, str(HERE))

REFERENCE = {
    'gpu': 'NVIDIA GeForce RTX 5080 (16 GB)',
    '10s_stereo_cold_seconds': 12.4,
    '10s_stereo_peak_allocated_mib': 4668,
    '10s_stereo_peak_reserved_mib': 9900,
    '1s_mono_cold_seconds': 20.35,
    '1s_mono_warm_seconds': 5.18,
}


# ----------------------------------------------------------------------------- helpers
def nvidia_smi():
    """Driver/GPU facts straight from nvidia-smi (works even if torch is broken)."""
    info = {}
    try:
        q = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,driver_version,memory.total,memory.used,memory.free,compute_cap',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=30)
        rows = [r.strip() for r in q.stdout.strip().splitlines() if r.strip()]
        if rows:
            parts = [p.strip() for p in rows[0].split(',')]
            keys = ['name', 'driver_version', 'memory_total_mib', 'memory_used_mib', 'memory_free_mib', 'compute_cap']
            info.update(dict(zip(keys, parts)))
            info['gpu_count'] = len(rows)
        head = subprocess.run(['nvidia-smi'], capture_output=True, text=True, timeout=30).stdout
        m = re.search(r'CUDA Version:\s*([\d.]+)', head)
        if m:
            info['driver_max_cuda'] = m.group(1)
    except (OSError, subprocess.SubprocessError) as error:
        info['error'] = f'nvidia-smi unavailable: {error}'
    return info


def smi_memory_used_mib():
    try:
        out = subprocess.run(['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
                             capture_output=True, text=True, timeout=30).stdout.strip().splitlines()
        return float(out[0])
    except Exception:
        return None


def cpu_name():
    if platform.system() == 'Windows':
        try:
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DESCRIPTION\System\CentralProcessor\0')
            return winreg.QueryValueEx(key, 'ProcessorNameString')[0].strip()
        except Exception:
            pass
    try:
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.startswith('model name'):
                return line.split(':', 1)[1].strip()
    except Exception:
        pass
    return platform.processor() or 'unknown'


def synthetic_clip(seconds, channels, seed=1234):
    """Deterministic speech-like test signal: voiced harmonics with vibrato and syllable
    envelopes, plus broadband noise and hum. Different content per channel."""
    import numpy as np
    rng = np.random.default_rng(seed)
    n = int(round(seconds * RATE))
    t = np.arange(n) / RATE
    out = np.zeros((n, channels), dtype=np.float32)
    for ch in range(channels):
        f0 = 120 + 70 * ch + 15 * np.sin(2 * np.pi * 0.7 * t + ch)
        phase = 2 * np.pi * np.cumsum(f0) / RATE
        voice = sum((0.6 / k) * np.sin(k * phase) for k in range(1, 16))
        syllables = np.clip(np.sin(2 * np.pi * (3.1 + 0.4 * ch) * t), 0, None) ** 2
        noise = rng.standard_normal(n) * 0.05
        hum = 0.02 * np.sin(2 * np.pi * 60 * t)
        x = 0.25 * voice * syllables + noise + hum
        out[:, ch] = (0.5 * x / max(np.max(np.abs(x)), 1e-9)).astype(np.float32)
    return out


def enhance_channel(signal, decode_fn, window, overlap):
    """Overlap-add windowing identical to the WTVAudioWizard runner (runners/mossformer2.py)."""
    import numpy as np
    summed = np.zeros(len(signal), dtype=np.float64)
    weight = np.zeros(len(signal), dtype=np.float64)
    step = window - overlap
    for start in range(0, len(signal), step):
        size = min(window, len(signal) - start)
        block = np.pad(signal[start:start + size], (0, window - size))
        result = np.asarray(decode_fn(block)).reshape(-1)
        if len(result) != window or not np.isfinite(result).all():
            raise ValueError('Model returned invalid samples or duration')
        blend = np.ones(window)
        if start:
            blend[:overlap] = np.linspace(0, 1, overlap, endpoint=False)
        if start + window < len(signal):
            blend[-overlap:] = np.linspace(1, 0, overlap, endpoint=False)
        summed[start:start + size] += result[:size] * blend[:size]
        weight[start:start + size] += blend[:size]
        if start + window >= len(signal):
            break
    if not np.all(weight > 0):
        raise ValueError('Windowing left uncovered samples')
    return (summed / weight).astype(np.float32)


def run_inference(model, source):
    import numpy as np
    import torch
    result = np.zeros_like(source)
    with torch.inference_mode():
        for channel in range(source.shape[1]):
            signal = source[:, channel]
            if np.max(np.abs(signal)) > 1e-8:
                def decode(block):
                    return model(torch.from_numpy(block[None].copy()).cuda(), sr_in=RATE, sr_out=RATE,
                                 enable_plc=True).detach().cpu().numpy()
                result[:, channel] = enhance_channel(signal, decode, window=RATE * 8, overlap=RATE * 4)
    torch.cuda.synchronize()
    return result


def mib(x):
    return round(x / 2**20, 1)


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--input', help='48 kHz mono/stereo audio file (default: synthetic clip)')
    ap.add_argument('--seconds', type=float, default=10.0, help='synthetic clip length (default 10)')
    ap.add_argument('--channels', type=int, default=2, choices=(1, 2), help='synthetic clip channels (default 2)')
    ap.add_argument('--warm-runs', type=int, default=1, help='number of warm runs after the cold run (default 1)')
    ap.add_argument('--save-audio', action='store_true', help='write input/enhanced WAVs to results/')
    ap.add_argument('--skip-verify', action='store_true', help='skip checkpoint SHA-256 verification')
    ap.add_argument('--device-index', type=int, default=0, help='CUDA device index (default 0)')
    args = ap.parse_args()

    RESULTS.mkdir(exist_ok=True)
    stamp = _dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    report = {'tool': 'WTV GPU-Test / GAP-URGENet benchmark', 'version': 1, 'timestamp': stamp,
              'system': {'os': platform.platform(), 'python': sys.version.split()[0], 'cpu': cpu_name()},
              'nvidia_smi': nvidia_smi(), 'reference_rtx5080': REFERENCE, 'issues': []}
    exit_code = 0
    try:
        if args.device_index:
            os.environ.setdefault('CUDA_VISIBLE_DEVICES', str(args.device_index))

        import numpy as np
        import soundfile as sf
        import torch
        torch.set_num_threads(4)

        env = report['environment'] = {
            'torch': torch.__version__, 'torch_cuda_runtime': torch.version.cuda,
            'cudnn': torch.backends.cudnn.version() if torch.backends.cudnn.is_available() else None,
            'numpy': np.__version__, 'soundfile': sf.__version__,
        }
        if not torch.cuda.is_available():
            hint = ('PyTorch cannot see a CUDA GPU. ')
            if torch.version.cuda is None:
                hint += 'The installed torch is a CPU-only build; rerun run_gpu_test with --reinstall-torch.'
            else:
                hint += 'Check that an NVIDIA GPU is present and the driver is up to date.'
            raise RuntimeError('GAP-URGENet requires CUDA. ' + hint)
        props = torch.cuda.get_device_properties(0)
        env.update(gpu=props.name, total_vram_mib=mib(props.total_memory),
                   compute_capability=f'{props.major}.{props.minor}',
                   arch_list=getattr(torch.cuda, 'get_arch_list', lambda: [])())
        cc = f'sm_{props.major}{props.minor}'
        if env['arch_list'] and cc not in env['arch_list'] and not any(
                a.startswith('compute_') for a in env['arch_list']):
            report['issues'].append(f'This torch build has no kernels for {cc} ({props.name}); '
                                    f'built for {env["arch_list"]}. Expect "no kernel image" errors.')

        # ---- checkpoints
        if not args.skip_verify:
            from fetch_checkpoints import verify
            print('Verifying checkpoint SHA-256 ...', flush=True)
            status = verify()
            report['checkpoints'] = status
            bad = {k: v for k, v in status.items() if v != 'ok'}
            if bad:
                raise RuntimeError(f'Checkpoint problem: {bad}. Run: python fetch_checkpoints.py')
        paths = {f'{key}_ckpt_path': str(CKPT_DIR / fname) for key, fname in
                 [('dewavlm', 'DeWavLM-Omni.pt'), ('adapter', 'Adapter.pt'), ('vocoder', 'Vocoder.pt'),
                  ('predictor', 'Predictor.pt'), ('postnet', 'PostNet.pt')]}

        # ---- input
        if args.input:
            source, rate = sf.read(args.input, dtype='float32', always_2d=True)
            label = Path(args.input).name
            if rate != RATE:
                raise ValueError(f'{label} is {rate} Hz; GAP-URGENet benchmark input must be 48000 Hz')
        else:
            source, rate = synthetic_clip(args.seconds, args.channels), RATE
            label = f'synthetic {args.seconds:g}s {"stereo" if args.channels == 2 else "mono"}'
        if source.shape[1] not in (1, 2) or not len(source) or not np.isfinite(source).all():
            raise ValueError('Expected finite mono/stereo audio')
        report['input'] = {'label': label, 'seconds': round(len(source) / RATE, 3),
                           'channels': int(source.shape[1]), 'sample_rate': RATE}
        print(f'Input: {label} ({len(source) / RATE:.2f} s, {source.shape[1]} ch, 48 kHz)', flush=True)

        from models.gap_urgenet import GAP_URGENet

        runs = report['runs'] = []
        smi_before = smi_memory_used_mib()

        # ---- cold: load + inference
        print('Cold run: loading model + inference ...', flush=True)
        start = time.perf_counter()
        torch.cuda.reset_peak_memory_stats()
        model = GAP_URGENet(**paths).cuda().eval()
        torch.cuda.synchronize()
        load_seconds = time.perf_counter() - start
        output = run_inference(model, source)
        cold = time.perf_counter() - start
        runs.append({'run': 'cold', 'elapsed_seconds': round(cold, 3), 'load_seconds': round(load_seconds, 3),
                     'inference_seconds': round(cold - load_seconds, 3),
                     'peak_allocated_mib': mib(torch.cuda.max_memory_allocated()),
                     'peak_reserved_mib': mib(torch.cuda.max_memory_reserved())})
        print(f'  cold {cold:.2f} s (load {load_seconds:.2f} s)', flush=True)
        smi_during = smi_memory_used_mib()

        # ---- warm: inference only
        for i in range(max(1, args.warm_runs)):
            print(f'Warm run {i + 1}: inference only ...', flush=True)
            start = time.perf_counter()
            output = run_inference(model, source)
            warm = time.perf_counter() - start
            runs.append({'run': f'warm{i + 1}' if args.warm_runs > 1 else 'warm',
                         'elapsed_seconds': round(warm, 3),
                         'realtime_factor': round(report['input']['seconds'] / warm, 2),
                         'peak_allocated_mib': mib(torch.cuda.max_memory_allocated()),
                         'peak_reserved_mib': mib(torch.cuda.max_memory_reserved())})
            print(f'  warm {warm:.2f} s', flush=True)

        report['device_memory'] = {
            'nvidia_smi_used_before_mib': smi_before, 'nvidia_smi_used_with_model_mib': smi_during,
            'note': 'nvidia-smi numbers are whole-GPU (all apps + CUDA context); the torch peaks are this model only',
        }
        report['output_finite'] = bool(np.isfinite(output).all())
        if args.save_audio:
            sf.write(RESULTS / f'{stamp}_input.wav', source, RATE, subtype='FLOAT')
            sf.write(RESULTS / f'{stamp}_enhanced.wav', output, RATE, subtype='FLOAT')
    except Exception as error:
        exit_code = 1
        report['error'] = f'{type(error).__name__}: {error}'
        report['traceback'] = traceback.format_exc()
        if 'out of memory' in str(error).lower():
            report['issues'].append('CUDA out of memory: this card does not have enough free VRAM for the '
                                    'standard GAP-URGENet path. Close other GPU apps and retry.')
            try:
                import torch
                report['oom_peak_allocated_mib'] = mib(torch.cuda.max_memory_allocated())
                report['oom_peak_reserved_mib'] = mib(torch.cuda.max_memory_reserved())
            except Exception:
                pass

    gpu_slug = re.sub(r'[^A-Za-z0-9]+', '-', report.get('environment', {}).get('gpu')
                      or report['nvidia_smi'].get('name', 'unknown-gpu')).strip('-')
    out = RESULTS / f'{stamp}_{gpu_slug}.json'
    out.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print_summary(report, out)
    return exit_code


def print_summary(r, path):
    smi, env = r['nvidia_smi'], r.get('environment', {})
    line = '=' * 64
    print('\n' + line)
    print(' GAP-URGENet GPU test results')
    print(line)
    print(f" GPU            : {env.get('gpu') or smi.get('name', '?')}")
    print(f" VRAM total     : {env.get('total_vram_mib', smi.get('memory_total_mib', '?'))} MiB")
    print(f" Driver         : {smi.get('driver_version', '?')}  (driver supports CUDA {smi.get('driver_max_cuda', '?')})")
    print(f" PyTorch        : {env.get('torch', '?')}  (CUDA runtime {env.get('torch_cuda_runtime', '?')}, cuDNN {env.get('cudnn', '?')})")
    print(f" CPU / OS       : {r['system']['cpu']} / {r['system']['os']}")
    if 'input' in r:
        print(f" Input          : {r['input']['label']}")
    for run in r.get('runs', []):
        extra = f"  (load {run['load_seconds']} s)" if 'load_seconds' in run else \
                f"  ({run['realtime_factor']}x realtime)"
        print(f" {run['run']:<5} elapsed   : {run['elapsed_seconds']} s{extra}")
        print(f"       peak      : {run['peak_allocated_mib']} MiB allocated / {run['peak_reserved_mib']} MiB reserved")
    if 'error' in r:
        print(f" ERROR          : {r['error']}")
    for issue in r.get('issues', []):
        print(f" NOTE           : {issue}")
    ref = r['reference_rtx5080']
    print(f" Reference      : RTX 5080, 10 s stereo: {ref['10s_stereo_cold_seconds']} s cold, "
          f"{ref['10s_stereo_peak_allocated_mib']} / {ref['10s_stereo_peak_reserved_mib']} MiB")
    print(f" Saved          : {path}")
    print(line)


if __name__ == '__main__':
    sys.exit(main())
