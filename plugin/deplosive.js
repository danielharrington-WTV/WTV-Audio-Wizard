// Seeded, single-location plosive/pop attenuation, triggered from the
// Premiere playhead (see service/deplosive.py's module docstring for the
// underlying reasoning: no whole-file scanning, a human-identified location
// only). Standalone utility: runs on whichever single audio clip is selected
// (any clip -- raw, Clean dialogue, music, anything), with or without a WTV
// session; the playhead only supplies the seed time (v0.8.1).
const ppro = require('premierepro');
const host = require('./premiere.js');
const safeSequences=async project=>host.listSequences ? host.listSequences(project) : ((await project.getSequences())||[]).filter(s=>s && s.guid);
const {inventory} = require('./per-clip.js');
const {waitForStableWav} = require('./wav.js');
const {getWavPreset} = require('./export-presets.js');
const {exportSequenceWithRenderWait} = require('./export-sync.js');
const {readWavFloat, writeWavFloat, attenuatePop} = require('./local-dsp.js');
const id = sequence => sequence.guid.toString();
const pathKey = path => path.replace(/\\/g, '/').toLowerCase();

// Finds the single selected, enabled, unmuted clip the playhead is parked
// inside, and the clip-local seed time within it.
async function locate(context) {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  // Works on the clip(s) SELECTED on the timeline, not whatever is under the
  // playhead: select exactly one audio clip, then park the playhead on the pop
  // inside it. The playhead only supplies the seed time.
  const playhead = await sequence.getPlayerPosition();
  const all = await inventory(sequence);
  const selected = [];
  for (const entry of all) if (await entry.item.getIsSelected()) selected.push(entry);
  if (!selected.length) throw new Error('Select the audio clip containing the pop on the timeline first.');
  if (selected.length > 1) throw new Error('Select just one clip to fix a pop.');
  const matches = selected;
  if (!selected[0].enabled) throw new Error('The selected clip is disabled.');
  if (selected[0].muted) throw new Error('The selected clip is on a muted track.');
  // TickTime.ticks is a string; comparing it with </>= sorts the text, not
  // the numeric time, so use the numeric .seconds property.
  if (playhead.seconds < selected[0].start.seconds || playhead.seconds >= selected[0].end.seconds) throw new Error('Park the playhead on the pop inside the selected clip.');
  const entry = matches[0];
  if (entry.transitions) throw new Error('Remove audio transitions on this track before fixing a pop.');
  if (await entry.item.getSpeed() !== 1 || await entry.item.isSpeedReversed()) throw new Error('Pop fixing currently requires a normal-speed, forward clip.');
  // run() renders ONLY this clip's timeline range (see exportSequence's
  // exportFull=false below), so the resulting WAV starts at local time zero
  // == entry.start on the timeline -- NOT the clip's source media in-point.
  // The previous version added the source in-point on top of the
  // timeline-relative offset, which is only correct if the WAV were the
  // full original source file; for a trimmed clip this sent a seed far
  // outside the actual rendered file (caught by the same 2026-09-10 review).
  const seedSeconds = playhead.seconds - entry.start.seconds;
  return {project, sequence, entry, playheadSeconds: playhead.seconds, seedSeconds};
}

async function snapshot(sequence, count) {
  const result = [];
  for (let index = 0; index < count; index++) {
    for (const entry of (await inventory(sequence)).filter(e => e.trackIndex === index)) {
      result.push([index, entry.sourceId, entry.start.ticks, entry.end.ticks, entry.enabled, entry.muted]);
    }
  }
  return JSON.stringify(result);
}

async function run(sessionContext, {fs, binary, request, check, say, sleep, outputFolder}) {
  const {project, sequence, entry, playheadSeconds, seedSeconds} = await locate(sessionContext);
  // Standalone runs have no WTV context; derive what the render needs from the sequence.
  let context = sessionContext;
  if (!(context && context.applied && !context.failedApply && context.sequence && id(sequence) === id(context.sequence))) {
    const settings = await sequence.getSettings();
    context = {name: 'WTV', originalId: null, dialoguePaths: null,
      rate: Math.round((await settings.getAudioSampleRate()).value), channels: await settings.getAudioChannelCount()};
    if (![1, 2].includes(context.channels) || ![44100, 48000, 96000].includes(context.rate)) throw new Error('Fix pop at playhead supports mono/stereo sequences at 44.1, 48 or 96 kHz.');
  }
  const originalProjectItem = await entry.item.getProjectItem();
  const count = await sequence.getAudioTrackCount();
  const before = await snapshot(sequence, count);
  // playheadSeconds (timeline-relative) is what the user actually
  // parked the playhead at and can verify by looking at the timeline;
  // seedSeconds (rendered-file-relative, computed in locate()) is only
  // meaningful to the /v1/deplosive call below, never shown to the user.
  say(`Rendering the clip around ${playheadSeconds.toFixed(3)}s for pop attenuation...`);
  const beforeSequences = new Set((await safeSequences(project)).map(id));
  // A plain before/after sequence-list diff misses a clone made while
  // editing inside a nest or multicam source: listSequences() doesn't list
  // the nest itself, or a clone of it, while it's the active sequence (see
  // UXP-QUIRKS.md). identifyNewSequence() adds the project-bin-diff and
  // active-sequence fallbacks per-clip.js's cloneActive() already relies on
  // for the same reason.
  const beforeItems = await host.snapshotProjectItems(project);
  host.transaction(project, 'WTV: prepare pop-fix render', c => c.addAction(sequence.createCloneAction()));
  const render = await host.identifyNewSequence(project, beforeSequences, [context.originalId, id(sequence)].filter(Boolean), 'pop-fix render sequence', beforeItems);
  let renderDeleted = false;
  // The isolated-clip export ("clip.wav") is a throwaway upload source and
  // is deleted below once no longer needed. The attenuated result
  // ("popfix-...wav") is NOT: it becomes the timeline clip's actual media
  // reference after placement and must persist for as long as the project
  // references it, like every other stem this panel ever inserts (per-
  // clip.js/premiere.js's applyStems() write to a permanent, user-chosen
  // folder for the same reason). Using a temp folder and deleting it after
  // placement -- the original version of this function -- silently broke
  // the fixed clip's backing media right after inserting it.
  let scratchFile = null;
  try {
    const all = await inventory(render);
    const target = all.find(c => c.trackIndex === entry.trackIndex && c.index === entry.index && c.sourceId === entry.sourceId
      && c.start.ticks === entry.start.ticks && c.end.ticks === entry.end.ticks);
    if (!target || !target.enabled) throw new Error('The clip changed while preparing its render.');
    const item = await render.getProjectItem();
    host.transaction(project, 'WTV: isolate pop-fix clip', compound => {
      compound.addAction(item.createSetNameAction(`${context.name}_POPFIX_RENDER`));
      for (const e of all) compound.addAction(e.item.createSetDisabledAction(e !== target));
      compound.addAction(render.createSetInPointAction(target.start));
      compound.addAction(render.createSetOutPointAction(target.end));
    });
    if (target.muted) {
      const track = await render.getAudioTrack(target.trackIndex);
      if (!await track.setMute(false)) throw new Error('Could not unmute the render for this clip.');
    }
    const preset = await getWavPreset(fs, context);
    // Date.now() alone can collide on fast back-to-back fixes (observed in
    // testing); a random suffix makes each fix's filenames unique regardless
    // of timing.
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = await outputFolder.createFile(`popfix-render-${entry.trackIndex}-${entry.index}-${unique}.wav`, {overwrite: false});
    scratchFile = file;
    const manager = await ppro.EncoderManager.getManager();
    const renderWait = await exportSequenceWithRenderWait({
      ppro, manager, sequence: render,
      exportType: ppro.Constants.ExportType.IMMEDIATELY,
      outputFile: file.nativePath, presetFile: preset.nativePath, exportFull: false,
      outputNativePath: file.nativePath, check, sleep,
      rejectedMessage: 'Premiere did not accept the pop-fix export.',
    });
    const expected = {rate: context.rate, channels: context.channels, duration: target.duration};
    const {bytes, exportWait: stabilizeWait} = await waitForStableWav(file, expected, {
      binary, check, sleep, renderWaitMode: renderWait.mode,
    });
    try { renderDeleted = await project.deleteSequence(render); } catch (_) { /* Harmless render clone retained. */ }

    // Runs entirely in-panel now -- no /v1/deplosive round trip. This is pure
    // CPU envelope math on a few seconds of audio (see local-dsp.js's
    // file-level comment for why), so there's no service to be unreachable
    // and no OS-specific dependency, which matters once this needs to also
    // run on a Mac.
    say('Attenuating the pop...');
    const {sampleRate, channels: decoded} = readWavFloat(bytes);
    const {output, report} = attenuatePop(decoded, sampleRate, seedSeconds);
    const outBytes = writeWavFloat(sampleRate, output);
    // Distinct name per fix (not just trackIndex/index) so re-fixing the
    // same clip again later -- e.g. a second, different pop -- never
    // collides with or overwrites this run's still-referenced file.
    const outFile = await outputFolder.createFile(`popfix-${entry.trackIndex}-${entry.index}-${unique}.wav`, {overwrite: false});
    await outFile.write(outBytes, {format: binary});
    // clip.wav's isolated-render export has done its job (uploaded); safe to
    // discard now, before the permanent file below is put in play.
    try { await scratchFile.delete(); scratchFile = null; } catch (_) {}

    if (before !== await snapshot(sequence, count)) throw new Error('Timeline changed during pop attenuation. No edits applied.');
    say('Placing the attenuated clip...');
    const {added} = await host.importIntoBin(project, [outFile.nativePath], 'Could not import the attenuated clip.');
    let imported;
    for (const candidate of added) {
      const clip = ppro.ClipProjectItem.cast(candidate);
      if (clip && pathKey(await clip.getMediaFilePath()) === pathKey(outFile.nativePath)) imported = {item: candidate, clip};
    }
    if (!imported) throw new Error('Could not identify the imported attenuated clip; timeline unchanged.');
    const newName = `${await entry.item.getName()} pop fix @${playheadSeconds.toFixed(3)}s`;
    host.transaction(project, 'WTV: name pop-fix clip', c => c.addAction(imported.item.createSetNameAction(newName)));
    host.transaction(project, 'WTV: set pop-fix clip range', c => c.addAction(imported.clip.createSetInOutPointsAction(ppro.TickTime.TIME_ZERO, entry.end.subtract(entry.start))));
    if (before !== await snapshot(sequence, count)) throw new Error('Timeline changed during pop attenuation. No edits applied.');

    const beforeOverwrite = await inventory(sequence);
    const editor = ppro.SequenceEditor.getEditor(sequence);
    const isTouched = c => c.trackIndex === entry.trackIndex && c.start.ticks === entry.start.ticks && c.end.ticks === entry.end.ticks;
    let placed = false;
    try {
      host.transaction(project, 'WTV: fix a pop', c => c.addAction(editor.createOverwriteItemAction(imported.item, entry.start, -1, entry.trackIndex)));
      placed = true;
      const after = await inventory(sequence);
      const replaced = after.find(c => isTouched(c) && c.enabled);
      if (!replaced || replaced.sourceId === entry.sourceId) throw new Error('Could not verify the pop-fix placement.');
      const untouchedBefore = beforeOverwrite.filter(c => !isTouched(c)).map(c => [c.trackIndex, c.sourceId, c.start.ticks, c.end.ticks, c.enabled, c.muted]);
      const untouchedAfter = after.filter(c => !isTouched(c)).map(c => [c.trackIndex, c.sourceId, c.start.ticks, c.end.ticks, c.enabled, c.muted]);
      if (JSON.stringify(untouchedBefore) !== JSON.stringify(untouchedAfter)) throw new Error('Clips outside the fixed range changed unexpectedly.');
    } catch (error) {
      let recovered = false;
      if (placed) {
        try {
          host.transaction(project, 'WTV: restore clip after failed pop-fix verification',
            c => c.addAction(editor.createOverwriteItemAction(originalProjectItem, entry.start, -1, entry.trackIndex)));
          recovered = true;
        } catch (_) { /* Restoration attempt failed; original clip may be gone. */ }
      }
      throw new Error(`${error.message} ${recovered ? 'The original clip was restored.' : 'Inspect the track and use Undo if needed.'}`);
    }
    // Keep a WTV session's list of Clean dialogue sources current, so music
    // ducking still treats this (now pop-fixed) clip as dialogue.
    if (context.dialoguePaths) context.dialoguePaths.push(outFile.nativePath);
    // report's seed_seconds/start_seconds/end_seconds (and per-channel
    // start_seconds/end_seconds) all come from service/deplosive.py measuring
    // the rendered, clip-local WAV -- shift them back to timeline-relative
    // (adding entry.start.seconds) so everything shown to the user lines up
    // with what they'd see by parking the playhead there, consistent with
    // playheadSeconds/newName above. duration_seconds/max_reduction_db/
    // baseline_rms are relative measurements, not positions, and are passed
    // through unchanged.
    const toTimeline = seconds => seconds + entry.start.seconds;
    return {output_path: outFile.nativePath, exportWait: {render: renderWait.mode, stabilize: stabilizeWait}, ...report,
      seed_seconds: toTimeline(report.seed_seconds), start_seconds: toTimeline(report.start_seconds), end_seconds: toTimeline(report.end_seconds),
      channels: report.channels.map(c => ({...c, start_seconds: toTimeline(c.start_seconds), end_seconds: toTimeline(c.end_seconds)}))};
  } finally {
    if (!renderDeleted) { try { await project.deleteSequence(render); } catch (_) {} }
    if (scratchFile) { try { await scratchFile.delete(); } catch (_) {} }
  }
}

module.exports = {run, locate};
