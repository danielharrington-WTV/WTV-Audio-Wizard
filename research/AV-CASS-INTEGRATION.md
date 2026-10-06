> **DROPPED 2026-09-21.** AV-CASS is no longer a planned option and was removed from the panel and service. Reason: in the paper's Table 8 the audio-only variant does not beat Bandit on SI-SDRi (about -2 dB per stem) or dialogue PESQ; the full model's gains depend on picture input we cannot supply. Kept for reference only.

# AV-CASS secondary worker target

Status: official source inspected and stored locally; checkpoint runtime, video preprocessing and GPU measurements are not installed or implemented. The service advertises AV-CASS as unavailable and rejects jobs rather than returning substitute stems.

Use a separate Linux worker environment. The released inference entry point is `av_cass/test_ddp_avdnr_spec_av.py`, launched by `av_cass/bin/infer_av.sh` through torchrun/NCCL. A native Windows port would need to replace that distributed startup and validate its remaining compiled dependencies. WSL2 is a candidate deployment environment, not yet tested here.

## Required assets and configuration

The official README links separate audio-only and audio-visual checkpoint downloads. The AV workflow additionally loads visual-backbone weights. The checked-in launcher defaults to `visual_encoder_type=cavp`; code also supports `talknet` and `both`. Select the encoder configuration compatible with the chosen model checkpoint and require strict loading; do not infer compatibility from the filenames. For `both`, load both CAVP and TalkNet weights.

Inputs must include synchronized audio and picture. The current public wrapper expects AVDnR-style data and annotations rather than an arbitrary video path, so it cannot be dropped behind our WAV-only API without adaptation. Build a user-media dataset adapter that does not require ground-truth stems and does not fabricate them to satisfy the training/evaluation loader.

Primary implementation references: [README and checkpoint links](https://github.com/pantheon5100/AVCASS/tree/public-main), [visual backbone code](https://github.com/pantheon5100/AVCASS/blob/public-main/av_cass/visual_backbones.py), [data layout](https://github.com/pantheon5100/AVCASS/blob/public-main/docs/DATA_LAYOUT.md).

## Planned API extension — not accepted by v0.1

Add a typed video asset and alignment object to jobs. Record sequence GUID, export revision, sequence-relative start ticks as a decimal string, audio sample count/rate, video frame rate as numerator/denominator, first-frame timestamp, frame count, and any proxy offset. Support missing-face segments explicitly. Resampling or face cropping must preserve the source timeline and cannot silently reset alignment.

Export the cloned sequence's corresponding picture once, with the same start and duration as the audio. Build facial crops and scene inputs with the chosen upstream preprocessing. Cache these by the picture content hash and preprocessing version. Do not upload video for Bandit jobs. The plugin must visibly identify AV processing because it sends picture as well as sound to a future remote worker.

The worker should return dialogue/music/effects WAVs plus native format, output sample count, any channel conversion, seed, solver steps, checkpoint hashes, preprocessing version, timing and GPU peak metrics. AV-CASS is generative: include the seed and numerical configuration in cache identity. Keep the native mono limitation visible; duplicating mono into stereo is not stereo recovery.

## GPU profiling gate

No verified minimum VRAM is currently available. Profile on the RTX 5080 first with one GPU and batch size 1, then increase batch size only if useful. Record process/board peak memory as well as PyTorch allocated/reserved memory, since visual encoders and preprocessing can allocate outside the separator's core model. Use the released solver-step setting initially; the current script defaults to 250 steps, which affects latency. Separately measure scene preprocessing, face preprocessing, separation and resampling.

Test several actual film segments: no visible speaker, multiple speakers, scene cuts, loud music, quiet speech, overlapping effects, stereo mixes and variable-frame-rate sources. Report failures rather than labeling the model ready after one successful allocation. Compare separation quality and preservation of high-frequency/stereo content against Bandit before enabling the secondary option.

Source: [pinned inference implementation](https://github.com/pantheon5100/AVCASS/blob/1d3189af0d0b02545723fb140e1a8b8fbe834f8f/av_cass/test_ddp_avdnr_spec_av.py).
