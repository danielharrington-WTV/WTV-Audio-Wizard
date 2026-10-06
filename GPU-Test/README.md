# GPU-Test: GAP-URGENet VRAM and speed benchmark

This folder runs the GAP-URGENet speech-enhancement model, as WTVAudioWizard uses it, on your NVIDIA card. It reports how much VRAM the model needs and how fast it runs. Everything the test needs is in this folder. It doesn't need the WTVAudioWizard repo, espnet, torchaudio or any other checkout.

## Quick start

**Windows:** double-click `run_gpu_test.bat`.
**Linux:** `chmod +x run_gpu_test.sh && ./run_gpu_test.sh`

The first run:

1. Checks your GPU and driver with `nvidia-smi`.
2. Downloads the model weights (about 2.34 GB) into `checkpoints/` and verifies each SHA-256.
3. Creates a private Python environment in `.venv/` and installs a CUDA build of PyTorch that matches your driver (about 3 GB), plus numpy and soundfile.
4. Runs the benchmark and saves a JSON report in `results/`.

Later runs skip steps 2 and 3. Plan for roughly 6 GB of free disk space.

**Requirements:** an NVIDIA GPU with a recent driver (570 or newer for RTX 50-series), Python 3.10 to 3.13, and an internet connection for the first run. The model needs CUDA. There is no CPU mode.

### If you already have the weights

```
run_gpu_test.bat --from-dir "D:\path\to\gap-urgenet\checkpoints"
```

This copies the weights and checks them against the hashes. It doesn't download anything.

## What gets measured

The call pattern matches the WTVAudioWizard production runner exactly:

| Step | Detail |
|---|---|
| Input | 48 kHz float32. By default this is a deterministic 10 s synthetic stereo clip, so results from different machines can be compared. |
| Windowing | Each channel is processed separately in 8 s blocks with 4 s crossfades (overlap-add). The last block is zero-padded to 8 s. |
| Per-block call | `model(torch.from_numpy(block[None]).cuda(), sr_in=48000, sr_out=48000, enable_plc=True)` inside `torch.inference_mode()` |
| Model | Built once: `GAP_URGENet(dewavlm_ckpt_path=…, adapter_ckpt_path=…, vocoder_ckpt_path=…, predictor_ckpt_path=…, postnet_ckpt_path=…).cuda().eval()` |
| Memory | `torch.cuda.reset_peak_memory_stats()` runs right before the model loads. After each run the report shows `max_memory_allocated()` and `max_memory_reserved()` in MiB. |
| Cold time | `time.perf_counter()` around model load plus the first full inference. |
| Warm time | A second full inference in the same process, with the model already on the GPU. |

The report also records the GPU name, total VRAM, driver version, the highest CUDA version the driver supports, the PyTorch and CUDA-runtime versions, cuDNN, CPU and OS. It includes nvidia-smi's whole-GPU memory use before and after the model loads, which covers other apps and the CUDA context.

### Options

Pass any of these to `run_gpu_test.bat`, `run_gpu_test.sh` or `benchmark.py`:

| Option | Meaning |
|---|---|
| `--seconds 1 --channels 1` | 1 s mono synthetic clip (the second reference test below) |
| `--input clip.wav` | Your own 48 kHz mono or stereo file |
| `--warm-runs 3` | Run the warm pass several times |
| `--save-audio` | Also write the input and enhanced WAV files to `results/` |
| `--from-dir PATH` / `--base-url URL` | Where to get the checkpoints |
| `--torch-cuda cu126` / `--torch-version 2.11.0` / `--reinstall-torch` | Override the PyTorch build that is picked automatically |
| `--use-current-python` | Skip `.venv` and use the Python you launched with. It must already have CUDA PyTorch, numpy and soundfile. |

### How PyTorch is chosen

| Driver | PyTorch build |
|---|---|
| 570 or newer | `torch 2.11.0 + cu128` (the build validated with this model; needed for RTX 50-series) |
| 528 to 569 | `torch 2.11.0 + cu126` |
| 452 to 527 | `torch 2.7.1 + cu118` |
| older | Stops and asks you to update the driver |

## Reference numbers (RTX 5080, 16 GB)

These are for comparison, not targets.

| Test | Cold (load + inference) | Warm | Peak allocated | Peak reserved |
|---|---|---|---|---|
| 10 s synthetic stereo | 12.4 s | – | 4,668 MiB | 9,900 MiB |
| 1 s mono | 20.35 s | 5.18 s | – | – |

Peak *reserved* is PyTorch's caching allocator footprint. Treat it as the practical VRAM the process holds. A card needs that much plus about 300 to 500 MiB for the CUDA context, and more if other apps are using the GPU.

## Sending results back

Send the newest `results/<timestamp>_<GPU>.json`, or paste the summary block the script prints at the end. If something fails, the JSON still gets written, with the error, traceback and environment details.

## Folder layout

```
GPU-Test/
  run_gpu_test.bat / .sh   one-click launchers
  gpu_test.py              sets up .venv, picks the PyTorch build, fetches checkpoints, runs the benchmark (stdlib only)
  fetch_checkpoints.py     resumable download or local copy, with SHA-256 verification (stdlib only)
  benchmark.py             the measurement itself
  requirements.txt         numpy, soundfile (PyTorch is installed separately)
  checkpoints/             manifest.json + config.json are in git; the *.pt weights are downloaded here
  gap_urgenet/models/      vendored GAP-URGENet inference code (unchanged apart from the import notes below)
  LICENSES/                upstream licenses
  results/                 JSON reports (ignored by git)
```

### Changes to the vendored model code

Only the inference path was copied from upstream (`Xiaobin-Rong/gap-urgenet`). The math is unchanged. These edits remove heavy dependencies, and each one is marked `(GPU-Test)` in the source:

- `torchaudio.functional.resample` is replaced by a verbatim copy in `models/_resample.py`. Its output is identical, and you avoid torch/torchaudio version-mismatch installs.
- `espnet2`'s `AbsSeparator` and `get_layer` are replaced by verbatim copies in `models/_espnet_compat.py`.
- One `einops.rearrange` call is replaced by the equivalent `permute` + `reshape`.
- Unused top-level `omegaconf` imports were removed. Only the `__main__` demos used them.
- Line endings were normalised to LF.

## Checkpoints

The weights are too large for a normal git repo: `DeWavLM-Omni.pt` alone is 1.26 GB. They are fetched at run time and must match these hashes:

| File | Bytes | SHA-256 |
|---|---|---|
| DeWavLM-Omni.pt | 1,261,995,206 | `117a0ced06a2ccc41f5766bcc8da6aa43f98fdc336feb5997a5e5dfea1426738` |
| Adapter.pt | 520,092,014 | `63473a9f764e4a97971530e4d7b987f9472d7b431aee6a982f25f91bcb4d48c6` |
| Vocoder.pt | 454,994,736 | `6881d02168698de3d1083becb6b0c30d4468323f8cfed61f02afb675f4fd81b0` |
| Predictor.pt | 88,469,158 | `1e58c270c12ab953e4df32a34e4b580f780d016bee9bf5580684d6c982f77866` |
| PostNet.pt | 19,170,170 | `d401c7572451341d1482bf35a1bc2c590b9fe8c21d17f0b4b1268e0d88d1c066` |
| config.json | 33 | `faba0c6f14ef6066eebf93568c4914e70d03ab66fc9c969b796aed5067bc8371` |

The default download source is set in `checkpoints/manifest.json`, pinned to one upstream revision. To host the weights yourself, for example as GitHub Release assets (each file is under the 2 GB asset limit), upload the five `.pt` files and run with `--base-url https://github.com/<you>/<repo>/releases/download/<tag>/`, or set `GPU_TEST_CHECKPOINT_URL`. Any file that doesn't match its hash is set aside as `*.bad` and never loaded.

## Licenses

GAP-URGENet is MIT licensed (© 2026 Rong Xiaobin). The adapted components are covered by the Apache-2.0 (ESPnet, PASE, URGENT, xLSTM), MIT (BigVGAN, WavLM, WavTokenizer and others) and BSD-2-Clause (torchaudio) licenses in `LICENSES/`. The checkpoints are subject to the upstream model's terms.
