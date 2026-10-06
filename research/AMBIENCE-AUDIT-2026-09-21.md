# Ambience workflow audit — 2026-09-21

Audit only; no production processing changes. Read current handoff and UXP-QUIRKS. Latest default is -18 dBFS in the panel; persisted settings retain their existing targets. Service API default remains -30, but panel explicitly submits its target, so that difference does not override the UI.

## Findings

1. **P1: overlapping selected clips overwrite earlier extracted ambience.** extract-ambience.js:151 uses one destination track for all source tracks and overwrite for every subsequent result. Verification excludes the whole destination track (159-161), so earlier generated clips are unprotected. Existing mock reproduction: two clips on different source tracks at identical times return succeeded=2 but leave one output clip. Fix: allocate non-overlapping destination lanes (or separate lane per source), and verify all previously placed outputs after each insertion. Do not flatten overlaps through overwrite.

2. **P1: batch continues after unsafe placement failures.** extract-ambience.js:161 detects unexpected modifications only AFTER edits; line 200 catches every error and continues, including placement/verification errors. No rollback/muting occurs. main.js success summary still says Originals untouched even with such failures. Fix: distinguish harmless pre-edit eligibility failures from post-edit failures; stop immediately on uncertain/failed mutations, attempt verified rollback, and report partial state accurately.

3. **P2: placement verification misses duration, and frame-grid handling is absent.** extract-ambience.js:156 checks source/start/enabled only, never end or coverage. A four-second test export is inserted as one second by the existing mock and is reported successful. This is a demonstrated verifier gap, not a claim that native Premiere always truncates to one second. Known native frame-flooring makes this consequential: export/placement uses raw start/end, no shared frame-cover geometry, and only four-sample start tolerance. Fix: reuse current per-clip export/placement geometry, explicit media in/out, and verify coverage/end plus prior stems.

4. **P2: ambience-only level depends on unused dialogue.** app.py leaves raw mixture as dialogue for standalone extraction; audio.py:69-77 sums all internal stems and applies that mix's peak attenuation to every exported stem. Controlled test with identical ambience/target: silent raw => 0 dB extra attenuation; full-scale raw => -2.629 dB. The source-dependent attenuation is therefore real even though only effects is downloaded. Optional ambience in dialogue cleanup has the same shared-level coupling. Fix: define standalone output protection independently of unused raw dialogue; retain protection without tying it to an undelivered mix. Note -18 is an active-RMS target with max-boost limiting, not a guaranteed peak or LUFS value.

5. **P2: cancellation/export failure deletes resources while export may still be running.** extract-ambience.js:166-169 unconditionally deletes the render clone and scratch WAV in finally. Encoder acceptance can return before render finishes; cancellation/timeout can reach this block before WAV verification. Fix: retain render/file until completion is confirmed, cancel safely where supported, and give recovery instructions for retained scratch resources.

6. **P2: standalone path misses documented nested/multicam clone discovery.** extract-ambience.js:56-59 only diffs getSequences/listSequences. UXP-QUIRKS documents unlisted clones and the project-bin discovery fallback already used by Prepare. This path can fail and leave an unidentified clone. Reuse shared clone identification.

## Secondary observations

- snapshot() calls complete inventory once per track: unnecessary repeated full-sequence reads (quadratic with track count); call inventory once and filter.
- Export waits use the legacy event grace then full-file polling, unlike improved Step 1 bounded verification. Long WAVs magnify memory and polling overhead.
- Upload cleanup for non-reused jobs is ineffective: asset DELETE rejects references held by JOBS; job DELETE only requests cancellation, not record deletion. This is shared service retention behavior, not a guaranteed permanent leak; any pruning policy must be considered separately.
- When Also duck extracted ambience is checked, standalone extraction detects activity in the raw mixture (enhancer none), not the chosen Duck against tracks. Background itself may drive attenuation. Clarify/disable that inherited option or provide an explicit reference.
- New default -18 is sent by the panel; old remembered -30 remains until reset. Direct API clients still default to -30.

## Evidence and recommended order

9/9 existing extract-ambience tests pass, despite overlap and duration reproductions. Audit script: workspace work/audit-ambience.cjs. DSP reproduction directly called service.audio.mix with synthetic 48 kHz signals. No native timeline mutations or model inference performed.

Implement overlap-safe placement and fatal-failure handling first, then frame coverage and independent level protection, then export lifecycle/nested sequence parity and performance. Add regressions for overlaps across tracks, end/coverage mismatch, mid-apply failures, cancellation during export, and ambience gain invariance to unused dialogue.
