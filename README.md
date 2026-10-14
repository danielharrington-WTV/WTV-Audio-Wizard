# WTVAudioWizard — panel 0.8.5, service 0.7.2

**Panel 0.8.5 (2026-10-14):** panel menu **Help: operator guide** opens the operator guide in the web browser. The guide ships inside the plugin (`plugin/help/`, a copy of `docs/WTVAudioWizard-Guide.html`; after editing the guide, copy it there too, a test checks they match), so it also works in a packaged plugin. Reload the plugin fully: the manifest gained permission to open `.html` files.

**Panel 0.8.4 (2026-10-13):** the Service URL defaults to the office GPU server, `http://192.168.0.176:8756`, the preset menu ends with **+ New preset…** (also in the panel menu) to save the current settings as your own preset, and a small arrow button left of **Level & duck music** selects the music clips (clip or track name contains the words in Options > Ducking > Select music, default `ANW`). Service unchanged.

## Current state (2026-10-12)

**Panel 0.8.3 / service 0.7.2 (2026-10-12): no pairing token, LAN access.** The Token field and the service's pairing token are gone (Dan's request). The service accepts any client on this computer (loopback) or on a private LAN (10.x, 172.16-31.x, 192.168.x) with a matching Host header, and still refuses browser pages (any `Origin`). The panel's Service URL accepts `http://127.0.0.1:8756`, `http://localhost:8756` or a private LAN IPv4 address on port 8756, e.g. the GPU server `http://192.168.0.176:8756`, and remembers the last URL that connected. The panel requires service 0.7.2 exactly, so update and restart the service together with the plugin. The listening address is `WTV_HOST` (or `WTV_HOST=` in a git-ignored `WTVAudioWizard-Service/service.env` on Linux), default `127.0.0.1`.


**Panel 0.8.2** (2026-10-06) is 0.8.1 plus everything added since 2026-09-29: Rebuild Speech, the Batch Process Options menu (first called Processing) with separate Level and De-ess, live progress, Mute raw when done, the renames below, and the per-project export folder with its `WTVAudioWizard` subfolder. The service is still version 0.7.1 and the panel still requires exactly that, so only the plugin needs reloading for the version change. Settings files and saved preferences from 0.8.1 load unchanged.

This folder holds the Premiere panel (`plugin/`), its tests, the operator guide (`docs/`), research notes and `HANDOFF.md`. The audio service lives in its own subfolder, `WTVAudioWizard-Service`, with its own README; it can be deployed separately. The old copies from before the split have been removed.

**Start the service (Windows):**

```powershell
& 'C:\Users\Dan\Documents\Codex\2026-09-05\files-pasted-by-the-user-wtvaudiowizard\outputs\WTVAudioWizard\WTVAudioWizard-Service\start-service.ps1'
```

Then load `plugin/manifest.json` in UXP Developer Tool, open Connection in the panel, enter the Service URL the service prints (`http://127.0.0.1:8756` on the same computer, `http://192.168.0.176:8756` for the Debian GPU server) and click Connect. No token is needed.

**Main tab today.** Names changed on 2026-10-01 and 2026-10-06; older sections below use the names of their time.

| Now | Was |
|---|---|
| Batch Process Dialogue | Clean Dialogue (renamed 2026-10-06) |
| Batch Process Options (menu under it) | Processing (renamed 2026-10-06) |
| Rebuild Speech (track "Rebuilt speech") | Restore Speech ("Restored speech") |
| Level & duck music | Conform & duck music, step 4 |
| Fix pop at playhead | Fix a pop |
| Mute raw when done | Auto mute |

Batch Process Dialogue is one button; the numbered steps 1 to 4 described in older sections were merged into it. Its steps are chosen in the **+ Batch Process Options** menu under the button. **Mute raw when done** (on by default) decides whether Batch Process Dialogue and Rebuild Speech silence the originals they replace. Only the button was renamed: the tracks it adds are still called **Clean dialogue**, and the Options group is still **Clean dialogue**.

**Stem separation preset (2026-10-08).** A built-in preset that starts from the factory settings with Extract ambience stem and Extract music stem ticked, so Batch Process Dialogue returns dialogue, music and ambience/sound-effects tracks. Dialogue still comes from neural cleanup of the raw clip; Bandit v2 supplies the other two.

**Interleaved batch (2026-10-07).** In Per clip mode, Batch Process Dialogue now sends each clip to the service as soon as its export finishes, instead of exporting everything first. The GPU works while Premiere exports the remaining clips; the processing phase then collects results that are already done or under way. If the service cannot take early jobs, the batch continues the old way. No service change or restart is needed. Not yet run in Premiere.

**Panel menu and compact layout (2026-10-06).** The menu on the panel's tab offers Copy report, Open export folder, Change export folder, Connection settings, Save settings, Load settings and **Compact panel**. Compact panel (off by default, remembered) hides Copy report, Change, an idle Cancel, and the Connection row while connected, leaving a green dot in the heading. Everything hidden is in the menu, and the layout can only be switched from the menu, so a Premiere build that shows no menu loses nothing. Not yet seen in Premiere.

**Export folder.** The row at the top of Main shows the export folder for the open project. A saved project uses its own folder automatically; click **No folder** to choose one, or **Change** to pick a different one. The choice is remembered per project. Everything the plugin keeps (per-clip exports and cleaned audio, full-sequence results, rebuilt speech, extracted ambience, pop fixes) goes in a `WTVAudioWizard` folder inside it. Full sequence mode no longer asks where to save. Clip folders from earlier versions, loose in the export folder, are still reused in place.

**Shared GPU machine (planned).** The service is being prepared to run on a Debian PC (RTX 3060 12 GB) for the four office Macs, on the office network only, while the Windows PC keeps its local service. The service folder already has a Debian installer and start script; the network and multi-user parts are not built, and the panel still only accepts a service on the same computer. The plan and its status are at the top of [HANDOFF.md](HANDOFF.md).

**Service storage cleanup (2026-10-09).** The service removes what it has not used for 14 days (7 on the shared machine) from its own data folder: finished jobs and their results, uploads, dialogue cache. Results the panel already saved in the project export folder are never touched; a cleaned-up job is just processed again if rerun. Restart the service to use it. Details in the service README.

**Presets retuned, clip handles on, Don't use cached files (2026-10-09).** Clip handles are on at 0.5 s for every preset. Promo/Action keeps 15% of the raw clip under the cleaned voice (new **Keep raw mix** setting), dialogue -10 dBFS, music ducked 12 dB with 100 ms attack / 800 ms release. Interview stays fully clean with 250 / 1500 ms ducking and a -45 dBFS speech floor. Camcorder keeps 10% raw, turns on De-click, allows 12 dB of boost (new **Max level boost** setting) and uses a -48 dBFS speech floor. On first load the panel resets those three presets' last-used settings to the new defaults and turns handles on in every other saved preset. **Don't use cached files** in the panel menu (global, remembered) exports, analyses and processes everything again; it needs the updated service (restart it).

**Silent exports rejected (2026-10-09).** Batch Process Dialogue checks every clip export for digital silence (peak below -90 dBFS), which happens when the track or clip was muted. A silent export is not kept and is not sent to the service; the batch finishes the other exports and then names the silent clips so they can be fixed and the button clicked again. A silent export left in the folder by an earlier run is exported again instead of reused, and a clip exported afresh never reuses an older processed result. Full sequence mode refuses a silent export the same way.

**Checked in Premiere (2026-10-09):** everything changed since 2026-09-29, including the panel menu, compact layout, interleaved batch, renames, Stem separation preset, export folder and plain-text token field.


**Clean Dialogue Processing menu (2026-09-29):** the processing steps now sit in a collapsible **+ Processing** menu directly under the Clean Dialogue button on Main (collapsed by default, remembered). In pipeline order: Neural cleanup (with the GAP-URGENet / MossFormer2 choice), Level & compress, De-ess, De-click · Exp., Extract ambience stem, Extract music stem. Collapsed, a one-line summary shows what will run. **Level & compress and De-ess are now separate checkboxes** (previously one "Level, limit & de-ess"); older presets and settings files keep de-ess matched to their old Level setting. Clean Dialogue greys out when nothing is ticked, and the menu locks while anything runs. Options > Clean dialogue keeps only the setup choices: Source, Selected clips only, Process in place, clip handles. Restart the service (for the separate De-ess setting) and reload the panel.

**Operator guide:** [Open the interactive WTVAudioWizard guide](docs/WTVAudioWizard-Guide.html) in a browser. Includes the actual Premiere panel with clickable callouts, the quick workflow, QAQC tools, Extras and settings. The HTML is self-contained and can be shared as one file.

**Rebuild Speech (Sidon, 2026-09-29; named Restore Speech until 2026-10-01):** Main > **Rebuild Speech**, beside Check dialogue quality. Select dialogue clips and click it: [Sidon](https://huggingface.co/sarulab-speech/sidon-v0.1) (MIT) rebuilds each voice as clean, full-band speech on the service GPU, removing room echo, reverb, noise and band-limiting. Results go on a new **Rebuilt speech** track, sample-aligned (about 5 ms early, the model's own offset); each original is muted the same way Clean Dialogue mutes raw clips, so **Unmute** / **Select muted** work on them. Hover the button for when to use it and when not to. It re-synthesizes the voice, so audition before delivery. **Setup, once per Windows service machine (NVIDIA GPU needed):** in the `WTVAudioWizard-Service` folder, double-click `setup-sidon.bat` (creates `../../work/sidon-env` with PyTorch 2.8 cu128, puts the two model files in `../../work/sidon-models`, runs a GPU test, adds a `sidon` entry with checksums to `local-config.json`), then restart the service and click Connect. `scripts/validate-restore.bat` there re-checks the whole service path on the GPU without disturbing a running service (pass it a WAV file). On Debian, `setup-linux.sh` installs this model with the others.

**Connected dialogue quality review (panel 0.8.1):** Connect to the updated service, then use Main > **Check dialogue quality**. Select dialogue audio clips on the timeline; adjust the review threshold in **Options > Dialogue quality** if needed. DNSMOS runs on the service CPU and adds red review markers; no separate helper setup. Update service dependencies, restart the service, and reload/reconnect the panel. See [setup, scoring limits and attribution](research/DIALOGUE-QUALITY.md). Live Premiere/M2 verification remains pending; the existing connection is still loopback-only.


**Mixed-batch speed improvement:** when neural cleanup and optional stems are selected, all raw clips are cleaned first, then Bandit extracts stems from the same raw audio. This keeps each model loaded across clips and preserves existing final levels/ducking. Progress shows two processing passes. Restart the updated service and reload the plugin after active work finishes. Interrupted runs reuse native model caches.


Per-clip exporting and cleaning now show completed clips, overall progress, elapsed time and an approximate time remaining for the current step. Estimates start after the first non-reused clip finishes and adapt to this batch; cached/resumed clips do not train the estimate. Reload the panel to use the new display.


**Optional clip handles:** Options > Clean dialogue > Add clip handles processes extra audio (default 0.5 seconds per side, off initially) for later trims/crossfades, while retaining the existing visible cuts. Applies to per-clip cleanup and its checked stems. Available source media and timeline zero limit each side; unavailable/unsupported source bounds are reported and the clip cleans normally without handles. Requires host access to full media duration (documented from Premiere 26.5). Settings are remembered and included in Save/Load. Reload the plugin after updating; native Premiere acceptance is pending.

### Normalize music levels
Select music clips in the timeline, then click **Normalize music levels** (below Conform and duck music, left of Enhance low end). Applies two native Multiband Compressor instances in sequence, before existing duck Amplify effects: first Premiere's Broadcast settings with **-12 dB Output Gain**, then a second **peak-control** stage (**3:1 above -30 dB**, 0 dB output gain) that tames whatever peaks remain above -30 dB. Existing Multiband Compressors on selected clips (one or two, from any prior run) are replaced; reruns do not stack them. Works offline with editable native effects and no audio export/import. This applies fixed compressor presets and gains, not a measured LUFS target. Broadcast verified on Premiere 26.2.2; the peak-control stage reuses the same verified parameter layout and Broadcast's own captured Ratio value (confirmed live to mean 3:1) rather than a freshly guessed formula — see `plugin/normalize-music.js` for the threshold/ratio derivation. Incompatible parameter layouts are rejected on either stage. Reload the plugin after updating.


**September 16 update:** Step 1 checks WAV completion while listening for export events, removing the five-second per-clip grace wait and checking stability at 200 ms intervals. Music ducking replaces all existing Amplify effects on selected music (including manual/stacked copies) with one new duck effect. Reload the plugin; no service restart required. See [HANDOFF.md](HANDOFF.md) for validation and native acceptance.

**Music ducking now works offline (September 15):** reload the plugin; no service connection or token is needed for step 4. Select existing music in the active sequence, open **Options → Ducking**, choose **Clean dialogue** for a finished WTV clone or **Choose tracks** for any supported sequence, then click **4. Conform & duck music**. Cleanup and other audio processing still require Connect.

The plugin measures audio and generates keyframes locally. Three temporary Premiere exports remain to measure the actual timeline music/dialogue and verify native gain. They are cleaned up after completion; **nothing is imported or replaced**. Existing clips receive editable Amplify keyframes. No model or GPU is used by this feature. See [PREMIERE-MUSIC-PASS.md](PREMIERE-MUSIC-PASS.md) for the current workflow and [HANDOFF.md](HANDOFF.md) for validation and remaining native acceptance. The historical service-start instructions below apply to dialogue cleanup.

**Music ducking optimization (September 15):** the plugin now writes curve corners instead of filling ramps with redundant keyframes. Synthetic 22-minute / 21-clip stereo benchmark: 95% fewer keys with the same calculated duck curve. Speech detection and attack/release are unchanged. Reload the plugin; no service restart required for this patch. Copy report records actual and estimated old native key counts. 173 JavaScript tests pass; acceptance on the long Premiere project remains pending.

## Latest — whisper body (2026-09-11)

Enhance low end now boosts existing 150–500 Hz content for whispered dialogue; it replaces the previous upper-harmonic generator. Cog slider remains 0.2×–3×, default 1×. Nominal centre boost is about +1.6 / +6 / +12 dB at 0.2 / 1 / 3×, before linked peak attenuation. 1× now means the new normal setting, not the old algorithm. The chosen multiplier scales the added **150–500 Hz body band** on the next run; it does not adjust a clip already processed, and resets to 1× after a panel reload. Four-times oversampled peak estimation applies global attenuation to −1 dBFS when needed; this is not a certified true-peak limiter. No pitch synthesis or recovery of absent bass; background low-frequency noise can also increase. Algorithm report: whisper-body-v1. Restart service, reload plugin and reconnect. Real whispered-dialogue listening/native Premiere acceptance still required. See [LOW-END-EVALUATION-2026-09-11.md](research/LOW-END-EVALUATION-2026-09-11.md) for background — it describes the earlier, now-superseded harmonic algorithm, not whisper-body-v1's actual DSP.

## Latest — dialogue leveling v4 + sparse whisper lift (2026-09-15)

Clean audio now matches **C0021-class whispers** to typical mixed dialogue level (validated on Bear bait + C0021 NAS fixtures): **v4 multiband compression** (whisper/loud inside a clip) plus an automatic **sparse clip normalize** when a take has hot peaks but mostly quiet speech. Dense clips skip the second step (Bear bait ~7 s breath not pumped). Report field: `compress_dialogue.sparse_dialogue`. **Restart service** after pull. Listening on your timeline still recommended after neural clean.

## Earlier — per-clip Apply handles raw clips that don't sit on whole frames (2026-09-14, later)

A 43-clip per-clip batch failed Apply deterministically on one clip whose timeline boundaries were not on whole 29.97 fps frames. Premiere floors a newly placed audio clip's start and duration to the sequence frame grid, so the clean stem came out one frame (33 ms) short. Per-clip mode now reads the sequence timebase (`Sequence.getTimebase()`), exports such a clip one frame long, places its stem with the whole-frame span that covers the raw clip, and verifies coverage within one audio sample instead of demanding exact ticks; on-grid clips are unchanged. Placement failures now report the actual placed ticks and deltas next to the expected ones. Full account in [HANDOFF.md](HANDOFF.md). Same session, earlier: the per-clip export can be **resumed** after an interruption (Prepare turns into "1. Resume export"), status lines show each clip's track and timeline position, the batch-size cap is gone, flaky in/out-point and placement actions are retried in place, and Music target defaults to **Peak**. **Current full-suite counts: 156 JS / 119 Python passing.** Native acceptance of the off-grid fix is pending Dan's next run.

## Earlier — script object fixes, per-clip transition scoping, and music target mode (2026-09-14)

Four distinct causes of the generic Premiere `The script object is no longer valid.` error were found and fixed this session; see [HANDOFF.md](HANDOFF.md)'s "Known error pattern" section for the full list (stale handle reuse, a speculative/unconfirmed transition-removal API, long derived sequence names exceeding filesystem path limits, and track-wide instead of per-clip transition evaluation). The last of those was reported directly by Dan: selecting a single dialogue clip with no crossfade of its own could still fail Prepare because of an unrelated crossfade between two other, unselected clips on the same track. `plugin/per-clip.js`'s `inventory()` and `plugin/premiere.js`'s `stripAudioTransitions()` now evaluate transitions per clip (does a transition actually touch *this* clip's own span), not per track — a transition between two other clips is left untouched. This also fixes the same over-broad check in Fix a pop and Enhance low end, which share the same `inventory()`.

Also: **Duck attack/release defaults changed from 200/1000 ms to 200/1200 ms** (a slower release reduces audible music pumping on longer dialogue pauses); the native music pass now supports a **Target counts as: RMS (active audio) / Peak** choice (default RMS, unchanged behavior) so a Peak baseline lands the ducked level's sample peak, not its RMS, at a predictable target; and the global **Measure: RMS/LUFS** toggle (Options → Levels & stems) was removed entirely as out of scope — the panel's stem-level normalization is RMS-only now, same as the native music pass always was. Per-clip crossfade capture/strip/reapply (added earlier this session), the 250-clip batch limit, and the removed 10-minute sequence cap are all still in place and unchanged. **Current full-suite counts: 138 JS / 119 Python passing.**

**Continuation:** Read [HANDOFF.md](HANDOFF.md) for the latest approved changes and pending decisions. The Clean dialogue / Choose tracks selector and approved pop timing fixes are implemented. Other review findings still require individual approval. Development folder is current; ZIP has not been rebuilt for this incremental patch.

Clean dialogue comes directly from raw audio through your choice of GAP-URGENet (default) or MossFormer2 SE 48K. Bandit v2 runs only when Ambience as stem or Music as stem is checked, supplying the selected outputs; its speech output is never read by the dialogue pipeline. Processing adds aligned stems below the raw audio in a duplicate sequence. Raw clips retain their source media, trims, speed and video links; the clone's processed raw tracks are muted to prevent doubled playback. The original sequence is untouched.

Default track order is **Raw → Clean dialogue**, using GAP-URGENet with both optional stem checkboxes off. In Clean dialogue, check **Ambience as stem** and/or **Music as stem** to append those groups in that order. Bandit is skipped entirely when neither is checked. Its shared encoder runs when either is checked; only the requested output heads are evaluated, accumulated, saved, downloaded and inserted. Each source lane gets one additional lane per requested output; Full sequence mode uses one continuous track per requested output. Reset restores the factory model and unchecked options; saved explicit choices are otherwise retained. De-click & de-ess is available as an unchecked experimental option in Clean dialogue; see below.

## Optimizations and music diagnostics in 0.7.0

Clean model outputs are now cached separately from levels, ducking and optional de-click/de-ess. Reprocessing the same exported audio with different finishing settings can skip neural inference. Cache identities include decoded audio, checkpoint pins, runner/model code, package metadata and conversion policy; corrupt artifacts are rejected. The existing whole-job cache remains available.

Consecutive clips using the same model reuse one loaded GPU worker. Checkpoint contents are verified before each new worker loads them. Changing models or Bandit output heads unloads the previous worker; the panel requests release after processing, and the service unloads after failure, cancellation, shutdown or 60 idle seconds. Only one GPU model is resident. Batches with both separation and cleanup still alternate workers per clip; stage grouping is deferred.

Music RMS uses bounded blocks, dialogue-only processing skips the unused duck envelope, and model input is written once. Upload validation runs outside the service event loop; analysis pins uploads while reading outside the job lock. Reused whole jobs discard their new unused upload. The music pass discovers Amplify once per pass and reuses already-read trim values, retaining all verification before timeline edits.

Results include `timings`, `stage_cache` and `workers`. Enhancement/benchmark measurements on a cache hit describe the original inference; use the new phase timings for this run. Inference artifacts live in the service data directory's `stage-cache` folder. Automatic eviction is not implemented, so it grows with unique inputs/settings. To reclaim it, stop the service and remove only that folder; saved/imported Premiere WAVs must be retained. Existing job outputs remain separately referenced by history.

On this RTX 5080, one-second synthetic mono clips took 20.35 → 5.18 seconds for cold → warm GAP and 19.51 → 0.20 seconds for MossFormer. A real service run took 17.99 seconds cold, 5.00 seconds for another clip with the model resident, and 0.14 seconds to reuse inference for a finishing change. These are short-clip startup measurements, not production throughput or perceptual-quality guarantees. All supported Bandit stem selections matched full-head outputs exactly on the fixture. GAP and MossFormer are not bit deterministic across runs; fresh-process controls showed comparable differences (ClearVoice's feature extractor uses random dither). See the optimization smoke/control JSON reports in `validation/`.

The music pass now exposes **Speech floor**, default −40 dBFS. Lower values detect quieter dialogue; higher values exclude more background noise. Copy report includes detection coverage, baseline gain, calibration, settings and whether Apply succeeded. The panel stops before changing music when ducking was requested but no dialogue was detected. It warns when ducking covers nearly all audible music or when detected dialogue causes no ducking on the selected music.

**Native host acceptance confirmed 2026-09-09**: after fixing `component.getParamCount` sequencing, Amplify parameter identification (`Left`/`Right`), gain-value marshalling (`coerceGainValue`), and — the actual root cause of the calibration failures — the gain encoding formula itself (Amplify's `Left`/`Right` is a normalized position on a fixed **−96 dB to +48 dB** linear-in-dB range, confirmed against Premiere's own Effect Controls UI, not a linear amplitude ratio as first assumed), the user confirmed **native ducking works** in real Premiere. See [PREMIERE-MUSIC-PASS.md](PREMIERE-MUSIC-PASS.md) for the full fix history.

Precision, model overlap, de-click/de-ess processing and native keyframe generation remain unchanged. Streamed 4× peak analysis, history indexes, stage-grouped batches and experimental GPU modes are deferred. Read [HANDOFF.md](HANDOFF.md) for continuation context.

## Compact workflow and optional repair in 0.6.3

The panel now leads with **Clean dialogue**: source selection, cleanup model, optional repair/extraction, then Prepare → Clean → Add tracks. Levels & stems and Help & repair report are collapsed initially. All ducking-related controls (Duck against, Duck dB, speech floor, attack/release, ambience ducking) live behind a **⚙** gear button at the end of the step-4 row instead of a permanently visible section, so the always-shown workflow stays uncluttered; the gear menu opens automatically after clean insertion. Buttons stay disabled until their prerequisites are ready, and Cancel is enabled only while working.

Preferred docked size is **300 × 480** (previously 340 × 540); minimum is 280 × 280. Inputs, margins and the status footer are more compact, with scrolling for smaller docks. Saved Premiere dock dimensions may persist: resize the panel if reloading does not change its size. Browser layout checks are an approximation; native UXP controls still need visual acceptance.

**De-click & de-ess · Experimental** is back in the panel, unchecked. It resets to off on initial load, Reset and every reconnect, including when old saved settings had it on. Explicitly checking it sends `deess_declick: true` for processing; the service default remains false. The combined repair algorithm is unchanged and can still alter ordinary speech transients. The Click/pop report is restored under Help & repair report.

History: 0.6.1 introduced the feature, briefly default-on, then default-off after artifact reports; 0.6.2 removed its controls while keeping the implementation. Real-audio investigation found repairs clustered through ordinary dialogue outside the known pop. See [DECLICK-RESEARCH.md](research/DECLICK-RESEARCH.md) for fresh source research, a local FFmpeg comparison and a proposed detection-first improvement plan. v0.6.3 restores explicit opt-in; it does not claim that detector quality has improved.

Historical v0.6.3 required a restart and invalidated earlier cached jobs. Cleanup models, native music automation and stem defaults are unchanged. Prepared media remains on disk, but the panel still needs its current batch context after reload; no session-recovery feature was added.

## Track naming fix in 0.3.1

The status footer now includes **Copy report**. It copies the last error and stack, mode, job ID, apply state and recent status messages without replacing the visible error. Pairing tokens are redacted. A selectable text area appears if clipboard access fails. Unload and load the updated manifest once to apply its new clipboard permission; the panel only writes to the clipboard when you click Copy report.

Track renaming is optional because the installed Premiere build does not expose `createSetNameAction` on audio tracks. Missing or rejected naming now leaves Premiere's default track labels and continues placement. Stem order remains Raw → Clean dialogue → Ambience → Music; per-clip stem names remain descriptive. The panel reports when default track names were retained.

## Start this update

1. Stop the old audio service with Ctrl+C in its PowerShell window after any current job finishes. This update requires a service restart.
2. Run the following command in PowerShell and keep the window open:

   ```powershell
   & 'C:\Users\Dan\Documents\Codex\2026-09-05\files-pasted-by-the-user-wtvaudiowizard\outputs\WTVAudioWizard\WTVAudioWizard-Service\start-service.ps1'
   ```

3. In UXP Developer Tool, unload the old plugin and use **Load & Watch** with this build's `plugin/manifest.json`. Keep the complete plugin folder together. The panel should show **v0.8.3**.
4. Connect at `http://127.0.0.1:8756` (or the GPU server's LAN URL, e.g. `http://192.168.0.176:8756`). There is no pairing token. The panel requires service v0.7.2 and checks that the selected dialogue worker is available before processing. Open **Clean dialogue → Cleanup** to choose MossFormer2 or GAP-URGENet. The selection is saved with your settings.
5. Start with a short sequence. Leave **Process selected dialogue clips only** checked and select all audible dialogue on dedicated tracks. Keep existing music on separate, unselected tracks. In default Per clip mode, step 1 asks for an output folder and creates the clone and isolated render sequences. WAV presets are chosen automatically. Wait for Premiere to finish **all** exports before step 2.
   - **Ducking finds Clean dialogue on its own:** the default reference now recognizes WTV's inserted stems by their file/item/track names, not just the current session's memory — so it keeps working after a reload, a second batch, or when ducking offline. Choose tracks is still there for anything else.
   - **Reuse across runs:** exports land in a stable `<sequence>-clips` folder with stable per-clip file names. Re-running Prepare on clips that already have a valid export there skips the export; re-running Clean audio with the same settings on clips whose processed stems are already in the folder skips the upload and processing. Change the clip or the settings and only that part is redone.
   - **Verify loudness** now flags every peak over a level you set (Options → Loudness verification, default −6 dBFS), merging hits within a window (default 2 s) into one event, and adds a sequence marker at each ("WTV peak …", replaced on every run; uncheck to skip). The first few positions show in the panel; the full list is in Copy report.
   - **Mix on timeline** (Options → Clean dialogue, off by default, per clip mode): the service renders pure model output, and step 3 leaves both the raw clip and its clean stem audible with a native Amplify on each so they sum to the mix slider (100% = raw silenced, 50% = both at −6 dB). Move the slider afterwards and click **Update mix** to change the blend with no reprocessing. Not identical to the in-service mix at intermediate values, since level/limit/de-ess apply only to the clean half.
   - **Process in place (no clone)**, in Options → Clean dialogue, is checked by default: Prepare adds tracks directly to the active sequence instead of cloning it first, so there's no duplicate sequence to find or clean up, and it works even when the active sequence is a nested sequence (cloning a nest is currently unreliable). Undo still works project-wide either way. Uncheck it to get the original clone-first behavior — a fully untouched original sequence to fall back to, at the cost of a duplicate sequence in the project. Reloading the panel mid-run currently only auto-recovers a clone-based session, not an in-place one.
6. Step 2 runs the selected dialogue worker on raw audio. Bandit is also run beforehand only if an optional stem was checked. Keep the clone and render copies unchanged.
7. Step 3 adds Clean dialogue plus only the checked optional stems below the raw tracks. Keep the WAV output folder: Premiere references those files. Successful batches remove their temporary render sequences.
8. Select existing music clips in the finished clone, leave clean dialogue audible, open the **⚙** ducking settings menu at the end of the step-4 row (it opens automatically after step 3) to confirm **Duck against → Clean dialogue** (default) or **Choose tracks** and adjust Duck dB/attack/release if needed, then click **4. Conform & duck selected music**. It targets the combined selected music bed at −28 dBFS before ducking (RMS over active audio by default, or **Peak** — see **Target counts as**) and adds editable native Amplify keyframes. Keep the timeline unchanged until it finishes.

The new stems are separate audio clips, not automatically linked to video. Existing raw audio/video links stay intact. A failed insertion leaves a pending clone for inspection and blocks retries against that clone; prepare a fresh batch. Recovery attempts to restore original mute states and mute added tracks.

## Processing and limits

Both dialogue workers receive the original uploaded audio, bypassing Bandit speech. Ambience is the original separated effects stem, with the configured level/ducking settings; removed dialogue noise is not added back to it. Music remains a separate stem. There is no silent cleanup fallback if the model fails. API callers can explicitly choose `enhancer: "none"`; this leaves raw dialogue unenhanced. The panel offers MossFormer2 and GAP-URGENet; it never offers Bandit for dialogue.

MossFormer works at 48 kHz with four-second blocks, one-second crossfades, and independent mono channels. Results are resampled back to the sequence rate and checked against the original sample count/channel layout. Bandit exits before the selected dialogue worker starts, releasing its GPU allocation. GAP-URGENet uses eight-second blocks with four-second crossfades at 48 kHz, processing stereo channels independently. Do not infer total GPU requirements by adding the two model peaks.

This machine uses an RTX 5080 with 16 GB VRAM. The real ten-second stereo MossFormer execution used about **251 MiB peak allocated / 258 MiB reserved by PyTorch**, taking **4.5 seconds** from model loading through processing (Python/import startup excluded). These figures exclude driver, display, Premiere and other process allocations and are not a minimum-VRAM guarantee. See `validation/mossformer-stereo-smoke.json`. Existing Bandit measurements are in `research/ARCHITECTURE-VALIDATION.md`; AV-CASS remains a secondary target, not an available worker.

GAP-URGENet completed the ten-second stereo synthetic test on the RTX 5080 in 12.4 seconds from model load through processing, with **4,668 MiB peak allocated / 9,900 MiB reserved by PyTorch**. This is a measured test configuration, not a minimum VRAM requirement; Premiere/driver memory is additional. Its existing five local checkpoints total about 2.34 GB. Paths and checksum pins are in `local-config.json`; no download is needed on this machine. See `validation/gap-stereo-smoke.json`.

Use neutral master and track effects, unity master gain, and no track solos. Rendered effects/gain must not be applied twice after re-import. Clip effects, trims and speed are baked into the new WAVs; new stems have no extra trim handles. Per-clip ducking/peak protection works within each clip and does not coordinate different overlapping lanes. Audition the combined sequence for peaks and stereo image.

Preview limits: 250 enabled clips per batch, 512 MiB upload per WAV, mono/stereo at 44.1/48/96 kHz. Muted tracks and disabled clips are skipped. Same-track overlaps require Full sequence mode. Per-clip mode temporarily removes audio crossfades on processed tracks in the pending clone for export, then best-effort restores them on the **Clean dialogue** stem lane after step 3 (original sequence never edited). Levels are measured as absolute RMS over active audio (LUFS is out of scope for now). Current peak protection uses 4x oversampled global attenuation, not a certified true-peak limiter.

## Files and configuration

- `plugin/`: UXP panel, Premiere adapters, six bundled WAV export presets. `click-pop-report.js` and `clip-batch.js`'s `clickPopEvents()` provide the optional repair report.
- `WTVAudioWizard-Service\service/`: authenticated FastAPI job service, cancellation, cache, normalization, ducking, de-click/de-ess (`deess.py`, explicit opt-in in the panel and API) and seeded single-location pop attenuation (`deplosive.py`, `/v1/deplosive`).
- `WTVAudioWizard-Service\runners/`: real Bandit v2, MossFormer2, GAP-URGENet and Sidon (`sidon.py`, with the vendored MIT `sidon_features.py`) workers.
- `WTVAudioWizard-Service\setup-sidon.bat` / `scripts/setup_sidon.py`: installs Sidon for Rebuild Speech on Windows; `scripts/validate-restore.bat` checks it end to end. `setup-linux.sh` / `start-service.sh` install and start the service on Debian.
- `WTVAudioWizard-Service\local-config.json`: this machine's environment paths and pinned checkpoint checksums (one per machine, never copied between machines).
- `docs/`: the operator guide.
- `PER-CLIP-MODE.md`: lane mapping and Premiere acceptance steps.
- `research/`: planning deliverables and background research — start at [project-planning.html](research/project-planning.html) or [README.md](research/README.md).
- `research/ARCHITECTURE-VALIDATION.md` and `research/AV-CASS-INTEGRATION.md`: architecture/API research and secondary model planning.

The MossFormer checkpoint is copied under `../../work/mossformer-runtime/checkpoints/MossFormer2_SE_48K`. The worker uses the existing ClearVoice Python 3.10 / PyTorch 2.7.1+cu128 environment referenced by `local-config.json`, without modifying that environment. Numba caches live in writable workspace runtime/job folders. Checkpoints and environments are not bundled in the ZIP; this is a machine-configured development build, not a portable installer.

The service uses Python 3.12 at `../../work/service-env` (the same location seen from the service folder; `WTV_WORKSPACE` moves it). To recreate it, make that virtual environment with Python 3.12 and install `requirements.lock.txt`. Bandit uses its separately configured working CUDA environment; do not replace it with upstream's old Torch dependencies. `WTV_CONFIG` overrides the configuration file; `WTV_DATA_DIR` overrides job storage (a `token.txt` left there by older versions is unused). Processing uploads/results remain retained. Temporary music-analysis uploads are deleted after the pass.

## API and connection

There is no token: `/v1` endpoints accept any loopback or private-LAN (RFC 1918) client whose Host header is a loopback/LAN IP address or `localhost`, and refuse requests carrying a browser `Origin` (403). Health and defaults use GET `/v1/health` and `/v1/defaults`. POST WAV bytes to `/v1/assets`, then POST a job to `/v1/jobs`:

```json
{"tracks":[{"asset_id":"UPLOAD_ID_HERE","role":"mixture"}],"settings":{"separator":"bandit_v2","enhancer":"gap_urgenet","separate_ambience":false,"separate_music":false,"deess_declick":false,"output_rate":48000}}
```

`deess_declick` defaults to `false`; enable it explicitly via the checkbox or API for the experimental combined repair. GET `/v1/jobs/{id}` reports progress and result metadata, including `enhancement` model/GPU metrics and a `deess_declick` object (`clicks_repaired`, `samples_repaired`, `repairs` — each with `start_seconds`/`duration_seconds`/`channels` — `repairs_truncated`, `avg_gain_reduction_db`, `max_gain_reduction_db`); it is `null` when the setting is off. DELETE requests cancellation. GET `/v1/jobs/{id}/result/{stem}` returns `dialogue`, `effects`, `music` or `mix`. The effects API name corresponds to the Ambience track. The panel downloads only requested outputs, not the combined mix. `separate_ambience`, `separate_music` and `deess_declick` all default to false in the API too. `dialogue_postprocess` is Level & compress (leveling, compression, whisper lift); `deess` switches de-essing on its own and, when omitted or null, follows `dialogue_postprocess` as it did before the split. Unrequested result endpoints return 404. Bandit availability is not required for dialogue-only jobs. Set `enhancer` to `mossformer2`, `gap_urgenet` or `sidon` (speech restoration; the panel uses it with `dialogue_postprocess: false` for Restore Speech). Result metadata records `enhancement.input_source: "raw_audio"` for mixture jobs. Provided-stem jobs enhance the explicitly supplied dialogue stem. Provided-stem callers can use `separator: "provided_stems"` with dialogue/music/effects roles. Cleanup and checkpoint identity are included in cache identity, so old uncleaned dialogue cannot satisfy a cleanup job.

The UXP manifest retains `network.domains: "all"` for the previously diagnosed host permission issue. Panel code restricts requests to loopback or private-LAN IPv4 HTTP on port 8756; this is not equivalent to a platform network sandbox. See the architecture notes. Run one service process and one worker; this is not an internet service, and anyone on the office LAN can submit jobs.

## Validation

Panel tests, from this directory:

```powershell
node --test tests/*.test.cjs
```

Service tests, from `WTVAudioWizard-Service`:

```powershell
& ..\..\work\service-env\Scripts\python.exe -m pytest tests -q
```

Tests cover stem downloads, duration validation, original timeline preservation, grouped lane placement, failure recovery, cleanup chunk boundaries, unavailable models, service auth/cache/cancellation and DSP behavior, including click/pop repair (location/channel accuracy, run-length capping, truncation) and de-essing on synthetic tones (`tests/test_deess.py`), the same detector compared against baseline "models" on real recorded dialogue (`tests/test_deess_real_audio.py`, skipped if its binary fixture isn't present), seeded pop attenuation on synthetic bursts plus a real-audio regression against three measured plosives (`tests/test_deplosive.py`, also skipped if its fixture isn't present), the `/v1/deplosive` and asset-download endpoints (`tests/test_service.py`), the Premiere-side render/upload/import/overwrite flow with a mocked host (`tests/deplosive.test.cjs`), and the Click/pop report's timeline aggregation/formatting (`tests/click-pop-report.test.cjs`, `tests/clip-batch.test.cjs`). Real-model execution reports are under `validation/`. Synthetic audio verifies execution and alignment, not perceptual dialogue quality.

The complete export/import flow still needs the in-Premiere acceptance pass. Mocked Premiere tests do not prove installed-host behavior. Model installer/distribution, AV-CASS integration, automatic linking of added stems, and real Premiere sequence/clip markers for click/pop locations (currently a text report only) remain future work. Fixing the click/pop detector's false-positive rate on ordinary dialogue (see the same section) is the next step for that feature; see [research/DECLICK-RESEARCH.md](research/DECLICK-RESEARCH.md).

## Existing Premiere music and native ducking

The **4. Conform & duck selected music** button ducks against **Clean dialogue** by default: enabled, unmuted clips matching the media WTV inserted, wherever they sit in the finished clone. Click the **⚙** button at the end of the step-4 row to open the ducking settings menu; **Duck against → Choose tracks** there reveals checkboxes for other dialogue tracks, including audio WTV did not process. The panel shows track names and mute states, remembers the choice per sequence, and provides **Refresh** after timeline changes. Chosen tracks must exist and contain enabled, unmuted dialogue; an invalid choice stops before rendering. Music selection must exclude the dialogue reference. There is no automatic A1/A2 rule. This is a plugin reference choice, not Adobe Essential Sound tagging. It preserves source media and existing volume fades, adding a native Amplify effect with editable gain keyframes. Three temporary analysis renders verify the gain mapping before timeline music is changed; no replacement music files are imported. Music analysis is CPU-only. Duck dB, speech floor, attack/release and "also duck extracted ambience" live in the same **⚙** menu.

See [PREMIERE-MUSIC-PASS.md](PREMIERE-MUSIC-PASS.md) for settings, reruns and host acceptance limits. This is WTV-generated automation using native effects, not an invocation of Adobe Essential Sound's detector. Premiere runtime acceptance remains outstanding; the button performs a calibration on your host before applying music changes.

Reconnecting after reopening the panel or restarting Premiere automatically resumes an already-finished WTV clone if it's the active sequence — Conform & duck / Fix a pop / Enhance low end don't require rerunning steps 1–3 onto a fresh clone just because the panel session was lost. If the resumed session can't recover the exact Clean dialogue media it inserted (e.g. that track wasn't named "Clean dialogue" on this host), use **Duck against → Choose tracks** instead of the default. **Confirmed on real Premiere**: Full sequence source mode for steps 1–3 with **Duck against → Choose tracks**, resumed across closing and reopening the project. **Untested**: Per clip source mode, and the default **Clean dialogue** reference, across that same kind of session split — prefer Choose tracks until that's confirmed.

## Fix pop at playhead (formerly Fix a pop)

**Fix pop at playhead** (always visible, beside Level & duck music) attenuates one human-identified plosive/mic-pop in an already-inserted Clean dialogue clip. Park the playhead on the pop, then click it. There is deliberately no automatic whole-file scanning: a real-world investigation (2026-09-10, see `service/deplosive.py`'s module docstring) found that a genuine pop a human flagged by ear ranked outside the top 10 by simple energy-ratio detection among ordinary loud words in the same file, in every frequency band tried — the same false-positive failure mode already documented for `deess_declick`'s click/pop detector. Seeding from a human-identified playhead location sidesteps that problem entirely.

The auto-sizing/attenuation mechanism itself is generic: given a seed timestamp, it walks outward from it using the signal's own local energy envelope (no whole-file scanning) to find the burst's true extent, tolerating brief troughs in a decaying oscillation, then applies an attack/hold/release gain dip (up to 16 dB) only across that window. Validated with unmodified default parameters against three different real plosives in one file: 61-83% peak reduction, 68-82% RMS reduction, each within its own auto-sized window (60-270ms), negligible effect on the rest of the file.

Implementation renders just the target clip (isolated via a temporary sequence clone, like per-clip export), attenuates it inside the panel (`plugin/local-dsp.js`, a port of `service/deplosive.py`; no service connection is needed), imports the attenuated result, and overwrites only that clip's timeline range — the rest of the Clean dialogue track, other tracks and video are untouched and verified unchanged before and after. Requires a normal-speed, transition-free Clean dialogue clip under the playhead. Undo reverts just this one fix.

Fixed clips are saved in the `WTVAudioWizard` folder inside the export folder; that folder holds the fixed clip's actual media going forward, so keep it. Each fix is tracked in `context.dialoguePaths`, so a previously-fixed clip is still recognized as a valid target for fixing a second, different pop later — the export step re-renders whatever is currently on the timeline, so a second fix correctly starts from the first fix's already-attenuated audio.

## v0.6.3 validation

63 Python tests and 58 JavaScript tests passed. The panel smoke checks explicit repair off/on requests and ignores saved legacy opt-in on reconnect. Browser layout checks passed at 300 × 480 and 280 × 280 without horizontal overflow; screenshots are in validation/. Native Premiere acceptance remains outstanding.

## v0.7.0 validation

See `validation/v0.7.0-checks.json` for final test counts. New checks cover bounded RMS equivalence, conversion equivalence, inference-cache integrity/reuse, worker lifecycle, analysis asset pinning, duplicate-upload cleanup and music detection diagnostics. GPU evidence is in `validation/optimization-*-smoke.json` and `validation/optimization-gpu-controls.json`. Native Premiere playback and real-dialogue quality remain manual acceptance checks.

## Approved dialogue-reference update (2026-09-10)

Implemented only review item 1, as approved: **Clean dialogue** by default and **Choose tracks** as the only alternative. Reload the full plugin folder; the selector appears after step 3. Service protocol/version and pairing token are unchanged. Choices are stored per sequence, but resuming the cleanup context after panel reload is still a separate, unimplemented feature. The development ZIP has not been rebuilt for this incremental patch.

Validation: all **106 JavaScript tests pass**, including custom-reference analysis and panel-choice tests. Native Premiere visual/behavior acceptance remains pending. Python/service code is unchanged from the reviewed build, whose 94 tests passed in Python 3.12. See `validation/dialogue-reference-2026-09-10.json`. Other findings in `research/WORKFLOW-REVIEW-2026-09-10.md` await individual user approval.

## v0.7.1 validation

Added Fix a pop (`service/deplosive.py`, `plugin/deplosive.js`). See `validation/v0.7.1-checks.json` for test counts. Two real bugs were found and fixed after the user's own testing, both before any confirmed native acceptance: (1) `plugin/local-api.js`'s endpoint allow-list regex rejected `/v1/deplosive` and the asset-download route outright ("Unexpected local service endpoint."); (2) the fixed clip's output file was written to a temporary folder that was then deleted right after the clip was placed on the timeline, silently breaking its own media reference, and the fixed clip's new path was never recorded so a second fix on the same clip couldn't recognize it as a valid target. Both are covered by regression tests (`tests/local-api.test.cjs`, `tests/deplosive.test.cjs`). Native Premiere acceptance of Fix a pop itself remains outstanding.


Standalone Extract ambience now preserves overlapping selections on separate output lanes and stops/mutes the affected lane on a placement verification failure. It uses ambience-only peak protection and does not inherit the dialogue-driven ambience duck option. Restart the updated service and reload/reconnect the plugin. Optional clip handles are planned in [the feasibility plan](research/HANDLES-FEASIBILITY-2026-09-21.md), not yet implemented.
