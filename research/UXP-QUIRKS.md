# Premiere UXP quirks, limits and roadblocks

A consolidated reference for the host (Premiere Pro UXP) behaviour WTVAudioWizard has run into. Each entry gives the symptom, the cause (or best current theory), and what the code does about it. Detail and history live in `HANDOFF.md`; file names below point at where the workaround lives. **Confirmed** = reproduced live in Dan's Premiere and/or matches Adobe's reference. **Theory** = best explanation, not proven.

Add new entries here (newest category-appropriate spot) whenever a host surprise is found, and link back from the `HANDOFF.md` entry.

## 1. Handles, objects and identity

### "The script object is no longer valid."
Generic error with several unrelated causes. Check in this order (all confirmed):
1. **Stale handle after a transaction.** Any committed transaction can invalidate previously fetched `Sequence` / `Track` / `TrackItem` handles. Never hold a handle across a transaction; re-fetch by guid (`sequenceById()`, `resolveContextSequence()` in `premiere.js` / `per-clip.js`).
2. **Speculative API method.** `item.createRemoveAudioTransitionAction()` / `createRemoveVideoTransitionAction()` do not exist on the real `AudioClipTrackItem` and produce this error. Use `SequenceEditor.createRemoveItemsAction()` on real `TRANSITION` track items (`stripAudioTransitions()`). `addAudioCrossfade()`'s add-transition path is still unconfirmed; failures are caught per boundary into `context.crossfadeReport`.
3. **Long derived names.** Sequence names become folder/file names; past Windows `MAX_PATH` (~260) this surfaced as the same error. `sanitizeSequenceName()` strips illegal characters and caps at 80 chars.
4. **Evaluating unrelated clips.** Transition removal/detection scoped to the whole track tripped it. Now scoped to per-clip adjacency (`transitionTouchesSpan()`).

If none apply, capture the exact method being called at failure before guessing a fifth cause.

### Quality review markers — implemented, native verification pending (2026-09-28)

`quality-pass.js` uses documented `Markers.getMarkers(sequence)`, `createAddMarkerAction(name, 'Comment', start, duration, comments)` and `Marker.createSetColorByIndexAction(ppro.Constants.MarkerColor.RED)`. Marker creation returns an action, not the marker. Commit, reacquire the sequence/marker collection, identify this run's names, then colour in a second transaction and verify with fresh `getColorIndex()` calls. Use the RED constant rather than an assumed numeric palette index. This path has mocked tests only; do not describe it as live-confirmed. Source/analysis sequence handles are reacquired after mutations; selected-track isolation retains mixer solos because UXP cannot enumerate/reset them reliably. Clear solos before the scan. See `research/DIALOGUE-QUALITY.md` for setup and limitations.

### Action creators return nothing
`create*Action()` / `importFiles()` don't hand back the object they create (`importFiles` returns a boolean). New sequences and project items are identified by diffing lists before/after the transaction (`cloneActive()`, `identifyNewSequence()`, `host.importIntoBin()`).

### `getTrackItems()` can contain nulls
Confirmed. Every call goes through `clipTrackItems(track, type)` in `premiere.js`, which drops falsy entries.

### `project.getSequences()` is unreliable
- Can contain **null / guid-less entries** (crashed `findSequence` at clip 115 of 158). Use `listSequences(project)`; it also tolerates the call throwing. Never call `getSequences()` directly.
- **Does not list nested sequences or multicam sources** when they are the active sequence, and does not list a clone made of one. Handling: `findSequence(project, id)` checks the list, then `getActiveSequence()`, then a cached project item; `identifyNewSequence()` falls back to diffing project bins and resolving `ClipProjectItem.getSequence()`. Confirmed for multicam source (the "clone becomes active" guess was wrong; the clone is simply unlisted).
- Nest/multicam handling has only been exercised live for Prepare (steps 1 to 3). Fix a pop, Enhance low end, Extract ambience and Duck inside a nest are unverified.

### Unlisted render clones
A render clone of a multicam source can't be found by list diff; see above. `unlistedSequenceItems` caches sequence-guid to project-item id so it can be re-fetched after later transactions.

## 2. Time and ticks

- **`TickTime.ticks` is a string.** Comparing with `<` / `>=` sorts text ("508032000000" >= "1016064000000" is true). Use the numeric `.seconds` for ordering and containment (`deplosive.js` `locate()`).
- **`TickTime.createWithTicks(ticks)` requires a string.** Passing a `Number` throws `Illegal parameter type`. Confirmed against Adobe's reference. Fixed in per-clip and `addAudioCrossfade()`; the test mock now throws on non-strings.
- **Placement snaps to the frame grid.** `createOverwriteItemAction` floors the start *and floors the duration to whole frames*. An off-grid raw clip (speed change, nest, audio-unit slip) gets a stem one frame (33 ms at 29.97) short. Handling: read the timebase (`Sequence.getTimebase()`, UXP >= 25.6, ticks per frame as a string; fallback `SequenceSettings.getVideoFrameRate().ticksPerFrame`), place a whole-frame *cover* (`floor(start)..ceil(end)`), export from the floored start, and verify "stem covers raw clip" within one sample (`placementGeometry()`, `per-clip.js`).
- Off-grid clips are normal editing, so this must be handled, not reported as an error.
- **Track-item trims (in/out/start/end) snap to whole frames too (2026-09-21, from the handles feature).** Requesting a 0.5 s handle (14.985 frames at 29.97) on a scratch clip came back different, so the exact read-back check failed with "Premiere did not preserve the requested handle trims". Keep every requested trim on the sequence frame grid (`addHandles()` floors head/tail to whole frames) and print expected vs found ticks on mismatch. Footage at a different frame rate than the sequence may snap on its own grid; unverified. **Confirmed working (2026-09-21):** with whole-frame handle lengths and the two-step apply (source in/out first, then start/end only if needed), the scratch extension read back exactly and handles worked end to end on `C0046.MP4`. Multicam/nested clips have no file-backed source and are skipped.

## 3. Render sequences and export

- **Isolate transaction can misfire transiently.** `render.createSetInPointAction()` (or its readback) once produced an in-point of exactly -400000 s the first time an export touched a *different audio track* than the previous 36 clips. The out point applied fine; an identical retry seconds later succeeded. Symptom without the guard: a 60 MB WAV for a 6 s clip and a 5 minute "hang" that is really a wrong-duration file. `isolateClipOnRender()` reads the points back and retries up to 3 times with 300 ms pauses. Confirmed self-healing.
- **Export wait.** `EncoderManager` render events are attached, but on Dan's Premiere 26.x build `export_wait` reported `poll`: no correlated `EVENT_RENDER_COMPLETE`. `export-sync.js` falls back to polling the WAV (3 s event grace for music analysis, 5 s elsewhere; the Step 1 verifier starts immediately). Still to do: capture one real `EVENT_RENDER_COMPLETE` payload to tighten correlation.
- **Poll cost.** Reading the whole WAV each poll is expensive for long clips (hundreds of MB on a 30 min clip). `waitForStableWavFile()` uses file size plus a bounded header parse.
- **Files Premiere has imported are locked on Windows.** Overwriting a WAV that is on the timeline fails with `resource busy or locked` (EBUSY). Never reuse a fixed file name for something that may already be placed; fall back to a suffixed name (`writeStem()` in `clip-batch.js`).
- **Playback masks missing media.** A pop-fix WAV written to a temp folder that was then deleted still played from Premiere's cache, so the first use looked fine; the second failed. Any WAV placed on the timeline must live in a persistent folder for as long as the project references it.
- **No direct PCM access to the timeline.** No documented way to read the mixed timeline audio, so analysis uses full temporary renders (music baseline, dialogue reference, two-endpoint calibration). Source-file decoding would not reproduce trims, overlaps and effects.
- **No reimport of replacement music media.** The music pass edits Amplify on existing clips.

## 4. Effects and components

### Static gain action construction must be inside transaction (confirmed 26.5.1, 2026-09-22)
`param.createSetValueAction(key,true)` threw "The script object is no longer valid" even with freshly fetched, verified non-time-varying Amplify parameter. Creating the action within `host.transaction(..., compound => compound.addAction(param.createSetValueAction(key,true)))` succeeds; live scratch readback confirmed normalized 0 = -96 dB. Commit time-varying=false first and reacquire parameter handles before static gain. Construct keyframes outside the locked callback; no asynchronous work inside transactions. This is distinct from the earlier keyframe-creation-inside-lock crash in music-effects.js. Do not generalize that warning into prohibiting action creation inside the transaction.


- **Amplify identification.** Internal match names are opaque and the display name is the documented handle; `isAmplifyComponent` checks `getDisplayName()` first, internal names as fallback. A component chain's cached count can be stale after edits, so handles are reacquired from the active timeline before and after a transaction. Failures now report track, time, expected/observed counts and every remaining effect's display + internal name. Exact native cause of one earlier failure is unconfirmed.
- **Component values are normalized.** Amplify gain is encoded on a normalized -96..+48 dB range (`music-effects.js`). Multiband compressor gain values use native 0.5 for 0 dB.
- **Silencing a raw clip in place.** UXP has no link/unlink API (no linked-item methods on `AudioClipTrackItem`), so disabling a raw audio clip also disables its linked video. In-place partial lanes use a native Amplify at -96 dB (`silenceRawClip()`) instead. Full-lane track mute is safe (never touches video).
- **Not in UXP:** Essential Sound clip tagging, track-volume ExtendScript. Music ducking uses clip Amplify keyframes instead.
- **Markers API** (`ppro.Markers.getMarkers` / `createAddMarkerAction`) needs Premiere 25.6+; a host without it makes marker placement a no-op. Markers don't change `host.signature()`.
- **Amplify parameter layout depends on the clip's channels (live 2026-09-25).** Mono: `Bypass, Channel Count, Link Sliders, Gain, <31 unnamed>, Link Keyframes`. Stereo: the named sliders are `Left`, `Right`. The 32 slots exist on every instance; only the ones in use have a display name. Match gain sliders as *named, non-control* params (`plugin/amplify-params.js`), never by hard-coded channel names.
- **Track mixer state is invisible.** `AudioTrack` exposes only `isMuted()`/`setMute()`: no solo, track volume/pan or track effects (checked against the reference, 2026-09-25). Anything that fingerprints "the timeline is unchanged" cannot see a solo toggle. Verify loudness's render cache reused a soloed render for exactly this reason and was removed in v0.8.1.
- **`TrackItemSelection` is only valid inside its callback.** `createEmptySelection(cb)`: call `addItem(item, skipDuplicateCheck)` (the second arg is required) and `sequence.setSelection(sel)` synchronously inside `cb`. Using the object after `cb` returns threw "A nullptr was dereferenced" live (Select muted, 2026-09-25). `premiere.js`'s `stripAudioTransitions()` still uses the extract-then-use pattern for `createRemoveItemsAction` and works, but don't copy it.

## 5. Panel UI (Spectrum / webview)

- **Native `<button>` chrome.** A UXP/host regression paints native button chrome (grey pill) over custom CSS despite `appearance:none`. All actions are `<div role="button">` with hand-rolled `.disabled`, focus and keyboard (Enter/Space) handling in `main.js` (`makeButtonDiv`). Consequence: every button div must be registered in that id list.
- **CSS `display:grid` breaks layouts in the panel; use flexbox (confirmed 2026-09-21).** Symptom: after the Options > Clean dialogue checkboxes were put in a two-column `.check-grid` (`display:grid; grid-template-columns:repeat(2, ...)`), Dan reported options missing from the menu. The markup still contained every control (all ids present), so nothing was deleted; the grid simply didn't lay out (options went missing from view). Fix: `.check-row` flex rows of two `flex:1 1 0` labels each (`plugin/index.html`, `plugin/style.css`); Dan confirmed all checkboxes are back. Rule of thumb: build every panel layout from flex (`.field-row`, `.step-row`, `.check-row`, `.reference-row`), never grid. **Still open:** `#dialogueTrackList` (Ducking > Choose tracks) also uses `display:grid` (2 columns) and is likely affected; check it live and convert to flex rows if tracks look wrong. Diagnosis tip: when "controls disappeared" after a CSS-only change, diff the markup's element ids first; if all are present it is a layout problem, not a data/JS one.
- **`.step-row > [role="button"]`** gets `flex:1 1 0`, which overrode a 28 px icon button's sizing (the old "?" toggle). Rows should only hold full-size step buttons.
- **HTML `<input type="range">`** snapped between 0 and 100 in Premiere. Use Adobe's native `sp-slider` (0..100, step 1). Its handlers must not reset disabled state mid-drag; values can be numbers or strings.
- **Untouched `<select>` can read as empty** despite its first `<option>`. Set every select's value explicitly on init/reset (`mode`, `enhancer`, `separator`).
- **Number fields** need explicit DOM assignment to initialize on first load.
- **Tooltips.** Native `title` tooltips are used on every button. Dan confirmed on 2026-10-06 that they show in Premiere.
- **Panel menu (flyout), added 2026-10-06, NOT yet seen live.** `uxp.entrypoints.setup({panels: {wtvAudioWizard: {show(){}, menuItems, invokeMenu}}})` in `main.js` via `panel-menu.js`. `setup` may be called once only. The call is wrapped: if it throws, the panel still works and Copy report says "Panel menu: not installed (reason)". The Compact panel tick is updated through `entrypoints.getPanel(id).menuItems.getItem(id).checked`, which Adobe documents for Photoshop but not on the Premiere page; that call is also wrapped. To confirm live: the menu appears, items fire, the tick updates, and defining `show` does not blank the panel body.
- **Stale panel after code changes (unresolved).** After the "?" popover removal the panel kept showing the old UI after a UDT Reload. Files on disk were correct. Try: fully Unload then Load in UDT; toggle the panel in Premiere; check UDT isn't pointed at a second copy of the plugin (packaged `.ccx`, UXP cache under `%APPDATA%`); restart Premiere. Also check `manifest.json` version drift (0.7.1 vs panel v0.8.0). Documented and left open; revisit only if it recurs.
- **Scroll cues** are gradient overlays with a bottom chevron on the scroll viewport (the panel doesn't show scrollbars reliably).

## 6. Files, storage and text

- **File pickers / folders.** Save/Load settings use native UXP JSON pickers (acceptance still to be confirmed live). A project whose folder isn't accessible triggers a "Could not access project folder" prompt. Creating a folder whose name exists throws "A Folder with given name exists"; reuse existing `-clips` folders (`clipsFolder()`) and give in-place runs a timestamped label.
- **Secure storage** holds the pairing token (`uxp.storage.secureStorage`); settings exports never include token or service URL.
- **Encoding.** Source literals with non-ASCII punctuation got corrupted through a Windows legacy encoding. Use ASCII `\u` escapes in `main.js` / `music-pass.js`, and always read/write source files as explicit UTF-8. Preserve each file's existing line endings (many are CRLF) when editing programmatically.
- **WAV support** for reads: mono/stereo PCM 8/16/24/32 and float 32/64 (incl. extensible), sequences at 44.1 / 48 / 96 kHz, RIFF only.

## 7. Tooling notes

- `main.js` requires `uxp` and the DOM at module scope, so it can't load under plain Node. Testable logic lives in small modules (e.g. `button-state.js`) and tests load plugin files via `vm.runInNewContext` with mocked `premierepro`.
- Mocks must be as strict as the host: the strict `createWithTicks` mock is what catches the string-ticks bug class.
- UDT: after plugin edits, reload (or unload/load) the full plugin folder; restart the service only when the service side changed.

## 8. Adobe APIs noted for future spikes (not implemented)

`encodeProjectItem` / AME batch encode; `Transcript` (`hasTranscript`, `exportToJSON`, `transcribeClipProjectItem`); `EventManager` on Sequence/AudioTrack/Project for live edit detection; `ClipProjectItem.createSubClipAction` (26.3) for hard-bounded subclips; OTIO/FCPXML `ProjectConverter` (not a PCM substitute).

## References

- Adobe Premiere UXP reference: https://developer.adobe.com/premiere-pro/uxp/ppro-reference/
- Known issues: https://developer.adobe.com/premiere-pro/uxp/uxp-api/known-issues
- `HANDOFF.md` (dated entries), `research/ARCHITECTURE-VALIDATION.md`, `PREMIERE-MUSIC-PASS.md`, `PER-CLIP-MODE.md`
