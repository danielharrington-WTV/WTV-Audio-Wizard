# Optional clip handles — feasibility plan

## Implementation update

Implemented 2026-09-21 for per-clip cleanup and its optional stems. Dan explicitly waived the pre-implementation manual-test gate below; native audition/acceptance is pending after delivery. See HANDOFF.md for scope, compatibility limits, automated evidence and remaining standalone integration. The sections below preserve the original proposal, not the current delivery status.

## Original recommendation

**Feasible for normal-speed file-backed audio, subject to a small native Premiere proof first.** Start with an off-by-default checkbox and 0.5 seconds **per side** (one extra second total when available). Keep the visible cut at its original start/end; extra processed media is available when extending trims or adding crossfades later. Do not automatically extend timeline items into adjacent clips. Allow 0-2 seconds initially and record actual available head/tail lengths separately.

This is a plan, not an implemented control. Existing frame-cover padding is not a genuine source handle: an isolated clip exported beyond its existing boundary produces silence unless the clip is extended on the scratch sequence.

## Available API evidence and unknowns

Adobe AudioClipTrackItem documents source-relative getInPoint/getOutPoint and createSetInPointAction/createSetOutPointAction, plus timeline start/end actions. ClipProjectItem provides media access; Media documents getDuration. These are sufficient building blocks in principle, but safe action ordering, audio mapping, trim limits and persistence must be proven on the installed Premiere build. Project-item in/out marks are NOT necessarily the full media boundary. Inspect Media duration rather than assuming the marked range is all available media.

Sources:
- https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/audiocliptrackitem
- https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/clipprojectitem
- https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/media

## Phase 1: isolated native proof (go/no-go)

Use a disposable sequence with a known WAV (impulses or speech spanning each cut). Clone it with the existing shared discovery helper. Disable other clips; modify only the isolated scratch clip. Verify every source in/out and timeline start/end readback. Never change the original source project's trim marks to get more media.

At normal speed, requested head H = min(0.5, sourceIn - mediaStart), tail T = min(0.5, mediaEnd - sourceOut). Clamp each side independently, do not stretch/repeat audio. Initially clamp head to sequence start as well; a later dedicated scratch timeline can translate a clip forward to recover handles before timeline zero. Source time origin must be verified for media with nonzero timecode.

Set scratch clip source bounds to sourceIn-H/sourceOut+T and timeline bounds to start-H/end+T. Export the isolated extended region. Reimport its WAV; place using media in=H and media out=H+originalDuration at the original cut position. Extend it manually afterward and confirm the hidden material is the expected original source audio, not silence, shifted content or a neighbor. Close/reopen project to confirm trims persist.

Go only if sample alignment, duration, hidden handle content and original sequence preservation pass on mono/stereo, 25/29.97 fps, clip at timeline zero and source-file boundaries. Failure means retain exact-clip export and show why handles were unavailable.

## Phase 2: processing and bookkeeping

- Extract a shared geometry helper from per-clip handling first; it must distinguish original cut, requested handles, actual handles, frame-cover padding, export origin and imported trim offsets. Do not equate padding with usable handle content.
- Extend the export input, then run GAP/MossFormer/Bandit on that whole region. Crop only the visible timeline range through source trims on imported media, not by discarding processed handles.
- Store original ticks, export ticks, actual head/tail samples, raw source bounds, rate/channels and a geometry schema version in the manifest. Reuse/caches must include export content and geometry; verify output duration against the extended export.
- A 30-minute selected clip plus handles may exceed the current selected-clip duration while still being valid rendered media. Keep selection cap at 1800 seconds, allow at most handle/padding overhead on exports, and recheck upload byte bounds.
- Wet/dry on the timeline: keep dry and processed media sample-aligned and retain the original cut. Do not automatically reveal handles on only one side of the blend.
- Processing handles can alter edge context and whole-clip normalization slightly; report this and compare the original visible region at matched settings.
- Unique output filenames remain essential for imported/locked media. Cancellation must retain unconfirmed in-flight exports.

## Phase 3: UI, coverage and rollout

Place Handles under Clean dialogue options, default off, 0.5 s each side when enabled. Save/Load and auto-remember include it; older presets default off. Report shortened/missing handles per clip. Enable for standalone ambience separately once the same geometry is shared; overlapping ambience already requires independent output lanes.

First release: ordinary file-backed normal-speed forward clips only. Explicitly report unavailable handles for nests/multicam, reversed/time-remapped clips, offline media, unsupported source-channel mapping or unresolved bounds. Add these formats only after native tests. Existing audio transitions and effect automation need special attention: expanding a clip can expose different fades/keyframe extrapolation; do not silently strip or rebuild effects to manufacture handles.

Regression matrix: no head/no tail/both available; short source; neighboring cuts and overlaps; multiple tracks; exact/off-frame boundaries; 44.1/48/96 kHz; mono/stereo; both cleanup models; Bandit; cached rerun; save/reopen; imported WAV extension; cancellation and placement failure. Require sample-position/coverage assertions and listening checks for comb filtering or clicks.

Suggested order: finish shared frame-cover geometry for standalone ambience, perform the native proof, implement export/manifest offsets, then expose the checkbox. Estimate: one focused native API investigation followed by implementation and integration tests; avoid committing to a production date before trim/handle round-trip is proven.
