# WTVAudioWizard v0.7.1 workflow review

**Implementation status after the review:** Item 1 was approved with exactly two choices, **Clean dialogue** (default) and **Choose tracks**, and is now implemented. Items 2 and 3 were approved together on 2026-09-10 (same file/function, both pure correctness fixes) and are now also implemented. Current JS suite: 107 passing. Findings 4-9 and all optimizations remain pending individual approval. The findings and original counts below describe the pre-patch review. Line numbers may have shifted. The reproduction script covers items 1-3 as fixed and reproduces the remaining six scenarios (see its own note on this below). See HANDOFF.md for the exact continuation checkpoint.


Reviewed the updated HANDOFF.md and current plugin/service code on 2026-09-10. This is a review, not a production patch. No Premiere project, plugin source, model settings or packaged release was changed.

The architecture remains sensible: preserve the original sequence, clean raw dialogue with GAP-URGENet/MossFormer, run Bandit only for requested stems, and apply native music gain separately. The main problems are at the boundaries between those steps and in recovery from edits, Undo and cancellation.

Validation: **94 Python tests passed** in the existing Python 3.12 service environment; **93 JavaScript tests passed**. Two existing Python deprecation warnings remain. This resolves the handoff's uncertainty about the substitute Python 3.10 environment. Nine additional review scenarios reproduced the problems below using the existing host fixtures and unchanged production modules. These are mock-host reproductions, not live Premiere acceptance tests.

Reproduction script: `../../work/workflow-review-repros.cjs`, run from this product directory with `node ../../work/workflow-review-repros.cjs`. It asserts that the current defects are present; it is evidence for this review, not a regression suite whose green result means the defects are fixed.

## Findings, in recommended repair order

### 1. P1 — Music dialogue selection conflicts with the normal cleanup workflow

Locations: `plugin/music-pass.js:19,49`; `plugin/per-clip.js:176,235`; `plugin/main.js:168`.

The music pass only considers enabled, unmuted dialogue on A1/A2. Cleanup mutes processed raw lanes and places clean dialogue after the occupied tracks. With raw dialogue on A1/A2 and music on A3, the clean dialogue ends up on A4/A5; step 4 then reports no dialogue. A music clip on A2 is also rejected even when it was deliberately left out of cleanup. The panel instructs the user to proceed directly from Add clean tracks to Conform & duck music without explaining this layout requirement.

Reproduced: clean dialogue on A4 with muted raw A1 is ignored and collection fails.

The handoff explicitly records Dan's preference for A1/A2 as a way to use dialogue that WTV did not create. Preserve that capability. Add an explicit dialogue reference choice showing actual track names: **A1/A2**, **inserted clean dialogue**, or **chosen dialogue tracks**. Validate that the chosen reference is audible before starting analysis, and display the choice beside step 4. Do not silently unmute raw audio to satisfy the positional rule.

### 2. P1 — Fix a pop compares string times alphabetically — FIXED 2026-09-10, approved together with item 3

Location (pre-patch): `plugin/deplosive.js:30`.

Premiere's `TickTime.ticks` is a string. Comparing two such values with `<` or `>=` orders their text, not their numeric time. For a clip spanning 1–4 seconds and a playhead at 2 seconds, `"508032000000" >= "1016064000000"` is true, so the in-range playhead is rejected. Depending on the values, an out-of-range clip can also be admitted.

Reproduced by changing only the test fixture's ticks to the documented string representation. The current pop tests return numeric ticks, hiding this defect.

Use the numeric seconds property for containment, or an exact supported numeric tick comparison. Update the fixture and test clips across digit-length boundaries. Adobe reference: [TickTime](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/ticktime).

**Fix applied:** `locate()`'s containment check now compares `playhead.seconds`/`entry.start.seconds`/`entry.end.seconds` (numeric), matching every other ordering comparison already in this codebase (`music-pass.js`). `tests/deplosive.test.cjs`'s `tick()` fixture now always produces string `ticks` (not just for one transformed case), so this class of bug can't be hidden by the fixture again. New regression test uses the review's own 1-4s/playhead-2s digit-length-boundary example. `../../work/workflow-review-repros.cjs`'s check 1 now confirms the fix instead of reproducing the bug.

### 3. P1 — Fix a pop sends the wrong seed for trimmed dialogue — FIXED 2026-09-10, approved together with item 2

Locations (pre-patch): `plugin/deplosive.js:40,84,125`; `service/deplosive.py:156`.

The plugin renders only the target clip's timeline range, producing a WAV that starts at local time zero. It nevertheless adds the original media in-point to the playhead offset when sending the repair timestamp.

Reproduced: a four-second clip starting at timeline 1 second, with source in-point 10 seconds and playhead 2.2 seconds, sends **11.2 seconds** for a **4-second WAV**. The correct rendered-file offset is **1.2 seconds**. The service rejects an out-of-range seed; with a smaller in-point it can attenuate the wrong audio instead. The existing test explicitly asserts the incorrect 11.2-second value.

Use `playhead.seconds - entry.start.seconds` for the isolated render. Keep timeline time separately for the user-facing report. See Adobe's [EncoderManager exportSequence API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager); this code exports the sequence in/out range with `exportFull=false`.

**Fix applied:** `locate()` now computes `seedSeconds = playhead.seconds - entry.start.seconds` (no in-point addition) for the `/v1/deplosive` call; `run()` keeps `playheadSeconds` (timeline-relative, unchanged) for the status message and the fixed clip's new name, and shifts the service's rendered-file-relative `report.seed_seconds`/`start_seconds`/`end_seconds`/per-channel times back to timeline-relative (`+ entry.start.seconds`) before returning, so the whole user-facing report (shown via `main.js`'s `say()`) is internally consistent and matches the timeline position the user actually parked at, not an internal rendering detail. `tests/deplosive.test.cjs`'s seed test now asserts the correct 1.2s value and that the returned report round-trips back to the timeline-relative 2.2s. `../../work/workflow-review-repros.cjs`'s check 2 now confirms the fix instead of reproducing the bug.

### 4. P1 — Music reruns can lose ownership and stack ducking effects

Locations: `plugin/music-pass.js:83,101,115`.

`stillOwnsEffects()` treats an effect missing from its old index as if the effect had been removed. It then discards the entire ownership record. Inserting or moving another effect ahead of WTV Amplify changes that index while leaving WTV Amplify present. The next pass treats the old automation as part of the original music and appends another Amplify. Losing one recorded effect in a multi-clip selection likewise discards ownership for all clips.

Reproduced: run once, insert a user effect before WTV Amplify, rerun. Two Amplify effects remain, including the previous WTV automation. The mock analysis accepts the pass; a real render may pass or fail calibration depending on the signal, but ownership has already been discarded. If it proceeds, baseline correction does not reliably remove the old time-varying duck curve.

Reconcile each clip and its owned effect independently. Only clear ownership after positively establishing removal of all relevant owned effects. Preserve the record and stop on ambiguity. Never infer removal solely from a changed component index.

### 5. P1 — Reusing a muted empty track inserts silent clean dialogue

Locations: `plugin/per-clip.js:126,225,235`.

The new trailing-empty-track reuse preserves the destination's mute state. Apply verifies placement and mutes the raw track, but never makes the reused clean track audible. This is especially plausible with existing templates and previously muted lanes.

Reproduced: append an empty muted track, run selected-dialogue cleanup, then apply. `context.applied` becomes true, the destination contains clean dialogue, and it remains muted.

Explicitly establish and read back intended destination mute states before reporting success. Include those changes in failure recovery. Empty tracks can also have non-neutral processing/routing; either validate their suitability or use fresh lanes when they are not appropriate.

### 6. P1 — Fix a pop can overwrite edits made while processing

Locations: `plugin/deplosive.js:44,145,160`.

The timeline snapshot includes source ID, timeline position, enabled state and track mute. It omits source in/out points and speed. A slip edit leaves the source ID and timeline boundaries unchanged, so it is not detected; the pending repair then replaces the editor's new source range with the previously rendered material. Clip effect changes are also absent from this guard.

Reproduced: change the source in-point during the service request. The final overwrite still executes.

Use a shared, comprehensive clip signature and validate the active target and relevant effects immediately before placement. Also verify the replacement's exact imported source ID, rather than merely checking that its source differs from the original.

### 7. P1 — Pop-fix rollback does not restore the original clip state

Locations: `plugin/deplosive.js:176–184`.

On failed placement verification, recovery overwrites the range with the original **project item**. It does not restore the timeline clip's source in/out, effects or automation, and performs no readback before saying the original clip was restored. A trimmed timeline clip can differ from the project item's current marked range; this recovery can therefore put back different audio or extend into a neighboring clip.

This is a code-path finding, not a reproduced native overwrite failure. Treat restoration as unverified until complete state matches. Prefer a host-verified undo/restoration mechanism or a repair design that retains the existing clip; prevent further automatic edits after uncertain recovery.

### 8. P2 — Pop-fix cancellation is both incomplete and overaggressive

Locations: `plugin/deplosive.js:108,118,145,192`.

Cancellation is checked only while waiting for the export. A cancel arriving during upload, DSP or download is ignored and the timeline is still overwritten. Conversely, cancel during an outstanding export unconditionally deletes the render sequence and scratch file, despite the timeout message promising to retain an active render.

Both paths reproduced. Add cancellation checks after network operations and before import/placement. Track render completion separately, as music-pass.js already does, and retain resources an unfinished exporter may still use. Clean up result assets in a finally block if downloading fails.

The full-sequence processing path also lacks the post-submission cancellation check and polling deadline already implemented in per-clip processing (`plugin/main.js:243–267`). Share that job-control implementation.

### 9. P2 — The Undo regression does not model the current music transactions

Locations: `plugin/music-pass.js:235,246`; `tests/music-pass.test.cjs:139`.

Music now commits effect insertion and keyframes separately. The Undo test removes the entire Amplify, but undoing only the latest keyframe transaction leaves the effect in place. A rerun then reports that effects/keyframes were edited and requires a fresh clone.

Reproduced the post-keyframe-Undo state in the mock host. Actual Undo stack behavior needs confirmation in Premiere. Update the tests to represent both transaction stages and provide an explicit, verified reset/update path instead of requiring repeated model cleanup.

## Useful optimizations and workflow improvements

1. **Reduce generated music keys.** `plugin/music-effects.js:40` subdivides every gain slope into 0.25 dB steps. With the now-confirmed linear normalized-dB mapping and linear interpolation, those intermediate points are mathematically redundant. A 0 → −10 → 0 dB shape currently produces approximately 81 keys per channel rather than three boundary points. Retain source-relative endpoints and validate a sparse curve with the existing rendered calibration before removing subdivision. This should reduce host calls, readback work, undo payload and keyframe-limit failures without changing the intended envelope.

2. **Inventory once per snapshot.** `plugin/deplosive.js:47` inventories the entire sequence again for every track. Hoist that call outside the track loop. With T tracks, this removes T-fold repeated full-inventory work at each guard. Consolidate shared signatures and render lifecycle helpers so pop repair does not keep diverging from music's safeguards.

3. **Resume an existing cleanup session.** Applied context and pop output paths live only in panel memory (`plugin/main.js:12,140`). Reloading the panel or changing mode loses access to music/pop finishing until another cleanup is prepared. Persist a versioned association between project/clone, imported dialogue, output folder and job manifest, then revalidate it on resume. This is a workflow improvement, not proof that saved media itself is lost.

4. **Consider native gain automation for manual pop attenuation.** The current DSP is a local gain envelope, but each click exports, uploads, downloads, imports and replaces an entire dialogue clip. A continuous full-sequence dialogue clip makes that particularly expensive. Returning a detected envelope and applying a dedicated native gain effect could preserve trims/effects and avoid replacement WAVs. Validate envelope equivalence, sample resolution, repeat repairs and Undo before adopting it.

5. **Group optional model stages across a batch.** Dialogue-only batches benefit from the resident worker already. When Bandit stems are checked, each clip runs Bandit then GAP/Moss, so the single worker changes models repeatedly. A batch-aware separation phase followed by a dialogue phase could reduce reloads while keeping only one model resident. This requires coordinated cancellation/progress and is lower priority than the correctness fixes.

6. **Bound storage and long-file memory before scaling usage.** Stage artifacts, job outputs and inputs currently accumulate; job deduplication scans history. Add an explicit cleanup policy that distinguishes disposable service cache from Premiere's permanent media. The four-times-oversampled full-mix peak array in `service/audio.py:71` is also a candidate for bounded-memory processing, but filter-boundary equivalence needs tests. These are growth limits, not reasons to weaken integrity hashes or peak protection.

7. **Report no-op pop repairs honestly.** The service can return an empty affected window while still reporting the configured maximum 16 dB reduction. The panel always says “Pop fixed” and creates a replacement. Distinguish an actual attenuation from “No repair applied at this location,” and show both timeline and rendered-file timestamps where useful.

The native component-handle and boxed-value fixes recorded as successful in the handoff should be retained. This review does not recommend reintroducing the experimental lock change associated with the reported Premiere crash, removing calibration, changing model quality settings or increasing simultaneous GPU model residency.

Before release, exercise the normal selected-dialogue workflow through step 4, cancellation during each phase, muted reused tracks, slips during processing, both music Undo stages, effect reorder/partial removal, and project/panel reopen in real Premiere. Items 2-3 (string-tick containment, trimmed-clip seed) are now fixed in mocks but likewise still need real-host confirmation, same as everything else. The current passing unit suites do not cover the remaining boundaries adequately.
