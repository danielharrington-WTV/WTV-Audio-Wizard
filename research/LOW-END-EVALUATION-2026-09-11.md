# Enhance low end evaluation — 2026-09-11

Evaluation only; no production code changed. Latest HANDOFF records removal of Dialogue richness; this review does not propose reinstating it. Fixes below are recommendations requiring approval, not accepted work.

## Assessment

The current effect can add subtle upper-bass/body harmonics when low-frequency voice energy is already present. It is not a general reconstruction of missing bass, and its effect falls sharply with pitch. Workflow defects should be fixed before increasing its strength or relying on it in a finished sequence.

Signal path: low-pass at 200 Hz, full-wave rectification, DC removal, harmonic band-pass at 100–400 Hz, low-band envelope multiplication, clip-wide normalization of the added layer to 20 dB below the filtered input RMS. The dry signal remains in the sum. CPU-only, no extra GPU model. Six existing DSP tests pass, covering silence, a low tone, high-frequency bypass, independent channels, dtype/shape and numerical noise.

Generating upper harmonics from existing bass is an established technique; see the manufacturer's [MaxxBass manual](https://www.waves.com/1lib/pdf/plugins/maxxbass.pdf). This supports the general concept, not equivalence to the commercial algorithm or proof that this implementation improves dialogue. The implementation comments overstate its ability to help a recording that never captured the needed low-frequency content. An even-harmonic-only tone also does not establish perceptual recovery of the original fundamental; listening tests are necessary.

## Confirmed or directly identifiable workflow issues

1. **P1 — Clean dialogue tracking is lost.** `plugin/main.js:469` records the result but never adds successful enhanced output paths to `context.dialoguePaths`. `music-pass.js:39` discovers Clean dialogue by those paths, and Fix a pop uses that identity as well. Enhancing cleaned dialogue can make later music ducking omit those clips (or reject when all reference clips were replaced) and prevent pop repair from finding them. Proposed fix: return original/output identity and update matching cleanup context paths for each successful replacement, including partial batches; do not indiscriminately classify arbitrary enhanced clips as dialogue.

2. **P1 — Cancellation does not stop placement after export.** `plugin/lowend.js:88` checks while waiting for export; there are no checks through upload, processing, download, import or overwrite. A injected cancellation during `/v1/lowend` still reached successful overwrite in the host fixture. Conversely, cancellation while exporting enters `finally` at line 159 and deletes the render sequence and scratch file, even though Premiere may still be writing. The timeout message claiming the sequence is retained contradicts this cleanup. Proposed fix: check after each awaited stage and immediately before mutations, track export completion, retain possibly running exports, propagate cancellation distinctly and preserve partial-batch results.

3. **P1 — Timeline guard and recovery are incomplete.** `plugin/lowend.js:18` snapshots source ID, timeline bounds, enable/mute only; it omits source in/out, speed changes, clip effects/keyframes, video/link state and active project/sequence. A source-trim change during service processing still passed the guard and reached overwrite in the fixture. At line 148, rollback re-inserts only the original project item, not the original timeline clip's trims, effects or links, and declares restoration without verifying it. It can restore the wrong source range/length. Proposed fix: robust identity/state validation and a demonstrably reversible placement strategy; stop the batch after a mutation/verification failure. Do not claim native exact rollback until verified against Premiere.

4. **P1 — Mixer processing can be baked and applied again.** The isolated sequence export includes track/master routing and processing; the returned file is placed back on the same track. Non-neutral mixer effects, gain or pan can therefore be applied again. Clip processing is baked and its editable settings/linkage are not preserved by inserting a fresh project item. Proposed fix: define and validate supported routing, block or clearly require neutral mixer state until a safe render strategy is established, and make the flattening behavior explicit. This is a code-path concern requiring native verification, not a measured Premiere result.

5. **P2 — Download lacks verification.** `plugin/lowend.js:114` saves and imports returned bytes without calling `inspectWav` on them. An empty download reached the overwrite path in the fixture (its import stub accepts files; this is not evidence real Premiere would import an empty WAV). Result assets can also leak on download failure because deletion is not in a finally block. Proposed fix: validate downloaded format, channels, sample rate, finite samples and duration before import; reliably clean temporary assets.

6. **P2 — Bypass is reported as enhancement and still replaces media.** The service can return `applied:false`; the panel nevertheless renders, imports, overwrites and counts it as success. Reruns are allowed to accumulate the effect on prior output. Proposed fix: skip placement for unchanged output, distinguish skipped from enhanced, and expose a controlled amount/source-based retry behavior.

## DSP measurements and limitations

Synthetic two-second mono sine waves, 48 kHz, peak amplitude 0.05. Added-layer RMS relative to input:

| Input frequency | Added layer | Applied |
|---|---:|---|
| 60 Hz | −20.00 dB | Yes |
| 100 Hz | −20.03 dB | Yes |
| 150 Hz | −20.83 dB | Yes |
| 200 Hz | −26.02 dB | Yes |
| 250 Hz | −36.82 dB | Yes |
| 300 Hz | None | No |

This explains why some lower-pitched voices may gain body while higher-pitched or heavily high-passed dialogue changes very little. Actual speech contains multiple harmonics/noise and must be auditioned separately; this is not a speaker-quality ranking.

**P2 — No peak protection or level matching:** a 100 Hz sine with peak 0.99 produced peak **1.09118** (about +0.76 dBFS). FLOAT WAV preserves above-full-scale samples, so this is not necessarily clipping inside the saved file; it creates clipping risk on later playback/conversion. The normal pipeline's peak handling is bypassed by this standalone endpoint. Add linked-channel peak protection and useful before/after level/peak reporting. Use matched-level audition to assess the effect rather than simply preferring the louder version.

**Level-dependent activation:** a 100 Hz tone at amplitude 0.005 applies; 0.002 and 0.001 bypass. Both low-band RMS and `harmonic * envelope` RMS use the same `1e-6` threshold even though the product scales quadratically with input level. Clip-wide normalization also means pauses and loud syllables affect the whole clip's result. No voice/noise classifier distinguishes a fundamental from hum, rumble or a pop. The envelope alone does not establish the documentation's claim that non-voice material is excluded.

**Repeated passes:** the same 100 Hz amplitude-0.05 tone peaks at 0.05511 after one pass, 0.080997 after five and 0.12462 after ten. Total RMS change after ten passes is +3.61 dB. Repeated application is cumulative and not a reliable substitute for an Amount control.

**Secondary robustness:** arrays of 27 samples or fewer fail filter padding; valid uploaded very short audio can therefore produce an unhandled service error. The endpoint checks source existence outside its pin lock and lacks failure cleanup for partial result files. It processes whole channels with several float64 intermediate arrays and hashes using `read_bytes`; bounded processing/streaming hashes would help long clips. Host snapshot also rereads the full inventory once per track; inventory should be read once per snapshot. Profile these after correctness work.

## Evidence and next work

- Existing targeted suite: **9 JavaScript + 6 Python tests pass**. These do not cover the failing paths above.
- `../../work/evaluate-lowend.cjs`: reproduces cancelled processing proceeding to overwrite, render cancellation deleting scratch state, changed trim escaping the guard, and empty download reaching import/placement. Uses existing host mocks; no real Premiere actions.
- `../../work/evaluate-lowend-dsp.py`: reproducible pitch/level/peak measurements against the real DSP.
- No real dialogue audition or native Premiere acceptance was performed in this evaluation.

Recommended order: dialogue identity tracking; cancellation/export safety; timeline guard/recovery and mixer handling; output verification and peak safety; then tune pitch coverage/amount using matched-level dialogue listening. Approve each proposed change separately before implementation.
