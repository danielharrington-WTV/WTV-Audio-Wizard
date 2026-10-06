# Per-clip mode — v0.7.0

Each enabled (non-disabled) clip is exported from its own isolated render sequence. With "Selected dialogue clips only" checked, an explicit selection overrides a muted track — selecting clips there means "process these," so their isolated export is unmuted before rendering. Without a selection (automatic/full-track detection), muted tracks are still skipped entirely, since mute is then the only signal available to exclude tracks such as one a previous WTVAudioWizard run already muted after cleaning it. By default GAP-URGENet cleans dialogue and Bandit is skipped. Music and ambience extraction are independent opt-in checkboxes. The selected MossFormer2 or GAP-URGENet worker cleans the raw rendered audio directly; Bandit speech is discarded. The panel validates and downloads dialogue plus only the checked optional stems before allowing Apply.

Apply preserves every existing raw clip, source trim, speed, disabled state and raw audio/video link in the cloned sequence. Stem groups start on the first of any completely empty audio tracks trailing at the end of the sequence, reusing that space before creating any brand-new track beyond it; only a fully-empty *trailing* run is ever reused (never an empty track buried in the middle of otherwise-used tracks, which stays untouched). If there is no trailing empty track, it appends stem groups after all existing audio tracks exactly as before. Only the raw lanes that were processed get muted. New stems are not automatically linked to video.

With both optional stems enabled, for three existing raw tracks with A1 and A2 active and A3 muted, the resulting order is:

| Tracks | Contents |
|---|---|
| A1–A3 | Existing raw audio, now muted in the clone |
| A4–A5 | Clean dialogue from A1 and A2 |
| A6–A7 | Ambience from A1 and A2 |
| A8–A9 | Music from A1 and A2 |

Each new clip starts and ends at its source clip's timeline ticks, preserving gaps and cross-track overlaps. Source trims and speed changes are already rendered into these WAVs; their media in-point is zero. A raw clip whose boundaries don't sit on whole video frames (possible after a speed change, merged/nested clip or audio-unit slip) is handled specially, because Premiere floors a newly placed audio clip's start and duration to the sequence frame grid: its export runs one frame long and its stem is placed with the whole-frame span that covers the raw clip, so the stem may start up to one frame early and end up to one frame late (the extra is silence) but never leaves a hole. Apply verifies that every stem covers its raw clip within one audio sample and reports the actual placed ticks if it does not. New tracks are named by stem and source lane when supported; otherwise Premiere keeps its default track labels, with unchanged stem group order. Music is retained so separation does not discard it. Raw track names are preserved.

No timeline insertion begins until all outputs match duration, sample rate and channel count. Apply imports one to three WAVs per clip depending on the options, creates empty destination lanes using the first insertion, and places later clips only on those new lanes. It checks raw/video snapshots and all added clip positions. A partial failure leaves the pending clone, restores prior raw mute states and mutes added tracks where the host permits it; retries require a fresh batch. Original sequences are never edited.

`clip-batch.json` stores source IDs, original tracks/ticks, settings, job IDs, output paths and results. Completed results can reuse the service cache. Temporary render copies are removed only after successful Apply. Interrupted copies remain for inspection.

Use neutral master/track processing and no solos to avoid applying effects twice. Muted/disabled audio is skipped. Same-track overlaps require Full sequence mode. Per-clip mode strips only the transitions that actually touch a clip being processed in the pending clone (a transition sitting entirely between two other, unselected clips on the same track is left alone) so isolated exports stay reliable, records their timing, and best-effort puts matching crossfades back on the **Clean dialogue** stem lane after Apply (status reports how many restored). The original sequence is never edited. Per-clip ducking and peak protection do not coordinate simultaneous clips on other lanes. Levels are absolute RMS over active audio (LUFS is out of scope for now). There is no cap on the number of enabled clips per batch (removed 2026-09-14; was 250) — large batches (150+) are supported via the export loop's resume-on-interruption behavior (see `HANDOFF.md`). Individual clips remain capped at ten minutes for isolated export.

### 2026-09-14: transition handling scoped to the clip actually being processed

Previously, both the "Remove audio transitions on track N..." validation and the automatic strip-on-prepare step treated a transition anywhere on a track as belonging to every clip on that track. In practice this meant selecting one dialogue clip with no crossfade of its own, on a track that also happened to have a completely unrelated crossfade between two other, unselected clips, could still fail Prepare (reported as `The script object is no longer valid.`) purely because of that unrelated transition. `plugin/premiere.js`'s `stripAudioTransitions()` now only removes a transition that actually touches the timeline span of a clip in the current batch, and `plugin/per-clip.js`'s `inventory()` now reports `transitions` per clip (does a transition overlap *this* clip's own start/end) instead of "this track has any transition at all." A transition entirely between two other, unselected clips is left in place and no longer blocks or gets removed. This also fixes the same over-broad check in Fix a pop and Enhance low end, which reuse the same `inventory()`.

1. Restart the updated service and reload plugin v0.6.2. Use a short duplicate test project with two linked camera clips, a gap, reused source media with different trims, a speed-changed clip, overlapping audio on another track, and muted/disabled audio.
2. Prepare exports; wait for all Premiere renders to finish before processing. Confirm the service reports raw dialogue cleanup; separation should appear only if an optional stem is checked.
3. Apply and check Raw → Clean dialogue → Ambience → Music group order. Inspect the raw source media, trims, timing, speed, disabled state and video links. They should be unchanged; processed raw tracks should be muted only in the clone.
4. Check each added stem's exact start/end, gaps and overlaps. Audition clean dialogue, ambience and music alone and together, including crossfade boundaries, sibilants, stereo image and combined loudness.
5. Confirm the original sequence is unchanged. Save and reopen the project with the WAV output folder retained. Repeat with mono/stereo and supported sample rates.
6. Test cancellation and a changed clone before Apply. Neither should overwrite raw audio or permit applying stale results.

This installed-host acceptance pass is still outstanding; automated host mocks cover lane mapping and recovery but cannot validate Premiere's actual insert/encoder behavior.

## Selected dialogue in v0.6.2

The panel defaults to selected dialogue only. Select all audible dialogue on each chosen source track before Prepare; place music on separate unselected tracks. This preserves audible music while muting processed raw dialogue lanes. Uncheck only when every audible source clip should be cleaned. After insertion, select existing music and use step 4; see PREMIERE-MUSIC-PASS.md.
