# WTVAudioWizard — Feature Planning

Ideas and design notes for features that are approved in concept but not yet
implemented. Each entry should carry enough detail to pick up cold later.
When a feature moves into active development, promote its notes into
HANDOFF.md's session log and remove (or mark done) the entry here.

---

## Audit bad dialogue (new panel step)

Status: planned, not started. Added 2026-09-21.

### Goal
A new, standalone panel step that scans dialogue clips for likely problem
spots — clipping, harsh sibilance, dropouts/silence, excessive noise floor,
leftover plosives — and surfaces them as sequence markers plus a reviewable
list in the panel, so problem clips can be found without scrubbing the whole
episode by ear.

### Decisions locked in (2026-09-21)
- This is its **own step** (its own button/phase), not folded into Verify
  loudness.
- **No clip/bin coloring.** Confirmed via Adobe's docs and community threads
  that `TrackItem` (the timeline clip instance) has no color/label API in
  either the UXP `premierepro` module or the legacy ExtendScript API — only
  `name`, `disabled`, `start`/`end`/`inPoint`/`outPoint`, `components`,
  `mediaType`, `matchName`. A `ProjectItem` (bin item) does support a label
  color, but that colors *every* timeline instance of that source file
  project-wide, not just the flagged instance — ruled out as misleading.
  **Markers are the only per-instance visual flag available** — same
  approach as Verify loudness's existing peak markers.
- Runs on **whatever clips are selected**, regardless of content — no
  requirement that they be Clean dialogue output. The user is expected to
  target cleaned dialogue in practice, but the feature itself doesn't
  gate on it.

### Detection signals
Reuse before building new:
- Peak-over-threshold / clipping — already exists in `loudness-meter.js`'s
  `createMeter()` (`peakFlagDbfs`, `mergeSeconds`, event merging). Reusable
  as-is for this audit's "clipping" flag type.
- Loudness stats per clip — already produced by the BS.1770 pass.

New signals to add:
- **Noise floor / bleed check** — measure RMS during detected silence gaps
  vs. speech segments per clip; flag when "silence" isn't actually silent
  (hum, hiss, room tone spikes, mic bleed).
- **Dropout/silence detector** — contiguous near-zero-sample runs inside a
  clip that aren't at its head/tail (excludes normal lead-in/lead-out
  silence). Catches a mic cutting out or an over-aggressive de-click hole.
- **Harshness/sibilance flag** — energy concentration in the ~4–9 kHz band
  relative to the rest of the spectrum, flagged when a clip's ratio spikes
  well above the episode's median. Can reuse FFT/band-analysis machinery
  already built for the low-end enhancer.
- Stretch/optional: **leftover plosive/pop residue** — re-run `deplosive.js`'s
  existing pop-detection heuristic in report-only mode (no repair applied),
  doubling it as an audit signal.

### Scoring
- Each clip gets multiple scores (peak dBFS, noise-floor delta, sibilance
  ratio, dropout count), not one pass/fail — "bad" is contextual (a
  whispered line and a shouted line have different healthy ranges).
- Configurable thresholds per signal, same settings pattern as Verify
  loudness's `peakFlagDbfs`/`mergeSeconds` (persisted via `defaults.json` +
  `settings-file.js`).
- Nearby flags on the same clip merge within a configurable window, same
  pattern as existing peak-event merging, so one bad stretch doesn't produce
  a cluster of overlapping markers.

### Output
- Sequence markers, reusing the `placePeakMarkers` pattern in
  `loudness-pass.js` (`ppro.Markers`, stale-marker cleanup by prefix on
  rerun). New prefix, e.g. `WTV audit:`, named with the specific reason
  ("clipping -3.1dB", "possible dropout", "harsh sibilance").
  - Open question: whether `ppro.Markers`' `createAddMarkerAction` supports
    a color argument distinct from marker type — needs a quick check against
    the Markers API before assuming per-reason marker colors are available;
    fall back to distinct marker names/comments if not.
- Panel: a results list (clip name, timecode, reason, severity) — expand on
  Verify loudness's existing top-N status-text summary into a real
  navigable list, since a full episode could produce more flags than fit in
  a status line. Clicking an entry should move the playhead/selection to
  that clip.

### Performance approach
- Piggyback on audio data already being decoded/exported during Prepare's
  per-clip WAV export (or the full-sequence dialogue reference render)
  rather than triggering a second full render — all the signals above are
  analysis-layer work on audio already in hand, not new Premiere export
  calls.

### Open items before implementation
- Confirm `ppro.Markers` marker-color support (spike/read-only check).
- Threshold tuning needs real episode material, same as attack/release
  defaults were tuned earlier — plan to tune against a couple of Dan's real
  timelines rather than guessing defaults.
- Decide exact set of v1 signal types (clipping + noise floor + dropout are
  the safe core; sibilance and plosive-residue could ship in a v1.1 if they
  need more tuning time).
