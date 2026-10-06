# Voice polish proposal — 2026-09-11

**SCRAPPED by Dan on 2026-09-11.** Do not implement the integrated polish chain, preset package or AI-restoration roadmap below. Retained only as historical context. Current direction: a separate dialogue-richness button with explicit QA/QC, researched in [DIALOGUE-RICHNESS-PROPOSAL.md](DIALOGUE-RICHNESS-PROPOSAL.md). That document is a proposal, not implementation approval.

Status: planning only. No DSP, model or UI changes approved or implemented by this document. Dan wants more appealing spoken voices, with Adobe Podcast as a listening reference, complementing the existing psychoacoustic bass feature. Continue individual approval before implementation milestones.

## Direction

Add an optional Voice polish stage after GAP-URGENet/MossFormer cleanup and before final loudness normalization/peak protection. Prioritize consistent speech level, balanced tone and controlled harshness while preserving the speaker's identity and expression.

Adobe describes Enhance Speech as AI enhancement aimed at clearer, studio-quality speech and removal of noise/echo. Its published product descriptions do not establish its exact processing architecture; this plan targets a comparable listening experience, not a reproduction of Adobe's algorithm. [Adobe overview](https://podcast.adobe.com/guides/what-is-enhance-speech).

The inspected service/audio.py applies a single normalization gain per stem, then ducking and global peak attenuation. That does not level quiet words against loud words within the same clip. The inspected service/lowend.py adds a synthesized harmonic layer derived from low-frequency content, mainly within 100–400 Hz. It can add body but does not independently solve dynamics, boxiness, sibilance or room coloration. No new listening comparison has been performed, so the priorities below are hypotheses to validate on Dan's recordings.

## Proposed processing

1. **Corrective tone shaping.** Remove sub-bass rumble when present; reduce excessive boom, boxiness and narrow resonances with bounded EQ/dynamic EQ. Use speech-only statistics and slow adaptation. Keep automatic moves conservative; do not force every speaker toward one spectrum. Starting audition limits: broad cuts around 1–3 dB, boosts no more than about 2 dB. These are prototype bounds, not fixed settings for every recording.
2. **Speech-aware leveling.** Smooth phrase-level changes with a slow gain rider, followed by gentle compression for shorter peaks. Suppress upward gain during pauses/noise and cap both boost and reduction. Start auditioning around 1.5:1–2.5:1 compression and roughly 2–4 dB reduction on louder speech, preserving emphatic delivery. Use analysis across clips belonging to the same speaker/mic where possible; avoid abrupt tone/gain changes at every edit.
3. **Separate sibilance/harshness control.** Introduce a conservative de-esser independent of the experimental combined de-click/de-ess switch. Reduce detected sibilant bands rather than darkening the entire voice. Validate consonants, breaths and bright voices to avoid lisping. Existing de-click remains off unless explicitly enabled.
4. **Small finishing EQ and optional body.** Add presence/air only where the recording benefits. Keep existing virtual bass separately adjustable and off by default inside the new stage; avoid automatically applying it again to already-enhanced audio. Excessive 100–400 Hz energy should reduce or bypass added body. Prototype zero-boost settings first so extra loudness/brightness does not masquerade as quality.
5. **Final level and peak protection.** Apply the existing project target after polish, with peak protection after every additive stage. Do not change the -12 dBFS dialogue or -28 dBFS music defaults as a side effect. Run music ducking against the final audible dialogue.

EQ, compression and de-essing are established complementary vocal processing tools, but their settings and order need auditioning for spoken production audio. [iZotope vocal-chain guidance](https://www.izotope.com/en/learn/crafting-a-basic-vocal-chain).

## User workflow

Keep the small panel: one unchecked **Voice polish** option, a **Strength** control, and a gear menu containing **Natural** (initial preset), later **Warm** and **Present** presets. Keep detailed filter parameters out of the main workflow. Strength should scale bounded processing amounts, not indiscriminately mix phase-shifted or delayed signals.

Start with a loudness-matched preview of **Clean** versus **Polished** using the same excerpt. Apply the chosen sound once as the Clean dialogue output in the existing Raw → Clean dialogue → optional Ambience/Music layout. Preserve the clean pre-polish intermediate in cache so a strength/preset change does not rerun the neural model. Do not introduce two simultaneously audible dialogue tracks.

For a later post-insertion utility, preserve the existing clean media and clip state, verify timing and use explicit versioned outputs or verified native effects. Do not build a new utility by copying an overwrite/recovery path whose safety remains unresolved. Native Premiere EQ/compressor/de-esser creation and parameter mapping require their own host validation; the successful Amplify integration does not prove those effects work through the same assumptions.

## Implementation milestones, each requiring approval

**1. Listening prototype.** Collect representative short excerpts: clean-but-thin, boomy, sibilant, reverberant, quiet/loud delivery, several speakers and recording setups. Process locally outside Premiere; compare current cleanup, cleanup+bass, and proposed polish at matched speech loudness. Include individual-stage bypasses. No new model downloads or external audio uploads. Adobe-processed references can be included if Dan supplies them or separately authorizes processing there. Deliver examples and choose the smallest chain that is consistently preferred.

**2. CPU service stage.** Add service/voice_polish.py, validated settings and structured reports; integrate before final mix/normalization. Keep inference-cache keys independent of polish controls while including polish settings/DSP version in finished-output keys. Preserve exact sample count, sample rate, channel layout and alignment. Link stereo gain detection when channels form a stereo recording; do not treat unrelated dual-mono microphones as one speaker. Exercise short clips, silence, loud transients and clip-boundary behavior. This stage adds no GPU VRAM requirement by design; CPU runtime and RAM still need measurement.

**3. Compact preview and apply UI.** Add the opt-in control and Natural preset. Implement matched preview, cancellation and safe apply; verify in real Premiere. Confirm reruns start from the recorded clean source rather than repeatedly processing previous polish. Only add Warm/Present after listening results justify them.

**4. Optional AI restoration comparison.** If DSP polish leaves thin/band-limited or damaged voices unsatisfactory, audition Resemble Enhance as an isolated candidate. Its official repository describes restoration of distortions and bandwidth extension, trained on 44.1 kHz speech. Compare raw → Resemble against GAP/Moss → polish, and only test serial neural processing as an explicit experiment. Do not assume stacking enhancers improves quality. Check speaker identity, consonants, timing, artifacts and local Windows/CUDA compatibility, checkpoint licensing, throughput and actual peak VRAM before integration. Keep one GPU model resident at a time. [Official Resemble Enhance repository](https://github.com/resemble-ai/resemble-enhance).

## Acceptance criteria

- Prefer the polished version in loudness-matched, randomized listening across varied speakers; document failures as well as wins. Similar loudness is essential to avoid simply choosing the louder clip.
- Preserve words, natural expression, breaths and speaker identity. No pumping, lisping, metallic coloration, bass buzz or emphasized room noise.
- Exact duration/alignment; finite samples; bounded gain; final peaks protected. Verify silence does not become boosted noise and disabled polish preserves the existing output path.
- Reusing a preset should sound consistent across adjacent clips from the same speaker. Mixed-speaker clips must not inherit an inappropriate speaker-specific profile.
- Measure runtime/RAM, and GPU VRAM only for the optional model experiment. Do not quote an unmeasured capacity requirement.

Recommended next approval: milestone 1, the local listening prototype. Production integration should follow demonstrated improvement, not precede it.
