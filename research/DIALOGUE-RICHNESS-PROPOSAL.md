# Dialogue richness — separate QA/QC step

2026-09-11. **Implementation approved and built** following Dan’s “build it in”. Real Premiere and listening acceptance remain pending. Dan scrapped the integrated Voice Polish ideas and asked for richness as a separate step/button, informed by r/audioengineering. Existing psychoacoustic bass stays separate. The research and original proposal below are retained for context; the implementation section is authoritative.

## Implemented review

The panel adds Dialogue richness → Amount (25 default) → Generate review → Before/After → Accept/Reject. Select 1–20 clips explicitly. This action runs independently of cleanup and bass enhancement.

Each clip is exported in isolation with existing clip processing baked in. A required user acknowledgement confirms neutral track/master effects, levels, pan and automation; the host mixer is not automatically inspected. The service adds a small filtered saturation residual: 120–1600 Hz source band, biased tanh minus its linear term, 100–2600 Hz output band, bounded parallel layer, 4x oversampling with contextual chunks. Before/After share a fixed active-speech mask for RMS matching. If measured peaks exceed the permitted ceiling, the layer is backed off; an already overloaded input is rejected. Supported rates are 44.1/48/96 kHz, mono/stereo, up to ten minutes per clip. No additional model, GPU or library is required. Perceptual quality and production throughput remain unmeasured.

QA happens in a **separate review sequence**, with one appended candidate track per selected clip. Candidates start disabled. Before/After switches selected source/candidate clips only; other audio remains unchanged. Accept leaves candidates audible in that review sequence. Reject returns to the starting sequence and retains review copies and WAVs. This provides safe recovery even after a user edits the review, and avoids destructive rollback. Both sequences and permanent media remain available. Repeated processing of result files is blocked; change Amount from the preserved pre-richness source.

Source/review signatures include clip structure, effects/keyframes and sequence ranges. Cancellation or detected edits stop preparation; pending local storage records allow Reject after a reload. Completed export scratch sequences are removed; possibly running exports retain their sequence/file. Reports record DSP version, Amount, matching gain, RMS/peak measurements and output paths. Accepted reports persist locally and are available to Copy report in the current panel session.

Validation: 128 JavaScript tests, 119 Python tests; browser approximation checked at compact sizes. Native Premiere insertion, Before/After switching and audible quality still require a listening test. RMS matching reduces level bias but does not guarantee equal perceived loudness. No changes were made to the separate low-end DSP or neural cleanup chain.

## Research findings

Several r/audioengineering discussions suggest subtle saturation or a filtered parallel saturation layer for vocal thickness and density. In the thin-midrange thread, suggestions include blending a processed duplicate, but the original poster also reports that stronger parallel processing sounded ugly. This is practitioner experience, largely about singing, not proof it improves production dialogue. [Thin vocal / midrange discussion](https://www.reddit.com/r/audioengineering/comments/uwusfu/), [Reasons for vocal saturation](https://www.reddit.com/r/audioengineering/comments/f5a2ci/).

A training-video narration discussion recommends only a small amount of saturation for consistency. Another voice-over discussion recommends backing off saturation for a more natural result. These support auditioning a subtle effect, not applying it universally. [Repeatable narration](https://www.reddit.com/r/audioengineering/comments/11s5kep/), [Natural voice-over tone](https://www.reddit.com/r/audioengineering/comments/1exdjua/).

Search-indexed thread text was available; direct requests to some Reddit thread pages failed. This was a targeted sample, not an exhaustive subreddit review or established consensus.

For the underlying implementation concept, a manufacturer's documentation describes band-specific saturation, dry/wet mix and tone controls. Use that as evidence for the technique, not a requirement to purchase or embed the commercial plugin. [FabFilter Saturn band controls](https://www.fabfilter.com/help/saturn/using/bandcontrols).

## Recommended first candidate

**Subtle, band-limited parallel saturation.** Retain the input dialogue and blend a carefully filtered, gently saturated version into it. Aim for fuller body and harmonic texture at equal perceived level. Unlike the existing low-end module's rectification of sub-200 Hz material, experiment with a broader voice-body band. The useful bandwidth and blend must be selected through listening across speakers; no fixed gender-based EQ recipe.

Prototype several low drive/blend settings, with the added layer's upper frequencies constrained to avoid emphasizing sibilance. Match before/after speech loudness. Use oversampling/anti-alias filtering and verified latency compensation; bypass must preserve timing, and the parallel path must not produce unintended phase cancellation. Avoid adding DC or artificial noise. Keep the original performance, words and pitch intact.

Start with saturation alone so QA can attribute any improvement to one treatment. Parallel compression is a possible separate experiment if saturation does not add useful density, not an automatically included processor. Do not revive the rejected multi-stage polish chain under a new label. Saturation cannot be assumed to reconstruct missing low-frequency information or repair a damaged recording.

This candidate is local CPU DSP, requiring no additional neural model or GPU allocation. Runtime, RAM and actual quality remain unmeasured.

## Separate button and review workflow

Proposed button: **Dialogue richness**, near the existing repair/enhancement tools, not inside Clean audio. Select dialogue clips explicitly; do not run automatically after cleanup or as part of bass enhancement. Suggested use is after cleanup/bass audition and before final music QA, while keeping the action independently available.

1. Select dialogue and click Dialogue richness. Start with one conservative Amount control.
2. Generate a candidate without changing the accepted timeline audio. Record exact source/range, settings, DSP version, gain compensation and output file.
3. Audition Before/After at matched loudness. A proposed alternate Richness track starts muted; audition switching must ensure only one version is audible and restore previous states on cancel. Host implementation needs validation before promising native A/B behavior.
4. Accept only after listening. Preserve the input and timing, switch only the selected clip versions, and retain permanent output media. Do not mute an entire track containing unrelated clips.
5. Reject restores the previous audible state. Reruns regenerate from the recorded pre-richness input rather than stacking saturation on an earlier result.

The QA report should include source/output references, applied amount, loudness/peak measurements and whether the result was accepted. Keep speaker identity, intelligibility, silence, stereo/mono behavior and clip boundaries in the acceptance checks. Verify cancellation and recovery independently before timeline insertion; do not assume an existing overwrite helper is safe simply because it is already used elsewhere.

## First approval to request

Create local, loudness-matched listening examples on representative dialogue, comparing untreated input, existing bass alone, richness alone and bass plus richness. Include subtle settings and an obvious upper-bound example to locate the point where texture becomes distortion. Judge both in solo and under the actual music bed, on headphones and ordinary speakers.

No production button, bulk timeline edits, model downloads or broad processing chain should be implemented until the sound direction is approved. A pleasing result across varied real voices is the gate, not a claim that saturation always improves speech.
