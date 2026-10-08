# WTVAudioWizard continuation handoff — v0.8.2

## Latest — Interleaved batch: jobs start during export (2026-10-07)

Dan: "change the way batch processing works so it exports then sends to the connected service, interleaving for faster processing." Panel only; the service is unchanged and needs no restart. Still panel 0.8.2.

Before: Batch Process Dialogue (Per clip mode) exported every clip, then uploaded and processed them one by one, then placed them. The GPU sat idle for the whole export phase. Now each clip is uploaded and its job submitted as soon as its export is verified, while Premiere exports the next clip.

How it works:
- New `plugin/prefetch.js` (pure). `createPrefetch({settings, request, binary, sleep, isCancelled, maxActive = 4})` returns `exported(context, clip)`, `stop()`, `take(clipId)`, `abort()`, `matches(settings)`.
- `main.js` `exportPerClipBatch` creates it (it needs the run's `context` because the job settings include the sequence sample rate) and calls `batchPrefetch?.exported(context, clip)` in three places: clips already exported when a batch is resumed, an export reused from the folder, and a fresh export.
- `doProcess` calls `stop()` (no more early submissions; waits for the one in flight) and passes the helper to `processBatch` as `prefetch`. The existing assertions (`host.assertUnchanged`, `assertExportsUnchanged`) still run before any result is collected, so an early job only ever costs wasted GPU time, never a wrong result on the timeline.
- `clip-batch.js` collects through `prefetch.take(clip.id)`:
  - Normal batches: the early upload is reused and the job is submitted again as before. The service matches final jobs on content and settings and returns the early job (`reused: true`), so there is one code path. The early upload is not deleted, because it is that job's input.
  - Mixed batches (neural cleanup plus stems): the early job is the `dialogue_cache` stage job, which the service does not de-duplicate, so pass 1 polls the early job id directly. If it failed, was cancelled or is unknown to the service, it is replaced once.
- Limits: the service runs one job at a time and returns 429 above 8 waiting or running jobs. The helper keeps at most 4 unfinished early jobs; further exported clips wait in a local queue, and whatever is still queued when export ends is handled by the normal pass.
- Failure handling: any error in the helper (including 429) switches it off for the run and is written to the recent-status list as "Early processing stopped: ..." for Copy report; the batch continues the old way. `runCleanDialogue` has a `finally` that calls `abort()`, which cancels early jobs that are unfinished and uncollected when a run stops, fails or is cancelled.
- Clips the folder already holds results for (same settings) are not sent early.
- Status line after export: "N of M clips were sent for processing during export."

Effect to expect: total time approaches the longer of the export phase and the processing phase instead of their sum. With a GPU faster than Premiere's export, most clips are already done when export ends. Clips collected this way report as reused to the progress estimate, so the time-remaining figure in the processing phase is based only on clips processed after export.

Not changed: Full sequence mode (one file, nothing to interleave), Rebuild Speech and Extract ambience (each already exports, uploads and places one clip at a time), the apply/placement step, the service.

Tests: new `tests/prefetch.test.cjs` (13 tests, including a stand-in service with content-matched job reuse, the 4-job limit, stop while an upload is in flight, abort, failed early jobs, and a check of the three hand-off points in `main.js`). JS tests 394/394.

NOT verified in Premiere. Things to watch on the first real batch: that export is not slowed by uploads running alongside it, that Cancel during export leaves no jobs running on the service, and the time saved (the timing line at the end of the run shows prepare and process seconds). For the planned shared GPU machine this matters more: with several users the 8-job service limit is shared, so `maxActive` should drop or become per-user when the multi-user queue is built.

## Latest — Panel menu and compact layout (2026-10-06)

Dan confirmed tooltips show in Premiere, and asked to use the panel (tab) menu more to make the panel compact. Still panel 0.8.2.

- New `plugin/panel-menu.js` (pure, no DOM/UXP): `menuItems({version, compact})` and `createMenu({entrypoints, panelId, version, hooks})`. `main.js` calls it once after `optionsUi` loads, with `uxp.entrypoints` and panel id `wtvAudioWizard` (the manifest entrypoint id).
- Menu: Copy report, Open export folder, Change export folder…, Connection settings, Save settings…, Load settings…, Compact panel (ticked when on), and a disabled "WTVAudioWizard v0.8.2" line. Five of them simply `click()` the existing panel control with the same id, so the busy lock and disabled rules apply unchanged.
- Compact panel: `body.compact`, saved as `compact` in `wtv-options-ui-v1`, off by default. CSS at the end of `style.css` hides `#copyReport`, `#changeFolder`, `#cancel` while it is disabled (idle), and `#connectionBlock` while connected (`body.is-connected`, set in `updateConnectionStatus`). A green dot `#headingConnected` in the heading shows the connection instead. "Connection settings" toggles `body.show-connection` to bring the block back and opens it; a successful Connect puts it away again. Measured in headless Chromium at 320 px: 64 px saved when idle and connected.
- Safety rule (also in the module header and enforced by a test): compact can only be switched on from the menu, and it hides only controls the menu offers. A Premiere build that shows no menu therefore loses nothing. `setup` and the runtime tick update are both wrapped in try/catch; Copy report now includes "Panel menu: installed / not installed (reason) · compact on/off".
- Not done on purpose: Reset this preset is not in the menu (too easy to hit next to Load); Cancel is never hidden while something runs; the main hint line and status line stay.
- The version string is now in six places; `tests/version.test.cjs` covers the menu's About line. New `tests/panel-menu.test.cjs`. JS tests 381/381.
- NOT verified in Premiere, and this is the first use of `entrypoints.setup` in this plugin: check that the menu appears on the panel tab, each item works, the tick updates, and the panel body still renders. See the new entry in `research/UXP-QUIRKS.md` section 5. If the menu works, consider making compact the default in a later version.
- Guide (new "Panel menu and compact layout" entry under Settings reference; picture unchanged, it shows the normal layout), README and `research/UXP-QUIRKS.md` updated.

## Idea noted, not built — clickable results (2026-10-06)

Dan: might be useful for Check dialogue quality and Verify loudness; note it for now. Today both report as text plus sequence markers (red review markers for quality, "WTV peak …" markers for loudness). The idea is a list in the panel where clicking an entry moves the playhead to that spot, and for quality also selects the flagged clip. The pieces exist: `premiere.js` already builds a `TrackItemSelection` for Select muted (must be used inside its callback, see UXP-QUIRKS section 4), and marker times are known when the markers are written. Open points: whether Premiere UXP lets a panel set the playhead position on this build (not yet used anywhere in the plugin), where the list goes without undoing the compact layout (probably a collapsible block that appears only after a run), and how long the list may get on a long sequence.

## Latest — Processing menu renamed Batch Process Options (2026-10-06)

Dan asked for the collapsible menu under Batch Process Dialogue to read **Batch Process Options** instead of Processing. Text only.

- `plugin/index.html` initial label and `main.js` `section('Processing', 'Batch Process Options', ...)` (the first argument is the element-id stem and is unchanged).
- Messages: collapsed summary with nothing ticked ("Nothing selected — open Batch Process Options and tick a step."), the run error and the `button-state.js` hint (both now "Tick at least one step in Batch Process Options.").
- Unchanged: ids `toggleProcessing`, `processingSection`, `processingSummary`, `processingWarning`; the saved `processing` open/closed preference; `PROCESSING_STEP_IDS` and function names. The Options tab is still called Options.
- Guide callout renamed (picture re-rendered), README table updated. JS tests 375/375; label fits one line at 240 px in headless Chromium. Not checked in Premiere. Still panel 0.8.2.

## Latest — Panel version 0.8.2 (2026-10-06)

Dan asked for the version to become 0.8.2. Panel only; the service stays 0.7.1.

- Changed to 0.8.2: `plugin/manifest.json` `version`, the heading label in `index.html`, `plugin_version` written by `settings-file.js`, the Copy report header in `main.js`, and the network-permission help text in `local-api.js` (and its test).
- Left alone on purpose: `service/app.py` version `0.7.1` and the Connect check `health.service_version !== '0.7.1'` in `main.js`. Bumping the service would make every panel refuse to connect until both sides matched, and nothing in the service changed its API. Comments and test names that say "(v0.8.1)" record when a feature arrived and were not edited.
- Checked for side effects: `plugin_version` in a settings file is written but never validated, so 0.8.1 files load; no storage key, cache key or resume state includes the panel version; the manifest `id` is unchanged, so saved preferences and per-project folders carry over.
- New `tests/version.test.cjs` fails if the five places disagree, if the service check changes, or if an older settings file stops loading. JS tests 375/375.
- Guide (`docs/`), `panel-preview.png` and README updated to 0.8.2.
- To pick it up: reload the plugin in UXP Developer Tool (it should list 0.8.2 and the panel heading should read v0.8.2). No service restart is needed for the version change. Not checked in Premiere.

## Latest — Clean Dialogue button renamed Batch Process Dialogue (2026-10-06)

Dan asked for the Main-tab button to be called **Batch Process Dialogue**. Text only; no behaviour changed.

- Every "Clean Dialogue" (capital D: the button and messages that name it) became "Batch Process Dialogue" in `plugin/` (`index.html`, `main.js`, `button-state.js`, `per-clip.js`, `premiere.js`, `wav.js`, `click-pop-report.js`, comments in `style.css`, `output-folder.js`, `restore-speech.js`) and in four tests. The resume label is now "Resume Batch Process Dialogue".
- NOT renamed, on purpose: the "Clean dialogue" tracks and clip names (ducking and resume recognise inserted stems by that name), the Options group "Clean dialogue", element ids (`runCleanDialogue`, `toggleCleanDialogue`), CSS classes, function names and settings keys.
- Guide and `panel-preview.png` re-rendered with the new label; README "Current state" table updated. Older HANDOFF and README entries keep "Clean Dialogue".
- JS tests 372/372. The longer labels fit on one line at 240 px in headless Chromium. Not checked in Premiere.

## Latest — Documentation brought up to date (2026-10-05)

- `README.md`: new "Current state (2026-10-05)" section at the top (what lives in this folder, the service's new folder and start command, a table of current and former button names, export folder behaviour, the shared-GPU plan in one paragraph, what is still unchecked in Premiere). Title now "panel 0.8.1, service 0.7.1". Start command, Files and configuration, Validation and the Sidon paragraph point at `..\WTVAudioWizard-Service`. The Fix a pop section is renamed Fix pop at playhead and corrected: it runs in the panel (`plugin/local-dsp.js`), not through `/v1/deplosive`, and saves into the `WTVAudioWizard` output folder. The dated history sections below were left as written; they use the names of their time.
- `docs/WTVAudioWizard-Guide.html` and `docs/panel-preview.png`: panel picture re-rendered from the current panel files (468x600, export folder row with Change); 19 callouts (new "Change", rewritten "Export folder"); new help entry "Where are my files saved?"; dates set to 5 October 2026. Checked in headless Chromium at desktop and phone widths: 19 hotspots, no console errors, no external requests, no horizontal overflow.
- `..\WTVAudioWizard-Service\README.md` was written with steps 1 and 2.
- The guide still describes a service on the same computer; update its Connection text when office-network access is built (step 3 onwards).
- Not touched: `PER-CLIP-MODE.md`, `PLANNING.md`, `PREMIERE-MUSIC-PASS.md`, `research/`.

## Latest — Debian installer, Linux start script and cache fix, step 2 of the shared-GPU plan (2026-10-05)

Dan confirmed the GPU machine will run Debian. All changes are in `..\WTVAudioWizard-Service` only; the plugin and the old service copies in this folder are untouched.

Added:
- `setup-linux.sh` -> `scripts/setup_linux.py` (standard library only). It installs `uv` into `<workspace>/work/tools-env`, creates `service-env` (Python 3.12, `requirements.lock.txt`), `gapurgenet-env` (3.10, torch/torchaudio 2.11.0; GAP-URGENet and Bandit v2 share it, as on Windows), `clearvoice-env` (3.10, torch/torchaudio 2.7.1, torchvision 0.22.1) and `sidon-env` (3.12, torch/torchaudio 2.8.0); clones GAP-URGENet and Bandit v2 at the pinned commits; downloads the weights; checks every weight file against its pinned SHA-256 (a mismatch is renamed `.bad` and never used); runs an import check of each model's code in its environment; writes `local-config.json` with a backup. Options: `--plan`, `--only`, `--from-dir` (copy weights from a folder, hashes still checked), `--cuda`, `--skip-gpu-check`. Safe to rerun.
- PyTorch build follows the NVIDIA driver: 570+ -> cu128, 528-569 -> cu126 (same table as GPU-Test).
- `requirements/gapurgenet.txt`, `clearvoice.txt`: exact package versions read from the `dist-info` folders of the working Windows environments on 2026-10-05, installed with `--no-deps` after PyTorch so Linux gets the same package set. `requirements/sidon.txt`.
- `vendor/gap-urgenet-overlay/`: Dan's Windows checkout of GAP-URGENet differs from upstream commit `fbf4673`: `models/gap_urgenet.py` (releases intermediate tensors between stages) and a new `models/gap_urgenet_low_vram.py` (one stage on the GPU at a time; not used by the service yet, relevant for the 12 GB card). The installer copies both over the fresh clone.
- `start-service.sh`: Linux start. On Linux the workspace defaults to the folder containing the service folder (so `work` sits beside it); `WTV_WORKSPACE` overrides.
- `.gitattributes` keeps `.sh`/`.py` files LF.

Changed:
- `service/stage_cache.py`: new `site_packages(python)`; the cache identity now reads package metadata from `<env>/lib/pythonX.Y/site-packages` when `<env>/Lib/site-packages` is absent. Windows identity is unchanged.
- `service/app.py`: the default data folder honours `WTV_WORKSPACE` (`WTV_DATA_DIR` still wins; Windows default unchanged).
- New tests `tests/test_stage_cache_layout.py`, `tests/test_setup_linux.py`.

Sources recorded in the installer: GAP-URGENet `github.com/Xiaobin-Rong/gap-urgenet` @ `fbf467378fbf...`, weights `huggingface.co/Xiaobin-Rong/gap-urgenet` @ `f1916ff86b83...`; Bandit v2 `github.com/kwatcharasupat/bandit-v2` @ `d5563d9031e9...`, weights Zenodo record 12701995 `checkpoint-multi.ckpt` (saved as `bandit-v2-multi.ckpt`); MossFormer2 `huggingface.co/alibabasglab/MossFormer2_SE_48K` @ `eff8c97925c8...`, package `clearvoice==0.1.2`; Sidon as before.

Verified in the cloud sandbox (Linux, no GPU): the installer's service part ran for real and reruns as a no-op; `start-service.sh` started the service, `/v1/health` answered, a non-local Host was refused with 403; Python tests 163 pass, 6 skip, same two music failures, both with system Python and inside the installed `service-env`; both pinned package lists installed on Linux Python 3.10 (without PyTorch) and their compiled packages import.

NOT verified (cannot be from the sandbox: no GPU, and download.pytorch.org, huggingface.co and GitHub clones are blocked there): the PyTorch installs, the repository clones, the weight downloads and their URLs, the model import checks, and any model actually running on Linux. Expect to fix things on the first real run on the Debian machine. Windows on the 5080 has also still not been started from the new folder.

Read access: Dan granted this session read access to `C:\Users\Dan\Documents\Codex\2026-09-01\referenced-chatgpt-conversation-this-is-an-2\work` and `...\2026-09-05\files-pasted-by-the-user-wtvaudiowizard\work` to read package versions and repository origins. Nothing was written there.

Noted for step 5: GAP-URGENet reserved about 9.9 GB on the 5080 (GPU-Test reference); on the 12 GB 3060 it will not share the card with another loaded model, so unloading idle models, or the low-VRAM variant, is required.

## Latest — Service split into its own folder, step 1 of the shared-GPU plan (2026-10-05)

The service side now also exists as a sibling folder, `..\WTVAudioWizard-Service` (beside this folder, same parent). Full path on Dan's PC: `C:\Users\Dan\Documents\Codex\2026-09-05\files-pasted-by-the-user-wtvaudiowizard\outputs\WTVAudioWizard-Service`. It holds `service/`, `runners/`, `scripts/`, the Python tests (`tests/*.py`), `requirements.lock.txt`, `start-service.ps1`, `setup-sidon.bat`, `.gitignore`, a copy of this PC's `local-config.json`, a new `local-config.example.json` and its own `README.md`. All Python files are byte-identical copies of the ones here.

Changed in the new folder only:
- `start-service.ps1`, `scripts/setup_sidon.py`, `scripts/validate-restore.bat`: the workspace (the folder containing `work`) defaults to two folders above the service folder, as before, and can now be set with `WTV_WORKSPACE`. Because the new folder is a sibling of this one, the default resolves to the same `work` folder: same service environment, same data folder, same pairing token.

Not changed: `service/app.py` (still local-only), `service/stage_cache.py` (the Linux layout fix is step 2), the plugin.

State of this folder: the old `service/`, `runners/`, `scripts/`, `tests/*.py`, `requirements.lock.txt`, `start-service.ps1`, `setup-sidon.bat`, `local-config.json` and its `.bak` are STILL HERE, because Claude cannot delete or move files. They are now duplicates. Until Dan deletes them, edit the service only in `WTVAudioWizard-Service`; do not edit the copies here. `tests/*.test.cjs` and `tests/plugin-test-require.cjs` stay here (plugin tests). `validation/` stays here; the Python tests that use its audio fixtures skip when it is absent.

Checks: Python tests run from the new folder in the cloud sandbox: 151 pass, 6 skip (no PyTorch, no audio fixtures), and the same two music tests fail as before the split. NOT yet checked on Dan's PC: starting the service from the new folder with `start-service.ps1` and connecting the panel.

Known effect: the stage cache key includes the runners' file paths, so the first run from the new folder reprocesses each clip once instead of reusing cached model output.

`README.md` here was updated later the same day (see the documentation entry above). `scripts/validate_restore.py` and `setup_sidon.py` still mention a `Derev-Test` folder that no longer exists; validate needs a WAV path argument.

## Plan — Shared GPU service on a Linux PC, office network only (2026-10-05; agreed; steps 1 and 2 done, see above)

Goal: run the service on a separate Linux PC (RTX 3060 12 GB) for the four office Macs, over the office network only. Dan keeps testing locally on his RTX 5080: the local Windows service must keep working unchanged, and the panel's Service field selects which service is used.

Scope decided by Dan on 2026-10-05: four office Macs, none of which leave the office. No out-of-office computers, no Tailscale or VPN, no public internet exposure. (Remote access through Tailscale was considered and dropped; if it returns, it adds compressed transfer, retries and a Tailscale HTTPS name, and nothing below changes.)

Service folder: the service side moves to its own sibling folder, `WTVAudioWizard-Service` (`service/`, `runners/`, `scripts/`, Python tests, requirements, start scripts for Windows and Linux, setup scripts, `local-config.example.json`, its own README). `plugin/`, JS tests, `docs/`, HANDOFF and README stay here. Per machine: `local-config.json`, Python environments, model files, data folder (`WTV_CONFIG` and `WTV_DATA_DIR` already allow this).

Service-side changes:
- `start-service.ps1` and `scripts/setup_sidon.py` assume environments live two folders above the project; make that configurable.
- `service/stage_cache.py` looks in `Lib/site-packages` (Windows layout); handle the Linux layout too.
- Linux installers for all four models (only Sidon is scripted today) and `start-service.sh`.
- `service/app.py`: the Host check (127.0.0.1/localhost only) and the 127.0.0.1 bind become a configured allowlist; the Linux firewall limits the port to the office network range. The GPU machine needs a reserved address or name on the office router.
- Multi-user: per-computer tokens (today one shared token in `token.txt`), jobs owned by a token, fair queue between users (today one job at a time, limit of 8 waiting jobs overall), queue position reported in job status, upload cleanup (fixes the 409 leftover-uploads issue), unload idle models to fit 12 GB.

Plugin-side changes:
- Required: `plugin/local-api.js` `normalizeBaseUrl` accepts only `http://127.0.0.1:8756` / `http://localhost:8756`; it must also accept the office GPU machine's address (and `https://` if the Mac check below fails). The Service field's help text and error messages say "local service"; reword.
- Required with the multi-user queue: show "Waiting, N jobs ahead" from the job status instead of sitting at 0%; make sure the panel's job timeout does not count time spent queued behind other users.
- Small: messages that tell the user to run `setup-sidon.bat` on the service machine should not assume Windows; drop or keep the asset delete call according to the service's new cleanup.
- No change needed: the panel already uploads audio and downloads results over HTTP (no shared disk assumed), already has a token field, and `manifest.json` already allows all network domains.

Order of work:
1. Split the folder; confirm Windows on the 5080 behaves as before.
2. Linux installers, start script, cache fix.
3. Single-user trial from Dan's PC over the office network (needs the address allowlist and the panel address change); record speed and GPU memory per model on the 3060.
4. Mac check: can the panel on an office Mac use plain HTTP to the GPU machine's office address? Adobe's Premiere UXP network documentation says macOS restricts `http://`. If it fails, the GPU machine gets its own certificate, each office Mac trusts it once, and the panel accepts the `https://` address.
5. Multi-user service work and the panel's queue display.
6. Add the four Macs one at a time.

Unverified: the Mac HTTP check above; the 3060's speed and per-model memory; the Linux distribution is not yet known. Claude cannot move or delete files in this folder, so after step 1 Dan deletes `service`, `runners` and `scripts` from the old folder himself. See also `research/REMOTE-SERVICE-READINESS-2026-09-22.md`.

## Latest — Kept files go in one WTVAudioWizard subfolder; Full sequence stops prompting (2026-10-05)

Dan asked whether everything goes into the export folder. Two changes he approved:

- **One output subfolder.** New `plugin/output-folder.js`:
  - `outputFolder(root)` gets or creates `WTVAudioWizard` inside the export folder. A root already named that is used as is.
  - `clipsFolder(output, root, name)` handles per-clip `<sequence>-clips` folders.
  - `main.js` `resolveOutputFolder(context)` returns `{root, output}` and re-prompts if the folder cannot be written.
  - It is used by per-clip and full-sequence prepare, Rebuild Speech, Extract ambience and Fix pop at playhead. Their files used to land loose in the export folder, usually the project folder.
- **Legacy clips folders.** A `<sequence>-clips` folder from before this layout, loose in the export folder, is still reused in place when the new location has none. This preserves export and stem reuse and keeps an in-progress project's media together. New sequences go inside `WTVAudioWizard`. Existing timeline media is not moved.
- **Full sequence mode.** `doApply()` no longer opens a folder picker for the results. They are written to the output folder, and the "Stems are ready" message was reworded.
- **Unchanged.**
  - Temporary measurement renders (Level & duck music, Verify loudness, Check dialogue quality) stay in UXP temporary storage.
  - Save settings still asks where to save.
  - The folder button shows and opens the chosen export folder, or the active batch's clips folder.
- **Tests.** `tests/output-folder.test.cjs` (6), plus a panel-help source check that all callers use the output folder. JS 372/372. Not yet checked in UXP. Reload the panel.

## Latest — Export folder remembered per project; Change button (2026-10-05)

Follow-up to the entry below. Dan works across projects, so the chosen export folder is now remembered per project, and he asked that the picker open in the folder the project is saved in.

- **Storage.** New `plugin/project-folders.js` (pure). It keeps `{projects:{<key>:{token, at}}}` in localStorage `wtv-project-folders-v1`, limited to the 40 most recently used. The key is the project file path with slashes and case normalised. Unsaved projects have no key.
- **`main.js`.**
  - `workFolder` now belongs to one project (`workFolderKey`), with `workFolderChosen` marking a user choice.
  - `syncWorkFolder()` is serialized and runs from `updateDestinationFolder()`, `resolveWorkFolder()`, `openDestinationFolder()` and `chooseExportFolder()`. When the active project changes it drops the previous project's folder and restores this project's remembered one via `fs.getEntryForPersistentToken`. A token that no longer resolves is forgotten, and the panel falls back to the project folder or "No folder".
  - `setChosenFolder()` stores a `fs.createPersistentToken` for the project. If the host cannot issue one, the folder still works for the session.
  - A folder chosen on an unsaved project is kept for the session and remembered once the project is saved.
  - The automatic project folder is never stored. It is also no longer carried to another project opened in the same session, which was a latent bug.
  - `destinationFolderEntry()` shows a newly chosen folder in place of the previous batch's clips folder, until the next batch starts.
- **UI.**
  - New `#changeFolder` "Change" button beside the folder button (`.destination-folder-row`). It opens the picker in the folder already chosen for the project, or in the folder the project is saved in when none has been chosen (`pickFolder(initial)`).
  - The folder button still opens the folder, or chooses one when it reads "No folder".
  - The tooltip says whether the folder was chosen for this project.
  - Change can also override an automatically detected project folder.
- `premiere.js`: new `getProjectPath()`.
- **Tests.**
  - `tests/project-folders.test.cjs` (5).
  - `tests/folder-memory.test.cjs` (6) runs the real `main.js` folder code against fake storage: restore after reload, project switching, missing folder, unsaved-then-saved, no-token host.
  - The panel-help source check was updated.
  - JS 365/365. Layout previewed at 320 px.
- **Not yet checked in UXP**, in particular that persistent tokens survive a Premiere restart on Windows and Mac. Reload the panel.
- **Stale:** the operator guide's panel picture and callouts do not show the Change button.

## Latest — "No folder" button chooses a folder (2026-10-05)

Dan asked that clicking the folder button when it reads "No folder" lets him choose one.

- `main.js` `updateDestinationFolder()`: the no-folder state is no longer disabled (only while busy), with or without a connection. Its tooltip says to click to choose.
- `openDestinationFolder()`: with no context folder, session folder or accessible project folder, it opens the folder picker (`pickFolder()`) instead of throwing. The choice becomes `workFolder`, which `resolveWorkFolder()` already prefers, so Clean Dialogue, Rebuild Speech, Extract ambience and Fix pop at playhead export there.
- Once a folder is set, the button shows its name and opens it in File Explorer, as before.
- `index.html`: initial tooltip updated; the initial `aria-disabled` was removed.
- **Limits:**
  - The choice lasts for the panel session only; it is not saved across reloads.
  - When a saved project's folder is detected the button shows that folder, so a different one cannot be chosen from the button.
- `tests/panel-help.test.cjs` gained a source check for both behaviours. JS 354/354. Not yet checked in UXP. Reload the panel.

## Open items as of 2026-10-02 (nothing changed in code)

- **409 on `DELETE /v1/assets/{id}` after Rebuild Speech and Extract ambience.** Dan asked on 2026-10-01 whether it was a uvicorn problem. It is not, and the result is unaffected.
  - Cause: `extract-ambience.js` (shared by both features) tries to delete its upload when it finishes. The service refuses because a finished job still references the asset; jobs are kept so reruns can reuse results.
  - Side effect: those uploads accumulate in the service data folder (`work/wtv-data`), like Clean Dialogue's.
  - Two options were offered and **no decision has been made**: remove the pointless delete call, or add a real cleanup (age-based purge on service start, or a "Clear service cache" button).
- **Not yet verified live in Premiere/UXP.** Everything from 2026-09-29 onward was checked by tests and browser preview only:
  - Rebuild Speech button end to end: placement on the new track and muting of originals.
  - The Processing menu.
  - Mute raw when done.
  - The renamed labels at real panel widths.
  - The hidden loudness and quality captions.
  - Smooth progress during model runs. The service must be restarted for progress and the separate De-ess setting.
- **Naming review, 2026-10-01.** Suggested but not chosen by Dan: Unmute → "Unmute raw", Select muted → "Select auto-muted", and one capitalisation style for all buttons.
- **Guide.** `docs/WTVAudioWizard-Guide.html` is current but hand-edited. The other agent's generator (`work/build-plugin-guide.py`) is out of step and would overwrite these edits if rerun. The panel image is a rendered preview; swap in a real Premiere capture if Dan supplies one.

## Latest — Guide: section taglines removed (2026-10-02)

Dan asked to remove the large tagline headings under parts 2–6 of `docs/WTVAudioWizard-Guide.html`: "One pass, seven steps.", "Measure. Flag. Then listen.", "Use when the edit needs it.", "Adjust the next action." and "Keep the next move simple." Each of those sections now has only its small label ("02 / Quick workflow" and so on), which became the section's `h2` (`h2.eyebrow.section-title`, same look as before) so the page keeps a heading per section. Part 1 keeps "The Panel". Rechecked at 1280 px and 390 px: 18 callouts, no errors, no external requests.

## Latest — Operator guide updated for the current panel (2026-10-01)

`docs/WTVAudioWizard-Guide.html` (the other agent's guide, 2026-09-29) was stale after the Processing menu, the Level/De-ess split, Mute raw when done and the four renames. Updated in place; it stays a single self-contained file.

- **Panel image.** Replaced with a preview rendered from the current `plugin/index.html` and `style.css` in headless Chromium at 468×600, shown connected with the Processing menu open. The caption states it is a rendered preview, not a Premiere capture. The copy is also saved as `docs/panel-preview.png`; the original capture `docs/panel-premiere.png` is kept but no longer used.
- **Callouts.** 18, up from 16: new Processing and Mute raw when done. All hotspot rectangles were regenerated from the rendered element positions.
- **Wording.**
  - Names updated throughout: Rebuild Speech (and "Rebuilt speech" track), Level & duck music, Fix pop at playhead.
  - Clean Dialogue points to the Processing menu and mentions the moving progress bar.
  - Workflow steps 3, 4, 6 and 7 were updated.
  - The settings reference now has a "Processing (Main tab)" group with separate Level & compress and De-ess rows; the Options "Clean dialogue" group keeps only scope, Process in place and handles.
  - The troubleshooting text and the footer date were updated.
- **Checked** in headless Chromium at 1280 px and 390 px: image loads, all 18 callouts activate with the right names, seven workflow tabs, no horizontal overflow, no JS errors, no external requests.
- The guide was edited directly. The other agent's generator in the workspace `work/` folder (`build-plugin-guide.py`) was not accessible from this session and is now out of step with the HTML.

## Latest — Button renames (2026-10-01)

Dan chose four renames after a naming review. Only labels and user-facing text changed; element IDs, module, function and setting names are unchanged (`restoreSpeech`, `restore-speech.js`, `musicPass`, `fixPop`, `autoMute`).

| Was | Now |
|---|---|
| Restore Speech | **Rebuild Speech** |
| Conform & duck music | **Level & duck music** |
| Fix a pop | **Fix pop at playhead** |
| Auto mute | **Mute raw when done** |

- **Rebuild Speech** also renames what it creates and says:
  - The new track is "Rebuilt speech" and the clip suffix is " · Rebuilt".
  - Undo labels read "WTV: … rebuilt speech …".
  - Status, error and Copy-report text use the new name.
  - File prefix `restored-*` and render name `WTV_RESTORE_RENDER` are kept.
  - Tracks and clips made before this keep their old "Restored" names.
- The other three: button or checkbox label, tooltips, the main hint ("click Level & duck music"), the Changed-from-defaults label, and the status messages that name the mute setting.
- Not renamed (Dan did not pick these): Unmute, Select muted, Check dialogue quality, and the title/sentence case mix.
- Lowercase prose such as "ready to duck music or fix a pop" is left as is. Older HANDOFF and README entries keep the old names.
- JS 353/353. Previewed at 320 px and 240 px: "Fix pop at playhead" and "Level & duck music" wrap to two lines at 240 px without clipping. Not yet checked in UXP. Reload the panel.
- **Stale doc:** `docs/WTVAudioWizard-Guide.html` still uses the old names.

## Latest — "Auto mute" checkbox on Main (2026-10-01)

Dan asked for a Main-tab tickbox, **Auto mute**, that turns off automatic muting of the raw audio in every feature that mutes it when processing.

- **Markup.** `index.html`: `#autoMute` "Auto mute", checked by default, sits under the Processing menu and above the button rows. Its hover text explains both features it affects. `style.css` adds `.auto-mute-row`.
- **Settings.**
  - A portable per-preset field: `settings-file.js` `autoMute:'boolean'`, with older files and saves defaulting to true.
  - FACTORY_DEFAULT_VALUES `autoMute:true`; label "Auto mute".
  - Covered by Reset and Changed-from-defaults, and locked while busy like the Processing steps.
- **What it gates:**
  - **Clean Dialogue, per clip:** `per-clip.js` `apply()` skips the whole raw-muting block when `context.autoMute === false`. That block covers full-lane track mute, the in-place −96 dB Amplify plus " · WTV muted", and the clone-mode raw disable. It says "Auto mute is off — raw audio left audible" instead.
  - **Clean Dialogue, full sequence:** `premiere.js` `applyStems()` skips muting the original tracks.
  - **Restore Speech:** `restore-speech.js` skips `muteOriginals` when `hooks.autoMute === false` and returns `autoMute`. The status line then says "Originals left audible".
  - `main.js` reads the box at Add/insert time (`context.autoMute`) and at Restore Speech click. Completion messages state which happened.
  - Failure recovery is unchanged: it still restores old mute states and mutes partially added tracks.
- **Not affected:**
  - Extract ambience never muted anything.
  - Fix a pop replaces media.
  - Unmute / Select muted work as before.
  - Restore Speech still refuses clips already WTV-muted.
- **Tests.** JS **353/353**, with new cases: per-clip full lane and partial lane with auto mute off, applyStems off, Restore Speech off, and the settings default. Layout previewed at 320 px; not yet checked in UXP. Reload the panel; no service change.

## Latest — Live job progress during model runs (2026-09-29)

Dan asked whether the service could report percent done. He had noticed that uvicorn's console lines are only the panel polling `GET /v1/jobs/{id}` about once a second. The job's `progress` already reached the panel, but it sat at 15% for the whole model call and jumped to 80% when it returned. Both requested parts are implemented.

- **Real progress from the runners.**
  - `runners/worker.py`: the runner's stdout is now a `ProgressLog`. It still writes everything to the job log. A line that is exactly `{"progress": 0-100}` is also sent on the worker protocol as `{"id", "progress"}`, only when the value changes. Other JSON lines, such as Bandit metrics, are not relayed.
  - `service/worker_pool.py`: `ModelWorker.run(..., progress=None)` calls `progress(value)` for those messages and `progress(None)` on each 0.25 s poll.
  - **Granularity:**
    - MossFormer2 / GAP-URGENet: `mossformer2.enhance_channel(progress=)` reports per block (about every 3 s of audio for MossFormer, every 4 s for GAP), across channels.
    - Sidon: per 20 s window, across channels.
    - Bandit: per window, unchanged.
- **Estimate.** New `service/progress.py`.
  - `SpeedHistory` keeps `<data>/model-speed.json` per model: warm seconds per audio-channel-second, plus cold-start seconds as moving averages. Defaults are 0.25–0.35 s/s plus 20 s to start.
  - `StageProgress` maps a call onto the job's [start, end] range:
    - Before the first report it shows elapsed ÷ expected, capped at 90% of the stage.
    - After reports arrive it follows them and carries on between them at the observed pace, but never more than halfway to the next unknown report.
    - The value never decreases. It stops at 99% of the stage until the model returns, and writes the job file only when the integer percent changes. Callback errors are swallowed.
- **`app.py`.** `model_run()` wraps both model calls, determines whether the worker is cold, and records the measured speed afterwards.
  - Separation spans 10%→15%, or 10%→85% when there is no enhancer.
  - Cleanup and Sidon span 15%→80%.
  - `run_worker` gained `progress=None`; the test fakes were updated to accept it.
- **Note.** The runner edits change `model_identity`, which hashes `runners/*.py`, so each clip's model stage reruns once, the first time after this update.
- **Panel.** No change. The per-clip batch bar and ETA and the status text already use `job.progress`, so they now move smoothly.
- **Validation.**
  - New `tests/test_progress.py` (7 tests): estimate cap and monotonicity, report takeover and interpolation limits, error safety, speed learning and persistence, relay filtering, a real subprocess worker relaying 25/50/75/100 plus poll ticks, and a job whose progress moves during the model call.
  - Python: 152 pass; the only failures are the two known music tests. JS 348/348.
  - Runner progress callbacks were checked in a torch env: Sidon reports 0.33/0.67/1.0 on 50 s of audio, and MossFormer reports per block.
  - `scripts/validate_restore.py` now records a `progress_seen` timeline per run.
- **Needs.** Restart the service.

## Latest — Clean Dialogue Processing menu; Level and De-ess split (2026-09-29)

Dan approved: move the processing controls out of Options into a collapsible menu under Clean Dialogue, keep Restore Speech separate, and split Level from De-ess.

- **Main tab (`index.html`).**
  - `#toggleProcessing` "+ Processing" and `#processingSection` sit directly under `#runCleanDialogue`.
  - The steps are listed in pipeline order: `enableEnhancer` with the `enhancer` select inline; `dialoguePostprocess` "Level & compress"; new `deess` "De-ess"; `deessDeclick` "De-click · Exp."; `ambienceStem` / `musicStem` "Extract … stem".
  - `#repairHelp` moved into the menu. New `#processingWarning` shows when nothing is ticked.
  - `#processingSummary` is a one-line status such as "GAP-URGENet · Level · De-ess". It shows only while the menu is collapsed.
  - The element IDs are unchanged, so presets, Save/Load, Reset and Changed-from-defaults keep working.
- **Options > Clean dialogue** now holds only Source, Selected clips only, Process in place and handles.
- **`main.js`.**
  - `PROCESSING_STEP_IDS`, `processingStepsSelected()` and `processingSummaryText()`.
  - `syncCleanupControls()` now also locks the steps while `busy`, and updates the summary, warning and de-click help.
  - `setProcessingOpen` persists `processing` in `wtv-options-ui-v1`, collapsed by default. Reset preserves it, like Presets.
  - `settings()` sends `deess`. On an old service with no `deess` in `/v1/defaults`, it errors only if De-ess ≠ Level. The empty-steps error names the Processing menu.
  - `ambienceSettings()` and `restoreSettings()` send `deess:false`.
  - `showSettings()`: an unset `deess` follows `dialogue_postprocess`.
  - The diagnostic line reports level and de-ess separately.
  - Changing a step refreshes the buttons.
- **`button-state.js`.** New `stepsSelected` input (default true). Clean Dialogue is disabled when it is false, and the hint says to tick a step.
- **`settings-file.js`.** New portable `deess` field. Older files and per-preset saves without it take their `dialoguePostprocess` value. FACTORY_DEFAULT_VALUES `deess:true`; label "De-ess". `defaults.json` `deess:true`.
- **Service.**
  - `schema.py`: `deess: bool | None = None` plus a `deess_enabled` property, where None follows `dialogue_postprocess` so older clients are unchanged. `ambience_only` still rejects de-ess.
  - `app.py`: de-ess runs on `deess_enabled`, independent of level/compress. The empty-job 422 counts de-ess.
  - The new field changes job fingerprints once, so earlier finished jobs won't be reused. The model stage cache still hits, so no model rerun.
- **Tests.**
  - JS **348/348**, including: cleanup-layout checks the menu order and that none of the steps remain in Options; settings-file checks de-ess round trip and the old-file fallback; button-state checks the no-steps case.
  - Python: new `tests/test_deess_split.py` (7 pass). The only failures are the two known music-analysis tests.
  - The real menu code was run in headless Chromium against the actual markup: collapsed summary, open/close persistence, summary updates, model select disabled with Neural cleanup off, no-steps warning, busy lock.
  - **Not yet checked live in UXP.**
- **Needs:** restart the service (for `deess`) and reload the panel.
- **Stale doc:** `docs/WTVAudioWizard-Guide.html`, from the other agent's earlier entry, still describes these checkboxes under Options > Clean dialogue.

## Latest — Interactive single-file operator guide (2026-09-29)

Created `docs/WTVAudioWizard-Guide.html`: standalone HTML with embedded CSS, JavaScript and the actual panel screenshot captured from Dan's open Premiere window (not a mockup). Original capture retained as `docs/panel-premiere.png`; only the HTML is needed to share/use the guide. No network requests or external assets.

Includes 16 clickable/keyboard-accessible screenshot callouts, a seven-step workflow (Connect → select dialogue → Clean Dialogue → QAQC → adjust ducking → Conform & duck music → optional Restore Speech), persistent guide-only checklist, QAQC tools, Extras, settings accordions, troubleshooting and print support. Restore Speech is documented as optional restoration with an audition and final loudness recheck. Descriptions checked against current source/handoff; no processing controls or timeline changes were invoked while capturing the panel.

Validated in headless Edge at desktop and 390px mobile widths: image loads, all callouts activate, workflow keyboard navigation works, checklist persists/clears, print expands details, no horizontal overflow, no JS errors or external requests. Guide build/check utilities are in workspace `work/build-plugin-guide.py` and `work/check-plugin-guide.cjs`. This is documentation only; no plugin/service behavior changed.


## Latest — Check dialogue quality idle caption removed (2026-09-29)

Same treatment as the loudness caption below. `#qualityResult` ("Select dialogue clips on the timeline, then check quality.") now starts empty and hidden (`display:none`). The `checkQuality` action shows it when a scan starts, so results and failure text still appear. The button's hover text covers selecting clips. JS 345/345. Reload the panel.

## Latest — Verify loudness idle caption removed (2026-09-29)

Dan asked to remove the caption above Restore Speech that read "Full audible sequence. Reports LUFS and sample peak; no level changes."

- `#loudnessResult` is kept, because it is where Verify loudness shows its reading. It now starts empty with `display:none`.
- The `verifyLoudness` action in `main.js` un-hides it when a run starts, so it appears only after the first check.
- The button's own hover text still explains what it measures.
- JS suite 345/345. Previewed at 320 px, not yet in UXP. Reload the panel.

## Latest — Restore Speech tooltip shortened; button colours (2026-09-29)

- **Tooltip.** Dan asked for a shorter Restore Speech tooltip with no mention of Sidon, the GPU or the service connection. It now reads: select clips; rebuilds the voice, removing echo, room sound and noise; best for / avoid for lists; result goes on a Restored speech track with the originals muted (Unmute reverts); audition before delivery.
- **Colours.**
  - Restore Speech is blue: new `.restore-speech`, #2f6b8a, the same as Clean Dialogue.
  - Unmute and Select muted are yellow: new `.mute-tool`, #c9a227 with dark #1b1d20 text for contrast.
  - Both classes replace `secondary` in `index.html`.
  - Disabled buttons still render flat grey via `.is-disabled !important`.
- **Checks.** Previewed in headless Chromium at 320 px, not yet in UXP. JS suite 345/345. Reload the panel; no service restart needed.

## Latest — Restore Speech button: Sidon speech restoration on the service GPU (2026-09-29)

Dan compared Sidon, Resemble Enhance and Adobe Podcast on `genre_search_draft_1` (Derev-Test kit, RTX 5080) and ruled out Resemble on quality. Sidon (`sarulab-speech/sidon-v0.1`, MIT, single-speaker; DialogueSidon is non-commercial and not used) is now a **Restore Speech** button on Main, in a row with Check dialogue quality (the service/GPU buttons). Its hover text lists use cases (echoey rooms, distant camera mics, phone/Zoom/laptop audio, noisy location interviews, muffled archive audio, any language) and when not to use it (singing or music under the voice, overlapping talkers, scenes where room sound should stay), plus the re-synthesis caveat.

- **Panel:**
  - New `plugin/restore-speech.js` reuses Extract ambience's per-clip pipeline. `extract-ambience.js` now takes a `kind` descriptor (default `AMBIENCE_KIND`, every ambience string unchanged). `RESTORE_KIND` fetches the `dialogue` stem, names files `restored-*`, the track **Restored speech** and clips `… · Restored`.
  - Job settings are `restoreSettings(factory)`: `enhancer:'sidon'`, wet 1, no separation, no level/de-ess/de-click, sequence output rate. The result is Sidon's output as-is except the mixer's shared −1.2 dBFS peak safety.
  - After placement, each restored clip's original is muted with `per-clip.js`'s `silenceRawClips` (now exported), the same −96 dB Amplify plus ` · WTV muted` that Unmute and Select muted understand. This also runs for clips already placed when a batch stops on Cancel or a fatal placement error. `extract-ambience.js` attaches `error.results` to any error leaving the batch for this.
  - Clips already muted by WTV are refused per clip, since they would render silent.
  - `button-state.js`: `restoreSpeech: busy || !factory`. `main.js` checks `/v1/health`'s `sidon` model on click and explains a stale service or a missing install (`sidonProblem`). The report goes into Copy report.
- **Service:**
  - `schema.py`: enhancer `'sidon'`.
  - `app.py`: `sidon_ready()`; health lists `{'id':'sidon','task':'speech_restoration'}` plus capability `sidon_restore_v1`. Submit gives a 409 naming `setup-sidon.bat` when Sidon isn't installed. `verify_model` checks both TorchScript files against `checkpoint_hashes`, and the runner gets `--models`.
  - Goes through the normal job and stage cache, so rerunning the same clip reuses the result. `service_version` is still 0.7.1, so no forced panel reconnect message.
- **Runner:**
  - `runners/sidon.py` (allowlisted in `worker.py`) plus the vendored `runners/sidon_features.py`.
  - Works in 25 s windows at 16 k, stepped every 20 s, with 5 s crossfades and 1 s of trailing silence per window so the decoder output always covers the window. Output is trimmed to exactly the input length at 48 k.
  - Dual-mono (channels within −90 dBFS) is restored once and copied. The model stays loaded between clips, and CUDA is required.
- **Setup:**
  - `setup-sidon.bat` → `scripts/setup_sidon.py` (stdlib).
  - Creates `work/sidon-env` (torch/torchaudio 2.8.0 cu128, numpy, soundfile).
  - Copies the model files from Derev-Test's HF cache, or downloads them at pinned revision `b3b02d8b…`, into `work/sidon-models`.
  - Runs a 3 s GPU smoke test through the real runner, then writes the `sidon` entry to `local-config.json`, keeping a `.bak-<time>` of the old file.
  - **Already run on Dan's PC 2026-09-29:** smoke test passed at 7.0 s including model load, 2116 MiB VRAM. Hashes: feature_extractor `c3739c33…`, decoder `a789c71f…`.
- **Validation:**
  - JS **345/345** (9 new restore tests plus 1 button-state test). Extract ambience's 12 tests are unchanged and pass.
  - Python: new `tests/test_sidon.py` (7 pass; the windowing test needs torch and passes in a torch env). The rest of the suite is unchanged, and the only failures are the two pre-existing music-analysis baseline tests.
  - `scripts/validate-restore.bat` on the 5080 ran the real service in-process on the 30 s Derev clip. The first run took 16.1 s (Sidon loaded, both channels restored), output length was sample-exact, lag −5 ms, finite, peak −2.0 dBFS. The repeat run was reused in 0.01 s. Output is in `validation/restore-speech/20260929-100454/`.
  - **Not yet checked live in Premiere:** the panel button, placement on the new track, muting originals.
- **To use:** restart the service (it must load the new config) and reload the panel, then Connect.

## Latest — Reset/preset coverage audited; quality default 1.5 (2026-09-28)

Confirmed qualityThreshold was stored in a standalone global key and omitted from Reset, preset persistence, settings files and Changed from defaults. It is now a normal portable per-preset field (range 1–5), with default **1.5** in panel markup, FACTORY_DEFAULT_VALUES, old-settings fallback, plugin scan fallback and service schema/analyzer. Removed the global-key reader/writer; reset clears that obsolete key. Older preset/settings files missing qualityThreshold load 1.5. Explicit values in newer files remain intact.

`resetActivePresetToDefaults()` now applies the complete FACTORY_DEFAULT_VALUES + active preset overrides through settingsFile.apply instead of maintaining a separate hand-written subset. Also collapses Dialogue quality. Natural retains MossFormer2; custom preset defaults overrides remain respected. Existing limited **Reset targets** remains limited to cleanup/levels; **Reset this preset to defaults** resets all portable fields. Connection URL/token, active preset/name, per-sequence duck-reference selection, other presets, timeline edits and results are intentionally not reset.

Audit tests execute the actual reset function against every field and check all input/select controls are covered except explicitly contextual controls. Added quality persistence, bounds and backward compatibility tests. **335 JS tests pass.** UI and service default now agree. Reload the panel; choose Reset this preset to defaults to reset existing saved values. No service restart needed for the panel's explicit threshold, but restart to pick up the new server fallback.


## Latest — Concise quality marker text (2026-09-28)

Marker titles now contain only the overall score to two decimals (e.g. `2.43`). Comments: `overall 2.43, speech 2.60, background 2.10. (Lower is worse)`. Red colour unchanged. Creation uses a temporary internal name, then renames during the colour transaction. Rerun ownership is stored separately by marker GUID, project path and sequence GUID in panel localStorage (memory fallback); legacy verbose markers for the matching clip scope are still recognized and replaced. Existing markers acquire the concise text when that clip is scanned again. GUID ownership requires Premiere 26.3+ (user is on 26.5); on older hosts or after clearing panel storage/moving projects between machines, renamed markers cannot be reliably matched and may remain on rerun. 11 quality tests pass including exact text and repeat replacement. Reload panel; no service changes.


## Latest — Quality scan corrected to selected clips; compact UI (2026-09-28)

Dan clarified that quality review must operate on selected timeline audio clips. Removed the track-number selector and long implementation/explanatory paragraphs. Options now contains the review threshold and one brief sentence. Main says to select dialogue clips.

`quality-pass.js` now snapshots enabled selected audio clips and refuses empty selection before any service/export operation. Each selected clip is isolated and rendered separately with bounded sequence in/out points (frame-aligned and read back), `exportFull:false`; EVERY other audio clip is disabled on the scratch, including unselected clips on the SAME track. Selected clip lengths must be 0.4 seconds–30 minutes. Server inference remains unchanged. Report times are offset back to the original timeline and clamped to the clip's visible boundaries. No gap or unselected audio gets markers. Entire batch analysis completes and timeline signature is rechecked before writing markers; progress spans the selected clips.

Reruns replace only the tool's markers for matching track/start/end clip scope, preserving markers for other clips even on the same track. Older whole-track quality markers are deliberately not auto-deleted; remove those old markers manually if present. Marker creation/colour failures can still leave a partial marker update (Undo available). No audio edits/imports.

Validation: 10 quality JS tests cover empty selection, unselected same-track exclusion, separate multi-clip exports, timeline offsets/clamping, scoped replacement, timeline changes, service cancellation and export retention. Full JS suite and 320px browser layout checked. Native Premiere behavior remains unverified. Reload panel; no service changes required for this correction.


## Latest — DNSMOS moved into the connected service (2026-09-28)

Supersedes the separate local CPU-helper implementation, which Dan asked to remove. **Check dialogue quality now requires the existing Connect session** and uses the same URL/token, authenticated asset uploads and request boundary as cleanup. No helper folder picker, standalone scripts, file queue or editing-machine Python requirement. Red duration-marker behavior and track/threshold controls remain.

- `service/quality.py`: retained verified DNSMOS P.835 CPU inference, bounded reads, stereo handling, calibration, silence gate and merged regions. Pinned model is lazily downloaded once into service data `models/dnsmos/sig_bak_ovr.onnx`; later scans need no Internet. CPU ONNX dependency added to `requirements.lock.txt` and installed in this workspace's existing `work/service-env`. Verified model copied into this workspace's service data directory from the earlier test installation. No GPU use or per-model worker switching.
- `service/app.py` + `schema.py`: authenticated POST/GET/DELETE `/v1/quality-jobs`, strict asset ID/threshold validation, one dedicated CPU executor, maximum two active/queued scans, bounded in-memory result retention (roughly 32). Progress and cancellation between windows; failures are explicit. Asset pins protect reads. Panel supplies `delete_asset_when_done:true` for its disposable upload; completion/failure/cancellation deletes it after releasing pins unless another job uses it. Service restart loses quality reports; user reruns. Health advertises `dnsmos_quality_v1`.
- `plugin/quality-pass.js`: checks capability before cloning/export, exports verified WAV into UXP temporary storage, uploads to the service, submits/polls job and validates result before markers. Cancellation sends DELETE to quality job (never the cleanup job). Confirmed local export deleted on all exits; uncertain export retained. Failed submission removes unclaimed uploaded asset best-effort. Network loss can prevent cancellation/cleanup requests; server-owned submitted disposable assets still clean up on completion. No audio imports or source edits.
- `main.js`, `index.html`, `local-api.js`: connection-gated button, removed helper setup UI/code, allowlisted exact quality routes. Threshold remains machine-local; track numbers intentionally blank on reload. Scores/marker semantics unchanged; clears old markers only for identical selected-track scope.
- Removed source: `quality-helper/helper.py`, helper README/requirements, `start-quality-helper.ps1`, `start-quality-helper.command`. Earlier ignored `.quality-env`, model and cache artifacts are inert and not used by the feature. Documentation now `research/DIALOGUE-QUALITY.md` (includes Microsoft notices); README and UXP quirks links updated. No version/ZIP change.

Validation: **328/328 JavaScript tests**, **7/7 quality Python/API tests** including actual ONNX CPU inference via authenticated service, cancellation, queue limit, asset pin/deletion, invalid requests and model failure. Broader `test_service.py`: 37 pass, one known pre-existing music-analysis baseline expectation failure (-4.9897 expected vs -8 actual); not changed. Live Premiere/M2 still unverified. Restart existing service and reload/reconnect panel to use. No server process restarted automatically.

**Existing deployment limitation:** `local-api.js` and service Host/bind policy remain loopback-only. Moving DNSMOS to the service does not itself enable a Mac to reach a different machine. Remote HTTPS/host support remains separate work; do not claim it is implemented.

## Latest — Presets area in Options is collapsible, collapsed by default (2026-09-26)

The Preset name box, Save as new preset / Delete this preset, and their help line now sit inside `#presetsSection`, under a **+ Presets** toggle (`#togglePresets`, same `section-toggle nested options-toggle` style as Levels & stems or Ducking).

- `main.js`: `setPresetsOpen = section('Presets', 'Presets', optionsUi.presets === true, …)` starts collapsed and remembers the open/closed state in `wtv-options-ui-v1`, like the other sections. `togglePresets` is added to the `makeButtonDiv` list.
- `resetActivePresetToDefaults()` preserves the Presets area's current open/closed state. It rewrites the options-UI blob, and it also runs when switching to a preset that has no saved settings yet; the area isn't a preset setting.
- JS suite 320/320. Collapsed state previewed in headless Chromium. Not checked live.

## Latest — User-created presets with custom names (2026-09-25)

Options → just above Save/Load settings: a **Preset name** box, **Save as new preset** and **Delete this preset**.

- **Save as new preset** copies the *current* settings into a new preset with that name, adds it to the top preset menu after the built-ins, and switches to it.
  - Its Reset target inherits the source preset's `defaults`, so a preset made from Natural (MossFormer) resets to MossFormer2.
  - Names are trimmed and whitespace-collapsed, 1–40 characters, and unique case-insensitively across built-in and custom presets.
- **Delete this preset** works on custom presets only; it's disabled on built-ins. UXP has no `confirm()`, so the first click arms the button ("Click again to delete") for 4 s and a second click deletes. Deleting removes the preset's saved settings key and switches to Camcorder.
- **Storage:** `localStorage` `wtv-custom-presets-v1` holds `[{id:'custom-…', label, defaults}]`. Each preset's settings use the existing per-preset key `wtv-last-settings-v1:<id>`, so remembering, Reset and "Changed from defaults" work unchanged.
- **Files:**
  - New `plugin/custom-presets.js`: pure helpers (`validateNewName`, `parseCustomPresets` which reads malformed data defensively, `makePresetId`, `isCustomPresetId`).
  - New `tests/custom-presets.test.cjs` (5 tests).
  - `main.js`: `allPresets()`, `renderPresetOptions()` (rebuilds `#presetSelect`), `updatePresetButtons()`, and `createPreset` / `deletePreset` actions.
  - `index.html` and `style.css`: the new controls, plus `.preset-name-row`.
  - The Reset tooltip no longer says "the other two presets".
- **Checks:**
  - JS suite 320/320.
  - The real preset code from `main.js` was also run in headless Chromium against the actual `index.html`: create from Natural, duplicate rejected, two-click delete, menu rebuilt each time.
  - **Not checked live in UXP**, notably that UXP's `<select>` redraws after its options are rebuilt. If the menu looks stale after creating a preset, that's the first suspect.
- Custom presets live in this panel's local storage only. They aren't written to Save-settings files and aren't shared between machines.

## Latest — New preset "Natural (MossFormer)" (2026-09-25)

A fourth project preset, `id: 'natural'`, label **Natural (MossFormer)**, whose factory default model is **MossFormer2** instead of GAP-URGENet. Everything else starts at the same factory defaults as the other presets, and like them it remembers its own last-used settings.

- `main.js`: `PRESETS` entries can now carry `defaults` overrides; Natural has `{enhancer:'mossformer2'}`. New `presetOverrides(id)` / `presetDefaults()` helpers.
  - Both "reset" paths (`resetActivePresetToDefaults()` and the targets-only `reset` action) now call `showSettings(presetDefaults())` instead of `panelDefaults`.
  - `updateChangedSettingsList()` compares against the active preset's defaults, so on Natural, MossFormer2 isn't listed as a change.
  - The reset-all message no longer hard-codes "Promo/Action and Interview"; it now says "Other presets are unaffected".
- `index.html`: new `<option value="natural">` in `#presetSelect`.
- Checked: the helpers were extracted and run under Node (promo/interview/camcorder → gap_urgenet; natural → mossformer2). JS suite 315/315.
- Not checked live. MossFormer2 must show as available after Connect, or cleanup reports the model as unavailable (the same check as picking it by hand).

## Latest — Main tab simplified: one Clean Dialogue button, music buttons merged (2026-09-25)

At Dan's request (this supersedes the menu-button entry below):

- **Steps 1–3 buttons and their menu removed.** The single `#runCleanDialogue` button is now labelled **Clean Dialogue**, or **Resume Clean Dialogue** when an interrupted per-clip export batch has progress (`button-state.js` `runLabel`, replacing `prepareLabel`). It runs whichever of prepare / process / apply are due.
  - It now works in **Full sequence mode** too. Before, Run refused that mode and it was only reachable through the step buttons. The "prepared" check after `doPrepare()` accepts `context.exportPath` (full sequence) as well as `context.prepared` (per clip).
  - `button-state.js`: `runCleanDialogue` no longer requires per-clip mode. `shouldOpenCoreSteps` removed. `prepare`/`process`/`apply` states are still computed because Clean Dialogue uses them internally to decide what's due. Hints now point at the Clean Dialogue button.
  - `main.js`: removed the `prepare`/`process`/`apply` action registrations and all DOM references to them, `setCoreStepsOpen` and its menu, and the step-label code in `updateWorkflow()`. `doPrepare`/`doProcess`/`doApply` are kept.
- **Conform & duck music now also normalizes.** The "5. Normalize music levels" button is removed, and its action now runs at the end of `action('musicPass')`, in two stages:
  1. **Duck:** unchanged.
  2. **Normalize:** `normalizeMusic.run()` on the same selection. It runs second because it inserts its compressors before the earliest Amplify and preserves the duck keyframes just written.
  - Ducking restores the active sequence after its analysis clone and doesn't touch the selection, so Normalize sees the same selected clips.
  - If Normalize fails, the error says ducking *was* applied. `lastMusicReport` gains `normalized` / `normalized_clips` / `normalize_error`.
  - Trade-off: Normalize can no longer run on its own, e.g. on music with no dialogue to duck against, or during an unapplied Clean dialogue batch. Add an Options toggle if Dan needs it.
- **Labels and colour:** numbers removed ("Conform & duck music"). Conform & duck music is **green** (`.step4` now uses `#3d8f6f`, the old step-2 green). New Main layout:
  - Clean Dialogue (full width)
  - Conform & duck music | Fix a pop
  - Unmute | Select muted
  - Extract ambience | Verify loudness (loudness result text directly below)
- **Wording:** user-facing messages that said "Prepare again / a new batch", "Click Prepare", "step 1/2/3" or "retry step 2" now refer to Clean Dialogue. Changed in `per-clip.js`, `premiere.js`, `wav.js`, `click-pop-report.js` and `main.js`.
- **Tests:**
  - `button-state.test.cjs`: full sequence mode now enables Clean Dialogue; new Resume-label test.
  - `per-clip.test.cjs` and `click-pop-report.test.cjs`: message regexes follow the new wording.
  - JS suite: 315/315.
- **Checked:** layout previewed in headless Chromium at 300 px. **Not checked live**, including Full sequence mode through the single button (its process stage still opens the "choose the exported WAV" picker) and the combined duck-then-normalize on real music.
- `README.md` still describes the old numbered steps; not updated.

## Latest — Run clean dialogue always visible; steps 1–3 behind a menu button (2026-09-25)

At Dan's request, the "− Clean dialogue" collapsible group header is gone. **Run clean dialogue (steps 1–3)** now sits permanently at the top of the group, with a small three-bar menu button (`#toggleCoreSteps`) on the same row. That button shows or hides `#coreStepsSection`, which now holds only 1. Prepare exports / 2. Clean audio / 3. Add clean tracks.

- **`index.html`:** a new `.run-row` wraps `#runCleanDialogue` and the menu button. The button's bars are three `.menu-bar` spans, drawn in CSS like the folder icon, so there is no font or glyph dependency.
- **`style.css`:** removed the `.workflow-steps-toggle` Show/Hide header rules. `.run-row` is its own flex row, deliberately not `.step-row`, whose flex:1 squashes small icon buttons (UXP-QUIRKS §5). Added `.steps-menu-btn`: a lighter background while open, grey bars while disabled.
- **`main.js`:** `setCoreStepsOpen` is now a small dedicated function instead of `section()`, because `section()` rewrites the button's text and would wipe the bars.
- **When the menu opens and closes:**
  - Closed at startup (mode always starts per-clip).
  - Opens when Mode switches to Full sequence (Run is per-clip only, so the steps are the only way to work there) and closes when switching back.
  - Still auto-opens when a per-clip batch is prepared but not applied (`shouldOpenCoreSteps`), e.g. a Run that stopped part-way, so it's clear where to continue.
  - Still closes after step 3 completes.
  - No longer forced open when Run or step 1 starts.
- **Checks:** JS suite 314/314. The layout was previewed in headless Chromium at 300 px wide with the menu open and closed; it looked right. UXP rendering may differ slightly and has **not been checked live**.

## Latest — Verify loudness always renders fresh; render cache removed (2026-09-25)

Live: Dan ran Verify loudness with two tracks soloed, un-soloed them, and reran it. The rerun said "Reused the previous render" and reported the soloed mix. The cache key was sequence id, channels, `host.signature()` and `effectSignature()`, and none of those can see solo. That isn't fixable: Premiere's UXP `AudioTrack` exposes only mute. There is no solo, track volume/pan or track-effects read (checked against Adobe's reference, and now noted in `research/UXP-QUIRKS.md` §4). Because the cache can't be made safe, it's gone, as Dan suggested.

Changes:
- `plugin/loudness-pass.js`: removed `cache` / `cachedRender` / `dropCache` / the `_dropCache` export and the reuse branch. Every run exports and analyses afresh. Streaming analysis is unchanged, so a run still takes about as long as Premiere's render.
- `run()` now deletes the finished render in a `finally`, on success *and* failure. An unconfirmed render (cancelled or timed out mid-export) is still left alone, because Premiere may be writing it. `render` in the result is now `streamed` or `rendered`, never `reused`.
- `plugin/main.js`: dropped the "Reused the previous render" status note.
- `tests/loudness-stream.test.cjs`: the reuse test is replaced by "every run renders afresh on an unchanged timeline, and each render is deleted once measured".
- `tests/loudness-pass.test.cjs`: back to expecting deletion after a successful run.
- `research/UXP-QUIRKS.md` §4 gains three entries from today: Amplify's mono/stereo parameter layout, mixer state being invisible to the API, and `TrackItemSelection` being valid only inside its callback.
- Full JS suite on the exact disk contents: 314/314.

Note for users: Verify loudness measures what Premiere exports *right now*, including any solo or mute. Clear solos before a final check.

## Latest — Regression audit: what reverted files, and the true test baseline (2026-09-25)

Dan asked whether UXP Developer Tool could be reverting files, and asked for a check for other regressions.

**Not UXP Developer Tool.** UDT only reads and watches the plugin folder in order to load it. It doesn't write source files, and the reverted files included `tests/` and `HANDOFF.md`, which UDT never touches. The timestamps point elsewhere:

- `plugin/mute-tools.js` / `tests/mute-tools.test.cjs` got their pre-fix content back with mtime **2026-09-25 17:44:14 UTC**. That is the exact second the Select-muted fix was committed from the cloud session.
- HANDOFF.md lost its "Select muted fixed" entry with mtime **17:44:34 UTC**, which was also that session's commit.

The cloud session's save-back therefore wrote an **older copy** of those files. The likely cause is copying files into the session's outputs area with a shell `cp` and committing seconds later, before the copy had registered, so the previous version was sent. The same thing probably happened on 2026-09-22 to `tests/button-state.test.cjs` (its hint assertion was back to `/offline/`). Mitigation, now standard practice for this project: **after every commit, re-read each written file from disk and byte-compare it with the intended content.** **Reproduced directly during this audit:** `tests/per-clip.test.cjs` was committed seconds after being copied into place. It landed on disk with a fresh mtime but its previous content (54,421 bytes, no `IN_TX` guard). Re-committing about 25 s later wrote the correct 55,437-byte file, confirmed by hash. So the cause is the save-back racing a just-copied file, not anything on Dan's machine. All files committed on 2026-09-25 were checked this way and match.

**Other regressions found:**
1. `tests/per-clip.test.cjs` had lost the 2026-09-22 guard described in "Native Apply gain error diagnosed and fixed". **Restored.** The Amplify mock now starts time-varying and throws "The script object is no longer valid." if `createSetValueAction` runs outside a transaction build callback, or before static mode is committed; `executeTransaction` sets `IN_TX` while building. Verified to catch the bug by reintroducing the old pattern in a throwaway copy of `per-clip.js`: 3 tests then fail with the exact live error.
2. `tests/loudness-pass.test.cjs` still expected Verify loudness to delete its render after a successful pass. The render cache (see the "Speed" loudness entry) deliberately keeps it. Only the assertion was updated; code unchanged.
3. `tests/button-state.test.cjs` (`/offline/`) was already fixed in the Fix a pop entry above.

**Correction to earlier entries today:** the "12 stale `lowend.test.cjs` failures" were **not real**. The cloud session was running an out-of-date local copy of that test. The copy on disk already provides `./local-dsp.js`, and all its tests pass. Ignore those notes in the entries above.

**True baseline:** the full JS suite, run on a fresh copy of exactly what is on disk (plugin, tests, WAV presets, `validation/music-local-parity.json`), is **314/314 passing**. Python service tests were not run in this audit.

## Latest — Fix a pop enabled by default and works on any clip, not just Clean dialogue (2026-09-25)

Dan asked for Fix a pop to stop being greyed out by default and to work on any clip, independently of Clean dialogue.

`deplosive.js` already had a standalone path: with no applied session it reads rate and channels from the active sequence, and it has always acted on whichever single clip is selected. Only the gating blocked it:

- `button-state.js`: `fixPop` is now just `busy`, the same as Unmute and Select muted. It was `busy || !context || !context.applied || failedApply`.
- `main.js`: removed the leftover `if (!factory) throw 'Connect first'` from the Fix a pop action. It hasn't used the service since the 2026-09-22 in-panel move.
- `deplosive.js`: text only. The header comment and user-facing messages no longer say "dialogue clip" or "Clean dialogue track", because it's any clip now. When a session exists it still adds the fixed file to `context.dialoguePaths`, so ducking keeps treating a pop-fixed Clean dialogue clip as dialogue.
- `index.html`: the tooltip now says it works on any clip, with or without Clean dialogue.

Tests:
- `button-state.test.cjs`: Fix a pop is enabled with no session and after a failed apply.
- `deplosive.test.cjs`: new `run(null, …)` case, covering a fresh panel with no session and a plain selected clip.
- **Another reverted file:** `button-state.test.cjs` on disk still expected the old "works offline" hint text, which was updated earlier today. That is the same regression pattern as `mute-tools.js`, and it has been corrected again.
- JS suite: 133 pass, 12 fail. All 12 failures are the known stale `lowend.test.cjs` cases.

Not yet run live on a raw, non-Clean-dialogue clip.

## Latest — Folder button gets a folder icon and clearer hover text (2026-09-25)

The destination-folder button (top of Main) only showed a folder name, so it wasn't obvious what it does. Changes:

- It now shows a small folder glyph before the name. The glyph is drawn with two CSS boxes, a tab and a body, in `style.css` (`.folder-icon*`), so it needs no image or font and renders the same in any UXP build. It turns grey when the button is disabled.
- The name lives in a new `#destinationFolderName` span. `main.js`'s `updateDestinationFolder()` now writes to that span instead of `btn.textContent`, which would otherwise wipe out the icon.
- The hover text on a real folder now reads "Open export folder in File Explorer" followed by the path; before it was just the bare path.
- The button's static markup now has a default title. That also fixes the long-standing `panel-help` "empty tooltip" test failure.
- JS suite: 132 pass. The 12 remaining failures are the stale `lowend.test.cjs` cases noted above.

Not yet checked live: confirm the icon sits vertically centred next to the name at the panel's normal width.

## Latest — v0.8.1: Enhance low end button hidden; Extract ambience / Unmute / Select muted rearranged (2026-09-25)

At Dan's request:
- **Enhance low end button removed from the panel, for now.** In `index.html` the row that held Enhance low end now reads *5. Normalize music levels | Extract ambience*. The next row reads *Unmute | Select muted*, and Verify loudness sits below that as before.
- In `main.js`, the `enhanceLowEnd` action handler, its `makeButtonDiv` / busy-list / `updateActions` entries and the `lowend.js` require are removed or commented out. `lowend.js`, `local-dsp.js`'s `enhanceLowEnd`, and `button-state.js`'s `enhanceLowEnd` state (still covered by button-state tests) are kept, so it can come back by restoring the markup and the handler. The comment at the old handler's spot says exactly what to restore.
- **Version is now 0.8.1** in `manifest.json`, the panel heading, the Copy report header, `settings-file.js` `plugin_version`, and `local-api.js`'s network-permission hint, plus that hint's test regex.

Checks: `node --check` is clean on all plugin JS, `manifest.json` parses, and the full JS suite is at 131 pass / 13 fail. All 13 failures are old and unrelated to this change:
- 12 in `lowend.test.cjs`. Its mock doesn't provide `./local-dsp.js`, which `lowend.js` has needed since Enhance low end moved in-panel on 2026-09-22.
- The known `openDestinationFolder` empty-tooltip case in `panel-help.test.cjs`.

`panel-help`'s "every registered panel button exists in the markup" passes, confirming no dangling `enhanceLowEnd` reference. **Reload the plugin in UXP Developer Tool.** It should list 0.8.1.

## Latest — Mono raw clips: Amplify's gain slider is "Gain", not Left/Right; fixed from the live param list (2026-09-25)

Add clean tracks failed twice on mono raw clips while muting the raw lane (first `C0062.wav`, then `Greg recording end.wav`). The second run's improved error printed the real Amplify parameter list on a mono clip:

```
Bypass, Channel Count, Link Sliders, Gain, param 4 … param 34 (unnamed), Link Keyframes
```

So Amplify has 32 channel-slider slots. Only the ones in use get a display name: "Gain" on mono, "Left"/"Right" on stereo (the stereo names were confirmed live 2026-09-22). The unnamed ones are hidden, unused channels. `setClipGains` only matched Left/Right, so every mono clip failed. The first attempted fix ("use the single leftover non-Bypass param") was wrong: Channel Count, Link Sliders, the 31 unnamed slots and Link Keyframes are all leftovers too.

Fix: new dependency-free `plugin/amplify-params.js` → `amplifyGainParamIndexes(component)`. Rule: a gain slider is any **named** parameter that isn't one of Amplify's controls (`Bypass`, `Channel Count`, `Link Sliders`, `Link Keyframes`). That covers mono, stereo and any other named layout without guessing channel names. `per-clip.js`'s `setClipGains` and `mute-tools.js`'s `findMuteAmplify` (Unmute / Select muted by value) both use it now, so they can't drift apart again. When nothing matches, the error still lists every parameter name.

Tests:
- `tests/per-clip.test.cjs`: `mockAmplifyMono()` now reproduces the real live layout (Gain at index 3 among controls and 31 unnamed slots). The mono test asserts only Gain is set to -96 dB and controls and hidden slots are untouched.
- Also fixed a stale mock: `mockAmplify`'s `createKeyframe` was `async`, but since the 09-22 fix `setClipGains` calls it synchronously, as the real API is. The key was therefore a Promise and every Amplify-silence test failed with "read back {}". The previous entry wrongly called that a sandbox artifact.
- Removed the two Mix on timeline tests (`mixGains`, `timeline mix`), which were still in the file on disk even though an earlier entry records that they were removed along with the feature.
- `tests/mute-tools.test.cjs`: new mono Select muted case, with a -96 dB mono clip selected and a -6 dB mono clip ignored.
- Result: per-clip 52/52, mute-tools 8/8, button-state 17/17. `node --check` is clean on everything touched.

**File regression noticed**: at the start of this fix, `plugin/mute-tools.js` and `tests/mute-tools.test.cjs` on disk were back to their pre-Select-muted-fix versions (`selection` pulled out of the callback, one-arg `addItem`), although that fix had been committed. HANDOFF.md had also lost an entry at one point, and the per-clip test file still had the removed mix tests. Something may be writing older copies back into this folder, such as a second editor or agent, a sync tool, or a restore. Both files are re-committed with the fix. Check that `mute-tools.js` contains `sel.addItem(entry.item, false)` inside the `createEmptySelection` callback before you run Select muted.

**Not yet confirmed live.** Rerun steps 1–3 on the Greg / C0062 clips. Then check in Effect Controls that the raw clip's Amplify reads -96 dB on its Gain slider.

## Latest — Select muted fixed: nullptr crash from using TrackItemSelection outside its callback (2026-09-25)

Live within minutes of shipping the entry just below: Unmute worked first try (9 clips unmuted cleanly). Select muted crashed every attempt with `A nullptr was dereferenced` at `mute-tools.js:126` (`sequence.setSelection(selection)`).

Root cause, found by re-reading Adobe's UXP reference for `TrackItemSelection` more carefully than the first pass: `createEmptySelection((selection) => void): boolean` is explicit that *"the selection object is valid for the lifetime and scope of the callback; it's not recommended to extract or use the selection object from outside the callback."* The original code did exactly that -- `let selection; createEmptySelection(sel => { selection = sel; }); /* ...later... */ selection.addItem(...); sequence.setSelection(selection);` -- extracting the object and using it after the callback returned. Compounding it, `addItem(trackItem, skipDuplicateCheck: boolean)` has a second, required parameter the original code never passed at all.

This is notable because `premiere.js`'s `stripAudioTransitions()` uses the exact same extract-then-use-later pattern (`let selection = null; ppro.TrackItemSelection.createEmptySelection(sel => { selection = sel; }); ... selection.addItem(t); transaction(project, ..., c => c.addAction(editor.createRemoveItemsAction(selection, ...)))`) and is documented elsewhere as working live. Whether that call site is silently getting lucky (no await between creation and use, unlike here) or whether `setSelection` specifically is pickier than `createRemoveItemsAction` about the object's lifetime is unconfirmed -- worth flagging if `stripAudioTransitions` ever misbehaves, but out of scope to touch now since it works.

Fix: `selectMuted()` now builds the selection, adds every item (with the required second arg), and calls `sequence.setSelection(sel)` all **synchronously inside** the `createEmptySelection` callback -- following Adobe's documented contract instead of working around it. `tests/mute-tools.test.cjs`'s mock `TrackItemSelection.createEmptySelection` now also enforces the two-arg `addItem` signature. All 7 tests still pass; `node --check` clean.

**Not yet re-verified live** -- Dan should retry Select muted on the same sequence (the 9 clips he just unmuted are gone now, but the "select muted" test needs at least one clip still muted by the Amplify workaround to select).

## Latest — Unmute + Select muted buttons added (2026-09-25)

Dan decided to keep the -96 dB Amplify mute workaround (see per-clip.js's `apply()` comment: disabling an audio clip item linked to video also disables the video, live 2026-09-17, so a partial in-place lane silences via Amplify instead of `createSetDisabledAction`). He'd first floated replacing it with disabling the track, then asked about unlinking audio from video first -- confirmed against Adobe's official UXP reference (`AudioClipTrackItem`, `TrackItem` (404'd), `SequenceEditor`) that **no link/unlink action exists in the API at all**, so that route is closed. Decision: keep the Amplify mute, add UI to reverse and locate it, since a muted clip isn't visually obvious on the timeline.

New file `plugin/mute-tools.js`, standalone (no WTV session/context needed, like `lowend.js`'s Enhance low end -- works on whatever's selected/on the sequence regardless of workflow state):

- `unmute({say})`: for every currently-selected clip, finds the muting Amplify (detected by a Left/Right param reading at AMPLIFY_MIN_DB, not just by the `· WTV muted` name suffix -- the suffix is a best-effort cosmetic rename per `setClipGains`'s own comment, so a clip can be muted with no suffix if that rename failed) and removes it via `AudioComponentChain.createRemoveComponentAction(component)` (confirmed against Adobe's UXP reference: `createAppendComponentAction`/`createInsertComponentAction`/`createRemoveComponentAction`, all since 25.6), stripping the suffix in the same transaction. Throws if nothing selected is muted.
- `selectMuted({say})`: scans every audio track on the *entire active sequence* via `per-clip.js`'s `inventory(sequence)` with no `{tracks}` filter, finds every clip muted the same way, and calls `Sequence.setSelection(trackItemSelection)` to make them the visible timeline selection -- confirmed via Adobe's UXP reference that `Sequence` has `getSelection()`/`setSelection()`/`clearSelection()`, and `setSelection` is synchronous (boolean return) as of Premiere 26.3. Selection group built with the existing `ppro.TrackItemSelection.createEmptySelection(cb)` + `selection.addItem(item)` pattern already used in `premiere.js`'s `stripAudioTransitions()`, just for setting the selection instead of feeding a removal action.

Wired into `main.js` (`action('unmuteClips', ...)`, `action('selectMuted', ...)`, both added to the busy-disable list and `updateActions()`), `button-state.js` (`unmuteClips: busy`, `selectMuted: busy` -- no `factory`/context dependency, same category as `enhanceLowEnd`), and `index.html` (both buttons placed next to Extract ambience, per Dan's request).

Tests: new `tests/mute-tools.test.cjs`, 7 cases (remove Amplify + strip suffix; find-by-value fallback when the suffix is missing; ignore a selected-but-unmuted clip; require a selection; leave an unrelated effect alone; `selectMuted` scans the whole sequence including unselected clips and calls `setSelection` with the right count; throws when nothing is muted). All pass. `node --check` clean on every changed file.

**Not live-tested against real Premiere** -- `createRemoveComponentAction` and `Sequence.setSelection` are both confirmed against Adobe's official reference docs but neither has been exercised live in this codebase before now (contrast with `createSetValueAction`/`createAppendComponentAction`, which are already proven live elsewhere in `per-clip.js`). Recommend Dan runs Clean dialogue on an in-place partial lane to produce a muted clip, then tries Unmute on it and Select muted across the sequence, and confirms both behave as expected before relying on them.

## Latest — Same "script object no longer valid" bug found and fixed in Normalize music levels (2026-09-22)

Dan hit the same failure class again, this time from **Normalize music levels**, ~60s after a successful Music ducking run on the same 21-clip sequence:

```
The script object is no longer valid. 0/21 clips completed. Failed clip restored.
    at Object.run (plugin/normalize-music.js:180:13)
```

This is a *different* call site than the one just diagnosed and fixed below ("Native Apply gain error diagnosed and fixed") -- that fix was in `per-clip.js`'s `setClipGains`. This one is in `plugin/normalize-music.js`'s `configure()`/`run()`, and turned out to be the exact same root cause: `ComponentParam.createSetValueAction(key, true)` was being built into an `actions` array *before* the `host.transaction()` call that committed it, instead of being created synchronously inside the transaction's build callback. Per the just-below entry's finding (confirmed live against Premiere 26.5.1, with an Adobe forum reproduction/workaround linked there), that ordering throws "The script object is no longer valid" on this host version.

Fix, mirroring `per-clip.js`'s `setClipGains` exactly: `configure()` was replaced with `plan()`, which only *reads* param state (time-varying? does the value already match?) and returns plain `{index, value}` descriptors -- no handles held across a transaction boundary. `run()` now does this in three phases per clip: (1) commit any needed `createSetTimeVaryingAction(false)` calls, then re-fetch fresh component/param handles by index; (2) build `{param, value}` pairs from those fresh handles, then inside a single `host.transaction(...)` build callback, synchronously call `param.createKeyframe(value)` and `param.createSetValueAction(key, true)` together, exactly where the working `per-clip.js` code does it; (3) re-fetch fresh handles again and `verify()` as before. `verify()` itself was untouched (read-only, never held a stale handle to begin with).

`configure` was a named export (`module.exports`); no other file called it directly (`main.js` only calls `normalizeMusic.run()`), so it was safely renamed to `plan` in the export list too.

Tests: existing 6/6 in `tests/normalize-music.test.cjs` still pass unchanged (the mock doesn't simulate real UXP staleness, so it couldn't have caught this on its own). Added a 7th, `tests/normalize-music.test.cjs`'s new regression test: the mock's `host.transaction` now tracks whether its build callback is actively running, and `createKeyframe` records that state on every call; the test asserts every recorded call happened inside a transaction. This test would fail against the old `configure()` code (which built actions -- including the `createSetValueAction` call -- before the transaction existed) and passes against the fix, so it's a real regression guard, not just a rename check. `node --check` clean.

**Not live-tested against real Premiere** -- this is a code-level fix following the pattern the previous diagnosis validated live, but this specific file/path hasn't itself been run against the real host yet. Recommend: Dan reruns Normalize music levels on the same sequence (or any selection) that failed, and confirms it completes and the applied compressor settings read back correctly.

Given this is now the **second** independent call site hit by the same bug class in one day, it's worth a quick audit of the rest of the codebase for any other place that builds a `ComponentParam` value/keyframe action outside a `host.transaction` callback and commits it later -- `music-effects.js`, `music-pass.js`, and `music-bed-compress.js` all touch native component params and haven't been checked for this pattern yet.

## Latest — Native Apply gain error diagnosed and fixed (2026-09-22)

Used the open UXP Developer Tools against Premiere 26.5.1 with Dan's permission. Actual retained error was Add clean tracks / setClipGains on Bear Multicam Day1, during raw silencing after placement, not the pop/low-end changes. Console probes pinpointed `ComponentParam.createSetValueAction(key,true)` throwing "The script object is no longer valid" while constructing the action OUTSIDE a transaction. Fresh parameter lookup and synchronous keyframe construction did not fix it. Left was time-varying, but committing static mode and refetching also failed when value action was still constructed outside the transaction. On a disposable clone, constructing the SAME action inside host.transaction succeeded and read back `{value:0}` (normalized -96 dB), with isTimeVarying false. Diagnostic clone was removed successfully; original user sequence's pre-existing failed Apply/muted tracks were not repaired or removed. No project save issued.

`per-clip.js setClipGains`: commit static-mode actions as a batch; reacquire all clip/chain/component handles; require static readback; prepare keyframes outside locks; create value actions INSIDE host.transaction's synchronous compound callback, then verify values through fresh handles. This preserves the previous music-effects caution: do NOT create keyframes or await operations inside lockedAccess. It changes static action construction only. No other effect tools changed.

52 per-clip tests pass. Amplify mock now starts time-varying and refuses value-action construction outside transaction or before static mode commits. Native isolated gain mutation/readback confirmed; full Add clean tracks rerun remains untested. UDT was in Watching/Debugging state, so a reload may already have occurred; reload the panel before a new run if necessary. Plugin-only, no service restart/version/ZIP change.

Reference: https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/componentparam documents static parameter requirement; related Adobe forum reproduction/workaround: https://community.adobe.com/questions-729/premiere-pro-26-3-regression-componentparam-createsetvalueaction-throws-the-script-object-is-no-longer-valid-1628867 . Local native probe is the evidence for this installed host.


## Latest — Fix a pop and Enhance low end now run entirely in-panel, no service (2026-09-22)

Dan asked for Fix a pop and Enhance low end to work without going through `127.0.0.1`, with an eye toward Mac support and a hint that UXP might help. New `plugin/local-dsp.js` ports both algorithms to pure JS (a hand-written WAV codec plus both DSP routines) and `plugin/deplosive.js`/`plugin/lowend.js` now call it directly instead of `/v1/deplosive`/`/v1/lowend` -- no upload, no download, no service dependency for either feature. This follows directly from [research/REMOTE-SERVICE-READINESS-2026-09-22.md](research/REMOTE-SERVICE-READINESS-2026-09-22.md), which flagged these two as the only genuinely portable endpoints (`/v1/jobs` still needs a GPU and stays server-side).

Deliberately **not** built on the Web Audio API (`OfflineAudioContext`/`BiquadFilterNode`), despite Dan's hint that UXP's webview might expose it: this environment can't confirm what Web Audio surface Premiere's UXP host actually provides, and this project doesn't ship code that assumes unverified host behavior (see UXP-QUIRKS.md's whole reason for existing). A pure-JS implementation has zero host-API dependency either way, which also happens to be the safest path to Mac support since it isn't OS-specific at all. If Dan can confirm live in the panel that Web Audio is present and stable, swapping the filter/oversampling internals for it later is a reasonable follow-up, not a blocker.

Fidelity:
- **Fix a pop / `attenuatePop`**: a direct line-by-line port of `service/deplosive.py`'s RMS-envelope walk + attack-hold-release gain envelope. No external dependency, no algorithmic simplification -- same constants, same math, should behave identically to the old service call.
- **Enhance low end / `enhanceLowEnd`**: **not** a bit-identical port. `service/lowend.py` filters with a true 2nd-order Butterworth bandpass (scipy `butter()` + `sosfiltfilt`); hand-deriving an exact Butterworth SOS design (analog prototype -> lp2bp -> bilinear transform) was judged too easy to get subtly wrong with no scipy reference available here to check against. Used the RBJ Audio EQ Cookbook's bandpass biquad instead (same 150-500Hz band, same constant-skirt-gain intent), applied zero-phase via a hand-written mirror-padded filtfilt, plus a naive 4x linear-interpolation true-peak estimate in place of `resample_poly`. Same band, same safety ceiling (-1 dBFS), **not guaranteed sample-identical** -- recommend an A/B listen against the old server-side output before treating this as a drop-in replacement.

Also fixed: `plugin/lowend.js`'s clone-identification had the same nest/multicam bug `deplosive.js` was fixed for earlier today (a plain before/after `listSequences()` diff, which misses a clone made while editing inside a nest -- see UXP-QUIRKS.md #1). Now goes through `host.identifyNewSequence()`/`snapshotProjectItems()` the same way.

`plugin/button-state.js`: `fixPop` and `enhanceLowEnd` no longer require `factory` (a live service connection) in their disabled conditions, since neither talks to the service any more. `fixPop` still requires an applied WTV session with a Clean dialogue clip in place (a workflow-state requirement, unrelated to the service). `extractAmbience` is unchanged -- it's model-based and still needs the service.

Files: new `plugin/local-dsp.js`; edited `plugin/deplosive.js`, `plugin/lowend.js`, `plugin/button-state.js`; new `tests/local-dsp.test.cjs` (WAV codec round-trip, both DSP routines); `tests/deplosive.test.cjs` and `tests/lowend.test.cjs` both rewritten to synthesize real audio and exercise the actual in-panel DSP path instead of mocking `/v1/deplosive`/`/v1/lowend` (each also asserts `request` is never called); `tests/button-state.test.cjs` updated for the dropped `factory` requirement. `service/deplosive.py`/`service/lowend.py` and their `/v1/deplosive`/`/v1/lowend` routes are untouched -- left in place for now (still reachable, just unused by these two panel features) rather than removed, in case Dan wants a fallback or the service is reused elsewhere.

Validation: 29/29 in `tests/deplosive.test.cjs`, 13/13 in `tests/lowend.test.cjs`, 7/7 new in `tests/local-dsp.test.cjs`, full `tests/*.test.cjs` suite (122 tests) otherwise green except one **pre-existing, unrelated** failure noted for the record, not touched here: `tests/panel-help.test.cjs`'s `openDestinationFolder` hover-description check (unrelated markup gap). Also found and fixed in passing: `deplosive.test.cjs` had a stale assertion referencing an "Insert clean dialogue first" message that doesn't exist anywhere in the code -- rewritten to match `run()`'s actual standalone-context behavior instead of deleting it. `node --check` clean on all new/edited files. **Not live-tested against a real Premiere/UXP host** -- neither the WAV codec against Premiere's actual export bit depth (all of PCM 8/16/24/32 and float 32/64 are supported, since the `.epr` preset's exact format couldn't be confirmed by inspection) nor the RBJ-vs-Butterworth Enhance low end output against a real ear. Recommend: run both features live, and specifically A/B the new Enhance low end output against a saved pre-change result if Dan has one.

## Latest — Mixed batches grouped by model (2026-09-21)

Approved fix for repeated Bandit/GAP reloads across 156 clips. `clip-batch.js` now performs a native dialogue-cache pass for ALL raw exports first (GAP or MossFormer), then runs normal mixed jobs with Bandit and required cached dialogue. Both receive the SAME RAW upload; never feed cleaned dialogue to Bandit. First pass returns before dialogue finishing; final jobs retain the existing joint normalization/ducking/peak protection. This avoids independently finishing stems or changing the mixing behavior. Dialogue-only and no-enhancer batches retain their original path. One model remains resident; no concurrent inference or increased model residency budget. One model switch expected for a cold uninterrupted mixed batch absent other clients/idle expiration.

Service JobRequest adds `stage_mode: dialogue_cache|complete` and `require_dialogue_cache`; health advertises `grouped_model_batch_v1`. Stage-only jobs always recheck native cache (don't trust old done-job records), return no downloadable stems, and persist checksummed native outputs using the existing StageCache. Final jobs fail if required dialogue cache disappears/changes, rather than reloading GAP during Bandit phase. Retry Clean audio reruns phase scheduling and reuses native cache. Raw asset IDs reused within this run; phase records/timings persisted in clip manifest. Service-managed asset retention unchanged. First-phase upload/cancel follows job cancellation; progress/ETA now resets between labelled "1/2 Dialogue cleanup" and "2/2 Stems and finishing". Earlier full-result file reuse still works in finishing phase; first pass may recheck/warm dialogue cache even for clips whose final files could later be reused.

**Restart service and reload plugin after current work finishes.** Old service rejected with explicit restart guidance before grouped uploads. Do not restart an active inference job automatically. Version remains 0.8.0; ZIP not rebuilt. Validation: 22 focused JS tests pass; 37 service tests pass (known unrelated music-analysis baseline expectation excluded). Integration test proves GAP/GAP/Bandit/Bandit order, both inputs equal raw samples, native cache reuse on retry, missing-cache failure without GAP reload, and sample-identical final stems vs the original finishing path with mocked model outputs. Cancellation after submission tested. No real-GPU throughput measurement performed, so no promised speedup or completely flat VRAM graph. Historical cold/warm measurements support this direction; actual inference still allocates working memory per block.


## Latest — Remote-service readiness: design notes (2026-09-22)

Dan noted `http://127.0.0.1:8756` will eventually be a remote server and asked to develop with that in mind -- not a code change, a request to document the tradeoffs before making any. Wrote [research/REMOTE-SERVICE-READINESS-2026-09-22.md](research/REMOTE-SERVICE-READINESS-2026-09-22.md). Key points: (1) `plugin/local-api.js`'s `normalizeBaseUrl()` currently hard-rejects any host but `127.0.0.1`/`localhost:8756` -- a real blocker, and HTTPS has to become mandatory in the same change (the Bearer token is sent over plain HTTP today, fine only because it never leaves the machine); (2) `/v1/deplosive` (Fix a pop) and `/v1/lowend` (Enhance low end) are plain CPU DSP, not model jobs, and are candidates to eventually move into plugin JS and skip the round trip entirely; (3) but the real latency exposure is `clip-batch.js processBatch`'s **sequential** per-clip upload/poll/download loop on 100+ clip batches -- that traffic can't move client-side (it needs the model) and is the highest-frequency call path by far, so it's the thing to design around first, before porting the two DSP endpoints. No files besides the new research doc changed.

## Latest — Fix a pop: "Could not identify the pop-fix render sequence." inside a nest (2026-09-22)

Dan's Copy report: fixPop failed twice in a row with that error, right after an unrelated Apply/`setClipGains` failure ("The script object is no longer valid.") on the same sequence -- the two are unconnected; the gain error is the known stale-handle-after-transaction class already in UXP-QUIRKS.md #1, not investigated further here. Dan then asked "it's in a nest, could that be why" -- yes. `deplosive.js run()` identified its scratch render clone with a plain before/after `listSequences()` diff, but `listSequences()` (and `getSequences()` under it) does not list a nested sequence, or a clone made of one, while it's the active sequence (UXP-QUIRKS.md #1) -- so cloning while editing inside a nest left the diff empty and `run()` threw immediately, before any export or edit.

Fix: `plugin/deplosive.js`'s clone-identification now goes through `host.identifyNewSequence()` (the same project-bin-diff / active-sequence fallback `cloneActive()` already relies on for this exact reason), with a `snapshotProjectItems()` snapshot taken before the clone transaction. This also means a failure now reports Premiere's actual candidate count and a nest hint, instead of always the same generic message. No change to the render/export/placement logic after the sequence is found.

While verifying, found and fixed a second, unrelated problem: `tests/deplosive.test.cjs`'s mocks didn't have `getIsSelected()` (added when Fix a pop became selected-clip-only) or `getSettings()` (added when it became usable standalone) -- 11/11 tests were failing outright before this session touched anything. Added `getIsSelected` to both clip-item mocks; 10/11 now pass. The remaining failure ("requires clean dialogue to already be inserted") asserts on the old "Insert clean dialogue first" guard, which was intentionally removed when Fix a pop went standalone -- the test is stale, not a real bug, and is left as-is rather than rewritten here since it's unrelated to today's report.

Not live-tested against a real nest (Dan's report didn't confirm root cause before asking; next Fix a pop attempt inside that nest will confirm). If it still fails, the new error text will say how many candidate sequences it found and whether the active sequence looked unlisted, which narrows it further.

## Latest — Clean dialogue missing options: Grid regression corrected (2026-09-21)

Dan again reported missing ambience/other Clean dialogue settings. All checkbox IDs remain in HTML, but style.css had reverted `.check-grid` to display:grid and had no `.check-row` rule despite the row-based markup. Restored the documented UXP-compatible flex column container and wrapping flex rows, with non-shrinking rows. No settings/defaults/storage changes. Regression test `tests/cleanup-layout.test.cjs` checks flex rules and all nine cleanup controls. Reload panel; native confirmation pending. This is a confirmed source regression and a likely explanation for missing controls, not proof of any saved-value loss.


## Latest — Batch progress and time estimates (2026-09-21)

Implemented for per-clip Prepare exports and Clean audio, including the combined Run clean dialogue button. Footer shows phase, completed/total clips, duration-weighted percent, elapsed time and approximate phase time remaining; updates every second without filling the status log. Export progress advances on verified files; cleaning includes service progress but reserves completion until downloaded stems and manifest are saved. Each phase starts its own estimate. No ETA before the first measured non-reused clip; resumed/cached clips count as complete but do not train speed. Estimates use measured wall-time per audio second and can change with cold model startup, cache hits, clip length and service load. Overruns display "Estimating time remaining..." instead of a misleading zero. Timers and progress UI are cleared in finally on success, failure or cancellation. No estimates for Add clean tracks, full-sequence mode or standalone tools.

Files: new `plugin/batch-progress.js`, main.js footer/timer wiring, clip-batch.js completion events, index.html compact estimate line. No service change, version bump or package rebuild; reload the panel. Validation: 19/19 focused tests (estimator + clip-batch), JS syntax check, browser smoke `work/check-batch-progress-ui.cjs` for estimate display/update/cleanup. Live Premiere appearance/performance not tested. Existing preset/handles changes preserved.


## Latest — "Changed from defaults" list added under Reset (2026-09-21)

Dan asked to see what's been changed in a preset: a collapsible list below the reset button of settings that differ from factory defaults. Added `#toggleChangedSettings` / `#changedSettingsSection` / `#changedSettingsList` in `plugin/index.html` right under `#resetAllOptions`, using the same collapsible-section pattern as the other Options toggles (`section()` helper, registered in the button-div list, expand state persisted in `OPTIONS_UI_KEY` like the others -- global, not per-preset, same as the section already noted for that key).

`plugin/main.js`: added `FACTORY_DEFAULT_VALUES`, a hardcoded snapshot of what every `settingsFile.fieldIds` field is set to by `resetActivePresetToDefaults()` (comment ties the two together -- if that function's defaults ever change, this needs updating by hand, nothing computes it automatically). `updateChangedSettingsList()` diffs the live panel (via `settingsFile.capture($)`, same schema) against that snapshot and lists each differing field as "Label: current value (default X)"; empty diff shows "No changes from factory defaults." It's read-only, never writes anything. Wired to refresh on every path that can change what's displayed: `rememberSettings()` (covers every field edit, Save/Load settings, and both reset buttons), the end of `loadPreset()`'s "apply saved settings" branch, and the end of `resetActivePresetToDefaults()`. Labels and value formatting (on/off, Per clip/Full sequence, MossFormer2/GAP URGENet) live in `CHANGED_SETTINGS_LABELS`/`formatChangedSettingsValue()` next to it.

Not live-tested (same UXP-only constraint as the rest of the preset work -- `main.js` can't run under plain Node). Live-check: open Options, expand "+ Changed from defaults", change a target, confirm it appears with old/new values, switch presets and confirm the list updates to that preset's own diffs, hit "Reset this preset to defaults" and confirm it goes back to "No changes from factory defaults." `panel-help.test.cjs` still only the one known `openDestinationFolder` failure; `settings-file` 6/6 pass (unaffected -- this feature doesn't touch that schema).

## Latest — "Reset all settings" renamed/clarified as per-preset (2026-09-21)

Dan asked how Reset all settings to defaults interacts with presets, and whether it should be preset-scoped, and to rename it if so. It already only resets the active preset: `resetAllSettingsToDefaults()` (renamed `resetActivePresetToDefaults()`) is followed by `rememberSettings()`, which writes to the currently active preset's own key (`presetSettingsKey(activePreset)`) -- the other two presets' saved settings are untouched, unaffected until you switch to them. The old name/label just predated presets and read as global. Renamed for clarity, no behavior change: button id `resetAllOptions` label is now "Reset this preset to defaults" (tooltip: "Reset every setting on this preset to factory defaults. The other two presets are untouched."), its confirmation message names the preset ("All Interview preset settings restored..."). The smaller `reset` button (targets only) got the same treatment: "Reset targets (this preset)". One caveat carried over unchanged: the panel-layout prefs under `OPTIONS_UI_KEY` (active tab, scroll position, which sections are expanded) are still global, not per-preset -- resetting the current preset also collapses sections / resets scroll for the whole panel, not just that preset's view. That's existing behavior, not new, and seems fine to leave (it's UI chrome, not an audio setting) but flagging in case it surprises anyone. Not live-tested (same UXP-only constraint as the preset feature itself); `panel-help.test.cjs` still has the one known `openDestinationFolder` failure only.

## Latest — Presets per project type added (2026-09-21)

Dan asked for a preset dropdown in the top-right corner: Promo/Action, Interview, Camcorder (Camcorder is the default). Added `plugin/index.html`'s heading `#presetSelect` and `plugin/style.css`'s compact heading-select rule. All three presets start identical, on the existing factory defaults (`defaults.json`) -- Dan will tailor each himself.

Mechanics (`plugin/main.js`): each preset keeps its own "last-used settings" blob in `localStorage` under `wtv-last-settings-v1:<preset>` (same schema as `settings-file.js`, i.e. everything `settingsFile.fieldIds` covers -- targets, mode, handles, loudness/peak checks, etc.), replacing the single global `wtv-last-settings-v1` key. The active preset name persists under `wtv-active-preset-v1` and is restored on panel reopen, so both "which preset" and "that preset's edits" survive closing/reopening the plugin -- this reuses the auto-remember mechanism that was already there (README/`rememberSettings()`), just keyed per preset now. Switching the dropdown (`loadPreset()`) applies that preset's saved settings if any, else falls back to the full factory reset (`resetAllSettingsToDefaults()`). Any field edit saves into the *currently selected* preset only (`rememberSettings()` now writes to `presetSettingsKey(activePreset)`); other presets are untouched.

Also removed: the legacy `action('connect')` fallback that reapplied a single global `wtv-settings-v1` blob (last real job settings, written only when a job actually ran) whenever no file/UI settings had been loaded yet. That mechanism pre-dates presets, is not preset-aware, and would have silently overwritten a freshly-selected, never-customized preset's factory defaults with an unrelated older run's settings the first time Connect ran. The two `localStorage.setItem('wtv-settings-v1', ...)` writes in `doProcess()` are left in place but are now dead (nothing reads that key anymore) -- harmless, flagged here in case someone goes looking for the reader.

Not yet touched: `settings-file.js`/the Save/Load-to-file feature is unchanged and preset-agnostic (loading a file overwrites whichever preset is currently active). `compressMusicBed`/`stripMusicVolume` and other `OPTIONS_UI_KEY` panel-only prefs stay global, not per-preset (they're auxiliary music-pass toggles, not part of what Dan asked to vary per project type). No automated test coverage added -- `main.js` can't load under plain Node (see UXP-QUIRKS.md #7), so this needs a live UDT check: switch presets, edit a target on each, reload the plugin, confirm each preset re-opens with its own last edit and Camcorder is the default on first-ever launch. `panel-help.test.cjs` unaffected (still the one known `openDestinationFolder` empty-tooltip failure). Next up per Dan: progress/time estimates during a batch run.

## Latest — AV-CASS dropped; Separator selector removed (2026-09-21)

Dan decided not to pursue AV-CASS. Rationale (paper Table 8, all models trained on the same data): the audio-only AV-CASS variant is roughly on par with Bandit on FAD/KL, but Bandit has about 2 dB better SI-SDRi on every stem and slightly better dialogue PESQ (2.15 vs 2.08); the full AV-CASS wins mostly because of picture input, which this WAV-only pipeline cannot supply; DAVIS-Flow needs video and MRX trails Bandit. The only possible upside for the audio-only model is effects/ambience, unverified. With one separator left the panel's Separator dropdown (Options > Levels & stems) is gone; the panel always sends `bandit_v2`. Files: `plugin/index.html` (row and tooltip text), `plugin/main.js` (constant; removed select init), `plugin/settings-file.js` (`separator` no longer a saved field; old preset files that contain it still load, the key is ignored), `service/schema.py` (`av_cass` removed from the separator Literal; the API now returns 422 for it), `service/app.py` (health entry and 409 branch removed), tests updated (`settings-file`, `test_service`). `provided_stems` is unchanged. `research/AV-CASS-INTEGRATION.md` is kept as a record with a status banner. Restart the service (schema/health changed) and reload the plugin. Tests: settings-file 6/6 pass; `panel-help` still has its one known empty-tooltip failure (`openDestinationFolder`); Python test_service not run here (syntax-checked only).

## Latest — "Mix on timeline" option removed (2026-09-21)

Dan asked to remove Mix on timeline (raw + clean both audible at a fixed 50/50 Amplify split). Add clean tracks now always mutes/silences the raw lane as before. Removed: the Options checkbox (`plugin/index.html`), all `mixOnTimeline`/`timelineMix`/`serviceWet` handling in `plugin/main.js`, `mixGains()`/`applyMixGains()`, the timeline-mix branch of `apply()` and the `MIX_SUFFIX` label in `plugin/per-clip.js`, and the `mixOnTimeline` field in `plugin/settings-file.js` (old saved/preset files that contain it still load; the value is ignored). `WTV_NAME_SUFFIX` still strips a ` · WTV mix` label from clips renamed by earlier runs. Tests: the two mix tests were removed from `tests/per-clip.test.cjs`; `tests/settings-file.test.cjs` no longer lists the field, and its 6 cases now pass (the standalone "reading 'checked'" failures recorded earlier were this field). per-clip 51/51, settings-file 6/6; panel-help still has its one known empty-tooltip failure. Not confirmed live; reload the panel and check Options > Clean dialogue has no Mix on timeline and Add clean tracks still works.

## Latest — Handles confirmed working live on a file-backed clip (2026-09-21)

Dan's Copy report: `C0046.MP4` with 0.5 s requested got 0.467 s head and tail (14 whole frames at 29.97), Prepare exports, Clean audio and Add clean tracks all completed (`Applied: true`, gain step OK). Earlier runs' failures are resolved by: whole-frame handle lengths, the stepwise scratch trim (source in/out first, timeline start/end only if needed) and the locked-file/gain fixes below. A multicam clip in the same batch correctly falls back ("No file-backed source"). Confirmed by Dan that the handles are present (hidden extra audio available when the clean clip is extended). Still unverified live: off-grid clips (C0021.MP4, tolerance fix), handles combined with Mix on timeline, and re-running on already-cleaned clips. Known cosmetic issue: the Copy report's "Last error" line is not cleared after a later success, so it can show a stale error next to `Applied: true`.

## Latest — Optional per-clip handles implemented (2026-09-21)

Dan authorized implementation now, with native testing after delivery; the feasibility plan's manual proof gate is superseded.

Options > Clean dialogue: **Add clip handles**, off by default, **0.5 seconds per side**, configurable 0.01–2 seconds. Per clip only. Included in portable Save/Load and last-used settings; old presets default off. Reset all settings restores off/0.5. Full sequence disables the controls. This applies to cleanup and its optional ambience/music stems, not standalone Extract ambience, Fix a pop or Enhance low end.

`per-clip.js` reads source duration, clamps independently at source boundaries and timeline zero, expands only a scratch clip's source and timeline trims, then verifies all four bounds and isolation before exporting. Whole-region model processing retains the handles; imported source in/out hide them and keep the previous visible placement/frame-cover behavior. Apply checks source trims as well as timeline coverage. Unsupported/offline/merged/nested/multicam/retimed sources or unavailable bounds fall back to existing exact-cut processing with a per-clip reason. Copy report and manifest include actual handles and reasons. Frame padding is not claimed as real source audio.

Compatibility: Adobe documents Media.getDuration (and deprecated duration property) from **26.5**. Earlier hosts may report no handles when full source bounds are unavailable; project-item marked out points are deliberately not used as full media duration. Track-item trim coordinates are documented relative to project-item start, so embedded timecode is not added. Capability/readback checks remain essential; native trimming order and listening acceptance are not claimed proven.

Expanded exports get distinct IDs and an exact export-identity comparison (sequence fingerprint + geometry) before either input or processed-result reuse. Manifest stores source/handle geometry, export range and imported media offset. A 30-minute selected cut may include handle overhead. Handled clips use a fresh scratch clone following each verified export, avoiding accumulated trim changes; this adds cloning overhead. Unconfirmed exports/trim failures retain scratch resources. Existing source effects remain on the scratch clip, so exposed automation and whole-clip normalization may affect the result near cuts.

Validation: **72/72 focused JS tests** (per-clip, clip-batch, settings-file), including source/timeline clamps, old-host fallback, retimed skip, 29.97 off-grid alignment, hidden import trims, scratch trim failure, unconfirmed export retention, 30-minute overhead, cache invalidation, old settings migration. Browser smoke `work/check-handles-ui.cjs` passes: default state, enabling/number control, full-sequence disabling, save/restore after reload, existing offline music action. Legacy `work/check-panel.cjs` cannot run against current button-div UI (mock lacks classList); use the browser smoke. Full JS suite: 285/287 pass; the two previously documented unrelated failures remain (loudness export mock and empty static destination-folder tooltip). No GPU or live Premiere test performed. Plugin-only changes: reload panel; no service restart needed for handles. Source version remains 0.8.0; ZIP not rebuilt.


## Latest — Handles live run 3: Prepare/Clean OK with handles; off-grid clip skipped handles; Add clean tracks "Script action failed to execute" (2026-09-21)

Dan: with the stepwise trim change, Prepare exports and Clean audio work with handles on (the file-backed clip extends; the multicam clip falls back). An earlier Add clean tracks run crashed Premiere (no report captured). A later run added the cleaned file to the timeline but with no handles and this Copy report: handle result for `C0021.MP4` was `"Source bounds unavailable or retimed"` (head/tail 0), then Apply failed in `setClipGains` phase 2 (`Gain: setting 1 level(s)`) with `Script action failed to execute.`; Apply rolled back (raw mute restored, added tracks muted).

1. **No handles on C0021.MP4 (fixed, tested):** this is the known off-grid clip (970.9996 timeline frames over 971 source frames). `addHandles` required source span == timeline span within 1 tick, so any off-grid clip was mistaken for "retimed". Tolerance is now one sequence frame (`Math.max(1, frameTicks)`). New test (fails without the fix; the test mock now carries `sourceOut` through sequence clones). Per-clip suite 53/53. Untested live: extending an off-grid scratch clip (start/end off the frame grid) may hit the earlier trim-snapping behaviour; the new `Trace:` error text will show.
2. **"Script action failed to execute" during gain set (cause unknown):** the same transaction also renamed the raw clip (` · WTV muted` label). Changes, both in `setClipGains` (`per-clip.js`): the rename now runs in its own transaction after the gain is verified, with fresh handles, and its failure is ignored (cosmetic, must not roll back Apply); the gain transaction's error now lists the clip, Amplify slot, param indices and dB being set. Rename-as-cause is a hypothesis only. Another candidate: the raw clip already carried an Amplify left by the crashed earlier run (the reuse check trusts the recorded slot; a stale/duplicate Amplify could make the set fail). Before retesting, Dan should Undo the failed Apply (or delete the muted added track and any Amplify left on the raw clip) so the sequence is clean.
Not confirmed live. If it fails again, send the report: the error text will now name the exact gain action set.

## Latest — Handles, second live failure: whole-frame handles still rejected; extension now stepwise with a trace (2026-09-21)

Second Copy report (handles floored to 14 frames = 0.467 s, so all four requested values are on the frame grid) still failed the same read-back. The new diagnostic was uninformative by itself: the three "found" clips were earlier clips of the same source file (starts ~122.2e12, before the requested ~128.7e12), i.e. the extended clip was not among the first three same-source clips, so it is unknown whether Premiere moved the clip, resized it, or left it untouched. Frame grid was therefore not (only) the cause. Two suspected causes remain: (a) trim semantics, where in/out and start/end are coupled (setting a source in-point also moves the timeline start), so setting all four in one transaction gives a different result than requested; (b) the clip is adjacent to a neighbor on the same track (clips in this multicam batch are contiguous) so the scratch clip cannot grow into occupied space even though the neighbors are disabled. `extendRenderClip` (`plugin/per-clip.js`) now: applies source in/out first in one transaction; reads back the clip located by overlap with the original cut (not exact ticks); only if start/end still differ applies setStart/setEnd and reads back again; on failure the error lists every clip at the cut with start/end/in/out (and marks other sources / disabled) after each step. Tests 52/52. Next step is another live run: the new `Trace:` text will show which of (a) or (b) is happening. If (b), handles on touching clips need a different approach (e.g. exporting the source region from a dedicated scratch sequence containing only that clip, instead of extending it in place on the clone).

## Latest — Handles: "Premiere did not preserve the requested handle trims" on first live run (2026-09-21)

Dan's Copy report (Prepare with handles 0.5 s, 2 clips): the multicam clip correctly reported "No file-backed source" (exact-cut fallback), but the file-backed clip `C0046.MP4` (handles 0.5/0.5) failed in `extendRenderClip` at the read-back check. The report's own numbers show why: the source in/out (`sourceIn` 46006.0 frames, `sourceOut` 46130.0) and the clip's timeline start are exactly on the 29.97 frame grid, but 0.5 s is 14.985 frames, so the requested in/out/start/end (`inTicks` 45991.015 frames etc.) were off the frame grid. Premiere snaps track-item trims to whole frames (same family as the placement flooring in UXP-QUIRKS.md section 2), so the read-back did not match the exact request. Fix (`plugin/per-clip.js addHandles`): head and tail are floored to whole sequence frames (0.5 s becomes 14 frames = 0.467 s at 29.97) so all four values stay on the grid; the error now also prints the expected and actual start/end/in/out ticks and the sequence frame size, so any remaining mismatch is diagnosable. Test added (`tests/per-clip.test.cjs`, handle lengths are whole frames); per-clip suite 52/52. Not yet confirmed live: retry Prepare with handles on a file-backed clip. If it still fails, send the new error text (it contains expected vs found ticks). Caveat: quantizing uses the sequence frame; footage at a different frame rate than the sequence may still snap on its own grid.

## Latest — Ambience hardening + handles feasibility (2026-09-21)

Implemented overlap-aware destination lanes; non-overlapping clips still share a lane. Verify BOTH start/end and all preexisting clips including previously generated outputs. Post-insertion failure stops the batch and mutes affected ambience lane; no speculative multi-transaction Undo/rollback. Active-sequence/layout change also stops rather than continuing on stale selection. Pre-edit eligibility failures still report per clip. Snapshot now reads inventory once. Shared identifyNewSequence/project-bin fallback replaces list-only clone identification. Unconfirmed exports retain scratch sequence/WAV; verified exports use concurrent bounded file polling and one upload read.

Standalone service requests set new `ambience_only:true` (schema validated); result stems are effects only and peak protection is based on effects alone, not unused raw dialogue. It no longer inherits Also duck ambience (raw-mixture-driven ducking was inappropriate here). Normal cleanup's optional stems keep their existing shared mix behavior. UI rejects old service lacking this field with restart guidance. Restart service + reload plugin/reconnect required.

Tests: 12 extraction tests pass, including overlapping output survival, duration verification/fatal batch stop+mute and cancellation retaining render. 2 Python ambience-only tests pass (raw-level invariance and schema safety). Existing unrealistic one-second placement mock corrected to actual output WAV duration. Native insertion/clone handling still needs acceptance. Full suite has known unrelated failures from previous audit; not claimed green.

Remaining: standalone still does not share Prepare's full off-grid frame-cover geometry; it now detects bad placement and stops/mutes rather than silently accepting truncation. No automatic rollback of uncertain native mutations. Asset/job retention policy unchanged. Optional cleanup stem levels still share mix protection. Handles plan: [research/HANDLES-FEASIBILITY-2026-09-21.md](research/HANDLES-FEASIBILITY-2026-09-21.md). Recommends 0.5 s each side, off by default, expanded scratch/source trims and hidden imported-media handles while preserving visible cuts; native round-trip proof is the gate. No handles UI implemented yet.


## Latest — Ambience feature audit (2026-09-21)

Read latest -18 dBFS/default, locked-file and standalone updates and UXP quirks. Audit report: [research/AMBIENCE-AUDIT-2026-09-21.md](research/AMBIENCE-AUDIT-2026-09-21.md). No production edits. Existing extraction tests 9/9 pass, but mock reproductions expose two successes with one surviving overlapping output, and success despite shortened output duration. High priority: overlap-safe destination lanes, verify previously placed clips, stop/rollback on post-edit failures. Also identified missing frame-cover placement, raw-dialogue-dependent ambience attenuation (controlled repro -2.629 dB), unconditional cleanup of in-flight renders, and missing nested clone-discovery fallback. Panel -18 target is explicitly submitted; service -30 default does not override it. Full native extraction remains unverified. See report for evidence and proposed fix order.


> **UXP / host quirks reference:** [research/UXP-QUIRKS.md](research/UXP-QUIRKS.md) consolidates every Premiere UXP quirk, limit and workaround found so far (stale handles, `getSequences()` gaps, tick strings, frame flooring, export misfires, panel UI regressions, encoding). Check it before debugging a host oddity, and add new findings there.

## Latest — Options checkboxes: CSS grid replaced with flex rows (2026-09-21)

Dan reported options missing from the Clean dialogue menu after the compaction below. All eight checkbox ids and both selects were still in the markup, so the likely cause is that UXP does not lay out `display:grid` reliably (the panel's layout is flexbox-based), so the `.check-grid` didn't render as intended. The checkboxes are now four `.check-row` flex rows of two labels each (`plugin/index.html`, `plugin/style.css`), the same flex mechanism `.field-row`/`.step-row` already use. Not confirmed live; if anything is still missing, note exactly which option. Follow-up worth doing: `#dialogueTrackList` (Ducking > Choose tracks) also uses `display:grid` and may be equally unreliable; check it and convert to flex rows if it looks wrong. **Confirmed by Dan: all checkboxes are back with the flex rows.** Documented in `research/UXP-QUIRKS.md` (section 5, "CSS `display:grid` breaks layouts").

## Latest — Options tab: Clean dialogue section compacted (2026-09-21)

The Options > Clean dialogue block was a long, sparse column (one checkbox per row plus three explanatory paragraphs). `plugin/index.html`: the eight checkboxes (Selected clips only, Neural cleanup, Process in place, Mix on timeline, Level/limit & de-ess, De-click, Extract ambience, Extract music) now sit in a two-column `.check-grid`, with shorter labels; the long explanations (Mix on timeline, post-processing, de-click) moved into each label's `title` tooltip, leaving only `#repairHelp` (shown when De-click is on) and `#modeHelp`. All element ids are unchanged, so no JS changes. `plugin/style.css`: Options-tab labels/notes/fields get tighter margins and 26 px controls (was 30), scoped to `#tabOptions`. Old `.inline-options` markup is gone (rule left unused). Not confirmed live: check that the two-column grid renders in UXP (the ducking track list already uses `display:grid`, so it should), that long labels don't clip at the narrowest panel width, and that hover tooltips show on labels.

## Latest — Normalize music levels is step 5; Extract ambience back to grey (2026-09-21)

`plugin/index.html`: the Normalize music levels button is labelled "5. Normalize music levels" with a new `.step5` colour (`#3d8f9a`, `plugin/style.css`) instead of step 4's orange (layout unchanged: still shares a row with Enhance low end). Extract ambience switched from `step step4` to `step secondary` (grey). No JS change. Known unrelated test failures: `tests/panel-help.test.cjs` (`#openDestinationFolder` has `title=""` in markup, set at runtime) and 7 `tests/settings-file.test.cjs` cases ("Cannot read properties of undefined (reading 'checked')" standalone). Not confirmed live.

## Latest — Ambience stem default target -30 -> -18 dBFS (2026-09-21)

Dan asked for the ambience stem default level to be -18. Changed the factory default in `plugin/defaults.json` (`effects.target`), the `#effects` field default in `plugin/index.html`, and the Reset-defaults status text in `plugin/main.js`. Panel-only. A previously remembered value (auto-saved settings or a loaded settings file) is kept until "Reset defaults" / "Reset all settings to defaults". Not confirmed live.

## Latest — "resource busy or locked" when re-cleaning a clip already on the timeline (2026-09-21)

Dan's Copy report: Step 2 (Clean audio) failed on the last write of a clip, after the job reached 100 %, with `resource busy or locked` from `clip-batch.js processBatch` (`file.write`). Cause: stem files are named `<clip.id>-<stem>.wav` and the clips folder is now stable per sequence, so re-processing the same clip (same id, e.g. after changing settings) overwrote the stem that an earlier Step 3 had imported and placed on the timeline; Windows won't overwrite a file Premiere holds open. Fix (`plugin/clip-batch.js`): new `writeStem()` tries the overwrite and, on a busy/locked/permission error only, writes `<id>-<stem>-<base36 time>.wav` instead; the manifest already records the real path so Apply follows it, and the reuse check now looks up the file name recorded in the manifest rather than assuming `<id>-<stem>.wav` (otherwise it would reuse the stale locked file). Tests: two new cases in `tests/clip-batch.test.cjs` (locked file gets suffixed name; unrelated write errors still throw); 14/14 pass. Not confirmed live. Side effects to know: locked originals stay in the folder (delete them by hand once unreferenced). Same class of risk may exist for other fixed-name overwrites (`<id>-input.wav` exports are not imported so are fine; Fix a pop / Enhance low end / Extract ambience use unique names). Also added to UXP-QUIRKS.md.

## Latest — Fix a pop is now standalone (2026-09-21)

Fix a pop was greyed out whenever there was no *applied* Clean dialogue batch in
the current panel session (after a panel reload, while a new Prepare was in
flight, after a failed apply, or with any other sequence active), because
`button-state.js` required `context.applied` and `deplosive.js` only matched
clips whose media was in `context.dialoguePaths`. It now works like Enhance low
end / Extract ambience: enabled whenever the service is connected. It acts on the
single enabled, unmuted audio clip under the playhead on the active sequence;
rate/channels come from the sequence settings when there is no session. If an
applied WTV clone is the active sequence it still restricts matches to that
batch's Clean dialogue clips, and re-registers the fixed file in
`context.dialoguePaths` as before. Overlapping clips at the playhead give an
error asking to mute/disable the others. **Update:** it now requires exactly one clip SELECTED on the timeline (playhead only supplies the pop position and must lie inside that clip), instead of matching whatever is under the playhead; the Clean-dialogue path filter was dropped. New test for the no-selection error. Files: `plugin/deplosive.js`
(`locate`, `run`), `plugin/button-state.js`, `plugin/main.js` (dropped the
"Insert clean dialogue first" guard), `plugin/index.html` (tooltip). Tests:
`deplosive.test.cjs` (standalone case, mock gained `getSettings`),
`button-state.test.cjs`. Both files pass locally (28/28); full suite not run.
Not confirmed live yet.

## Latest — Panel still showing the old "?" buttons after the tooltip change: likely a stale UXP load, unresolved (2026-09-21)

After the "?" popover removal below, Dan reports the panel still shows the
old "?" buttons, and only "Normalize music levels" tooltip works on hover
(the one button whose `title` predates this session's change and was never
touched). Verified from this side that this is not a source problem:
`plugin/index.html` has zero remaining `icon-button`/`HelpToggle`/
`HelpPopover` references, 27 buttons carry a `title=""` attribute, and a
directory listing of Dan's actual `plugin/` folder shows `index.html` and
`main.js` at the current write timestamp, matching what was pushed. So the
file on disk is correct; the *loaded* panel is not reflecting it.

Suggested first: a plain UDT "Reload" on the WTVAudioWizard entry -- Dan
tried this ("still incorrect in appearance"), so that alone isn't enough.
Since only one button's tooltip is stale-correct and nothing else changed,
this reads like the panel's webview (or UDT's own load) is serving a cached
copy rather than re-reading `plugin/` fresh. Things worth trying next,
in rough order of likelihood, not yet attempted/confirmed:
- Fully **unload** the plugin in UDT (not just Reload) and **Load** it
  again from scratch, in case Reload only re-runs `main.js` without
  re-fetching `index.html`/`style.css`.
- Close the panel in Premiere (Window > Extensions > WTVAudioWizard, toggle
  off/on) in addition to the UDT reload -- Premiere may hold its own
  webview instance open independent of UDT's reload.
- Check whether UDT is pointed at a **different** folder than
  `.../outputs/WTVAudioWizard/plugin` (e.g. a second checkout, a packaged
  `.ccx`, or a copy under Premiere's own UXP extensions cache directory --
  typically under `%APPDATA%/Adobe/UXP/...` or similar on Windows) --
  possible if the plugin was ever installed/loaded a second way besides
  UDT's live folder load. `manifest.json`'s `"main": "index.html"` and
  `"version": "0.7.1"` (note: stale relative to the `v0.8.0` panel heading
  Dan sees at runtime -- worth checking package version drift too) confirm
  there's exactly one `index.html` in this checkout, but can't rule out a
  second copy elsewhere on Dan's machine.
- A full Premiere restart, if the above don't resolve it.

Not yet root-caused. Needs Dan to report back which of the above (if any)
fixes it, or to describe exactly how the panel is currently loaded (UDT
live folder vs. a packaged install) so the next step can be targeted
instead of guessed.

## Latest — "?" help popovers replaced with plain button tooltips (2026-09-21)

The new Extract ambience "?" toggle turned out oversized and looked
greyed-out: it was a direct child of a `.step-row`, so it picked up the
`.step-row > [role="button"] { flex:1 1 0 }` rule meant for full-size step
buttons, overriding its own 28px icon-button sizing (first fixed by moving
it into a `.button-group`, matching Fix a pop/Enhance low end). Dan then
asked to drop the "?" popovers entirely in favor of native hover tooltips
on every button, so this removes the popover mechanism altogether rather
than patching it further. `fixPopHelpToggle`/`lowEndHelpToggle`/
`extractAmbienceHelpToggle` and their popovers/close buttons are gone from
`plugin/index.html`; their explanatory text moved onto each main button's
own `title=""` attribute (Fix a pop, Enhance low end, Extract ambience).
Every other button in the panel also got a `title` describing what it does
-- section toggles, the numbered Clean dialogue steps, Connect, Refresh,
Save/Load settings, both Reset buttons, Copy report, Cancel, and the two
tabs -- not just the three that used to have popovers. Removed the matching
JS (`setFixPopHelpOpen`/`setLowEndHelpOpen`/`setExtractAmbienceHelpOpen` and
their listeners, the now-gone ids from the `makeButtonDiv` list) and CSS
(`.button-group`, `.icon-button`, `.popover-menu`, `.popover-heading` rules
-- nothing left references them). `.step-row` simplified back to only ever
holding two full-size step buttons side by side (its original job before
the icon-button variant existed). No test changes needed -- nothing in the
suite asserted on the popover ids/behavior. Suite 254/255 remotely (the 1
is the known preset-fixture bridge-depth artifact, unrelated). Not
confirmed live yet -- check that every button's tooltip actually shows on
hover in the real Premiere panel (UXP's title tooltip rendering hasn't been
spot-checked this session) and that removing `.button-group` didn't leave
any row visually different from before (Fix a pop and Enhance low end each
now share a `.step-row` directly with their neighboring step button instead
of being wrapped alongside a "?" button).

## Latest — Extract ambience: standalone step (2026-09-21)

Dan asked for an "extract ambience" button: same background separation as
the existing Ambience stem checkbox, but its own optional step above Verify
loudness, blue, running on whatever clips are selected -- independent of the
Clean dialogue pipeline. New module `plugin/extract-ambience.js`, structured
like `lowend.js` (own clone/isolate/export per selected clip, no shared WTV
session/context) but calling the async job API instead of a synchronous
endpoint, since ambience separation is a model job. Key difference from
`lowend.js`: this *adds* a new clip rather than overwriting one -- the
original clip, its track, and every other track are left completely
untouched (no mute, no disable). Placement follows the same
insert-then-overwrite pattern `per-clip.js apply()` uses for a brand-new
stem lane: the first extracted clip in a run creates a new "Ambience" track
via `createInsertProjectItemAction` (track index = current count), every
later clip in the same run lands on that same track via
`createOverwriteItemAction`; verified afterward the same way (source/track/
enabled/position match, and every clip outside the new track's ticks are
diffed unchanged). Settings sent to the job are ambience-only regardless of
the main panel's Enable neural cleanup / Ambience checkbox state
(`enhancer:'none'`, `dialogue_postprocess:false`, `deess_declick:false`,
`separate_ambience:true`, `separate_music:false`) via a new
`ambienceSettings()` in main.js; `output_rate` is filled in by
`extract-ambience.js` itself from the active sequence (there's no big
session/context to read it from here). UI: new blue `.accent-blue` step
(`#3568a3`) plus a "?" help popover, matching the Fix a pop/Enhance low end
pattern; only needs a live service connection to enable, same as Enhance low
end. Tests: `tests/extract-ambience.test.cjs` (new, 9 tests) -- happy path
adds the track and places the clip with the original untouched, a batch of
selected clips lands on the same new track (insert once, overwrite after),
unselected/ineligible clips are skipped or reported without stopping the
batch, the extracted file is kept while the scratch render is cleaned up,
and the job settings reaching the service are ambience-only with the
correct output_rate. Suite 254/255 remotely (the 1 is the known
preset-fixture bridge-depth artifact, unrelated). Not confirmed live yet --
check that the new Ambience track is created and named correctly on a real
sequence, that the extracted clip lands exactly under the selected raw
clip, and that a second Extract ambience run on more clips reuses the same
track sensibly (it currently always adds a fresh track per run rather than
finding an existing "Ambience" track — worth deciding if that's the wanted
behavior or a follow-up fix).

## Latest — Model mix slider and Update mix removed (2026-09-21)

Dan asked to remove the "Model mix" slider next to step 2 (Clean audio), then
flagged that Update mix needed to go with it since it read from that same
slider. Removed both, not just hidden: `plugin/index.html` no longer has the
`modelWet` slider/label or the `updateMix` button; neural cleanup always
requests 100% wet from the service (`enhancer_wet=1`) — the partial
model/raw blend option is gone entirely, not just its control. `Mix on
timeline` (the Options-tab checkbox) still works, but `applyMixGains` is now
always called with a fixed 50/50 split (`context.mixWet=50`) at Apply time
instead of reading the slider; there is no longer a way to change that split
from the panel afterward — the panel copy now says to adjust each clip's
Amplify gain directly in Premiere if a different balance is wanted. Removed
`per-clip.js`'s `updateMix()` function and its export, `button-state.js`'s
`updateMix` disabled-state rule, and `modelWet` from `settings-file.js`'s
field list (old saved-settings files with a `modelWet` value still load
fine; the field is just ignored). `mixGains()`/`applyMixGains()` in
per-clip.js are unchanged and still used by Apply. Test:
`per-clip.test.cjs`'s timeline-mix test trimmed to drop the Update-mix
assertions, keeping the apply-time gain/no-mute/no-disable/rename coverage.
Suite 245/246 remotely (the 1 is the known preset-fixture bridge-depth
artifact, unrelated). Not confirmed live yet — check that Mix on timeline
still applies cleanly at Apply with the fixed 50/50 split and that neither
the missing slider nor the missing Update mix button leaves a dead click
target in the panel.

## Session timeline — 2026-09-17 → 2026-09-18 (times UTC, from the panel's own status timestamps in Dan's reports; ± a few minutes)

All entries below were written to Dan's checkout as they were made; each has its own detailed section further down. Test suite on Dan's machine: **243 pass / 0 fail** (confirmed 2026-09-18 by running `node --test tests/export-presets.test.cjs` there; the one test that fails in the remote working copy only needs the bundled `.epr` presets). Native acceptance status is noted per entry.

| When (UTC) | Change | Files | Live status |
|---|---|---|---|
| 09-17 ~16:40 | Nest clone error diagnosed; `identifyNewSequence()` with explicit exclusions + diagnostics | premiere.js, per-clip.js | Superseded by in-place work below |
| 09-17 ~17:00–17:25 | **Process in place** option (default on): `useActive()`, no clone, no rename, conditional copy throughout; `processInPlace` setting | premiere.js, per-clip.js, main.js, index.html, settings-file.js, button-state.js | Confirmed working through steps 1–3 by ~17:35 after the three follow-ups below |
| 09-17 ~17:25 | Nest not listed by `getSequences()` → `findSequence()` falls back to the active sequence | premiere.js | Confirmed live |
| 09-17 ~17:29 | Render clone of a multicam source not listed either → `snapshotProjectItems()` / `ClipProjectItem.getSequence()` fallback, item-handle cache | premiere.js, per-clip.js | Confirmed live (Prepare completed) |
| 09-17 ~17:31 | In-place export folder collision → timestamped `context.name`, `clipsFolder()` reuses existing folder | premiere.js, main.js | Confirmed live |
| 09-17 ~17:40 | In-place partial lanes: silence raw clip with Amplify −96 dB instead of disabling (linked video stayed enabled); per-clip apply no longer renames in place | per-clip.js | Dan-reported issue fixed; not re-reported since |
| 09-17 ~17:50 | Run clean dialogue (1–3) re-enables after an applied/failed batch | button-state.js | Pending |
| 09-17 ~18:00–18:40 | **Mix on timeline** (raw + clean audible, per-clip Amplify gains), **Update mix** button, service at 100 % wet; off-grid export now starts on the floored frame (sample alignment) | per-clip.js, main.js, index.html, settings-file.js, button-state.js, clip-batch.js | Pending — first acceptance step is a null test at 50 % |
| 09-17 ~19:00 | **Verify loudness**: every peak over a level (default −6 dBFS), merge window (2 s), sequence markers via Markers API; settings + Reset all | loudness-meter.js, loudness-pass.js, main.js, index.html, settings-file.js | Ran live; marker placement not explicitly confirmed |
| 09-17 ~19:20 | Loudness progress moved to the bar (status line was reflowing) | loudness-pass.js, main.js | Confirmed (no further bounce reported) |
| 09-17 ~19:40 | Loudness: streaming analysis during render + render cache for unchanged timelines | loudness-pass.js, main.js | Ran live |
| 09-17 ~20:00 | Streaming fallback fired live (two progress bars) → 2 s hold-back margin, `stream_fallback_reason` | loudness-pass.js | Pending re-check |
| 09-17 ~21:30 | **Prepare exports efficiency**: throttled full-sequence check, incremental render isolation, deferred render fingerprint (`sealRender`), header-only WAV wait, cached multicam item handle | per-clip.js, main.js, wav.js, premiere.js | Confirmed live: ~1 clip/s over 114 clips on the multicam |
| 09-17 ~21:58 | `getSequences()` returned a null entry at clip 115/158 → `listSequences()` filter everywhere | premiere.js, per-clip.js, deplosive.js, lowend.js, music-pass.js | Confirmed live: batch resumed and completed 158/158 |
| 09-17 ~22:14 | Step 3 looked frozen on 158 clips → header-only output validation, batched in-place silencing (`setClipGains`), per-lane item index, phase-by-phase status | per-clip.js, clip-batch.js, main.js | Pending |
| 09-17 ~22:20 | **Reuse across runs**: stable `<sequence>-clips` folder, stable clip ids (`<name>-A<lane>-<startTicks>`), export reuse, processed-result reuse via `clip-batch.json` | per-clip.js, main.js, clip-batch.js, premiere.js | Pending |
| 09-18 ~00:10 | **Ducking "Clean dialogue" reference** recognizes stems by file/item/track name, not just session paths | music-pass.js, per-clip.js | Pending |
| 09-18 ~16:00 | Ducking re-rendered the whole dialogue reference for a 1-clip pass after a full-sequence pass (`analysis_cache: miss`): cache key now depends only on the dialogue lanes + dialogue effects, not the music selection | music-pass.js, music-analysis-cache.js | Pending |
| 09-18 ~16:30 | Dialogue reference render limited to the selected music's span (+ attack/release margin), padded to timeline length; whole-sequence cache entries serve sub-spans | music-pass.js | Pending |
| 09-18 ~17:00 | Silenced / mixed raw clips get a name suffix (` · WTV muted` / ` · WTV mix`) since effects can't be renamed; suffix stripped for ids and stem names on later runs | per-clip.js | Pending |
| 09-18 ~00:15 | Test environment: `validation/music-local-parity.json` staged remotely; `safeSequences()` fallbacks for stub hosts | music-pass.js, deplosive.js, lowend.js | n/a |

**Open acceptance list for Dan, in priority order:** (1) re-run the 158-clip batch — steps 1–2 should be near-instant on reuse and step 3 should show phase progress; (2) duck against Clean dialogue after a reload or on a second batch without switching to Choose tracks; (3) Mix on timeline null test at 50 %; (4) Verify loudness once more to confirm a single progress bar and that markers appear on the sequence.

## Latest — The muting Amplify is labelled via the clip name (2026-09-18)

Dan asked for the Amplify that mutes a raw clip to be named "mute" so it's obvious. Premiere's API can't rename an effect (`Component` exposes only `getDisplayName()`; Adobe's reference has no setter, and Effect Controls can't rename one by hand either). So the raw *clip* is renamed instead: `setClipGains()` accepts an optional `suffix` per entry and, in the same transaction as the gain, appends it to the track item's name if not already present — ` · WTV muted` for the −96 dB silence, ` · WTV mix` for a timeline-mix raw clip. Never stacked (Update mix leaves the name alone), and Undo removes name and effect together. Because that changes what `inventory()` reads back as the clip name on a later run, `stripWtvSuffix()` removes the suffix before building `stableClipId()` (so exports/results still reuse) and before the clip name is used for stem naming (no "… · WTV muted · Clean dialogue · A2"). Tests: renamed after silencing, sibling untouched, unchanged across Update mix, same id and clean name on a following Prepare. Not confirmed live — check that renaming the audio item does not also rename its linked video item (the API acts on the one track item, but this is unverified).

## Latest — Dialogue reference render covers only the ducked span (2026-09-18)

Dan: if the dialogue changes, why re-render the entire sequence rather than the area being ducked? It now doesn't. `music-pass.js run()` computes `span` = [min music start − margin, max music end + margin] with margin = 1 s + attack + release + 200 ms hold (clamped to the sequence; a span ≥ 80 % of the sequence just renders the whole thing). `render()` takes the span, sets the analysis clone's in/out points (`createSetInPointAction`/`createSetOutPointAction`, the same calls per-clip export uses live) and exports with `exportFull: false`; `readSummary` validates against the span length, then `padSummary()` places the 20 ms blocks at the timeline offset inside a silent full-length summary, so `analyze()` and clip-relative keyframe mapping are untouched. Cache: the fingerprint now carries the span (`'full'` or `[start,end]`); a sub-span run first looks for its own entry, then for a whole-sequence entry (which covers it). `timing.renders.dialogue.span` reports `'full'` or the span. Hosts without in/out actions fall back to the full render. Tests: `padSummary` placement; a 1320 s mock sequence with one 600–610 s music clip exports a ~26 s span (in/out on the clone verified, `exportFull=false`), detects the dialogue inside it and writes keyframes; a whole-sequence run then serves a later sub-span from cache with no render. That test also caught a real bug in the first cut (`music[].start` is a plain number in `describe()`, not a TickTime — the span came out NaN and silently fell back to full). Suite 243/1 remotely (the 1 is the preset fixture). Not confirmed live.

## Latest — Dialogue analysis cache keyed on the dialogue, not the music selection (2026-09-18)

Dan ducked the whole sequence, then re-ran on one clip: the panel re-exported all 22 minutes of dialogue reference (`render_dialogue 16 s`, `analysis_cache: miss`) although nothing about the dialogue had changed. The cache fingerprint (`music-analysis-cache.js buildFingerprint`) took `passSignature` = `musicPassSignature(sequence, music, dialogue)`, which covers the *music* lanes too — so any different music selection (or the first pass's own Amplify keyframes changing the music lanes' state) produced a new key. The dialogue reference render depends only on the dialogue lanes (clips/trims/mute) and the dialogue clips' effects, so the key now uses `JSON.stringify([musicPassSignature(sequence, [], dialogue), dialogueBefore])` (per-clip effect snapshots of the dialogue). Everything else in the key (duck settings that affect analysis, reference choice, rate/channels/duration, preset, strip-volume flag) is unchanged, as are all the guards that run after a hit. Side fix: `packFloat64Array` now accepts plain arrays (the parity fixture stores levels as arrays, which made every cache round-trip in tests fail silently to a miss). Test: a second run with a different music selection reports `analysis_cache: hit` and performs no second render. Not yet confirmed live; on Dan's sequence the next 1-clip duck after a full pass should skip "Dialogue reference · exporting" entirely.

## Latest — Ducking's "Clean dialogue" reference no longer depends on the session (2026-09-18)

Dan: "ducking often loses track of what is clean dialogue and I have to revert to Choose tracks." Cause: `music-pass.js reference()` in clean mode matched clips only against `context.dialoguePaths` — the exact media paths inserted by the *current* panel session. That set is empty or incomplete after a panel reload (in-place runs can't be resumed), after a second batch on the same sequence (the context is replaced), and always for the offline music-only context (`dialoguePaths: []`). Fix: new `isCleanDialogueClip(entry, paths)` accepts the session paths **or** any of the durable markers every WTV stem already carries: media file name matching `*-dialogue.wav` (per-clip `<id>-dialogue.wav` and full-sequence `<jobId>-dialogue.wav`), track item name containing "Clean dialogue" (per-clip names items `… · Clean dialogue · A#`), or the track's own name containing "Clean dialogue" (full-sequence lanes). `per-clip.js inventory()` now records `trackName` per entry for that last check. Enabled/unmuted gating, Choose tracks mode, and the per-sequence saved choice are unchanged. Test added (each marker alone is sufficient; a raw clip merely named "dialogue" is not).

Also this pass: the local test copy was missing `validation/music-local-parity.json` (staged now), which is why 59 music-pass/loudness tests had been failing here all along — the plugin was fine. With it present, the earlier `listSequences` change surfaced a real fragility: music-pass.js, deplosive.js and lowend.js called `host.listSequences` unconditionally, which the test's stub host lacks; each now has a `safeSequences()` fallback to a filtered `project.getSequences()`. **Suite: 242 pass, 1 fail** (export-presets needs the bundled `.epr` files, which are too deeply nested to stage). Not confirmed live.

## Latest — Add clean tracks looked frozen on 158 clips; export/result reuse across runs (2026-09-17)

**Frozen step 3.** After Clean audio finished ("158 processed clips are ready") the Run 1–3 handler went straight into Add clean tracks with no status output and every button greyed (busy is correct while it runs; there was simply nothing being said). Two things made it slow enough to look hung: `validateOutputs` read every processed stem in full (158 whole-file reads) and, in place, each partial-lane raw clip was silenced one at a time — three transactions plus three track walks per clip on a ~300-item lane. Changes: `clip-batch.js validateOutputs(context, binary, {io, say})` reads only the WAV header per stem when `io` (fs) is passed, with a running count in the status line; `per-clip.js` gained `indexTrackItems(sequence, lanes)` (one walk per lane → Map by timeline key and by `${lane}:${sourceId}`) and `setClipGains(project, context, entries, {say})`, a batched version of the Amplify setter: three phases (append missing / set Left+Right / read back), each one index build and at most one transaction for the whole batch. `silenceRawClips()` and `applyMixGains()` use it; `setClipGain` (single) delegates to it. `apply(context, {say})` now reports every phase (checking, importing N, placing lane i/j, verifying, crossfades, muting/silencing, gain phases); the lane loop takes one `inventory(sequence, {tracks: lanes})` instead of a full inventory per lane; `validate()` with a sequence uses the index instead of a per-clip track walk. main.js passes `say` through Apply and Update mix.

**Reuse across runs ("excessive stale protection").** Previously every Prepare made a new timestamped folder and position-based clip ids (`clip-001`), so nothing from an earlier run could be reused. Now: contexts carry `baseName` (sanitized sequence name, no timestamp) and `clipsFolder()` uses `${baseName}-clips`, so the same sequence always exports into the same folder (existing folder reused; `saveManifest` writes `clip-batch.json` with overwrite). Clip ids are stable: `stableClipId()` = `<source name without extension>-A<lane>-<start ticks>` (per-clip.js `prepare`). In `exportPerClipBatch`, a clip whose `<id>-input.wav` already exists in the folder and validates (header: rate/channels/export length) is marked `exportVerified` without re-exporting ("reused existing file"; count in the ready message). In `processBatch`, if the folder's previous `clip-batch.json` (`context.reuse`, loaded by main.js `loadPreviousManifest`) recorded this clip id with identical settings JSON and its stem files still validate, the previous `result`/`outputs` are adopted with no upload or job ("reused previous result"; count in the ready message). Anything that changes the clip (trim, move, lane, source) changes its id and therefore its file names, so a stale file can never be matched to a changed clip; a settings change (model, wet, post-processing, stems) invalidates result reuse but not export reuse.

Validation: per-clip tests for stable ids across selections and for one add + one set transaction across a partial lane; suite 181 pass, same 59 pre-existing failures. **Not confirmed live.** If Dan's current batch (158 processed, manifest state `ready` in the folder) is re-run with the same selection and settings, step 1 and step 2 should both be near-instant and step 3 should now show progress.

## Latest — Prepare exports efficiency (2026-09-17)

Dan asked for an efficiency check of step 1. Per exported clip the loop was doing work that scaled with the *sequence*, not the clip: a full-sequence fingerprint (`assertUnchanged`, ~8 API calls per timeline item, every clip → O(clips²)); a full render fingerprint after every clip although only the last is ever compared; disabling every clip on the render per export (N actions); a full render inventory to find one clip; reading the entire WAV into memory on every 200 ms poll of `waitForStableWav` (hundreds of MB for a 30-minute clip); and, on a multicam source, walking every project bin several times per clip to re-fetch the unlisted render clone. Changes, none of which alter what is exported or where it is placed:

- `per-clip.js exportClip()`: full-sequence `assertUnchanged` at most once per `context.assertIntervalMs` (15 s; `resolveContextSequence` still refreshes the handle every clip). Isolation is incremental after the first clip (`context.renderIsolatedKey`: re-enable target, disable the previously isolated item — 2 actions instead of N) and `inventory()` takes `{tracks}` to scan only the affected lanes; if the previously isolated clip can't be found the code falls back to one full pass. Render fingerprint deferred with `context.deferRenderSignature`; new `sealRender(context)` computes it once for the clip the render is currently isolated on. `assertExportsUnchanged` says "batch was not finalized" if the seal is missing.
- `main.js exportPerClipBatch()`: sets `lastAssertMs=0` and `deferRenderSignature=true` for the batch, seals in `finally`. The export wait now uses new `wav.js waitForStableWavFile()` (lstat size + bounded `music-wav.header()` parse, two stable polls) instead of `waitForStableWav`'s whole-file `file.read` per poll. The old function is still exported for other callers.
- `premiere.js findSequence()`: caches the last project-item handle for an unlisted sequence (`unlistedItemHandles`) and asks it directly before re-walking the bins.

Live result: 114 of 158 clips exported at roughly one per second on the multicam (previously far slower), then clip 115 threw `Cannot read properties of null (reading 'guid')` from inside `findSequence` → `Array.find`: `project.getSequences()` returned an array with a null entry. New `listSequences(project)` in `premiere.js` filters null/guid-less entries (and tolerates the call throwing); every `getSequences()` call site in premiere.js, per-clip.js, deplosive.js, lowend.js and music-pass.js goes through it now. The interrupted batch is resumable ("1. Resume export") — 114 verified exports are kept. Regression test added.

Validation: new per-clip test (one `assertUnchanged` across a 3-clip batch, zero render signatures until `sealRender`, render left isolated on exactly the last clip, original untouched, unsealed batch refused). Suite 180 pass, same 59 pre-existing failures. **Not confirmed live.** Watch for: the incremental isolate on a real host (the 2026-09-14 in/out-point misfire retry still wraps it), and `require('fs').lstat/open/read` on the export WAV path from main.js (the loudness pass already uses the same calls successfully).

## Latest — Verify loudness: flag every peak over a level, with sequence markers (2026-09-17)

`loudness-meter.js` `createMeter(channels, {peakFlagDbfs=-6, mergeSeconds=2})` now records **every** sample above the flag level as an event (start, end, loudest sample + its position/channel, samples over), not just the single loudest sample. Hits within `mergeSeconds` of the previous event's last hit fold into it, so a hot passage or a clipped burst is one flag at its first sample. Capped at 500 events (`over_threshold_truncated`). Result adds `over_threshold_dbfs`, `over_threshold_merge_seconds`, `over_threshold_events[]`, `over_threshold_count`, `over_threshold_truncated`; everything that was there before is unchanged.

`loudness-pass.js` `run()` takes `peakFlagDbfs`, `mergeSeconds`, `addMarkers`, `formatPosition`; after the timeline-unchanged check it calls new `placePeakMarkers()`, which uses the UXP Markers API (`ppro.Markers.getMarkers(sequence)` → `createAddMarkerAction(name, 'Comment', TickTime, TIME_ZERO, comments)`, Premiere 25.6+ per Adobe's reference) to add one Comment marker named `WTV peak <peak> dBFS` at each event's start, comments carrying the span, loudest sample/position/channel and sample count. Existing markers whose name starts with `WTV peak` are removed in the same transaction so reruns replace rather than pile up. A host without the Markers API returns null (no-op); a marker failure is reported in the summary but does not fail the measurement. Markers do not affect `host.signature()`, so a rerun after markers still passes the unchanged check.

Panel: Options → Loudness verification gained **Flag peaks over · dBFS** (default −6, range −40..0), **Merge within · s** (default 2, 0..30) and **Add sequence markers at flagged peaks** (default on); all three round-trip through settings-file (with defaults for older files) and Reset all. The Verify loudness summary now lists the event count and the first five positions/levels, plus how many markers were added/replaced. The full event list is in the Copy report JSON.

Follow-up (same day): Dan reported the "analyzing N%" status line bouncing up and down as it climbed. The loudness pass now writes a single static status line and reports progress monotonically (whole percents, never backwards) through a new `onProgress` hook that main.js routes to the existing progress bar (`setCleanProgress`), which is hidden again in the action's `finally`. If the bounce was a footer reflow from the changing text length, this removes it; if the number itself was going backwards on the host, the monotonic guard hides it and the underlying cause would be a non-monotonic `format.samples`, which would be worth a report.

Speed (same day, Dan: "is it possible to save time encoding"): two changes in `loudness-pass.js`. (1) **Streaming analysis** — `verifyOutput` now follows the WAV while Premiere writes it: a lenient `streamingHeader()` finds fmt/data without trusting the RIFF/data sizes (writers patch those in at the end), whole frames past the data offset are fed to the meter as they appear (file opened per poll, never held across polls, in case the writer renames), and once the size is stable and the strict `header()` validates, any remainder is fed and the run finishes. If the lenient parse turns out wrong (data offset differs, or more frames were consumed than the final header says), the streamed meter is discarded and the finished file is analyzed from scratch — correctness never depends on the overlap. Net: total wait ≈ Premiere's render time. (2) **Render cache** — the finished WAV is kept in the temp folder with its fingerprint (`sequenceId + channels + timeline signature + effect signature`); a rerun on an unchanged timeline skips the export and re-analyzes the cached file (so changing the flag level/merge window and re-verifying never renders). Replaced (old file deleted) when the fingerprint differs or the file changed; in-memory only, so a panel reload starts cold. A finished render that fails before caching is deleted. Result carries `render: 'streamed' | 'rendered' | 'reused'`; the panel appends "Reused the previous render" when applicable. `tests/loudness-stream.test.cjs` (3 tests) drives a simulated growing WAV writer through the real pass: streamed result matches, progress monotonic, no handle leaks, reuse skips the export and re-analyzes with a new threshold, signature change re-renders and deletes the old file. **Unverified live:** that Premiere writes the WAV header before the data (if it doesn't, streaming silently falls back to the old full analysis — `render: 'rendered'` in the report says so), and that reading a file Premiere is still writing is permitted on Windows (the old per-poll header check already did this).

Live follow-up: Dan saw two progress bars after the export -- the stream reached nearly 100% and then a second bar started from zero. That is the streaming path's fallback firing: the streamed frames were judged unusable after the strict header, and the finished file was re-analyzed from scratch. Most likely cause: Premiere appends a chunk after `data` (bext/LIST/padding), so the stream fed those bytes as samples (`consumed > format.samples`), and there is no un-feeding. Fix: the stream now holds back the last 2 s of whatever is on disk (`STREAM_MARGIN_FRAMES`) and only feeds that tail once the strict header says exactly where the data ends; a trailing chunk smaller than that can no longer contaminate the meter. If a fallback still happens, the result now carries `stream_fallback_reason` (in Copy report) naming which check failed, and the status line says the layout differed. Regression test with a trailing LIST chunk added.

Validation: new `tests/loudness-peaks.test.cjs` (5 tests: multi-event detection with per-event loudest tracking, merge-window boundary and sustained passage, configurable threshold/window, 500 cap, marker add/replace/no-API). Suite 175 pass, same 59 pre-existing failures. **Not confirmed live**: the Markers API call shape (Adobe docs it exactly as used; if `createAddMarkerAction` rejects `TIME_ZERO` as a duration, try `createWithSeconds(0)`), and that markers appear on the sequence rather than the clip.


## Latest — "Mix on timeline" (2026-09-17)

New Options > Clean dialogue checkbox **Mix on timeline** (off by default; per-clip mode only; remembered via settings-file). When on, the service renders the neural output at **100% wet** (`main.js settings()` overrides `enhancer_wet`), and at Add clean tracks the raw clip and its Clean dialogue stem *both stay audible*, each with a native Amplify whose static gain makes them sum to the mix slider: raw = `20·log10(1−w)` dB, clean = `20·log10(w)` dB, floored at Amplify's −96 dB (so 100% = today's raw-silenced behavior, 0% = clean silenced). No lane mute, no disable in this mode. A new **Update mix** button (beside step 3, enabled only after an applied timeline-mix batch) re-reads the slider and rewrites the two Amplify values per clip — no export, upload or service call. Slider label reads "Timeline mix · N%" while the checkbox is on.

Code: `per-clip.js` — `silenceRawClip()` generalized into `setClipGain(project, context, locate, db, record, label)`; `record.index` remembers which chain slot holds *our* Amplify so a rewrite never stacks a second one (verified by re-reading Left/Right ≈ target). `mixGains(wet%)`, `findStemTrackItem()` (by lane + imported source id — each clip's stem location is recorded on `clip.stem` at Apply), `applyMixGains()`, exported `updateMix(context, wet)`. `apply()` branches on `context.timelineMix` before the lane mute/disable loop. `main.js` — `timelineMixOn()`, `mixLabel()`, `context.serviceWet` recorded at Clean time and checked at Apply (refuses to timeline-mix a stem the service already blended: "turn it off again, or re-run 1–3 with it on"), `context.timelineMix`/`context.mixWet` set at Apply, `updateMix` action. `button-state.js` — `updateMix` enablement. `index.html`, `settings-file.js` — checkbox, help text, button, field. Reset-all clears it.

**Alignment fix that this depends on (also affects normal replacement mode):** for an off-grid raw clip the render export used to start at the raw clip's exact start while Premiere placed the stem at the *floored* frame, so the stem's audio played up to one frame (33 ms) early — inaudible when the raw is silenced, a comb filter once raw and clean are summed. `placementGeometry()` now exports from `gridStart` too (`exportStartTicks`; the lead-in is silence on the render because every other clip is disabled and the raw clip hasn't started), `isolateClipOnRender()` takes the in point from it, `clip-batch.js` manifests carry `export_start_ticks`. On-grid clips are unchanged. Off-grid regression test updated to assert the floored in point.

Validation: `mixGains` math, a full timeline-mix apply (full lane not muted, raw clips not disabled, raw −12.04 dB / clean −2.50 dB at 75%, stems located, Update mix to 30% then 100% rewrites the same components without stacking, refuses on a non-applied context), plus the off-grid in-point test. Suite: 170 pass, same 59 pre-existing failures. **Not confirmed live.** First acceptance step should be a **null test**: set 50%, run 1–3 with Mix on timeline, then temporarily invert the raw clip's polarity in Premiere — if the model is latency-free and placement is sample-aligned, the sum should be much quieter than either half; if it flanges, paste the report and treat timeline mix as unusable until alignment is fixed. Also unverified: `AudioFilterFactory.createComponentByDisplayName` on the imported *stem* clip (same API as raw/music clips). Note the timeline mix and the service mix are not identical at intermediate values: level/limit/de-ess only touch the clean half here.


## Latest — "Process in place" option (2026-09-17)

Added a new Options > Clean dialogue checkbox, **Process in place (no clone)**, checked by default. When on, Prepare adds Clean dialogue/Ambience/Music tracks directly to the active sequence instead of cloning it first — no separate safety copy, no duplicate sequence in the project. Undo still works project-wide as before regardless of this setting.

Implementation reuses the existing `resumeAppliedClone()` pattern rather than adding special-case branching: `premiere.js` gained `useActive()`, a sibling to `cloneActive()` that runs the same validation (project open, sequence active, mono/stereo, 44.1/48/96 kHz, duration > 0) but performs no clone transaction, returning a context with `originalId: null` and `inPlace: true`. `originalId: null` is the same trick `resumeAppliedClone()` already used to make `assertUnchanged()`'s "refuse to touch the original" guard a no-op — no changes were needed to that guard. `applyStems()` now skips the final sequence-rename step when `context.inPlace`, and its user-facing strings (mute-failure, failed-apply, catch-block "retained for inspection") are conditional on it so an in-place run never talks about a "clone." `per-clip.js`'s `prepare()` takes a new `{inPlace}` option and picks `useActive()` vs `cloneActive()` accordingly — everything downstream (crossfade handling, frame-tick math, per-clip render-sequence isolation via `ensureRenderSequence()`) already operates generically on `context.sequence` and needed no change. Per-clip's disposable render-sequence clone (used to isolate one clip's audio for export, then deleted via `releaseRender()`) is unaffected either way — that's a technical necessity unrelated to what "in place" opts out of.

`main.js` wires a new `processInPlace` checkbox through to both full-sequence and per-clip Prepare, updates the full-sequence Prepare button label ("1. Export" vs "1. Clone & export"), and reworks every user-facing "clone" string (resume/export-ready/apply-failed/stems-ready messages, the WAV-choice error) to read generically or reference "the sequence" instead when `context.inPlace` is set. `button-state.js`'s failed-apply hint is likewise conditional. `processInPlace` was added to `settings-file.js`'s field map (boolean) so it round-trips through Remember/Save/Load like every other checkbox, defaulting via the HTML `checked` attribute (no `defaults.json` entry needed — consistent with how `selectedDialogue` etc. are handled). No warning copy was added next to the checkbox per explicit instruction.

**Live follow-up (2026-09-17, same day):** Dan's first in-place Prepare inside the nest failed at `stripAudioTransitions` → `sequenceById` with "Could not find the sequence in the project." This *confirms* the earlier working theory: when the active sequence is a nested sequence, `project.getSequences()` does not list it. Fix: new `findSequence(project, id)` helper in `premiere.js` that checks `getSequences()` first and falls back to `project.getActiveSequence()` when the ids match; `sequenceById()`, `resolveContextSequence()` and `assertUnchanged()` all go through it now. Regression test added (mock `getSequences()` returns `[]`; in-place resolve/assert/apply all succeed). The other `getSequences()` diff sites (render clone, deplosive, lowend, music-pass) are before/after diffs where the nest is consistently absent on both sides, so they were left alone — but they haven't been exercised live inside a nest either; if Fix a pop / Enhance low end / Duck fail there, that's where to look.

**Second live follow-up (2026-09-17):** with that fixed, Prepare got further and failed at `ensureRenderSequence` → `identifyNewSequence`: "found 0 candidate sequence(s): none, of 31 sequence(s) total". The clone transaction succeeded, but the render clone of the nest is *also* not listed by `getSequences()`. **Best guess, unconfirmed:** the clone becomes the active sequence. `identifyNewSequence()` now falls back to `project.getActiveSequence()` when the diff finds nothing (accepting it only if it's neither previously known nor excluded), and its error text now reports what the active sequence was after the clone ("already known" / "the source itself" / "unlisted") so the next failure says exactly which assumption is wrong. Every render-sequence lookup in `per-clip.js` (`ensureRenderSequence`, `isolateClipOnRender`, `assertExportsUnchanged`, `releaseRender`) now goes through the exported `host.findSequence()` instead of scanning `getSequences()`. Open risk: if the render clone becomes active and stays so, the nest itself is then neither listed nor active, so `resolveContextSequence()` for the nest would fail at the next step; `releaseRender()` deletes the render clone before Apply, which may or may not restore the nest as active. If the live run fails there, the alternative is keeping the in-memory handle rather than re-fetching, or using `project.setActiveSequence(nest)` after each render step. Regression test in `tests/per-clip.test.cjs` models the guessed behavior (nest + clone unlisted, clone becomes active).

**Third live follow-up (2026-09-17):** the render step now passed, but Prepare failed at `createExportTarget` with "A Folder with given name exists" and prompted twice for a folder. Cause: in-place `context.name` was the bare sequence name, so the second run collided with the first run's `<name>-clips` folder (clone mode never hit this because its name carries a timestamp). Fix: `useActive()` now builds the same `<name>_WTVAudioWizard_<timestamp>` label as `cloneActive()` (used only for folder/file/render-clone names -- the sequence is still not renamed), and `main.js`'s new `clipsFolder()` reuses an existing `-clips` folder instead of throwing. The first "Could not access project folder" prompt is pre-existing behavior for a project whose folder isn't accessible; unrelated to in-place.

**Fourth live follow-up (2026-09-17):** the "clone becomes active" guess was wrong. Diagnostic text from the live run: `found 0 candidate sequence(s) ... Active sequence after the clone: "Bear Multicam Day1" (the source itself)`. So Dan is editing inside a **multicam source sequence**; cloning it succeeds but the clone is neither listed by `getSequences()` nor made active. New third path: `snapshotProjectItems(project)` walks every bin collecting project-item ids; `identifyNewSequence()` takes an optional `beforeItems` snapshot and, when the sequence diff is empty, diffs the bins instead and asks each new item for its sequence via `ClipProjectItem.getSequence()` (`sequenceFromProjectItem()`). When exactly one resolves, it's the clone, and its sequence-guid → item-id mapping is cached in `unlistedSequenceItems` so `findSequence()` can re-fetch it after later transactions (list → active → cached item, in that order). Both `cloneActive()` and `ensureRenderSequence()` now pass the item snapshot. Error text additionally reports how many new project items appeared and how many resolved to a sequence. **Unverified assumptions:** that `ClipProjectItem.getSequence()` exists on this host (Adobe's UXP reference documents it; if it's missing, the error will say "0 resolved to a sequence"), and that the clone lands in a bin reachable from the root item. Regression test in `tests/per-clip.test.cjs` updated to model this (clone only visible as a new root-bin item).

**Fifth live follow-up (2026-09-17) — steps 1–3 now work in place inside the multicam source.** Dan reported that when a clean track is added, the raw clip is sometimes disabled, and when it's linked to video the video gets disabled too. That's per-clip `apply()`'s partial-lane path (`createSetDisabledAction(true)` on processed raw clips when not every enabled clip on the lane was processed) — harmless on a clone, destructive in place because the UXP API has no link/unlink control (checked Adobe's AudioClipTrackItem reference: no linked-item methods at all). Fix: in place, partial lanes now go through new `silenceRawClip()` in `per-clip.js`, which appends a native Amplify to the raw clip's chain and sets Left/Right to -96 dB as a static value (same `createKeyframe` + `createSetValueAction(key, true)` pattern normalize-music.js uses live; same -96..+48 dB normalized encoding music-effects.js confirmed live), then re-reads and verifies ≈0. Audio-only, Undo-able, visible in Effect Controls. Full-lane track mute is unchanged (track mute never touches video). Clone mode still disables as before. Also found while here: per-clip `apply()` renamed the sequence unconditionally (`WTV: finish clean sequence`) — now guarded with `!context.inPlace`, since `context.name` carries the timestamp; if Dan's sequence got renamed to `..._WTVAudioWizard_<timestamp>` on the run that worked, that's why, and a manual rename back is safe. Failure message conditional too. Regression test added. **Unverified live:** that `AudioFilterFactory.createComponentByDisplayName(name, audioTrackItem)` + `createAppendComponentAction` works on a raw *dialogue* clip exactly as it does on music clips (same API, same item type, so expected to). -96 dB is Amplify's floor, not true silence; inaudible in practice.

**Run clean dialogue (1–3) enablement (2026-09-17):** Dan noticed the combined button was sometimes greyed out. Cause: `button-state.js` disabled it whenever `context.applied` or `context.failedApply` was set, even though Prepare itself re-enables in exactly those states to start a new batch (and main.js's handler just runs whichever of steps 1–3 are currently enabled, in order). Rule simplified to: enabled in per-clip mode, when connected and not busy, whenever any of Prepare/Clean/Add is enabled. Test added.

Known limitation, not solved here: `resumeAppliedClone()` recovers a finished session after a panel reload by matching the sequence name against `..._WTVAudioWizard_<timestamp>$`, which in-place mode deliberately never applies (the sequence keeps its real name). Reloading the panel mid- or post- an in-place run will not auto-recover context the way the clone flow does; if Dan wants that, it needs a different recovery marker and is a separate task.

Validation: added `useActive()` and in-place `applyStems()`/failure-message tests to `tests/premiere.test.cjs`, and an in-place `prepare()` test to `tests/per-clip.test.cjs` (confirms no second sequence appears in the mock project and the sequence keeps its original name after apply). Full suite re-run clean: same pre-existing ~59 unrelated failures as before this change, all new tests pass. **Not yet confirmed against real Premiere** — needs: (1) normal clone path still unaffected with the checkbox off, (2) in-place run on an ordinary top-level sequence lands tracks correctly with the name unchanged and Undo recovers cleanly, (3) in-place run while editing inside a nest (the original trigger for this feature) no longer throws and adds tracks directly to the nest, (4) a deliberately failed in-place run shows sensible "original sequence retained" messaging and Undo actually recovers. Reload plugin; no service restart; ZIP not rebuilt; version remains 0.8.0.


## Latest — "Could not identify a unique clone" while editing inside a nest (2026-09-17)

Dan hit `Could not identify a unique clone; no timeline edits applied` at Prepare while the active sequence was a nested sequence (opened by stepping into a nested-sequence clip on another timeline). `cloneActive()` (`plugin/premiere.js`) and per-clip.js's `ensureRenderSequence()` both identify a freshly cloned sequence the only way UXP allows — diffing `project.getSequences()` before/after the clone transaction, since action creators don't return the object they create (same reason `importFiles()` only returns a boolean elsewhere in this codebase). **Working theory, not yet confirmed live:** if `project.getSequences()` doesn't consistently include the active sequence in its pre-clone snapshot when that sequence is a nest, the diff would see two "new" items (the nest itself, plus the real clone) instead of one, tripping this exact guard.

Fix: extracted both call sites' diff logic into one shared `identifyNewSequence(project, before, excludeIds, label)` in `plugin/premiere.js` (now exported). It explicitly excludes known ids (the original sequence; for the render-sequence step, also the main WTV clone) from candidacy, rather than relying solely on the before/after diff — so even if the active/original sequence is spuriously missing from the pre-clone snapshot, it can no longer be mistaken for "the new one," and Prepare should now succeed inside a nest instead of throwing this error. On a genuine ambiguity (more than one truly new, unexplained sequence), the error is now diagnostic: it names how many candidates were found, lists their names, and — specifically when an excluded id was missing from the pre-clone snapshot — adds an explicit "editing inside a nested sequence" hint, so a recurrence is diagnosable from the panel's own error text without a repro session.

Dan also asked whether the clone is strictly required, or whether skipping it just costs Undo. Answered in chat, recorded here since it affects workflow decisions: Premiere's Ctrl+Z Undo works across the whole project regardless of which sequence is active, so skipping the clone would **not** cost Undo specifically. What the clone actually buys is (1) the original edit sequence stays completely untouched so Dan can instantly A/B against it or discard the whole clone if a batch goes wrong, rather than trusting Undo to cleanly unwind a large multi-step operation, and (2) it's the sequence the plugin adds new tracks to — without it, Clean dialogue/Ambience/Music tracks and muted raw lanes would land directly in Dan's real edit. No "process in place, no clone" option exists in the code; building one would be a real workflow change, not a bug fix, and needs its own approval/design pass if wanted (e.g. what happens to per-clip render-sequence isolation, which also currently depends on a clone of the WTV clone).

Validation: added 2 new regression tests to `tests/premiere.test.cjs` — one proving `cloneActive()` no longer misidentifies ambiguity when the active sequence is (simulated) missing from its own pre-clone snapshot, one confirming a genuine two-candidate ambiguity still fails with named candidates in the message. Full existing suite re-run clean: same pre-existing ~59 failures as before this change (unrelated, not investigated as part of this task). **Not yet confirmed against real Premiere or the actual nest** — this fixes the failure mode consistent with the working theory above and makes any recurrence self-diagnosing, but the root cause (why the active sequence would be missing from `getSequences()`'s pre-clone snapshot) has not been directly observed. Reload the plugin and retry Prepare from inside the same nest; if it still fails, the new error text will say how many candidates were found and whether the nest hint fired — paste that back rather than re-guessing. No service restart; ZIP not rebuilt; version remains 0.8.0.


## Current handover summary — 2026-09-17

Most recent changes were already recorded below. This summary supersedes older historical entries where behavior differs:

- Plugin **0.8.0**, service **0.7.1**; final 0.7.1 plugin was user-confirmed stable. ZIP has not been rebuilt.
- Model mix sits beside Clean audio, defaults to 100%, supports GAP-URGENet/MossFormer, and blends before post-processing. Native Spectrum slider replaced the snapping HTML range control. Visible label now reads **Model mix · 90%**, without “wet”; internal fields/diagnostic terminology retain wet/dry names. User's latest native report shows 90%, confirming an intermediate value is being read; audible blend acceptance has not been explicitly confirmed.
- Preferences auto-restore and are included in Save/Load preset files. Remembered de-click selection now survives reconnect (older forced-off notes are historical).
- Independent full-mix loudness verification is user-confirmed working. Peak position/channel were added afterward; timestamps are elapsed from sequence start, not custom-start SMPTE. Sample peak only, not true peak. Loudness target/tolerance have their own collapsible Options section, closed on panel load/reset.
- Selected dialogue clips now support **30 minutes**; upload cap **1536 MiB**, Fix-pop seed up to 1800 seconds. Latest run: **233 JavaScript tests pass**, including duration boundaries. A full 30-minute neural run remains untested.
- Last targeted Python run: **41 passed**, with one separate music-analysis baseline assertion excluded after failing (expected -4.9897 dB, actual -8.0 dB). Keep this open; do not describe the full Python suite as green.
- To use all latest changes: **restart service, reload plugin, reconnect**. Native Save/Load picker acceptance and peak-location audition remain unconfirmed.
- VS Code was opened on the same existing `outputs` Git checkout used by Cursor (`wildtv25/Ai-Integration`, branch main). No pull, commit or push performed; preserve local changes when continuing.


## Latest — 30-minute dialogue clips (2026-09-17)

Raised per-clip Prepare limit from 600 to 1800 seconds inclusive, with a clear duration error. Service upload validator already had no duration ceiling; raised service MAX_BYTES and full-sequence client upload cap from 512 to 1536 MiB to accommodate 30-minute 96 kHz stereo float32 WAVs (~1.38 GB plus header). Fix-pop seed schema now permits positions through 1800 seconds. Neural workers retain their existing processing/cache behavior. Reload plugin and restart service for the larger upload cap. A boundary Prepare test covers 1800 accepted / 1800.01 rejected. Real 30-minute model processing has not been benchmarked or validated in this task.


## Latest — Collapsible loudness options (2026-09-17)

Target/tolerance/help now live under the matching Loudness verification section toggle in Options. Collapsed on each panel load and Reset all; uses shared section/keyboard handling. Main Verify loudness button unchanged. Reload plugin; no service restart.


## Latest — Wet slider endpoint snapping workaround (2026-09-17)

User reports HTML range control snaps between 0/100 in Premiere. Replaced it with Adobe's documented native UXP `sp-slider` (0..100, step 1), keeping the same settings ID. Input/change handlers now update only label/persistence rather than resetting disabled state during drag. Settings capture accepts numeric native widget values as well as strings. Regression covers 1/25/37/50/75/99 values and round trips. Native drag acceptance still pending; reload plugin, no service restart. Reference: https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-spectrum/spectrum-uxp-widgets/user-interface/sp-slider .


## Latest — Model wet/dry slider (2026-09-17)

Added 0-100% Model mix slider beside Clean audio (100% default), shared by GAP-URGENet/MossFormer, disabled while busy or neural cleanup is off. Main submits `enhancer_wet` (0..1) when service defaults expose it; partial wet with an old service raises an explicit restart instruction rather than a schema error. Remember/Save/Load includes modelWet; older settings files default to 100%. Full-sequence and per-clip paths both use settings(). Diagnostic report includes percentage. No live update of previously inserted clips.

Service Settings validates the new bounded field. After loading cached/new neural output and existing rate/length/channel alignment, `blend_dialogue` linearly combines dry and model output BEFORE dialogue postprocess, de-click and final normalization. Endpoints preserve original arrays; stem extraction is unaffected. Neural cache stays fully wet and mix-independent; full job fingerprint includes the mix. Even at 0%, selected model still runs on a cache miss; this intentionally keeps model/cache validation behavior unchanged. No new delay/phase compensation is introduced; audition partial blends on actual models. Enhancement report includes wet_mix.

Validation: 231 JS tests; offline UI harness; 41 targeted Python tests passed, including mocked end-to-end GAP/MossFormer half-wet output and cache reuse across stem combinations, numeric bounds and exact endpoints. Full targeted Python invocation had one unrelated music-analysis assertion failure (baseline gain expected -4.9897 but measured -8.0); excluded it for the successful follow-up, not changed. Native slider/model audition pending. Restart local service, reload plugin and reconnect. Versions unchanged; ZIP not rebuilt.


## Latest — Locate loudness sample peak (2026-09-17)

Dan confirms Verify loudness works natively (-20.2 LUFS, displayed peak 0.0 dBFS). Added first maximum sample position and 1-based channel to meter/result summary; position is HH:MM:SS.mmm **elapsed from sequence start**, not SMPTE or custom-start timecode. Copy report includes exact sample position in seconds and number of tied maximum samples across channels. Silence has no peak location. Peak level now displays 3 decimals to reduce one-decimal rounding ambiguity; a displayed 0.0 alone did not prove clipping. Existing measurements have no position history; rerun Verify loudness after reload. Tests cover known sample position/channel, ties, silence and formatting. No audio/timeline changes; native position acceptance pending.


## Latest — Remember settings + independent loudness verification (2026-09-17)

Implemented requested items 3 and 5. Main stores validated portable preferences on change under `wtv-last-settings-v1`, restores after initial DOM defaults and before normal interaction, persists explicit Load and resets, and preserves these choices across reconnect. Invalid incomplete edits retain the prior valid snapshot. Saved JSON files provide named presets. Old schema-1 files missing loudnessTarget/tolerance migrate to -24/1; other required fields remain strict. De-click now remains as explicitly remembered, instead of being forced off on reconnect. Connection and sequence-specific track storage stays separate.

New **Verify loudness** button: full audible sequence mix, independent of server, selection, cleaning and normalization. Asked user about scope/target; no reply received during implementation, so used stated default full mix plus editable Options target/tolerance (-24 LUFS +/-1 LU initially). `loudness-pass.js` exports active sequence directly with exportFull=true to temporary 48 kHz mono/stereo WAV, listens while verifying complete stable WAV headers, reads bounded chunks, validates timeline signature and clip effect snapshots, then deletes completed audio. No timeline edits/clones/imports. Keep mixer unchanged: master/track effects and solo changes are not completely covered by signature checks. Unconfirmed/cancelled renders are retained to avoid deleting an in-flight export. LUFS readings describe the exported render, not a future live state.

`loudness-meter.js`: BS.1770-5 Annex 1 coefficients at fixed 48 kHz; channel-energy sum, 400 ms blocks / 75% overlap; -70 LUFS absolute and -10 LU relative gates, incomplete blocks discarded. Also raw RMS and **sample peak**, not true peak. No claimed delivery compliance, no surround or LRA yet. Null integrated loudness for silence/too-short gated material cannot pass the target. Full report includes target, tolerance, deviation, timestamp, sequence and scope. UI summary retained under button; Copy report includes details. Shared `music-wav.js` exports existing header/sample helpers without changing duck analysis behavior.

Validation: **228 JS tests pass**. Generated 1 kHz mono -20 dBFS tone reads -23.0 LUFS both here and FFmpeg ebur128; stereo summation, silence gating and invalid samples tested. Mocked full export/read/cleanup, cancellation and timeline-change rejection tests pass. Browser harness confirms offline buttons, persisted changes and restoration in a fresh document. Native Premiere export/meter acceptance remains pending. Version remains 0.8.0; no service change or ZIP rebuild. Standard reference: https://www.itu.int/rec/R-REC-BS.1770 .


## Latest — Save settings separator initialization fix (2026-09-17)

User's report shows Save settings failing validation for separator before opening the save picker. Inspection found `showSettings` did not explicitly initialize that select (unlike mode/enhancer); likely an untouched UXP select returning empty despite its first HTML option. Now explicitly sets Bandit v2 during initialization/reset, and capture defaults only empty/null/undefined separator values to Bandit, the sole enabled model. Explicit unsupported values and malformed imported files remain rejected. Validation messages now distinguish saving from loading. No timeline edits or version bump; reload panel and retry Save settings. All 222 JS tests and offline UI regression pass. Native Save/Load picker acceptance still pending.


## Latest — v0.8.0 settings files; v0.7.1 stable (2026-09-16)

Dan confirmed the final v0.7.1 normalization works great: both limiters bypassed, all band gains 0 dB. Record v0.7.1 as the user-confirmed stable baseline. Plugin minor version incremented to 0.8.0 (manifest, heading, diagnostic version and network troubleshooting text). Service stays at compatible 0.7.1; handshake unchanged.

Added Options > Save settings / Load settings using native UXP JSON file pickers, independent of connection. `settings-file.js` allowlists and validates all portable visible processing preferences plus legacy music fields; never exports tokens, service URL, source paths, job state or timeline track IDs. Rejects invalid schema, types, ranges and enums before applying any field. Loading a different mode while context exists is rejected to preserve the workflow. Loaded settings survive reconnect during the panel session; explicit Load honors saved de-click. Reopening still follows existing startup defaults; users can load the file again. Reset clears the session override. Busy action guards apply. No adjustable Normalize settings exist to serialize.

All 220 JavaScript tests pass; offline UI regression also passes. Tests cover round trip, credential exclusion, malformed values/schema, and blank numeric input. ZIP not rebuilt; reload plugin for new buttons. Prior v0.7.1 native validation remains historical; settings file pickers still need native acceptance.


## Latest — Zero band makeup gain in Normalize (2026-09-16)

User requested removal of positive band gains. Runtime Broadcast preset now sets Gain 1-4 to native 0.5 (captured 0 dB value); Peak control inherits these zero gains. Both limiters remain bypassed. Overall output gains stay -12 dB for Broadcast and 0 dB for Peak control. Original native capture JSON remains intact. Updated README, tooltip/status and rerun regression assertions. Reload plugin and rerun Normalize on selected clips to update their effects; no open timeline edits performed by this task. Automated suite: 217 tests pass. This revision has not been checked live in Premiere; no ZIP rebuild or service restart.


## Latest — Normalize: bypass both internal limiters (2026-09-16)

Reviewed the latest two-stage revision (Broadcast -12 dB, then peak control 3:1 above -30 dB at 0 dB output). User requested limiter bypass because the result sounded louder. Both runtime presets now set `LMAX: Bypass` (index 53) to 1; the whole compressor remains enabled. This bypasses the limiter section, rather than merely changing its brickwall mode. Original `music-broadcast-preset.json` stays an untouched native capture; the runtime Broadcast copy overrides bypass before the peak preset inherits it. Existing readback verification includes bypass and rolls back on mismatch. UI tooltip/status and README describe the change.

Reload and rerun Normalize on selected music to replace existing instances; this task did not edit the open timeline. Positive Broadcast band gains (+1 dB band 1, +3 dB band 4) are still inherited by BOTH stages. Flagged this to Dan as another possible source of added loudness; did not change gain/compression scope without a request. No measured attribution of the loudness increase to the limiter has been established.

Validation: all **217 JavaScript tests pass**, including limiter bypass in both stages on repeated runs, whole-effect enabled, native capture unchanged, and rejection of incorrect bypass readback. The earlier handoff's 59 suite failures do not reproduce in this run. Limiter bypass revision has not been checked live in Premiere. No service restart, version bump or ZIP rebuild.


## Latest — Peak-control compressor added to Normalize music levels (2026-09-16)

Dan asked for a second compression stage: anything louder than **-30 dB** on selected music clips should go through **3:1 compression** so it's closer to -30 dB with fewer peaks. Implemented as a second native Multiband Compressor instance, inserted **after** the existing -12 dB Broadcast stage (Dan's chosen order): Threshold 1-4 = -30 dB, Ratio 1-4 = 3:1, Output Gain = 0 dB (no added gain from this stage), same verified 105-parameter layout/match id as Broadcast.

Both stages share the same Multiband Compressor match id, so a rerun now removes **all** existing Multiband Compressor(s) on the selected clip (one from an older single-stage run, or two from a prior run of this version) before inserting a fresh, correctly-ordered pair — same pattern already used for music-ducking Amplify replacement. Each clip's whole pair is inserted/configured/verified/rolled-back together; a clip that fails restores both to their pre-run state.

Threshold/ratio values are **not** a freshly guessed dB-to-normalized formula — both are solved from numbers Broadcast itself already shipped and this component already had confirmed live: Broadcast's own Ratio 1 (0.06896551698446274) and Ratio 2/3 (0.03448275849223137) decode exactly to 2/29 and 1/29 under `normalized=(ratio-1)/29`, i.e. stock Broadcast already ships 3:1 on bands 1/4 — the peak-control stage reuses that exact captured value rather than recomputing the fraction (recomputing lands a few ULPs off, since Premiere's own captured value isn't bit-identical to a fresh `(3-1)/29` in double precision). Broadcast's own Threshold 4 (0.5833333134651184) decodes to an exact -25.0 dB under `normalized=(db+60)/60`, the only one of the four that lands on a round number under any tested range — confirming a -60..0 dB threshold range, so -30 dB is exactly 0.5. Output Gain's confirmed -18..+18 dB range (from Broadcast's own -12 dB → 0.1666666716337204) puts 0 dB at 0.5 too. See `plugin/normalize-music.js`'s header comment for the full derivation.

Implementation: `plugin/normalize-music.js` (now builds `peakPreset` from `broadcastPreset` at load, and loops both stages through insert/configure/verify/rollback); `plugin/main.js`'s `normalizeMusic` action and `plugin/index.html`'s button title updated to describe both stages; `README.md` updated. No changes to `plugin/music-broadcast-preset.json`, `plugin/music-effects.js`, or any other feature.

Validation: **5/5 new JavaScript tests pass** in `tests/normalize-music.test.cjs` (two-stage insertion/order/rerun-no-stacking, peak-stage threshold/ratio values, failed-readback rollback of both stages, unknown-layout rollback, non-audio field tolerance) plus the full existing suite re-run clean against this change (same 59 pre-existing failures present on the unmodified checkout too — confirmed by diffing a run against `outputs/WTVAudioWizard` before this patch; unrelated to this change, not investigated further here). **Not yet run against real Premiere** — the threshold/ratio math is solved from Broadcast's own confirmed-live values, but the actual audible result (and whether Premiere accepts writing all eight Threshold/Ratio params, not just Output Gain, without surprises) has not been confirmed on Dan's host. Reload the plugin and test on selected music clips with real peaks above -30 dB before considering this done — Copy report/verify() will throw rather than silently ship if the live layout or readback doesn't match, but that only catches layout/readback mismatches, not whether -30 dB/3:1 is audibly what's landing. No service restart; ZIP not rebuilt; version remains 0.7.1.

## Latest — Normalize music levels (2026-09-16)

New offline button below Conform and duck music, left of Enhance low end. User clarified scope: **selected music clips**, not all tracks. Applies native Multiband Compressor Broadcast settings with **Output Gain -12 dB**. Replaces existing Multiband Compressors on those clips, puts the compressor before the earliest Amplify, and verifies other effects/keyframes remain unchanged. No service, export, import, or source WAV changes. This is fixed compression/gain, not measured loudness normalization. Each clip is verified separately; failure attempts restoration of that clip, while completed clips remain applied.

Implementation: `plugin/normalize-music.js`, `music-broadcast-preset.json`, main action and panel button. Profile captured from Premiere 26.2.2 showing Broadcast / -12 dB in its native editor; native output value is 0.1666666716337204. Exact GUID/105-parameter name layout is checked before configuration. Only exposed audio controls are configured and verified; spectrum/meter UI and unused legacy slots (including CrossOver Q) are excluded. Boolean/numeric toggle readbacks are equivalent. Unsupported/localized layouts fail safely rather than guessing.

Validation: **215 JavaScript tests pass**; offline panel browser check passes. Native isolated sequence test succeeded twice with readback and other-effects verification, no stacked compressor. Earlier native verification failure restored the failed clip successfully. `validation/normalize-native-smoke.json` records success; `multiband-native-capture.json` retains preset provenance. Original sequence was restored active and its effects were not edited. Test sequence **WTV_Normalize_Validation_20260916** remains in the open project for QA; project was not saved by this task. Native test selection: `getSelection()` + addItem + setSelection worked; createEmptySelection produced a host nullptr error on this build. Plugin itself only reads the user's selection.

Reload plugin to pick up the new action. No server restart. Version remains 0.7.1; ZIP not rebuilt.


## Latest — Amplify identification and fresh readback (2026-09-16)

Dan's native 22-minute run completed local dialogue analysis (2101 speech regions, 1706 curve points) but failed the new generic one-Amplify assertion before configuration. The old error did not include observed count/names, so the exact native cause remains unconfirmed. Corrected two weaknesses: `isAmplifyComponent` now checks the documented `getDisplayName()` for Amplify as well as the internal match-name fallback; music Apply reacquires selected clip/component-chain handles from the active timeline before replacement and after its transaction. Pre-Apply refresh also refreshes removal backups. The one-Amplify assertion remains; failure now reports track, time, expected/observed count, removal count, and every remaining effect's display/internal name. Rollback protections remain.

Reference: [Adobe Component API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/component) distinguishes display names from internal match names. Regression tests reproduce opaque internal IDs and a chain whose cached count remains stale after edits; **211 JS tests pass**. This does not establish which issue occurred on Dan's host. Reload and retry on one selected music clip; use the richer report if verification still fails. No service restart; ZIP not rebuilt.

## Latest — stable Duck against checkboxes (2026-09-16)

Checkbox changes now save the track selection and refresh only its validation/summary. They no longer clear/recreate every row or show a temporary loading message, preserving checkbox focus and avoiding list collapse/scroll jumps. Explicit Refresh and changing reference mode still rebuild the list. Existing revision/context guards reject stale asynchronous results. Four selector tests pass, including row identity preservation across a toggle. Reload plugin; no service restart.

## Latest — Step 1 concurrent export verification and Amplify replacement (2026-09-16)

Step 1 (per-clip and full-sequence) now supplies a WAV verifier to `exportSequenceWithRenderWait`. Once the host export call returns, WAV checks begin immediately while EncoderManager listeners stay attached; there is no five-second event grace first. Every 200 ms the verifier checks format, complete RIFF length, rate/channels and duration, requiring two valid reads with identical byte length. Completion events never bypass verification; cancellation and user cancellation still stop the pass. Listeners are disposed on success/failure. Export-acceptance timeout timers are now cleared when the host returns, avoiding accumulated dormant timers across a batch. Other export callers without a verifier retain their existing bounded event fallback. Expected ready-file overhead is about 200 ms plus reads, versus about six seconds on the missing-event path; this is a code-derived expectation, not a native wall-time benchmark.

Music Apply now removes **all Amplify effects on selected music**, including manual/unrecorded/stacked effects, before appending one new duck Amplify. Previous behavior depended on saved ownership and could leave an unrecorded Amplify or extra copies in place. Removal occurs in the final Apply transaction, after analysis succeeds. Original components and their positions are captured after optional Volume stripping, restored on verified Apply failure, and exactly one Amplify is required after insertion. Unselected music and non-Amplify effects are preserved (the existing explicit Volume-removal option remains). Options help describes manual Amplify replacement. Relative dialogue-only ducking, existing levels, and cache behavior are otherwise unchanged.

Validation: **209 JavaScript tests pass**, including immediate file verification with/without events, incomplete WAVs despite completion events, cancellation/listener cleanup, Step 1 verifier wiring, unrecorded/stacked Amplify replacement, unselected clip preservation, and rollback restoring effect order. Native Premiere acceptance still needed: reload plugin, test a short export batch and selected music with existing Amplify. No service restart required; ZIP not rebuilt.

## Latest — EncoderManager export events + UXP backlog (2026-09-15)

**Implemented:** `plugin/export-sync.js` listens for `EncoderManager` render events when available, then **immediately falls back to WAV polling** (3s event grace on music analysis; 5s default elsewhere). Dan's Premiere build reported `export_wait: poll` with no `EVENT_RENDER_COMPLETE` correlation — behavior matches pre-audit polling, without a long idle wait after `exportSequence` returns.

**Host acceptance (Dan):** On Premiere 26.x, run one per-clip export and one music pass; confirm faster “Waiting…” transitions and log one `EVENT_RENDER_COMPLETE` payload (console or temporary log) so we can tighten output-path correlation if Adobe sends fields.

**UXP backlog (not implemented — future spikes):**

| API | Value for WTV |
|-----|----------------|
| `encodeProjectItem` / AME batch (`launchEncoder`, `startBatchEncode`, 26.3 XMP toggles) | Alternate per-clip encode if render in/out stays unreliable |
| `Transcript.hasTranscript` / `exportToJSON` / `transcribeClipProjectItem` | Speech-span hints alongside RMS ducking |
| `EventManager` on `Sequence` / `AudioTrack` / `Project` | Live timeline edit detection during long batches |
| `ClipProjectItem.createSubClipAction` (26.3) | Hard-bounded subclips instead of render-sequence in/out |
| OTIO / FCPXML `ProjectConverter` export | Not a PCM analysis substitute |
| Essential Sound / track-volume ExtendScript | Not in UXP; WTV uses clip Amplify keyframes |

See also [ARCHITECTURE-VALIDATION.md](research/ARCHITECTURE-VALIDATION.md) export note and [EncoderManager events](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/encodermanager).

## Latest — music pass timing and guard performance (2026-09-15)

Step 4 now records **wall-clock timing** per phase (`collect`, `reconcile`, `prep`, three `render_*` passes, `analyze`, `apply_*`, `guard_unchanged`) plus per-render breakdown (`clone_isolate`, `export`, `wav_read`). Status and **Copy report** include `Music timing:` and `Music render breakdown:` JSON. Use this on the long clone to see whether Premiere exports dominate (expected on ~22 min sequences) or UXP guards/Apply do.

**Guard optimization:** timeline drift checks use `musicPassSignature()` — audio lanes for selected music and the dialogue reference only (no full video-tree scan). Mid-render checks on the user timeline skip redundant full-sequence signatures; scratch sequences still fingerprint locally.

**Apply optimization:** keyframe commits batch up to **500 native keys per transaction** when each clip stays under the limit; oversized curves still write one clip per transaction.

**Native baseline (Dan):** reload plugin, run step 4 on the ~22 min clone (service stopped), paste Copy report. Expect most wall time in `render_music` / `render_dialogue` / `render_calibration` export sub-phases (~3× sequence realtime). **Analysis-summary cache:** when timeline mix, dialogue reference, duck settings, and export preset match a prior pass, step 4 skips the three Premiere exports and reuses stored 20 ms RMS/peak summaries from plugin data (`music-analysis-cache/`). Copy report shows `Music analysis cache: hit|miss`.

## Latest — music selection auto-resolves reruns (2026-09-15)

The music pass no longer blocks with **“Selected music is not the same set as the previous pass.”** Each run reconciles stored ownership against the timeline (drops records whose clips or duck Amplify are gone; keeps selected clips even when Amplify was deleted so they can rebuild). Whatever music is selected is ducked or re-ducked; unselected clips that still carry a prior pass are left alone and stay in storage. Retrim or new clips replace a stray prior Amplify when exactly one is present; multiple duck Amplify effects on one clip still block. Copy report / status add `clips_updated`, `clips_fresh`, and `clips_unchanged`. Reload the plugin before retrying on a long clone.

## Latest — music ducking runs offline in the plugin (2026-09-15)

Dan requested the entire native music pass work without the service. Implemented: step 4, dialogue track selection, analysis, calibration and native keyframe writing now work without Connect or a pairing token. `plugin/music-analysis.js` replaces the music pass's service analysis call; `plugin/music-wav.js` reads local Premiere WAVs in bounded chunks using UXP `fs.open/read/close`, retaining only 20 ms RMS/peak summaries. No music uploads, downloads, HTTP requests or GPU/model work. Cancel during music does not send a cancellation request for an older cleanup job. The server music endpoint remains for compatibility; the plugin does not use it. Other processing still requires the service.

`music-pass.resolveMusicContext()` resolves the active sequence independently of cleanup/connection state, recovering WTV Clean dialogue paths from finished clone tracks where available. Ordinary sequences support **Choose tracks**; **Clean dialogue** remains the default for sequences with inserted clean media. A pending/failed in-memory cleanup sequence remains blocked. Music context is separate from cleanup context, and asynchronous refreshes cannot overwrite newer context with an older result. Reload the plugin, select existing music, open Options → Ducking, choose the reference, then run step 4. **No service restart or connection needed for this update.**

Export/import evaluation: retain three full-length temporary Premiere renders (music baseline, dialogue reference, two-endpoint gain calibration). They capture actual timeline decoding, trims, overlaps and effects. No documented direct timeline PCM access was found in the current [Sequence API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequence) or [AudioClipTrackItem API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/audiocliptrackitem). Source-file decoding alone would not reproduce that mix. There is **no reimport or replacement music media**; the pass edits Amplify on existing clips. Completed scratch sequences/WAVs are removed; unfinished exports are retained conservatively. Reads use the documented [UXP fs API](https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-js/modules/fs/fs). WAV support: mono/stereo PCM 8/16/24/32 and float 32/64, including supported extensible subformats, at existing sequence rates 44.1/48/96 kHz; RIFF only.

The local analyzer preserves active RMS, speech threshold, 200 ms hold, attack/release, 0.05 dB simplification and calibration tolerances. **One deliberate measurement difference:** predicted music sample peak is now a conservative upper bound from each 20 ms block peak and maximum gain in that block, rather than evaluating every source sample again. This keeps memory bounded and can reject an RMS target near the ceiling more conservatively. It does not change the generated duck curve. Copy report identifies `analysis_location: plugin` and `predicted_peak_method`. Existing sparse keys, Volume option, ownership/rerun/rollback protections remain.

Validation: **194 JavaScript tests pass** (`validation/music-offline-js-tests.txt`). Six fixtures generated by the real Python analyzer match local JS calibration/levels and curves sampled every millisecond within 1e-8; includes 44.1/48/96 kHz, mono/stereo, peak/RMS targets, overlaps, silence and zero duck. Reader tests cover six sample formats, partial reads, cancellation and non-finite samples. Offline host simulation runs the real JS analyzer and native pass with network calls forbidden. Browser check exercises the real panel, offline track selection and Run with zero network calls (`validation/offline-music-options.png`). Reproduce parity using `research/music-local-parity.py`, JS checks using `node --test tests/*.test.cjs`, and browser check using workspace `work/check-offline-music-ui.cjs`.

**Remaining acceptance:** reload in real Premiere with the service stopped; test Choose tracks on an ordinary sequence and Clean dialogue on a resumed clone, then audition and rerun after deleting Amplify. Local WAV access and responsiveness on Dan's 22-minute timeline still require native verification. Browser/host stand-ins cannot certify Premiere filesystem or timeline behavior. Service/model code unchanged; ZIP not rebuilt.

## Latest — rerun after manually deleting Amplify (2026-09-15)

Fixed `Cannot read properties of null (reading 'clips')` after successful keyframe writing. Root cause: a subset selection set `partialUpdate=true`, then missing Amplify cleared `previous`; final record merging dereferenced `previous.clips`. `plugin/music-pass.js` now keeps previous metadata immutable and resolves missing/surviving effects per selected clip. Missing effects are rebuilt; surviving owned effects are replaced; unselected clip records are retained. A different effect at the old Amplify index is no longer treated as owned when the recorded match name is absent. Completed status is emitted only after verification and ownership storage succeed. Existing unknown pending-pass protection remains.

Three regressions cover partial deletion plus repeat rerun, mixed missing/surviving effects without stacking, and an unrelated replacement effect. **176 JavaScript tests pass.** Plugin-only change: reload/reconnect, select intended music and rerun; service restart unnecessary. The earlier failing build may already have removed its saved ownership record on rollback; this fix cannot reconstruct lost historical records automatically. Native rerun acceptance still pending.

Dan's supplied real-project log confirms the sparse two-endpoint calibration passed on 1320.052 seconds: median error 0.000986 dB, p95 0.002780 dB, **1708** analysis `curve_points` (from the **service** analyzer on that run). That validates calibration on this material, not a completed native pass: the later ownership-record error aborted it. New runs use **`analysis_location: plugin`** (see top section); expect similar corner counts unless analysis tuning changes.

## Latest — panel/log text encoding repair (2026-09-15)

Fixed corrupted punctuation in `plugin/main.js` and `plugin/music-pass.js` (connection/resume messages, status/progress, track labels and Copy report). The corruption was present in the source literals, not generated by Premiere. Affected punctuation now uses ASCII JavaScript Unicode escapes so it renders correctly and survives tools using a Windows legacy encoding. Always read/write source files with explicit UTF-8. Reload the plugin to clear old in-memory status entries; no service restart. No audio or ducking behavior changed. Syntax checks and plugin text scan passed.

## Latest — exact sparse music keyframes (2026-09-15)

Implemented the requested music ducking optimization. `plugin/music-effects.js` now writes only the analysis curve corners plus each clip's start/end sample, anchored to source in-point. Removed 0.25 dB densification and the interim 0.5–16 dB adaptive ladder. **Correction to the historical explanation below:** Amplify stores `(dB+96)/144`, an affine mapping; LINEAR interpolation of this value is linear in dB. Extra keys along a straight ramp add no information. The old claim that this mapping needs amplitude-style densification was incorrect.

The analyzer's 20 ms blocks, 0.05 dB simplification, speech threshold, hold, attack/release and target match the former service behavior (now in `plugin/music-analysis.js`; see top section). No separate audio/DSP timing tradeoff was introduced for keyframes. Curve lookup and clip slicing now use binary search rather than rescanning all global points. The 8000-corner per-parameter budget is checked before final Amplify insertion; all corners are preserved or the pass stops (no silent coarsening). Per-clip transactions, both Left/Right parameters, readback/ownership guards and existing Volume handling remain.

Calibration render uses two endpoints (−3 to −9 dB) to exercise native interpolation across each retained music clip before applying final automation. The same median/p95 error limits gate Apply whether analysis ran in the plugin or (legacy) service. The actual native result must be confirmed on Dan's long project; if calibration fails, retain the error/report and investigate rather than loosening checks.

Copy report includes `keyframe_optimization` with `method`, `native_keys` (all gain parameters) and `legacy_native_keys` (estimated old 0.25 dB method, before its adaptive coarsening). Existing `keyframes` continues to mean gain points summed across clips, not multiplied by channels.

Benchmark: synthetic 22-minute envelope with 1707 corners, 21 consecutive stereo clips: **69,948 → 3,494 native keys (95.0% reduction)**. For 21 overlapping full-length clips: 1,467,270 → 71,694 (95.1%). Largest calculated interpolation difference < 6e−12 dB. These are synthetic key counts, not Dan's exact project or measured Premiere wall-time savings. Reproduce with `node research/benchmark-music-curves.cjs`; results in `validation/music-curve-optimization.json`.

Validation: **173 JavaScript tests pass**, including trimmed clips, short/constant curves, encoded interpolation equivalence, corner-budget rejection before final mutation, and result metrics. (Full suite now **194** — see Locations.) Python/service code unchanged; Python suite not rerun for this patch. **Reload plugin; no service restart required solely for this change.** Retry the long music pass and audition entrances, exits and quiet gaps. No new UI controls. ZIP not rebuilt.

## Status — v0.7.1 working well (2026-09-11)

Dan confirmed **v0.7.1** is working well on real material in native Premiere. Version is pinned in `plugin/manifest.json`, `service/app.py`, and the panel health check (`plugin/main.js`). Recent fixes validated in use: breathy C/S multiband compression + always-on de-ess, music pass ducking (422 silent-music fix), per-clip Prepare/import, and panel polish (Steps 1–3 toggle matches Options/Connect blue). **Restart service + reload plugin** after pulls; development ZIP not rebuilt for incremental patches.

**Music pass UX + Apply hardening (2026-09-15):** Conform & duck now drives the same `#progressWrap` bar as Clean audio (`main.js` `setMusicProgress` + `music-pass.js` `onProgress` through analysis renders, **local** envelope analysis, per-clip keyframe build, and verify). Apply no longer throws opaque `Cannot read properties of null (reading 'ticks')` when Premiere returns null entries in `getKeyframeListAsTickTimes()` or when clip in/out ticks are unreadable — see `music-effects.js` filters/guards and `music-pass.js` `describe()` validation. **Remove clip Volume before ducking** (Options → Ducking, default on) removes the native clip Volume effect—including keyframed fades—before analysis so Amplify baseline+duck is the only level automation; failed passes restore removed Volume automatically. Reload plugin to pick up panel changes.

**Music bed compression (2026-09-15):** Options → Ducking **Compress music bed before ducking** (default **on**) runs a 20 ms peak compressor in `plugin/music-bed-compress.js`, merged into the same Amplify envelope as ducking (`plugin/music-analysis.js`). Copy report / music analysis JSON includes `bed_compression` and `bed_compression_report`. Segment simulation for ANW4290: `node research/simulate-music-bed-segments.cjs` → `validation/music-bed-anw4290-segments.json`. Reload plugin after pull.

**Music analysis exports strip scratch Amplify (2026-09-15):** Before **Music baseline** and **Gain calibration** renders, every native **Amplify** on selected music is removed on the temporary analysis sequence only (Volume and other effects stay). Prevents stacked duck/manual Amplify from polluting exported WAVs; the working timeline is unchanged until Apply. Reload plugin after pull.

**Long-sequence bed compression envelope (2026-09-15):** Bed comp no longer feeds every 20 ms block into global simplify ( blew the 6000-corner limit on ~22 min timelines). Compression is quantized to 0.25 dB steps with a sparse control curve (≤1200 points) before merging with duck; simplify limit raised to **8000** (matches Amplify key budget) with slightly looser tolerance on long sequences. Analysis cache version bumped to **v2** so stale v1 summaries are not reused. Reload plugin after pull.

**Clean dialogue batch + timing (2026-09-15):** Main panel section renamed **Clean dialogue** (was “Steps 1–3”); **Run clean dialogue (steps 1–3)** chains Prepare → Clean → Add tracks in per-clip mode. On completion, status and **Copy report** include wall/phase timings plus summed per-clip service `timings` (e.g. `cleanup_seconds`, `total_seconds`). Reload plugin after pull.

## Music ducking — background & open work (2026-09-15)

**What happened on Dan’s long clone:** ~158 cleaned dialogue clips, **21** music clips, ~**22 min**; clean dialogue ~**26:35** wall (`Clean dialogue timing` in Copy report). Step 4 first failed with **`Too many music keyframes`** (old plugin densification × many clips). A later run passed analysis (**1708** `curve_points`, sparse two-point calibration OK) but aborted on an ownership-record bug after keyframes were written — fixed in **Latest — rerun after manually deleting Amplify** above.

**Plugin keyframes — implemented:** see **Latest — exact sparse music keyframes**. Copy report: `keyframe_optimization`, `analysis_location: plugin` (top section).

**Still open if needed:** coarser **20 ms → larger hop** or looser simplify in **`plugin/music-analysis.js`** if ~1708 corners or long-WAV read time remain painful after offline native acceptance — not a service change anymore.

## Known error pattern: "The script object is no longer valid."

This generic Premiere UXP error has recurred from several unrelated causes across this project's history. It is not one bug — check these in the order below before assuming a new cause, since each one traced back to one specific handle-reuse pattern or `create*Action()` call, never a general symptom:

1. **Stale handle after any transaction.** Any committed transaction — even one that only targets a track item, not the sequence itself — can invalidate every previously-fetched `Sequence`/`Track`/`TrackItem` handle held before it. Calling a method on the old handle afterward throws this error. Fixed generically by never holding a handle across a transaction boundary: re-fetch by guid (`sequenceById()` in `plugin/premiere.js`) immediately before the next read/transaction. See the comment above `sequenceById()` for the exact rule, and `resolveContextSequence()` for the `context`-level equivalent used throughout `per-clip.js`/`music-pass.js`.
2. **Calling a speculative/unconfirmed API method.** `item.createRemoveAudioTransitionAction()`/`createRemoveVideoTransitionAction()` were never confirmed against Adobe's actual `AudioClipTrackItem` surface and produced exactly this error when called. Removed in favor of the confirmed-working `SequenceEditor.createRemoveItemsAction()` pattern on real `TRANSITION` track items (see `stripAudioTransitions()` in `plugin/premiere.js`). `addAudioCrossfade()`'s `createAddAudioTransitionAction`/`createAddVideoTransitionAction` path carries the same unconfirmed risk today and is explicitly documented as such — failures there are caught per-boundary and reported in `context.crossfadeReport`, never break Apply.
3. **Long derived sequence names hitting filesystem path limits.** `context.name` (built from the original sequence's own name plus this plugin's suffixes, e.g. `_WTVAudioWizard_<timestamp>`) is used both as a Premiere label and, verbatim, as real folder/file names. An unbounded name can exceed Windows' ~260-char `MAX_PATH` once every downstream suffix (`_RENDER`, `-clips`, `-input.wav`, ...) is appended, and manifested as this same generic error on a project with a long original sequence name. Fixed by `sanitizeSequenceName()` in `plugin/premiere.js` (strips illegal filesystem characters, caps length to 80 chars), applied once where `context.name` is built in `cloneActive()`.
4. **Evaluating unselected/unrelated clips (2026-09-14).** `stripAudioTransitions()` used to remove every transition on an entire track once any clip on that track was being processed, and `inventory()` flagged every clip on a track as "has transitions" if the track had a transition anywhere on it. A transition sitting entirely between two unrelated, unselected clips could trigger this error even when the clip actually selected for per-clip processing had no transition of its own. Fixed by scoping both to per-clip adjacency (`transitionTouchesSpan()` in `plugin/premiere.js`) — a transition is only removed/flagged if it actually overlaps a clip being processed. Same fix also corrects the identical over-broad check in Fix a pop and Enhance low end (`plugin/deplosive.js`, `plugin/lowend.js`), which reuse the same `inventory()`. See `PER-CLIP-MODE.md`'s 2026-09-14 note for detail.

If this error recurs with none of the above as the cause, get the exact action/method being called at the moment of failure before guessing at a fifth cause.

## Latest — "Export timed out" on a large batch now resumes instead of restarting (2026-09-14)

Dan hit `waitForStableWav()`'s 5-minute timeout partway through a 158-clip per-clip batch (stalled at clip 100/158, `C0036.MP4`) — Premiere had accepted the export (`manager.exportSequence()` returned) but the resulting WAV never stabilized on disk within the deadline, most likely a blocking dialog or a genuine host hang on that one clip (Premiere's own UI looked idle afterward, consistent with it having already given up). Notably it failed on exactly the **100th** export of the batch — worth flagging in case it recurs, since a round number like that is at least as consistent with some resource accumulating a limit every 100 sequential exports in the same session (e.g. a Premiere-internal handle/cache count, a media cache limit, or similar) as it is with coincidence tied to that specific source file; nothing in this plugin's own code imposes any 100-item ceiling, and no evidence yet distinguishes "100th export" from "the specific clip that happened to be 100th," so treat this as an open lead rather than a confirmed cause. If it recurs at another multiple of 100 (or always near 100 regardless of which clip lands there), that would point at Premiere itself rather than the source media.

This wasn't a code bug in the timeout itself — 5 minutes for one clip's export is a reasonable ceiling — but retrying meant `action('prepare', ...)` unconditionally discarding `context` and cloning a brand-new sequence, forcing all 99 already-successful exports to redo along with the one that failed.

Fixed by making the export loop resumable: each clip now gets `clip.exportVerified = true` only after its WAV actually stabilizes (extracted into `exportPerClipBatch()` in `plugin/main.js`, which skips already-verified clips so it works identically whether called fresh or resumed). At the top of `action('prepare', ...)`, `resumableBatch()` checks whether the in-memory `context` is an interrupted-but-partially-exported per-clip batch (`context.mode === 'per_clip'`, not yet `prepared`/`applied`/`failedApply`, at least one `exportVerified` clip) on a pending clone that's still intact (`host.assertUnchanged(context)`) — pure eligibility split out as `isResumableBatchContext()` in `plugin/button-state.js` for testability (`tests/button-state.test.cjs`), the host check kept separate since it needs a live Premiere call. If eligible, it reuses the existing `context.folder`/render sequence and calls `exportPerClipBatch()` again, which only re-exports clips 100–158; otherwise it falls through to the original fresh-clone behavior unchanged. The retried clip's own file is created with `{overwrite: true}` (was `false`) since a partial file from the failed attempt may already sit at that path. No new button or UI: **Dan just clicks Prepare again** and the panel now says "Resuming batch: N/M clips already exported" instead of restarting from zero. This only applies within the same panel session — reloading the panel still loses the in-memory `context` (per-clip batches aren't currently resumable across a reload, unlike the applied-clone case `resumeAppliedClone()` already covers).

## Latest — Off-grid raw clips: Premiere floors a placed stem to whole frames; per-clip now exports and places a whole-frame cover (2026-09-14)

The one-sample tolerance in the entry below was necessary but not sufficient. With the actual-vs-expected diagnostic in place, the next run showed exactly what Premiere did with `clip-043 "C0021.MP4"` (the same clip, renumbered after re-Prepare): expected ticks `110005685647200-118235555323200`, found `110005684588800-118227081772800` — `Δstart −1058400 ticks = −0.20 samples`, `Δend −8473550400 ticks = −1601.20 samples`, source matches, enabled. On the sequence's 29.97 grid (frame = 8475667200 ticks) that is: raw clip = frame 12979.0001 → 13949.9998 (970.9996 frames); placed stem = frame 12979 → 13949 exactly (970 frames). So `createOverwriteItemAction` **floors the start to the frame grid and floors the item's duration to whole frames**. The start snap is sub-sample and harmless; the duration floor cut one frame (33 ms) off the stem's tail. Retrying can't change that, and no sane tolerance should accept it — with the raw lane muted it would be a 33 ms hole of dialogue.

Fix (`plugin/premiere.js` `sequenceFrameTicks()`, `plugin/per-clip.js` `placementGeometry()`):
- **Read the sequence timebase** at Prepare: `Sequence.getTimebase()` (UXP ≥ 25.6, returns ticks-per-frame as a string; Adobe's own sample does `Number(await seq.getTimebase())`), falling back to `SequenceSettings.getVideoFrameRate().ticksPerFrame`. Plain getters, probed defensively; if neither answers plausibly, `context.frameTicks` is `null` and everything behaves exactly as before.
- **For a clip that isn't on whole frames** (`floor(start)..ceil(end)` ≠ `start..end`): the stem's out point (`createSetInOutPointsAction`) is set to that whole-frame *cover* instead of the exact span — a whole-frame value has nothing to floor — and the render export runs **one frame past the cover** so the imported WAV is never shorter than the out point (an out point past media end would just be clamped and floored again). The extra exported audio is silence: every other clip on the render is disabled, and it lies beyond the raw clip's end. `clip.outTicks`, `clip.exportEndTicks`, `clip.exportDuration`, `clip.offGrid` carry this; every WAV-length check (`main.js` wait, `clip-batch.js` upload/result/output, `apply()` result check) uses `exportDuration ?? duration`; the manifest records `export_end_ticks`. On-grid clips (all 41 others in the live batch) are byte-for-byte unchanged: exact span, exact end, live `TickTime` passed through as before.
- **Verification** now expresses the actual requirement — *the stem must cover the raw clip*: start no later and end no earlier than the raw clip's by more than one sample; in the outward direction an on-grid clip is held to one sample, an off-grid clip may start up to one frame early (Premiere's floor) and end up to one frame late (the cover's ceiling). The diagnostic additionally prints `off-grid raw clip placed with a N-tick whole-frame cover` and `[sequence frame: N ticks | unknown]`.

Tests (`tests/per-clip.test.cjs`, 156 total): the mock now takes `frameTicks` and floors placed start/duration to frames exactly like the host. One test **reproduces the live failure verbatim** with the timebase hidden (`Δend -8473550400 ticks = -1601.20 samples`), proving the mock models the real mechanism; the fix test uses the live tick values and asserts a 971-frame cover, a 972-frame export, the padded render out point, a completed `apply()`, and a stem whose span fully contains the raw clip; a 30 fps on-grid test pins that nothing changes for on-grid clips; `sequenceFrameTicks` fallbacks and implausible values are covered. Untested live as of this writing — the next Prepare → Clean → Apply on the "Greg SpringBear" project is the real check. If it fails again, the message will now show the geometry directly.

Why this clip was off-grid at all: unknown and irrelevant to the fix — speed change, merged/nested clip ("Bear bait Camera"/"Bear Multicam Day1" are in the same batch), or an audio-unit slip all produce it. Any of those is normal editing, so this has to be handled, not rejected.

## Earlier today — clip-042 root cause: an off-grid raw clip; verification now tolerates one sample (2026-09-14)

Superseded in part by the entry above (the sub-sample snap was real but not the failing part). The retry below did **not** fix `clip-042 "C0021.MP4"` — it failed identically on all 3 attempts, so unlike the export-side bug this was deterministic, not flaky. The ticks in the error explained it: start `110005685647200` and end `118235555323200` are both exactly **3,175,200 ticks = 0.6 of a 48 kHz sample** past a sample boundary (`ticks mod 5292000`), and 0.2–0.4 sample off any 29.97/59.94 frame boundary, while the span is a clean 1,555,153 samples. So the raw clip sits at a sub-sample, sub-frame timeline position (typical after a speed change, merged/nested clip, or an audio-unit slip) that Premiere can't place a *new* item at: `createOverwriteItemAction` snaps the stem to the grid, the placed ticks differ from the raw clip's by <1 sample, and the exact-tick verification failed every time even though the stem was within ~20 µs of where it should be. The other 41 clips were on-grid and passed. Retrying re-snaps identically, hence deterministic.

Fix in `apply()` (`plugin/per-clip.js`): start/end now verify within **one sample** (`ticksPerSample = 254016000000 / context.rate`), while lane, source id and enabled state stay exact. This is consistent with — not looser than — the one-sample duration tolerance the exported WAV already has to pass (`inspectWav`, and the `c.result.samples` check at the top of `apply()`). The failure message, when it still fires, now also reports what is *actually* on the destination lane near each expected span — actual ticks, Δstart/Δend in ticks and samples, whether the source matched, enabled/DISABLED — so the next genuine failure is diagnosable from the panel without another round trip. Two new tests in `tests/per-clip.test.cjs` pin the boundary: a placement shifted by exactly the live deviation (0.6 sample) verifies and `apply()` completes; a 3-sample shift still fails and the message names `Δstart 15876000 ticks = 3.00 samples`. The in-place retry from the entry below is kept — it's still correct for the transient class — but it was not the cause here. Lesson for the "verification failed" family: when a retry doesn't change the outcome, look at the ticks modulo the sample/frame grid before assuming host flakiness.

## Earlier today — Placement verification now retries in place instead of aborting the whole batch (2026-09-14)

Immediately after the message above shipped, it caught a second real occurrence on a *different* 42-clip batch: `clip-042 "C0021.MP4" (from A2 @ 433.07s, destination lane 5, ...)` -- the very **last** clip in the batch, on the second source track. Same shape as the confirmed export-side bug (an action commits but the readback doesn't reflect it, self-heals if you just redo it), just in the placement step instead of the isolate transaction, and again on a "boundary" item (there: first clip on a newly-touched track; here: last clip in a large lane). Given that pattern is now confirmed twice in two different code paths, `apply()`'s placement verification (`plugin/per-clip.js`) now retries the same way the export isolate step does: instead of one check at the end that throws immediately, it loops up to 3 attempts, and on a miss it re-issues **only the mismatched addition(s)' own `createOverwriteItemAction`** (a "WTV: retry stem placement" transaction) before re-checking, with a 300ms pause between attempts. Only throws (`Stem placement verification failed after retrying: ...`) if 3 attempts are exhausted. This means an isolated flaky placement on one clip out of 40+ should now self-heal in under a second instead of discarding the whole batch and needing a full re-Prepare/re-export. Covered by two new regression tests in `tests/per-clip.test.cjs`: one confirms a transient single miss (matching what was actually observed live) self-heals and `apply()` completes normally; the other (updating the pre-existing "partial insertion failure" recovery test, which the retry logic incidentally "fixed" since its old one-time sabotage no longer survives a retry) confirms a *persistent* failure still exhausts all 3 attempts and correctly falls through to the existing mute-recovery/`failedApply` path.

## Latest — "Stem placement verification failed" now names which clip (2026-09-14)

Dan hit a bare `Stem placement verification failed` on a 42-clip Apply with no lead on which clip out of 42 (several sharing source files) actually failed. The check in `apply()` (`plugin/per-clip.js`) already knew exactly which addition(s) didn't verify — it just discarded that and threw a generic message. Now it reports each failing addition by **its own clip id**, source track, timeline position, and expected tick range, e.g. `Stem placement verification failed: clip-014 "C0036.MP4" (from A2 @ 363.10s, destination lane 4, expected ticks 92122026796800-93215387865600)`. Deliberately uses the clip's own `id`/timeline position rather than just its display name — confirmed while writing the regression test that the display name alone is the *source* clip's name (assigned by `createSetNameAction` before placement, e.g. `"C0036.MP4"`) and is **not unique** across clips that share a source file, which is exactly the kind of batch where this error tends to show up. Covered by a new regression test in `tests/per-clip.test.cjs` that sabotages one specific placement's target time and asserts the resulting message names that clip's own id. Still requires "Prepare a new batch" to retry (per `apply()`'s existing `context.failedApply` guard) — this only makes the failure diagnosable, not itself retryable; the exported/cleaned WAVs for the other 41 clips aren't affected either way.

## Latest — Root cause confirmed and fixed: retry the isolate transaction in place (2026-09-14)

The diagnostic guard below caught it on the next run, instantly instead of after a 5-minute stall: `Render in/out points did not take effect for "C0036.MP4" (expected 92122026796800-93215387865600, got -101606400000000000-93215387865600)`. That "got" in-point is exactly **-400000 seconds** (`-101606400000000000 / 254016000000`) — a nonsensical sentinel-looking value, not merely "stuck at the previous clip's position" — while the out-point applied correctly. Clicking Prepare again (which the earlier resume fix picked up automatically) re-ran the exact same isolate transaction on the exact same clip a few seconds later and it succeeded immediately. Dan noticed the pattern: **this was the first clip encountered on track A2 after 36 consecutive clips on A1** — i.e. `render.createSetInPointAction()` (or the readback `render.getInPoint()`) appears to misfire specifically the first time an export touches a *different* audio track than every export before it in the batch, not something particular to that clip's media or its leading gap. Confirmed real, transient, self-healing host behavior — not a bug in this plugin's own logic, and not fixable by changing what values are passed in.

Since retrying the identical transaction reliably works, `exportClip()` in `plugin/per-clip.js` now retries in place automatically: the isolate transaction + in/out readback + verification (previously the diagnostic guard added just above) is now `isolateClipOnRender()`, which retries up to 3 attempts with a 300ms pause between, only throwing (`... after 3 attempts`) if every attempt misses. This means the track-switch glitch should now self-heal within about half a second, invisibly, with no manual "click Prepare again" needed. If it ever does exhaust all 3 attempts, the earlier resume-on-failure behavior (clicking Prepare again) remains the fallback. Also, per Dan's suggestion, the Prepare button's own label now reflects that state: `button-state.js`'s `computeButtonState()` gained a `prepareLabel` field (`"1. Resume export"` instead of `"1. Prepare exports"` when `isResumableBatchContext()` is true) and a matching hint (`"Export was interrupted (N/M clips already done). Click Resume export to continue."`), wired into `main.js`'s `updateActions()` (`$('prepare').textContent = state.prepareLabel`). Covered by two new regression tests in `tests/per-clip.test.cjs` (exhausts all 3 attempts and throws; misses once then succeeds on retry) — the sandboxed test harness (`vm.runInNewContext`) needed `setTimeout` added to its box since the retry's pause uses it and the sandbox doesn't inherit Node's globals.

## Latest — Diagnostic guard: verify render in/out points actually took effect before exporting (2026-09-14, unconfirmed root cause)

Follow-up to the "Export timed out" investigation: Dan noticed the clip that stalled (`C0036.MP4`, first clip on its track, ~6 min after a long leading gap) produced a **60MB WAV for a 6–7 second clip** — 20x+ too large for any sane rate/format, implying Premiere actually exported something like 5–6 minutes of audio, not the isolated clip. That's consistent with `exportClip()`'s isolate transaction (`render.createSetInPointAction(target.start)` / `createSetOutPointAction(target.end)`) **silently not taking effect** for that specific clip, so the render sequence exported from wherever its in-point was actually left (matching the gap) through to the correct out point — producing a huge, wrong-duration file that can never satisfy `waitForStableWav`'s duration check, and so times out after 5 minutes looking exactly like a hang, when Premiere had actually already finished (with the wrong output).

**This is not yet confirmed** — it's the most numerically-consistent explanation found so far, not a proven root cause. Added a fast-failing guard rather than a fix: right after `exportClip()` reads the render's in/out points back (previously stored unchecked in `clip.renderInTicks`/`renderOutTicks`), it now compares them against `target.start`/`target.end` and throws immediately (`Render in/out points did not take effect for "<clip>" (expected X-Y, got A-B). Prepare a new batch.`) if they don't match, instead of proceeding to export. If the theory is right, the next run against `C0036.MP4` should fail **instantly** with this new error instead of stalling for 5 minutes — which would confirm the cause and open the door to an actual fix (e.g. re-fetching `render` again before setting the points, or retrying the transaction). If it *doesn't* throw and the export still stalls, the theory is wrong and the search continues elsewhere. Covered by a new regression test in `tests/per-clip.test.cjs` that stubs the render's set-point actions as no-ops and confirms `exportClip()` now fails fast with this message instead of silently exporting the wrong span.

## Latest — Removed the per-batch clip count cap entirely (2026-09-14)

Following the "100th export stalls, then resumes fine" investigation below, Dan asked to remove `MAX_CLIPS_PER_BATCH` (250) entirely rather than raise it further, since it's just a defensive sanity check with no evidence it maps to any real constraint — confirmed this session that our own code never counted or gated on a running export tally anywhere, and 250 was picked somewhat arbitrarily when it was raised from 100 earlier. Removed the constant, the `enabled.length > MAX_CLIPS_PER_BATCH` check, and its error message from `validate()` in `plugin/per-clip.js`. `PER-CLIP-MODE.md` updated to say there's no cap. Individual per-clip duration (600s) is unrelated and untouched.

## Latest — Export status now identifies which occurrence of a repeated source file (2026-09-14)

Following the "Export timed out" resume fix above, Dan asked for enough detail in the export status to identify exactly *which* timeline occurrence of a repeatedly-used source file (e.g. `C0036.MP4` appearing dozens of times across a 158-clip batch) stalled, so he could test that specific one in isolation rather than guessing among all the `C0036.MP4` instances. `plugin/main.js`'s `exportPerClipBatch()` now appends the clip's timeline location to every "Export"/"Waiting for export" status line and to the "Export timed out"/cancellation error itself, via a new `clipLocation(clip)` helper (`A<trackIndex+1> @ <mm:ss or h:mm:ss>`, e.g. `A2 @ 12:07`) built from `clip.trackIndex`/`clip.start.seconds` (already captured at Prepare-time inventory, no new host calls needed). So a stall now reads e.g. `Waiting for export 100/158 · C0036.MP4 · A2 @ 12:07`, and if it times out the error itself repeats that same location, both in the live Status line and in the log history — enough to jump to that exact spot on the clone/render sequence, or re-select just that one clip for an isolated test.

## Latest — Music target default changed to Peak (2026-09-14)

Dan asked to make **Peak** the default for the ducking "Target counts as" setting (was RMS). Changed the default in `service/music.py`'s `MusicAnalysis.target_mode` (`'rms'` → `'peak'`), `plugin/index.html`'s `musicTargetMode` select (`peak` option now first/`selected`), and the panel's own fallback in `plugin/main.js` (`optionsUi.musicTargetMode === 'rms' ? 'rms' : 'peak'`, was the inverse) so a panel with no saved preference yet defaults to Peak too. Existing saved panel preferences (`optionsUi.musicTargetMode`) are untouched — this only changes what a *fresh* install/preference-less panel starts on. `tests/test_music.py`'s `test_rms_target_and_silent_dialogue` now passes `target_mode='rms'` explicitly since it was relying on the old implicit default to test RMS-specific numbers.

## Latest — Prepare re-enables after a finished batch (2026-09-14)

Dan reported that after running steps 1–3 to completion (`context.applied === true`), every step 1–3 button stayed disabled, blocking selecting a different clip and running Prepare again — only step 4/Fix a pop/Enhance low end remained usable. Root cause: `updateActions()`'s `prepareDone` in `plugin/main.js` was `Boolean(context && !context.failedApply && (context.prepared || context.exportPath))`, which only turned false again on a *failed* apply (`context.failedApply`), never on a *successful* one — `context.prepared` stays true forever on the finished context, so `prepare` stayed disabled indefinitely once a batch succeeded. Fixed by also excluding `context.applied` from `prepareDone`, matching the already-correct failed-apply behavior: `Boolean(context && !context.failedApply && !context.applied && (context.prepared || context.exportPath))`. Clicking **Prepare** was already safe to call again in this state — `action('prepare', ...)` unconditionally resets `context`/`jobId`/`jobResult` and clones the currently active sequence fresh — so no change was needed there, only to the button-gating condition. The just-finished clone/tracks are untouched by this; only the panel's in-memory reference to that batch moves to the new one (the same tradeoff `resumeAppliedClone()` already accepts). The "Steps 1–3" section stays collapsed after a successful apply as before; click its header to expand and see the now-enabled Prepare button. A full DOM-harness test for `main.js` wasn't worth it — it `require`s the real `uxp` module and `document` directly at module scope and wires ~30 event listeners at load time, unlike `premiere.js`/`per-clip.js`/`dialogue-selector.js`, which take their host/DOM dependencies as function arguments and were built to be tested this way from the start. Instead, the pure gating logic (`prepareDone`/`processDone`/`applyDone`, the resulting `disabled` values, and `mainHint` text) was extracted into `plugin/button-state.js`'s `computeButtonState()` — no DOM, no `uxp` — and `main.js`'s `updateActions()` now just calls it and assigns the results. Covered by `tests/button-state.test.cjs`, including the exact regression (successful apply must re-enable Prepare, matching the already-correct failed-apply case).

## Latest — "Cannot read properties of null (reading 'getStartTime')" on a second per-clip batch (2026-09-14)

Dan hit this running a *second* per-clip batch in the same panel session — the first batch (4 clips, gap_urgenet) completed and its music was ducked successfully; then he selected a different clip (C0028.MP4, mossformer2) and used the "Prepare re-enables after a finished batch" behavior (see the entry below) to start a fresh batch, which failed at Apply. Root cause: `signature()` in `plugin/premiere.js` calls `track.getTrackItems(TrackItemType.CLIP, false)` and then unconditionally calls `.getStartTime()` on every returned item — but real Premiere hosts have been observed to include `null` placeholder entries for **gap regions** even when `includeEmptyTrackItems` is explicitly `false` (confirmed against community reports of the same Adobe API; `false` is documented as excluding those placeholders, but doesn't reliably in practice). This had never surfaced before because it needs a track with a real gap on it, and the first per-clip batch to hit it was the **stem lanes this plugin itself adds** — a "Clean dialogue" lane only covers the timeline spans of the clips it actually replaced, so it necessarily has gaps before/between/after them. `assertUnchanged()` (called at the top of every step, including the second batch's own Apply) scans *all* tracks via `signature()`, so the first batch's own added lane could crash a completely unrelated, later batch.

Fixed by a single defensive helper, `clipTrackItems(track, type)` in `plugin/premiere.js`, that filters out any falsy entries after calling `getTrackItems()`, and replaced every direct `track.getTrackItems(...)` call across `plugin/premiere.js` and `plugin/per-clip.js` (7 call sites, both `CLIP` and `TRANSITION` types) with it, rather than patching `signature()` alone — the same host quirk could otherwise resurface in `inventory()`, `captureAudioCrossfadePlan()`, `stripAudioTransitions()`, `reapplyDialogueCrossfades()`, `findClipTrackItem()`, `firstReusableTrackIndex()`, `audioSnapshot()`/`videoSnapshot()`, all of which iterate the same kind of array. Covered by a new regression test in `tests/per-clip.test.cjs` that pushes a `null` into a mocked track's clip list and confirms `apply()` still completes (verified it fails without the fix, passes with it).

## Latest — "Stem placement verification failed" on an 8-clip batch, then "Illegal parameter type" (2026-09-14)

Dan hit "Stem placement verification failed" on a real 8-clip per-clip batch (5 of the 8 clips from the same source file, `C0057.MP4`, on one track — a heavily-cut single-camera edit) right at Apply, after Prepare/Clean both succeeded. Root cause: `plugin/per-clip.js`'s `timelineTime()` (used to position each new stem clip on its lane) and the stem's `createSetInOutPointsAction` span both reconstructed a `TickTime` from the recorded `.seconds` value via `createWithSeconds()`, discarding the exact `.ticks` value already captured for that same clip at Prepare time. Premiere's ticks-per-second (254016000000) isn't a power of two, so ticks → seconds → ticks is a lossy round trip that can land 1 tick off the original position — normally invisible, but `apply()`'s placement verification compares exact tick strings, so a single tick of drift throws `Stem placement verification failed` even though nothing is actually wrong with the timeline. First fix: prefer `ppro.TickTime.createWithTicks()` in both spots, falling back to `createWithSeconds` only if `createWithTicks` isn't available.

That first fix immediately surfaced a second, real-host-only bug: **`createWithTicks(ticks)` throws `Illegal parameter type` if `ticks` is a `Number` instead of a `string`** — confirmed against [Adobe's own TickTime reference](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/ticktime/) (`createWithTicks(ticks: string): TickTime`), which the first fix got wrong by wrapping the ticks value in `Number(...)` before passing it. `plugin/premiere.js`'s pre-existing `addAudioCrossfade()` had the exact same bug (`createWithTicks(Number(entry.durationTicks))`) — never caught before because no test mocked `createWithTicks` strictly enough to notice, and because a failure there is caught per-boundary and only shows up in `context.crossfadeReport`, never breaking Apply outright. Both fixed to pass the already-string `.ticks` value through directly (converting a numeric ticks delta back to a string first where one is computed). The `tests/per-clip.test.cjs` mock's `createWithTicks` now throws the same `Illegal parameter type` error if ever called with a non-string, so this exact class of bug can't silently pass again.

## Latest — Clean audio progress bar jumped to 81% immediately, then stalled (2026-09-14)

Dan reported that during the Clean audio (step 2) progress bar, it "immediately jumps to 81% complete then stays there then finishes." Root cause: `service/app.py`'s `run_job()` set `progress=81` right *before* calling the dialogue cleanup worker (`run_worker()` running GAP-URGENet/MossFormer2) — the single dominant cost of the whole job, often the majority of total wall time — with no incremental progress from that subprocess itself (just a start and an end). So the number reported "81% done" the instant the slowest step began, before any of its work had actually happened, then had nothing to report until it returned, at which point the remaining fast stages (compress/de-ess/de-click/mix) blew through 86→91→93→95→100 almost immediately. Fixed by moving that stage's reported progress to a low value (`15`) when the worker starts, and only advancing it (`80`) once the worker actually returns — same jump-then-fast-finish shape underneath (there's still no way to get real incremental progress out of that subprocess), but now the bar sits at a low, honest-looking number for the long wait instead of an almost-done one. No test asserted the specific literal progress values, so nothing needed updating beyond the two `update()` call sites.

## Latest — dialogue dynamics chain (2026-09-11)

Dan confirmed the **breathy C/S fix** works on real material. Clean audio now runs by default, after the enhancer and before mix:

## Latest — dialogue leveling v4 + sparse whisper lift (2026-09-15)

Clean audio now levels whisper-heavy clips toward mixed-dialogue loudness without a separate panel control. **`dialogue-multiband-peak-v4`** (`service/compressor.py`): lower quiet-block floor (−54 dBFS), body band uses RMS-assisted drive, honors full `max_boost_db` from job settings. **`normalize_sparse_dialogue()`** runs immediately after compression when peak minus active RMS ≥ 18 dB (C0021-class sparse clips): tames outlier spikes, lifts active RMS toward Dialogue target − 13 dB (≈ −25 dBFS at default −12 peak target), sample-clips at peak target instead of global gain-down (so whisper lift is not cancelled). Dense clips (e.g. Bear bait mixed take) skip sparse normalize; intra-clip dynamics stay in the compressor. Job report: `compress_dialogue.sparse_dialogue` with `sparse_normalize_applied`, gains, and levels. Validated pre-ship on NAS fixtures Bear bait + C0021 (`research/evaluate_dialogue_leveling.py`, `validation/dialogue-leveling-prototype.json`). **Restart service** after pull. `service/leveler.py` (pre-compress speech-level-v1) remains unused — do not wire both.

1. **Multiband peak compression** (`dialogue-multiband-peak-v4`) — body band (150 Hz–4 kHz) levels toward Dialogue · dBFS peak target; air band (4 kHz+) limited with minimal boost; quiet blocks below −54 dBFS peak are not lifted (was −42 in v3).
2. **De-essing** — always on (split-band 4–9 kHz).
3. **De-click** — still optional via **De-click · Experimental** only.

**Restart service + reload plugin** after pulling. Cached jobs from before the DSP change must be rerun.

**Music pass follow-up (2026-09-11):** Dan hit `422 Selected music is silent` on Conform & duck music after the compression change. Fixes in `plugin/music-pass.js` (enable-all-then-disable isolation, unmute kept tracks on the scratch clone, client-side peak check before upload) and `service/music.py` (peak-based silence guard with measured dBFS in the error). **Dan confirmed this ducking fix works on real material.** Reload plugin to pick up panel changes; service restart if not already done since the music.py edit.

**Panel (2026-09-11):** Duck settings gear menu no longer auto-opens after Add clean tracks / Apply; open it manually with ⚙ when needed.

## Latest — whisper body (2026-09-11)

Enhance low end now boosts existing 150–500 Hz content for whispered dialogue; it replaces the previous upper-harmonic generator. Cog slider remains 0.2×–3×, default 1×. Nominal centre boost is about +1.6 / +6 / +12 dB at 0.2 / 1 / 3×, before linked peak attenuation. 1× now means the new normal setting, not the old algorithm. Four-times oversampled peak estimation applies global attenuation to −1 dBFS when needed; this is not a certified true-peak limiter. No pitch synthesis or recovery of absent bass; background low-frequency noise can also increase. Algorithm report: whisper-body-v1. Restart service, reload plugin and reconnect. Prior workflow review issues remain pending; real whispered-dialogue listening/native Premiere acceptance still required.

## Latest change — 2026-09-11 low-end intensity cog (UI)

User approved an intensity slider for Enhance low end: **0.2×–3×**, step **0.1×**, default **1×**. The previous help icon is now a cog using the same menu style as music ducking; its existing element IDs remain. Menu contains a live multiplier readout and original help. Changing the slider affects the next run, not audio already in the timeline; it resets to 1× on panel reload and is disabled during operations.

`plugin/main.js` → `plugin/lowend.js` → `/v1/lowend` sends `intensity`. Schema and DSP reject out-of-range/non-finite values. **Whisper-body-v1** scales the filtered **150–500 Hz body band** (`out = dry + intensity × body`); see top section for peak attenuation and what 1× means. Omitted API value defaults to 1. Reports include `intensity`, `body_band_hz`, and `algorithm`. Repeated runs remain cumulative. Pre-whisper-body workflow notes in `research/LOW-END-EVALUATION-2026-09-11.md` are stale for DSP but may still list open panel/workflow items — treat that file as historical until rewritten.

**Restart service, reload plugin, reconnect.** An old service rejects the new request field or returns the old harmonic report shape; the updated service is required. Tests: **122 JS / 111 Python passing**, including multiplier scaling, body-band gain, peak safety, and forwarding/validation. Cog open/close and slider/readout exercised in an Edge browser approximation; screenshot `validation/lowend-intensity-menu.png`. Native UXP slider interaction still needs acceptance. ZIP not rebuilt.

## Latest change — 2026-09-11 remove Dialogue richness; restore scroll fade overlays

Dan asked to drop the standalone **Dialogue richness…** feature and bring back the earlier scroll **fade/shadow** cues (gradient overlays with bottom chevron on the scroll viewport). Removed `plugin/richness.js`, `service/richness.py`, `/v1/richness`, related tests, and panel UI. Restored overlay fades with `pointer-events:none` instead of the interim inset-box-shadow + chevron-below-scroll-area approach. **Restart the local service** after pulling this change (service code changed). Reload the plugin folder in UXP. Proposal/history only in `research/DIALOGUE-RICHNESS-PROPOSAL.md` — not active code.

## Earlier panel fixes — 2026-09-10/11 per-clip workflow and project bin

Panel-only changes (no service restart). Reload the full plugin folder in UXP Developer Tool.

- **Partial dialogue selection:** per-clip Prepare no longer requires every enabled clip on a track to be selected. Apply mutes a raw lane only when every enabled clip on that lane was processed; otherwise it disables just the processed raw clips so unselected siblings stay audible. Supersedes the old “select all on track” rule still described in `PER-CLIP-MODE.md` and `PREMIERE-MUSIC-PASS.md`.
- **Single-clip Prepare → Clean:** clip matching uses timeline identity (`track + source + start/end ticks`), not track-item index; Prepare waits for each export WAV to finish writing (`waitForStableWav`) before enabling step 2.
- **Audio Wizard project bin:** all plugin imports (per-clip/full-sequence stems, Fix a pop, Enhance low end) go into a reusable root bin named **Audio Wizard** via `plugin/premiere.js` `importIntoBin()`. Uses `ppro.FolderItem.cast` (not the nonexistent `FolderProjectItem`) with root fallback if bin creation fails — fixes **Add clean tracks** crashing with `Cannot read properties of undefined (reading 'cast')` in real Premiere.
- **Scroll UI:** gradient fade overlays with bottom chevron on the scroll viewport (`pointer-events:none`); auto-collapse Connection after connect and Steps 1–3 after step 3 apply; panel min/docked sizes bumped in `manifest.json`.
- **Enhance low end:** standalone batch button (`plugin/lowend.js`, `POST /v1/lowend`) with optional **intensity** slider (0.2×–3×, default 1×) behind a cog menu — see top section. Separate from the cleanup pipeline.


## Latest change — 2026-09-10 UI polish: ducking settings moved behind a ⚙ gear menu

Dan asked (not a review-item fix, a direct UI request) to declutter the panel: move everything ducking-related into a menu behind a gear icon at the end of the step-4 row. Implemented: a `⚙` toggle button + `#duckSettingsMenu` popup (closed via the same button, an `×` inside it, or left open) now hosts the dialogue-reference selector (formerly always visible under step 3) and the Duck dB/speech floor/attack/release/ambience-ducking fields (formerly under Options → "Finish existing music", which no longer exists as a subsection). No element ids changed, so `main.js`/`dialogue-selector.js` logic is otherwise untouched; the menu auto-opens after a successful Apply (replacing the old `setOptionsOpen(true)` there) instead of the general Options section. See `PREMIERE-MUSIC-PASS.md`'s 2026-09-10 "gear (⚙) menu" follow-up for full detail. 107 JS tests still pass (this is HTML/CSS/main.js UI-only, doesn't touch music-pass/deplosive logic).

HANDOFF previously claimed `work/check-compact-ui.cjs` was fixed; **that script is not present in this checkout** (only `validation/compact-panel-*.png` may remain from an earlier run). Do not reference it as available until restored.

## Earlier approved change — 2026-09-10 items 2 and 3: Fix a pop's string-ticks and trimmed-seed bugs

Dan approved items 2 and 3 together (same file/function `plugin/deplosive.js`'s `locate()`, both pure correctness fixes, low risk, no design decisions involved). Both are now implemented:

- **Item 2**: `locate()`'s playhead-containment check compared `TickTime.ticks` (a string) with `</>=`, sorting text instead of time — could reject an in-range playhead or admit an out-of-range one depending on digit lengths. Now compares `.seconds` (numeric), matching every other ordering comparison already in this codebase.
- **Item 3**: the seed sent to `/v1/deplosive` incorrectly added the clip's source media in-point on top of the timeline-relative playhead offset, even though the rendered WAV is only the isolated clip (starts at local time zero, not the full source file) — for a trimmed clip this could send a seed far outside the actual rendered file. Now correctly `playhead.seconds - entry.start.seconds`. The returned report's `seed_seconds`/`start_seconds`/`end_seconds` (and per-channel times) are shifted back to timeline-relative before being returned, so the whole user-facing report stays internally consistent with the timeline position the user actually parked at, not an internal rendering detail.

New/updated tests in `tests/deplosive.test.cjs` (including making its `tick()` fixture always produce real string ticks, not just for one special-cased test, so this class of bug can't be hidden again), and `../../work/workflow-review-repros.cjs`'s checks 1-2 now confirm both fixes instead of reproducing the bugs. Full JS suite: 107 passing. See `research/WORKFLOW-REVIEW-2026-09-10.md`'s items 2-3 for full detail. **Not yet confirmed against real Premiere** — same as item 1 and everything else pop/music-related this session.

Findings 4-9 and all optimizations in the workflow review remain proposed but **not approved**; do not implement them without asking first.

## Earlier approved change — 2026-09-10 dialogue reference selector

Dan asked to approve workflow fixes one at a time. **Only review item 1 is approved and implemented**, with his refinement: **Clean dialogue** is default and **Choose tracks** is the only alternative. The A1/A2 positional rule described in the older notes below is superseded. Clean mode follows inserted media paths on any track, including later pop-fix paths; Choose tracks shows named-track checkboxes, remembers IDs per sequence and rejects missing/inaudible choices before analysis. The selector appears after step 3 near the music button; Refresh rereads the layout. Music cannot also be the dialogue reference. Preferences stay client-side, separate from the service schema. See README and PREMIERE-MUSIC-PASS for current instructions.

Validation: **106 JavaScript tests passed** after this patch. The review previously ran the real Python 3.12 environment successfully: **94 Python tests passed**, resolving the old substitute-environment uncertainty below. No service or model changes in this patch. Native Premiere acceptance is pending. The development folder is updated; ZIP not rebuilt, version remains 0.7.1 for this incremental change. Reload the whole plugin folder to pick it up. Current cleanup context still does not resume after reload; per-sequence preferences are not session recovery.

*(Historical checkpoint — superseded.)* Items 2–3 were approved and implemented later the same day; see the section above. Do not implement review findings 4–9 or optimizations without Dan's individual approval.

## Continuation checkpoint — saved at Dan's request

- **Authoritative directory:** `C:\Users\Dan\Documents\Codex\2026-09-05\files-pasted-by-the-user-wtvaudiowizard\outputs\WTVAudioWizard`. Do not resume an older copy or rebuild from the original architecture notes.
- **Approval boundary:** Dan explicitly wants each proposed fix explained and approved separately. Items 1, 2 and 3 are complete (2 and 3 approved and implemented together on 2026-09-10, after this checkpoint was first saved). Findings 4-9 and all optimizations remain proposed, **not approved** — do not implement without asking.
- **Changed implementation (item 1):** `plugin/music-pass.js` resolves clean media or chosen track IDs and validates reference/music separation; new `plugin/dialogue-selector.js` manages checkbox UI and per-sequence preferences; `plugin/main.js` passes the choice separately from DSP settings and includes it in Copy report; `plugin/index.html` and `plugin/style.css` add the compact selector/Refresh beside step 4. `tests/music-pass.test.cjs` and new `tests/dialogue-selector.test.cjs` cover these changes.
- **Changed implementation (items 2-3):** `plugin/deplosive.js`'s `locate()` now compares numeric `.seconds` for playhead containment (not string `.ticks`) and computes the service seed as `playhead.seconds - entry.start.seconds` (not shifted by the source in-point); `run()` shifts the service's rendered-file-relative report back to timeline-relative before returning it. `tests/deplosive.test.cjs` updated (its `tick()` fixture now always produces real string ticks) plus two new regression tests. See `research/WORKFLOW-REVIEW-2026-09-10.md`'s items 2-3 for full detail.
- **Verification performed:** 107/107 JS tests passed via `node --test tests/*.test.cjs`; `node --check plugin/deplosive.js` and `plugin/main.js` passed. The review previously ran 94/94 Python tests in `../../work/service-env/Scripts/python.exe` (Python 3.12). Python/service code was not modified by either patch. Do not present that earlier Python run as a new post-patch run.
- **Review reproduction tool:** `../../work/workflow-review-repros.cjs` now confirms items 1-3 as fixed and still reproduces the other six mock-host scenarios (findings 4-9). It passed after both patches. It is a review evidence tool, not proof the remaining bugs are resolved.
- **Remaining correctness work (findings 4-9):** music effect ownership after effect reorder/partial removal; muted reused output tracks; insufficient pop timeline-change guard (missing in/out point, speed, and effect coverage); incomplete pop rollback (no readback verification, doesn't restore trims/effects); pop cancellation gaps (ignored during upload/DSP/download) and over-aggressive cleanup during an active export; music Undo across its separate effect/keyframe transactions. See the review for examples and proposed fixes.
- **Optional optimizations awaiting approval:** coarser **plugin** music analysis (20 ms hop / simplify — Dan’s intent); one inventory per pop snapshot; session recovery; native gain-based pop repair; grouping optional model stages across clips; bounded cache/storage and peak-processing memory; honest no-op repair reporting.
- **Native validation:** neither the selector nor the items 2-3 fixes have been exercised in Premiere. The prior successful native Amplify handle/boxed-value fixes must remain intact. Do not reintroduce the earlier experimental lock change associated with a Premiere crash. Existing review issues (findings 4-9) remain relevant despite the passing test suites.
- **Delivery state:** files in the development directory are current; plugin/service remain version 0.7.1, token unchanged. **Restart the local service** after any `service/` pull (whisper-body-v1, richness removal, etc.); reload the full plugin folder for panel-only changes. Development ZIP was not rebuilt. The selector appears after step 3; reloading still loses the current cleanup context, because session recovery is not implemented.

## Earlier handoff notes (historical where superseded above)


Updated 2026-09-10. Read this file and README first. Continue the existing implementation; do not rebuild from the original proposal.

## Immediate task

**Current direction (2026-09-15):** **Reload plugin.** Step 4 no longer requires Connect or a running service (see **Latest — music ducking runs offline in the plugin**). Acceptance: service **stopped**, long clone — Choose tracks / Clean dialogue reference, full duck pass, audition, rerun after deleting Amplify; confirm Copy report shows `analysis_location: plugin` and `keyframe_optimization`. Prior blockers (sparse keys, ownership after partial rerun) remain in earlier sections.

**Superseded:** interim adaptive coarsening, 20 000-key guard, and **service `/v1/music-analysis` for step 4** (endpoint kept for compatibility only).

The previous immediate task (native music ducking throwing `component.getParamCount is not a function`) is resolved and confirmed by the user against real Premiere. Two follow-up usability bugs around reruns/moves were also found and fixed after that:
1. Undoing a ducking pass (Ctrl+Z) and moving the music clip before rerunning incorrectly threw "Select the same unchanged music clips to update the previous pass..." even though nothing was left to protect. Fixed in `plugin/music-pass.js` (`stillOwnsEffects()` now detects a clean removal of the previously-owned effect and treats it as a fresh first pass instead of blocking).
2. Dan then asked for the simpler case too: just moving the music clip (without undoing first) and rerunning should silently re-duck at the new position rather than requiring Undo-then-move-then-rerun. Fixed by splitting each clip's fingerprint into a position-inclusive `key` (unchanged) and a new position-agnostic `identity`; the rerun-continuity check now matches by `identity`, so a clip that only moved (same source in/out points) is treated as an ordinary rerun at its new position, while a genuine retrim (different source in/out) still requires a fresh cleanup clone.

Neither of these two music-pass fixes has been re-confirmed against real Premiere yet (the original `getParamCount` fix and the resulting ducking success were confirmed; these two rerun/move refinements came after that and are untested live). See `PREMIERE-MUSIC-PASS.md`'s 2026-09-09 follow-up section.

**Also on 2026-09-10**: Essential Sound clip tagging is not exposed in UXP (see research note in older `PREMIERE-MUSIC-PASS.md`). The positional A1/A2 dialogue rule was explored but **superseded** by the approved dialogue-reference selector (Clean dialogue / Choose tracks); see the 2026-09-10 selector section above.

**Current task: Fix a pop (new in v0.7.1), awaiting native confirmation of the corrected version.** Dan asked for a tool to attenuate a specific, human-identified plosive/mic-pop in already-cleaned dialogue, explicitly *not* a one-off fix for a single file — see the investigation and design reasoning in `service/deplosive.py`'s module docstring (a real-world energy-ratio detection experiment showed a genuine pop ranked outside the top 10 among ordinary loud words in the same file, in every band tried, so this is seeded/manual by design, not automatic). Built end-to-end: `service/deplosive.py` (DSP), `POST /v1/deplosive` + `GET /v1/assets/{id}/download` (service/app.py), `plugin/deplosive.js` (Premiere render/upload/import/overwrite), a new always-visible **Fix a pop** button sharing a row with step 4.

Dan tried it against real Premiere and reported two real bugs from that first attempt, both now fixed but **not yet re-confirmed**:
1. `plugin/local-api.js`'s endpoint allow-list regex didn't include the two new routes, so every click failed immediately with `Unexpected local service endpoint.` before reaching the service.
2. The fixed clip's output WAV was written to a temporary folder that got deleted right after the clip was placed on the timeline — silently breaking the clip's own media reference. Premiere's cached playback masked this, so "the first usage seems to work" but a second fix on the same clip couldn't find a valid target (its new path was never recorded either). Fixed by writing to a persistent, user-chosen folder (asked once per clone, reused after) and appending the new path to `context.dialoguePaths` after each fix.

See `validation/v0.7.1-checks.json` for full detail on both bugs and their regression tests. **Next priority: get Dan to retry Fix a pop in real Premiere and confirm it now works, including a second fix on an already-fixed clip.** If it still fails, get the exact new error text and Copy report output — do not assume these were the only two issues.

## Locations and operation

- Workspace: `C:\Users\Dan\Documents\Codex\2026-09-05\files-pasted-by-the-user-wtvaudiowizard`.
- Product: `outputs/WTVAudioWizard`; panel entry: `plugin/manifest.json`.
- Restart using `outputs/WTVAudioWizard/start-service.ps1`, then unload/reload the full plugin folder in UXP Developer Tool. Panel and service must both show **0.7.1**. The stored pairing token is unchanged.
- Service Python: `work/service-env/Scripts/python.exe` (3.12). One service process, one GPU job at a time, loopback port 8756.
- Model paths and pinned hashes: `local-config.json`. Existing GPU environments/checkpoints are already configured; no new downloads were needed.
- Default local data: `work/wtv-data`. Test GPU data: `work/optimization-gpu-smoke` and `work/optimization-service-smoke`, isolated from normal jobs.
- Development source ZIP: `outputs/WTVAudioWizard-development.zip`; previous package preserved as `outputs/WTVAudioWizard-v0.6.3-development.zip`. This workspace is not a Git repository. Do not package virtual environments, weights, private audio, tokens or service data.
- **Regression tests:** run from the product folder with `node --test tests/*.test.cjs` and `..\..\work\service-env\Scripts\python.exe -m pytest tests -q --basetemp=.pytest-tmp -p no:cacheprovider`. **194 JS passing** (2026-09-15); **111 Python** last full run 2026-09-11 — rerun Python after any `service/` pull.

## Product behavior to preserve

GAP-URGENet is the default dialogue enhancer, MossFormer2 SE 48K the alternative. Both clean raw audio directly. Bandit speech is never used for dialogue. Ambience and Music extraction are optional and unchecked; AV-CASS remains a secondary target without an integrated runner.

The panel clones the Premiere sequence and inserts additional aligned groups: Raw → Clean dialogue → optional Ambience → optional Music. Original media, raw trims, speed and video links remain intact. Processed raw lanes are muted when an entire lane was cleaned; partial per-clip selection disables only the processed raw clips. Per-clip mode defaults to selected dialogue on dedicated lanes; partial selection on a dialogue track is allowed (keep music on separate tracks). Imported stems and standalone fix/enhance outputs land in a project bin named **Audio Wizard**. Track naming is optional because some installed hosts lack `createSetNameAction` on tracks. Error reports support clipboard copying with token redaction and a manual fallback.

Existing timeline music is finished separately after clean dialogue insertion (steps 1–3 still require the service). **Step 4 — Conform & duck music** runs **entirely in the panel**: Premiere renders → local WAV read → `plugin/music-analysis.js` → native Amplify keyframes. No music upload to the service; `/v1/music-analysis` remains for compatibility only. Dialogue reference is **Clean dialogue** (inserted media paths, including pop-fix paths) or **Choose tracks** via `plugin/dialogue-selector.js` — not a positional A1/A2 rule and not Essential Sound tagging. The native pass targets the combined selected music bed (default peak −28 dBFS baseline before ducking; Options → Ducking) and adds editable Amplify keyframes. It uses temporary baseline, dialogue and calibration WAVs on disk; it does not replace/import music media. Existing clip effects/fades are preserved except optional clip Volume strip before ducking. A rerun replaces only the verified WTV-owned effect, and now correctly treats a clean post-undo state (see Immediate task) or a moved-but-otherwise-unchanged music clip as a fresh/updated pass rather than blocking it — only a genuine retrim, different selection, or independently-edited effect still requires a fresh cleanup clone. Calibration, installed-key readback, change detection, rollback and a durable pending marker protect edits. This is WTV's energy detector, not Adobe Essential Sound's Generate Keyframes command.

**Fix a pop** attenuates one human-identified plosive/pop in an already-inserted Clean dialogue clip, seeded from the Premiere playhead position — deliberately not automatic whole-file detection (see Immediate task and `service/deplosive.py`'s docstring for why). It renders just the target clip via an isolated sequence clone (same pattern as per-clip export), calls the local service, and overwrites only that clip's timeline range; everything else is verified unchanged before and after. The first use per clone asks for a persistent output folder (like steps 1/3) that must be kept, since it holds the fixed clip's actual media from then on.

**Enhance low end** is a standalone timeline action (not gated on cleanup context): selected clips are rendered, enhanced via `/v1/lowend` (**whisper-body-v1**), and overwritten in place. Intensity 0.2×–3× (default 1×) scales the filtered 150–500 Hz body band; see top section. Real whispered-dialogue listening and native Premiere acceptance are still pending.

## Recent changes

### v0.6.1–0.6.3: repair and compact UI

The combined de-click/de-ess algorithm caused false repairs on ordinary dialogue. It was briefly exposed/default-on, then default-off, removed from the panel in 0.6.2, and restored as explicit experimental opt-in in 0.6.3. It is forced off on load, Reset and reconnect even if old saved settings enabled it. The algorithm has not been improved since. `research/DECLICK-RESEARCH.md` documents the real-audio investigation and FFmpeg comparison; no clear replacement winner was established. Next work should improve detection precision and separate de-click from de-ess.

The panel now fits a preferred 300×480 dock, minimum 280×280. Dialogue setup and Prepare → Clean → Add tracks lead the flow. Levels, music and help sections collapse; music opens after successful insertion. Click/pop reporting is available under Help. Native visual acceptance is still needed.

### v0.7.0: optimizations now enabled

- `service/stage_cache.py`: immutable, checksummed native model outputs, independently keyed from finishing. Keys include decoded source identity, checkpoint pins, runner/relevant upstream source, dependency metadata and conversion policy. Corrupt/incomplete artifacts miss the cache; writes publish atomically. Model code/config changes during a job prevent publication. Cache hits still validate output layout/duration. Repair and normalization run afterward.
- `service/worker_pool.py` and `runners/worker.py`: private JSON pipes to one reusable model process. Verify checkpoint contents before loading a new worker; reuse only the matching identity and Bandit head set. Imports/models persist across consecutive same-model clips. Model switches terminate the old process before loading the next. Failure/cancellation discards it; panel processing completion requests release; 60 idle seconds and service shutdown also unload. No new network listener.
- All three runners retain the loaded model. Bandit strictly loads all pinned weights first, then prunes unrequested independent mask heads before CUDA transfer. Precision, window/hop and overlap settings are unchanged. GAP's Numba cache is placed beside the service job folders, rather than modifying its upstream checkpoint folder.
- Bounded 128-frame float64 music RMS; unused duck-envelope bypass for dialogue-only processing; single in-memory resample and WAV write for cleanup input. Source → output rate → 48 kHz conversion order is preserved.
- Upload write/validation offloading; short-lock asset pinning for music analysis; duplicate uploads removed when whole-job reuse makes them unreferenced. Existing assets referenced by jobs cannot be removed through that endpoint.
- Amplify catalog discovery once per music pass and reuse of already-read trim values, with verification boundaries retained.
- Job results expose stage timings, cache-hit flags and worker reuse. Cached enhancement/benchmark fields describe their original inference, not the current run. Whole-job reuse remains available; UI version alone no longer invalidates inference.

Only one model is kept resident. Clips requesting both Bandit and cleanup still alternate models per clip; batches are not regrouped by stage. Inference cache has **no automatic eviction**. It lives under `<service data>/stage-cache`; stop the service before manually removing only that folder. Do not delete saved Premiere WAVs. History indexes, streaming 4× peak analysis, advanced GPU precision/batching/compile and de-click solver changes remain deferred. The original review is retained as a historical assessment in `research/OPTIMIZATION-REVIEW.md`.

### Music review and diagnostics in v0.7.0

Checked the detector/envelope, clip-relative timing, native effect calls, calibration, rerun ownership and rollback. No confirmed native API mismatch or timing defect was established. A recent 15.18-second local clean-dialogue file was above the default −40 dBFS detection floor in 97.37% of frames. This predicts almost continuous detection for that clip, but does not establish whether the audio is speech/noise or matches the reported failing timeline.

Added **Speech floor · dBFS**, default −40, range −60…−15. Lower detects quieter speech; higher excludes more noise. It is shared with the existing threshold setting when processing extracted stems. Native analysis now reports dialogue activity, percentage of audible music ducked, maximum reduction, dialogue RMS peak, baseline and calibration. Copy report keeps a compact analysis summary and whether Apply succeeded. Requested ducking with zero detected dialogue stops before music Apply; Duck = 0 permits intentional level-only conforming. Nearly continuous ducking and no ducking during audible selected music produce explicit warnings. No VAD/model or speculative timing conversion was substituted.

### v0.7.1: rerun-after-undo fix, and Fix a pop (new feature)

- `plugin/music-pass.js`: fixed the rerun-after-undo usability bug described under Immediate task above.
- `service/deplosive.py` (new): seeded, single-location plosive/pop attenuation. No whole-file scanning by design; see its module docstring for the real-world false-positive investigation that motivated this. Auto-sizes the affected window from the signal's own local energy envelope around a given seed timestamp, tolerating brief troughs in a decaying oscillation, then applies an attack/hold/release gain dip (up to 16 dB, defaults validated against three different real plosives: 61–83% peak reduction, 68–82% RMS reduction each).
- `service/app.py` (new endpoints): `POST /v1/deplosive` (asset + seed_seconds → new attenuated asset + report, synchronous, never cached — this is CPU DSP on a few seconds of audio, not a model job) and `GET /v1/assets/{id}/download` (previously nothing could download an arbitrary uploaded/derived asset back; only job results were downloadable).
- `plugin/deplosive.js` (new): `locate()` finds the Clean dialogue clip under the Premiere playhead (same source-path matching as `music-pass.js`'s `collect()`) and the local seed time within it; `run()` isolates+exports just that clip (same clone/disable pattern as `per-clip.js`), calls the service, imports the result, and overwrites only that clip's timeline range, with before/after verification and a restore attempt on failure.
- New always-visible **Fix a pop** button (`plugin/index.html`/`style.css`/`main.js`), sharing a row with step 4, gated the same as step 4 (`context.applied && !context.failedApply`).
- Two real bugs found from the user's own first real-Premiere attempt and fixed — see Immediate task above and `validation/v0.7.1-checks.json` for full detail. **Neither fix has been re-confirmed against real Premiere yet.**

## Validation and measured limits

Final regression counts/status for this version: `validation/v0.7.1-checks.json` (Fix a pop, both bug fixes). Prior version: `validation/v0.7.0-checks.json` (cache reuse across finishing/repair/stem options, cache corruption/cancel, worker reuse/switch/failure/idle/cancel, asset pinning, unchanged RMS and resampling, native timeline preservation, music diagnostics). Two known FastAPI/Starlette test-client deprecation warnings do not fail tests. Private real-audio tests may skip in a clean ZIP lacking their local fixtures. **Current full-suite counts: 194 JS** (2026-09-15) **/ 111 Python** (2026-09-11, rerun after service changes).

GPU reports: `validation/optimization-gpu-smoke.json`, `optimization-gpu-controls.json`, `optimization-service-smoke.json`. RTX 5080, 16 GB; one-second synthetic mono fixture:

| Test | Observed |
|---|---|
| GAP cold / warm worker wall time | 20.35 / 5.18 s |
| MossFormer cold / warm worker wall time | 19.51 / 0.20 s |
| Service GAP cold / next uncached clip / finishing reuse | 17.99 / 5.00 / 0.14 s |
| Bandit music, sfx, music+sfx versus full heads | Exact retained samples on fixture |
| GAP PyTorch peak allocated / reserved | ~4668 / 9900 MiB |
| MossFormer allocated / reserved | ~251 / 258 MiB |
| Bandit one selected head allocated / reserved | ~957 / 1530 MiB |

Short synthetic tests measure startup savings and execution/alignment, not production throughput, minimum VRAM or perceptual dialogue quality. GPU/driver/Premiere allocations are additional. GAP cold/warm max sample difference was ~2.4e−6; a fresh-process control was ~2.6e−6. MossFormer cold/warm max difference was ~0.00089; fresh-process control ~0.00111. ClearVoice uses random fbank dither; repeated model runs are not bit deterministic. Native inference caching retains the original samples. All test workers were released.

## Next steps for the next agent

1. **Get Dan to retry Fix a pop in real Premiere** and confirm both fixes actually resolved the reported behavior: (a) it no longer fails immediately with "Unexpected local service endpoint.", and (b) using it twice on the same clip (fix one pop, then fix a second different pop in the same original clip, or just retry) actually works and the first fix's audio genuinely persists after reopening/relinking the project, not just within the same session's cache. If a different symptom remains, get the exact new error text and Copy report output.
2. Verify per-clip partial selection, single-clip Prepare → Clean, **Add clean tracks** (Audio Wizard bin + `FolderItem.cast`), scroll fade overlays, and Enhance low end (**whisper-body-v1** + intensity cog) in installed Premiere; mocks and browser layout checks are not sufficient. Restart service first if the running build predates whisper-body-v1.
3. Improve de-click precision using reviewed speech events/held-out clips, preferably detection/reporting before repair. Keep it off by default until quality supports changing that. (Separately: Fix a pop deliberately does not attempt automatic detection at all, for the same false-positive reason — see its module docstring. Do not conflate the two; a future automatic detector for either would need genuinely new evidence, not just reapplying the existing energy-ratio approach.)
4. Measure representative long/stereo projects and memory pressure with Premiere running. Prioritize stage-grouped mixed batches, bounded peak analysis and cache retention controls if measurements justify them. Any new Enhance low end workflow fixes should be scoped against **whisper-body-v1** and current panel code — `research/LOW-END-EVALUATION-2026-09-11.md` still describes the superseded harmonic algorithm.

Useful checks from the workspace: `work/service-env/Scripts/python.exe -X utf8 -m pytest tests -q --basetemp=.pytest-tmp -p no:cacheprovider` (from product folder), `node --test tests/*.test.cjs`. **194 JS** / **111 Python** (JS verified 2026-09-15). Workspace helper scripts used for one-off edits are not generally idempotent; read before rerunning. GPU helpers write isolated smoke outputs; repeated service-smoke runs must use a fresh test data directory to measure cold behavior.

**Satellite docs still stale:** `README.md` has a current whisper-body blurb at the top but still contradicts itself (harmonic-intensity paragraph, removed Dialogue richness section, stale test counts 128/119, “select all audible dialogue”). `PER-CLIP-MODE.md` and `PREMIERE-MUSIC-PASS.md` step 1 still describe partial-selection rejection. `research/DIALOGUE-RICHNESS-PROPOSAL.md` reads as live implementation but the feature was removed. `research/LOW-END-EVALUATION-2026-09-11.md` describes the superseded harmonic DSP, not whisper-body-v1. `research/VOICE-POLISH-PLAN.md` still points at dialogue richness as current direction. Trust this file and the code over those passages until synced.
