# Optimization review — WTVAudioWizard v0.6.3

Implementation update, 2026-09-09: v0.7.0 enables stage caching, one warm worker, bounded music RMS, unused-envelope bypass, one input WAV write, selected Bandit heads, upload offloading, pinned analysis reads, duplicate-upload cleanup and per-pass effect lookup reuse. See README and HANDOFF for validation and deferred items. The review below is the historical pre-implementation assessment.

Reviewed 2026-09-08. Scope: first-party panel, Premiere adapters, service, DSP, runners, schemas/configuration, presets and associated tests; relevant Bandit and GAP upstream execution paths were also inspected. Virtual environments and unrelated workspace projects were not treated as product source.

**No production optimizations were enabled in this review.** Most opportunities require code changes, not an existing switch. Two isolated CPU candidates were benchmarked without changing the product. The highest potential end-to-end improvements are stage caching and amortizing model startup across clips; their gains still need measurement on representative projects.

## Priority list

| Priority | Opportunity | Expected benefit | Readiness |
|---|---|---|---|
| 1 | Cache unnormalized model outputs independently of mix settings | Level/duck/de-click adjustments can avoid rerunning neural models | Architecture change; high value for repeated adjustments |
| 1 | Reuse one loaded model across a batch of clips | Avoid repeated Python/CUDA/model startup and weight verification | Worker lifecycle change; benchmark with Premiere using GPU |
| 1 | Bound music RMS and peak-analysis allocations | Substantially lower RAM pressure on long sequences | RMS candidate measured; peak streaming requires boundary tests |
| 2 | Remove the intermediate dialogue WAV write/read/rewrite | Less disk I/O, fewer live buffers | Small refactor with sample-equivalence tests |
| 2 | Skip Bandit output heads for unrequested stems | Avoid unused mask estimation and inverse transforms | Upstream structure supports it; verify selected outputs on GPU |
| 2 | Skip duck-envelope work when no present stem uses it | Less memory on default dialogue-only jobs | Isolated candidate measured; small production change |
| 2 | Make uploads/analysis responsive to concurrent status and Cancel | Avoid event-loop and global-lock stalls | Bounded offloading and asset-lifetime changes |
| 3 | Reduce repeated Premiere enumeration and file reads | Faster large-batch setup and native music passes | Host measurement required; preserve verification boundaries |
| 3 | Index job cache and clean unreferenced duplicate uploads | Keep service responsive and disk usage controlled as history grows | Small data-model/lifecycle changes |
| Experiment | Batch channels; TF32/AMP; larger Bandit hop; compile | Potential GPU throughput improvement | Quality, VRAM and backend benchmarks required |

## 1. Separate inference caching from finishing

Location: [service/app.py](service/app.py), `submit()` fingerprint around line 203 and `run_job()` around line 246.

The current cache key includes every setting and a global pipeline version. Changing a target, duck amount, output option or de-click flag changes the whole job key and reruns model inference. UI-only version increments also invalidate prior jobs. A dialogue-only job additionally depends on Bandit identity even when separation is disabled.

Use a cache graph:

1. Input decoded-audio hash, sample rate and channel layout.
2. Raw dialogue inference output keyed by model/checkpoint identity, runner and relevant upstream code, native conversion/chunk policy and numerical settings.
3. Optional separation output keyed independently by Bandit identity, inference settings and requested heads.
4. Optional repair output keyed by clean dialogue content and repair implementation/settings.
5. Final levels/ducking/peak protection keyed by the selected upstream outputs and finishing settings.

Keep unnormalized outputs reusable; never cache a level-adjusted file as if it were raw model output. Preserve exact length checks and atomic publication. Current DSP hashing protects `audio.py` and `deess.py`, but does not automatically hash runner edits or all upstream model code. Improve that identity when introducing stage reuse. Allow eviction only for files that are not active and are not Premiere's saved/imported output media.

Potential: large for repeated mixing changes. No speedup factor measured.

## 2. Amortize model startup and checksum reads

Locations: [service/app.py](service/app.py), subprocess launches around lines 272/337 and hashes around 263/318/326; all three [runners](runners/).

Each clip starts a fresh subprocess, imports the ML stack, creates a CUDA context and loads the model. The GAP checkpoint files named in local configuration total **2,344,721,317 bytes**. Each uncached GAP clip hashes those files again before the runner loads them. A 100-clip batch consequently requests approximately 234 GB of checksum input reads alone; OS caching can reduce physical disk traffic, but hashing and deserialization are still repeated.

First option: a batch-scoped worker that loads one model, accepts a sequence of clips, reports per-clip completion, and exits at batch end. Later consider an idle worker with an explicit unload timeout. Keep GPU admission serialized: the existing RTX 5080 is shared with Premiere, and GAP's recorded allocator reservation approached 9.9 GB. Do not keep all models resident by default.

For batches requesting both separation and cleanup, grouping stages can reduce model reloads further, but it changes progress, temporary-storage use and cancellation behavior. Evaluate this separately from dialogue-only worker reuse.

Verify pinned weights at worker startup and associate reuse with immutable verified model identity. Do not simply remove checksum checks or assume modification time proves content identity. Workers need crash recovery, request isolation, cancellation acknowledgements, bounded queues and model eviction. Current per-process termination gives reliable resource release; retain an equivalent recovery path.

MossFormer has another startup cost: ClearVoice loads the model, then the adapter loads weights again to enforce strict state validation. A strict single-load adapter may eliminate the second load, but removing strict validation would be a regression.

## 3. Lower peak CPU memory

Locations: [service/music.py](service/music.py):16–19, [service/audio.py](service/audio.py):52–72, [service/deess.py](service/deess.py):349 onward, and `enhance_channel()` in [runners/mossformer2.py](runners/mossformer2.py).

Music RMS currently pads the entire audio, casts the entire array to float64 and squares it. Process a bounded number of complete analysis frames at a time, preserving float64 accumulation and the final partial frame's padding.

Measured on deterministic stereo 48 kHz float32 input, 60 seconds plus 137 samples; three timed repetitions after warm-up:

| Isolated operation | Current | Candidate | Verification |
|---|---:|---:|---|
| Music RMS median time | 20.71 ms | 16.13 ms | Bit-identical levels |
| Music RMS peak traced allocation | 109.90 MiB | 4.71 MiB | 128 frames per block |
| Dialogue-only mix median time | 285.07 ms | 283.42 ms | Identical decoded audio and reports |
| Dialogue-only mix peak traced allocation | 241.85 MiB | 219.79 MiB | Skip unused duck envelope |

The RMS candidate lowered traced allocation by about 96%. The mix timing difference is too small to claim a useful speed gain; its benefit here is memory. Traced allocations are not total process RSS. Source buffers were allocated before measurement. These are CPU microbenchmarks, not model or Premiere benchmarks. Raw results: [validation/optimization-review.json](validation/optimization-review.json); reproducible script: `../../work/optimization-review-bench.py`.

The larger long-sequence issue is `resample_poly(summed, 4, 1)` followed by a full-sized `abs()` for peak detection. A ten-minute stereo float32 array at 48 kHz is about 219.7 MiB; its 4× version is about 878.9 MiB, before the absolute-value array and other live buffers. At 96 kHz these figures double. Stream peak analysis with correct filter history/overlap and exact boundary handling; do not replace it with sample-peak measurement or independent chunks with fresh filter edges.

Additional candidates: blockwise gain application, avoiding copies of arrays already owned by the mixing stage, and reducing full-length float64 de-esser/overlap-add buffers. Preserve accumulator precision until null tests and long-duration tests establish equivalence.

## 4. Remove redundant intermediate I/O

Location: [service/app.py](service/app.py):328–331.

The service writes dialogue at the requested output rate, reads that WAV back/resamples to 48 kHz, then overwrites it. Resample the existing in-memory array and write the worker input once. At 48 kHz the intermediate disk roundtrip provides no resampling benefit. At other rates preserve the existing conversion order initially; changing the model input from source → output rate → 48 kHz to direct source → 48 kHz is a separate signal-processing change requiring comparison.

Dialogue-only output also writes both `dialogue.wav` and an identical-audio `mix.wav`. The panel never downloads `mix`, but the API and tests expose it. Make combined output optional or lazily generated if desired; do not remove the route/file without changing its contract.

## 5. Compute only requested Bandit heads

Location: [runners/bandit_v2.py](runners/bandit_v2.py):36, 58–67. Relevant upstream method: `work/bandit-v2/src/models/bandit/bandit.py`, `Bandit.separate()` around line 316.

The runner constructs speech/music/sfx heads and filters results **after** `model(batch)`. Upstream encodes once, then loops independently over `mask_estim.items()` to produce each stem's mask, inverse STFT and spectrogram. Optional output flags already save accumulation and writes, but do not skip these unused head computations.

Strict-load the full checkpoint first, then execute only selected heads through a version-pinned inference adapter. Keep shared encoding unchanged and compare each retained stem against the current runner. This saves head work, not all model work; do not claim a 3× improvement when retaining one of three heads. It must continue to exclude Bandit speech from dialogue cleanup.

## 6. Service responsiveness and growing history

- `upload()` is async but performs synchronous writes, WAV decoding, finite checks and content hashing. Offload bounded disk/validation operations while keeping request streaming and cancellation safe. Starlette documents its thread-pool execution for synchronous endpoints; declaring code async does not offload blocking work. [Starlette thread pool](https://starlette.dev/threadpool/).
- `music_analysis()` holds the global job lock while loading/resampling up to three long WAVs. Pin asset references under a short lock, read outside it and release the pins afterward; deletion must honor those pins. Otherwise status/cancellation can wait behind unrelated I/O.
- The cache scans all historical jobs on submission; asset deletion scans every job's tracks. Add cache-key and asset-reference indexes, rebuild them on startup and update them atomically.
- The panel uploads again before discovering a job cache hit. Reused jobs can leave the newly uploaded asset unreferenced. Track and delete only that unused upload, or add a verified content lookup. Never delete assets used by running/completed jobs or saved Premiere outputs indiscriminately.
- Bandit progress reads the entire log every 250 ms to inspect its last lines. Use a maintained file offset/partial-line buffer. Avoid rewriting large job metadata for unchanged progress.
- CPU mixing, repair and checksum phases only check cancellation between stages. Bounded processing would also permit more responsive cancellation without touching already committed results.

## 7. Premiere/UXP overhead

Locations: [plugin/per-clip.js](plugin/per-clip.js), [plugin/premiere.js](plugin/premiere.js), [plugin/music-effects.js](plugin/music-effects.js), [plugin/music-pass.js](plugin/music-pass.js), [plugin/clip-batch.js](plugin/clip-batch.js).

Batch setup repeatedly inventories full sequences and calls many asynchronous host getters per clip. Each clip export creates and inventories a full clone, so large batches can incur substantial host work before GPU processing starts. Measure this phase separately. Cache immutable lookup data within a single operation and reuse already-read fields; retain fresh verification before mutation. The current structural signature omits effect parameter state, so it must not become a general cache key for rendered audio.

Music preparation rediscovers the effect catalog for each clip and performs many per-key host calls. Cache Amplify discovery once per pass; avoid redundant key-time getters within the same snapshot. Do not skip installed keyframe readback or reuse fingerprints across user-edit boundaries. Any bounded parallel host reads must first be verified with Premiere; more concurrent promises are not automatically faster or safe.

Batch WAVs are read once for complete-batch validation and again before uploading. That duplication deliberately catches incomplete/stale exports. A small byte-budgeted cache or metadata-first check can avoid some reads; retaining every 512 MiB file in UXP memory would be worse. Music export polling also rereads the full growing WAV each second; inspect file metadata first when supported, then validate complete bytes. Keep completion verification and isolated export sequences.

## 8. GPU experiments, not default switches

- **Two-channel batching:** the models generally expose a batch dimension, but workers process L/R separately. Start with Bandit or MossFormer; verify channel independence, exact output length and VRAM. GAP's existing reservation makes doubling its batch especially uncertain.
- **TF32:** test matmul precision on the actual runtime/GPU with quality and numerical comparisons. PyTorch documents the performance/accuracy tradeoff; a faster mode is not guaranteed to preserve audio output. [Numerical accuracy](https://docs.pytorch.org/docs/main/notes/numerical_accuracy.html).
- **AMP/BF16/FP16:** treat individually per model. Inspected GAP predictor/postnet paths explicitly disable autocast in places; blanket half conversion risks incompatible or unstable operations. Do not enable all models globally.
- **Larger Bandit hop:** current eight-second windows advance by one second, approximately eightfold overlap on long audio. Two- or four-second hops reduce forward calls but alter crossfading/context and require seam, quality and retained-stem tests.
- **`torch.compile`:** prioritize only after model reuse. Cold compilation can take seconds to minutes, and native Windows/backend support must be checked for the installed environment. Disk compiler caches may help repeated processes, but do not prove a net gain. [PyTorch compiler troubleshooting](https://docs.pytorch.org/docs/main/user_guide/torch_compiler/torch.compiler_troubleshooting.html).
- **Silence/duplicate-channel shortcuts:** workers already bypass an entirely silent channel after loading. Earlier silence checks or reusing exactly identical channels are candidates only after handling stateful/random model behavior; never use a loose threshold to discard quiet speech.

Already enabled: evaluation/inference mode, bounded model windows, sequential GPU jobs, per-channel silence bypass, content-based whole-job reuse, optional Bandit execution and selected-stem output writes. There is no missing universal “GPU acceleration” switch.

## 9. De-click-specific performance

Dense least-squares reconstruction and Python matrix construction in `deess.py` can become expensive with many/long repaired spans. Profile real candidate counts before pursuing a banded solver or compiled loops. Normal equations can worsen conditioning; preserve current fallback and numerical guards. Cache fixed filter coefficients and attack/release constants where appropriate, but these are secondary wins. Detector precision remains the higher priority: accelerating false repairs does not improve the result. See [DECLICK-RESEARCH.md](DECLICK-RESEARCH.md).

## Suggested implementation order

1. Add phase timings: upload validation, checkpoint hashing, process/import startup, model load, inference, resampling, DSP, writes, Premiere preparation and Apply.
2. Ship the bounded RMS, unused-envelope bypass and single worker-input write with equivalence tests; offload blocking validation with cancellation/lifetime tests.
3. Add stage caching with comprehensive content/code identities. Measure repeated target/duck edits on real batches.
4. Add a batch-scoped single-model worker and explicit GPU release policy. Benchmark many short clips, long clips, failures and Cancel while Premiere is open.
5. Validate requested Bandit heads, then consider precision/batching/hop experiments behind explicit settings.

This review produced the report and isolated benchmark artifacts only. The application remains v0.6.3, and the existing development ZIP was not rebuilt for an audit-only change. Production tests were not rerun because production code was unchanged; the isolated benchmark asserted equivalent RMS values, decoded output samples and mix reports.
