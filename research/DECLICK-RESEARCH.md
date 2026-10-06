# De-click improvement research — 2026-09-08

## Recommendation

Keep the existing LPC/least-squares AR repair engine as the baseline and improve **which events it accepts** before changing reconstruction again. Add a review mode for ambiguous events, separate de-essing from click repair, and evaluate on multiple labelled speech recordings. A generic library replacement is not supported by the evidence collected here.

v0.6.3 restores the existing combined **De-click & de-ess · Experimental** panel option, unchecked on initial load, Reset and every reconnect. Old saved settings cannot silently enable it. The click detector and de-esser themselves are unchanged; this release does not claim the false-positive problem is fixed. The report is available under Help & repair report.

## What the sources establish

iZotope's Mouth De-click documentation distinguishes sensitivity, frequency targeting and repair widening, and explicitly warns that high sensitivity can damage plosives. Its tutorial includes previewing only the removed clicks. These support keeping event acceptance, repair extent and auditioning separate concerns; they do not reveal RX's proprietary detector or establish that our implementation matches it. [Mouth De-click documentation](https://downloads.izotope.com/docs/rx6/33-mouth-de-click/index.html), [iZotope voice-recording workflow](https://www.izotope.com/community/blog/how-to-clean-up-voice-recordings-video-podcasts).

Audacity documents false detections from overly permissive thresholds or spike widths and distinguishes broad automatic click removal from repairing explicitly selected short regions. Its generic click remover is especially suited to vinyl. This is a useful baseline, not evidence of superiority for speech. [Audacity Click Removal](https://manual.audacityteam.org/man/click_removal.html).

FFmpeg's `adeclick` is an available, reproducible AR-based comparator. It exposes window size, overlap, model order, threshold and burst fusion. Its `m=save` mode preserves samples it does not interpolate; default overlap-add can change those samples slightly. We used overlap-save for comparison to reduce that confound. [Official FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#adeclick).

## Fresh local comparison

Ran the installed FFmpeg and WTV click-repair stage on the existing 48 kHz stereo recorded-dialogue fixture, 728,728 samples (15.18 seconds). No recording was uploaded. Production de-essing was excluded from this comparison so sibilance attenuation did not masquerade as click repair. Test script: `../../work/declick-comparison.py`; raw measurements and WAVs: `validation/declick-research/`.

The known-pop vicinity was 12.0–12.3 seconds. A sample was counted changed when either channel differed by more than 1e-6; adjacent changed samples were grouped with WTV's 1.2 ms gap rule. Counts represent edited audio, not independently labelled false detections.

| Click-only processing | Changed events | Changed samples outside pop vicinity | RMS difference inside pop vicinity |
|---|---:|---:|---:|
| Current WTV detector/repair | 27 | 886 | 0.03894 |
| FFmpeg `adeclick=t=2:m=save` | 3,076 | 37,041 | 0.00475 |
| FFmpeg `adeclick=t=6:m=save` | 37 | 57 | 0.00014 |

Default-threshold FFmpeg changed far more of this recording outside the known pop. Raising its threshold greatly reduced changes but barely altered the pop region. Neither result establishes a better replacement. Difference magnitude is **not** a quality score or proof of pop removal. This is one recording without a clean reference or a new listening assessment; genuine mouth noises elsewhere may account for some edits. The old real-audio test's “sparse and not chattering” name describes a loose ceiling, not demonstrated speech transparency.

## Best next experiment

1. **Separate detection and repair.** Return candidate intervals, confidence evidence and rejection reasons before writing samples. Let the user inspect uncertain locations. Provide normal-speed before/after and a removed-signal audition; retain channel and timeline mapping already supported by the report.
2. **Improve confidence, not just sensitivity.** Prototype forward/backward prediction agreement, residual energy relative to clean context on both sides, frequency-local evidence, and persistence across overlapping analysis windows. These are proposed features to test, not established improvements. Natural plosives can also be broadband impulses; a simple spectral-flatness test is insufficient.
3. **Stop unverified repair expansion.** Current ring extension and lower-threshold companion searches follow every accepted event. Gate those extensions on independent evidence and compare with them disabled. A false initial detection should not authorize several edits on the same syllable. Cluster nearby candidates for review rather than automatically merging the whole interval into a larger repair.
4. **Separate click repair from de-essing.** The current one-checkbox pipeline also attenuates 4–9 kHz content. Independent switches and click-only evaluation would make it easier to identify whether an audible change comes from reconstruction or sibilance reduction. This requires schema/cache/UI migration and is not part of v0.6.3.
5. **Use a held-out speech set.** Label actual clicks and clean plosives, consonants, breaths, sibilance and vocal fry across multiple speakers/microphones, before and after GAP/MossFormer. Add synthetic impulses to clean speech for paired-reference tests, but keep separate real-click listening tests. Measure event precision/recall, changes outside labelled defects, speech distortion and normal-speed listening results. Split by speaker/session; do not tune and evaluate on the same 15-second clip.

A suitable release gate is an agreed low false-repair rate on clean speech plus successful removal of held-out real clicks, with audible comparisons. Fewer edits or a lower LPC residual alone should not count as success. Until then, the explicit unchecked option is appropriate, and the existing false-positive caveat remains visible when enabled.
