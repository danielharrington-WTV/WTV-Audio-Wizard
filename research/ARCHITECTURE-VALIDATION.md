# Architecture validation

Verified September 5, 2026 against official Adobe documentation, model code and local execution.

The overall separation → optional speech enhancement → role aggregation → normalization → dialogue-triggered ducking → output protection design is sound. Three corrections change implementation: the UXP export API differs from ExtendScript; music separation stems cannot simply be relabeled dialogue/music/effects; and AV-CASS requires a video-aware job contract. Bandit v2 is now the implemented default cinematic separator.

## Premiere APIs

| Operation | Validated API | Implementation consequence |
|---|---|---|
| Clone | `Sequence.createCloneAction()` | Execute in a project transaction; it returns an action, not the new sequence. Compare sequence GUIDs before/after and require exactly one new sequence. |
| Rename | `Sequence.getProjectItem()` → `ProjectItem.createSetNameAction()` | `Sequence.name` is read-only. |
| Export | `EncoderManager.getManager()` → `exportSequence(sequence, exportType, outputFile, presetFile, exportFull)` | Replace the notes' ExtendScript `exportAsMediaDirect`. Explicitly request the full sequence. |
| Timeline placement | `SequenceEditor.getEditor(sequence)` → `createOverwriteItemAction()` or `createInsertProjectItemAction()` | Both missing operations exist. Insert can create tracks beyond the current track count. |
| Track isolation | `AudioTrack.isMuted()` / `setMute()` | Supported, but direct mute setters are distinct from transaction actions. |
| Import | `Project.importFiles()` | Returns a boolean, not imported clip handles. Resolve project items after import. |
| Timing | `Sequence.getEndTime()`, `getZeroPoint()`, `TickTime.TIME_ZERO` | Insert at sequence-relative zero; display timecode origin is a separate concern. |
| Show result | `Project.openSequence()` and `setActiveSequence()` | Open the identified clone explicitly. |

References: [Sequence](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequence), [ProjectItem](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/projectitem), [EncoderManager](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager), [SequenceEditor](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequenceeditor), [AudioTrack](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/audiotrack), [Project](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project).

The export promise returning true is not sufficient evidence of a fully written, valid WAV. Adobe documents render-complete/error/cancel/progress events. The panel uses **`plugin/export-sync.js`** to listen when `EventManager` is available, then still validates WAV bytes with stability polling as fallback. Automated event correlation remains conservative (serial exports + optional output-path match); see HANDOFF UXP backlog. [Encoder events](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager).

September 8 update: the plugin bundles six audio-only 16-bit PCM WAV presets and selects one by sequence sample rate (44.1/48/96 kHz) and channels (mono/stereo). UXP's `getPluginFolder()` and `getEntry()` resolve the packaged preset's native path for the encoder, removing the EPR picker and any dependency on a fixed Adobe install path. XML, format selection and the mocked panel handoff passed local checks; acceptance by Premiere's encoder remains unverified. Step 2 checks the exported WAV's duration, rate and channels before processing. [Plugin folder API](https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-js/modules/uxp/persistent-file-storage/file-system-provider), [folder entry API](https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-js/modules/uxp/persistent-file-storage/folder).

Version 0.4.0 preserves raw audio and adds Clean dialogue, Ambience and Music groups below it in a clone. Per-clip exports use isolated render copies and sequential Bandit ambience/music jobs and raw-audio dialogue jobs using MossFormer2 or GAP-URGENet. Each source lane gets a separate lane per stem group. The first clip creates a new track with `createInsertProjectItemAction`; subsequent clips use `createOverwriteItemAction` only on that new track. Readback checks raw/video structure and exact added clip boundaries. Raw audio/video links remain intact; added stem linking remains manual. See `PER-CLIP-MODE.md` for the installed-host acceptance pass, which is still outstanding.

The guard now also checks source in/out, disabled state, speed and reversal, in addition to clone identity, source IDs, timeline positions, names, duration and track mute states. It does not detect every effect/keyframe change. Keep the clone and render copies unchanged until processing finishes.

Per-track export remains a later mode. Muting individual tracks is documented, but submix sends, master compressors/limiters, external sidechains, solo states, nested sequences and track channel layouts require in-host tests. Independently rendered tracks do not necessarily sum to the original master when nonlinear bus processing is involved. Normalize and duck after aggregating each semantic role across inputs, rather than separately normalizing every input track and accidentally boosting the combined dialogue.

## Models and GPU evidence

| Model | What is established | GPU conclusion |
|---|---|---|
| Bandit v2 multilingual | Official 48 kHz configuration, mono input; strict checkpoint load succeeded; 37,022,688 parameters in the loaded model. | **RTX 5080 16 GB works in the tested configuration.** Peak PyTorch allocated 1,022 MiB; reserved 1,584 MiB. |
| AV-CASS | CUDA-based released launcher, one-GPU default, NCCL; visual and audio-only checkpoints are different workflows. | **Minimum VRAM unknown.** No official inference-memory minimum found in the paper, README or launch configuration checked. Not measured locally. |

Bandit measurement: 10 seconds of synthetic 48 kHz stereo audio, each channel processed independently, batch size 1, 8-second windows, 1-second hop, float32 model execution, CPU overlap-add. Runner elapsed 26.71 seconds after imports, including model loading and output writing. PyTorch 2.11.0+cu128, NVIDIA driver 610.88, RTX 5080 with 16,303 MiB reported VRAM. The 1.55 GiB reserved figure is the PyTorch allocator's peak, not total board usage including CUDA context, display and Premiere. It is not a minimum GPU specification or a quality/speed guarantee for all input lengths and settings. Full audio stays off GPU, so longer duration primarily increases CPU RAM and runtime in this adapter. Raw measurement: `validation/bandit-rtx5080.json`.

The v2 checkpoint is 446,680,129 bytes (about 447 MB on disk). Download size is not VRAM usage. Its published MD5 matched `fea2868787551b0cff36cfcf7c3622a3`; local SHA-256 is pinned in configuration. The original BandIt v1 repository's RTX 3090 benchmarks are not v2 requirements and were not used to size this build. [Official v2 repository](https://github.com/kwatcharasupat/bandit-v2), [official checkpoints](https://zenodo.org/records/12701995).

Bandit's example inference script resamples input to the model rate but writes estimates with the original input sample-rate variable. Our adapter writes native estimates at 48 kHz, then the service converts to the requested rate and checks exact output sample count. A real 44.1 kHz → model → 44.1 kHz service test passed. [Upstream runner](https://github.com/kwatcharasupat/bandit-v2/blob/d5563d9031e95fdaa3e5a73d5020b9a0df61adb6/inference.py).

AV-CASS's paper uses 16 kHz mono audio and 8.192-second analysis segments, with scene and facial visual streams. Upsampling its results cannot restore the removed high-frequency content or stereo image. Its published visual processing includes 4 FPS scenes and 25 FPS faces resized to 224×224. Those quality and synchronization implications justify keeping it secondary. [Paper, including Appendix A](https://arxiv.org/html/2603.26113v1).

The AV launch script defaults to `NUM_GPUS=1` and per-process batch size 4; the README's two-GPU example is not a two-GPU minimum. Its inference code initializes NCCL, unavailable in standard native Windows PyTorch. Target a Linux GPU worker, potentially WSL2 after validation, or implement a single-process port. Start measurements at batch size 1 on the existing 16 GB GPU; this is a test configuration, not an assertion that 16 GB will fit. Do not assign an 8/12/24 GB minimum without a measured run. [Official AV launcher](https://github.com/pantheon5100/AVCASS/blob/1d3189af0d0b02545723fb140e1a8b8fbe834f8f/av_cass/bin/infer_av.sh), [PyTorch backend support](https://docs.pytorch.org/docs/2.14/distributed.html).

## Audio and service corrections

“Effects” is the canonical third stem; the panel labels it effects/ambience. It is broader than background room noise. Bandit predicts speech/music/sfx, mapped to dialogue/music/effects. A music-only separator's vocals/drums/bass/other outputs do not provide that same semantic split.

The implemented RMS mode measures 10 ms active blocks above −60 dBFS; near-silent material is not boosted without bound. Gain increases cap at 18 dB by default. LUFS mode uses pyloudnorm's integrated measurement, with silent/non-finite loudness handled explicitly. Music ducks from a cleaned/available dialogue-level envelope; in this build dialogue is separated but not enhanced. A simple threshold can trigger on separation leakage, so speech-presence detection and a lookahead/hold stage are future quality improvements.

The final prototype protection measures a 4x oversampled peak and applies common static attenuation to all stems and the mix with a −1.2 dBFS ceiling. It preserves the sum of stems. It does not claim certified −1 dBTP limiting. Target loudness can change after ducking and safety gain; measured gains are included in job results.

Local-to-remote reuse is improved by uploading media bytes and referring to asset IDs rather than local paths. However it is not only a base-URL change: remote hosting still needs UXP domain permissions, TLS, per-user auth, isolated storage, resumable transfer, a durable queue and ownership checks. Local access already requires a token; ignoring authentication locally would create an unnecessary difference in the contract.

## Remaining acceptance work

Load the panel in Premiere 26.2.2 and validate its UI, network permission/token flow, WAV export preset and new-track insertion. In particular validate the `-1` video index for audio-only placement on the installed host, auto-created audio tracks, zero time with nonzero display timecode, full duration, channel mapping, no ripple to video, mute recovery, and exports with a trailing silent region. The documented API and mock tests do not substitute for that pass.

Then test real dialogue/music/effects mixtures, stereo image and model leakage; audition the raw-input MossFormer2 and GAP-URGENet dialogue options; add per-track export and global role aggregation; implement the AV-CASS worker and profile it; replace prototype peak protection with verified mastering DSP.

Code license files identify Bandit v2 as Apache-2.0 and AVCASS as MIT. Checkpoint and visual-backbone redistribution terms need separate verification before packaging models for distribution; no commercial-use conclusion is inferred solely from repository license labels. [Bandit license](https://github.com/kwatcharasupat/bandit-v2/blob/main/LICENSE), [AVCASS license](https://github.com/pantheon5100/AVCASS/blob/public-main/LICENSE.txt).

Source snapshots: Bandit v2 `d5563d9031e95fdaa3e5a73d5020b9a0df61adb6`; AVCASS `1d3189af0d0b02545723fb140e1a8b8fbe834f8f`; Adobe samples `d34e8016dafb36e45df3066017bec13451ed36bc`.
