// Standalone post-process: applies service/lowend.py's psychoacoustic
// low-end enhancement to every eligible clip currently selected on the
// active sequence, overwriting each in place -- one clip at a time.
// Deliberately independent of any WTV clone/context (contrast with
// deplosive.js, which needs an applied WTV session and a single clip under
// the playhead): this works on whatever the user has selected, on any
// sequence, regardless of workflow state. Mirrors deplosive.js's per-clip
// render/isolate/export/upload/download/reimport/overwrite/verify/rollback
// pipeline closely; see that file for the reasoning behind each step.
const ppro = require('premierepro');
const host = require('./premiere.js');
const safeSequences=async project=>host.listSequences ? host.listSequences(project) : ((await project.getSequences())||[]).filter(s=>s && s.guid);
const {inventory} = require('./per-clip.js');
const {waitForStableWav} = require('./wav.js');
const {getWavPreset} = require('./export-presets.js');
const {exportSequenceWithRenderWait} = require('./export-sync.js');
const {readWavFloat, writeWavFloat, enhanceLowEnd} = require('./local-dsp.js');
const id = sequence => sequence.guid.toString();
const pathKey = path => path.replace(/\\/g, '/').toLowerCase();

async function snapshot(sequence, count) {
  const result = [];
  for (let index = 0; index < count; index++) {
    for (const entry of (await inventory(sequence)).filter(e => e.trackIndex === index)) {
      result.push([index, entry.sourceId, entry.start.ticks, entry.end.ticks, entry.enabled, entry.muted]);
    }
  }
  return JSON.stringify(result);
}

// Every currently-selected clip on the sequence's audio tracks, whether or
// not it is actually eligible for enhancement -- eligibility (enabled,
// unmuted, no transitions, normal speed) is checked per-clip in
// enhanceOne() below, so an ineligible selected clip is reported with a
// clear reason rather than silently skipped.
async function selectedClips(sequence) {
  const all = await inventory(sequence);
  const selected = [];
  for (const entry of all) if (await entry.item.getIsSelected()) selected.push(entry);
  return selected;
}

async function enhanceOne(project, sequence, entry, {fs, binary, request, say, sleep, check, outputFolder, preset, rate, channels, intensity, context}) {
  if (!entry.enabled) throw new Error('Clip is disabled.');
  if (entry.muted) throw new Error('Clip is on a muted track.');
  if (entry.transitions) throw new Error('Remove audio transitions on this track before enhancing.');
  if (await entry.item.getSpeed() !== 1 || await entry.item.isSpeedReversed()) throw new Error('Low-end enhancement currently requires a normal-speed, forward clip.');

  const originalProjectItem = await entry.item.getProjectItem();
  const originalClip = ppro.ClipProjectItem.cast(originalProjectItem);
  const originalPath = originalClip ? pathKey(await originalClip.getMediaFilePath()) : null;
  const count = await sequence.getAudioTrackCount();
  const before = await snapshot(sequence, count);
  say(`Rendering "${entry.name}" for low-end enhancement...`);

  const beforeSequences = new Set((await safeSequences(project)).map(id));
  // A plain before/after sequence-list diff misses a clone made while
  // editing inside a nest or multicam source: listSequences() doesn't list
  // the nest itself, or a clone of it, while it's the active sequence (see
  // UXP-QUIRKS.md). identifyNewSequence() adds the project-bin-diff and
  // active-sequence fallbacks per-clip.js's cloneActive() and deplosive.js's
  // run() already rely on for the same reason.
  const beforeItems = await host.snapshotProjectItems(project);
  host.transaction(project, 'WTV: prepare low-end render', c => c.addAction(sequence.createCloneAction()));
  const render = await host.identifyNewSequence(project, beforeSequences, [id(sequence)], 'low-end render sequence', beforeItems);
  let renderDeleted = false;
  let scratchFile = null;
  try {
    const all = await inventory(render);
    const target = all.find(c => c.trackIndex === entry.trackIndex && c.index === entry.index && c.sourceId === entry.sourceId
      && c.start.ticks === entry.start.ticks && c.end.ticks === entry.end.ticks);
    if (!target || !target.enabled) throw new Error('The clip changed while preparing its render.');
    const item = await render.getProjectItem();
    host.transaction(project, 'WTV: isolate low-end clip', compound => {
      compound.addAction(item.createSetNameAction('WTV_LOWEND_RENDER'));
      for (const e of all) compound.addAction(e.item.createSetDisabledAction(e !== target));
      compound.addAction(render.createSetInPointAction(target.start));
      compound.addAction(render.createSetOutPointAction(target.end));
    });
    if (target.muted) {
      const track = await render.getAudioTrack(target.trackIndex);
      if (!await track.setMute(false)) throw new Error('Could not unmute the render for this clip.');
    }
    // Random suffix (like deplosive.js's) avoids collisions across fast
    // back-to-back clips in the same batch, not just back-to-back clicks.
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = await outputFolder.createFile(`lowend-render-${entry.trackIndex}-${entry.index}-${unique}.wav`, {overwrite: false});
    scratchFile = file;
    const manager = await ppro.EncoderManager.getManager();
    const renderWait = await exportSequenceWithRenderWait({
      ppro, manager, sequence: render,
      exportType: ppro.Constants.ExportType.IMMEDIATELY,
      outputFile: file.nativePath, presetFile: preset.nativePath, exportFull: false,
      outputNativePath: file.nativePath, check, sleep,
      rejectedMessage: 'Premiere did not accept the low-end export.',
    });
    const expected = {rate, channels, duration: target.duration};
    const {bytes, exportWait: stabilizeWait} = await waitForStableWav(file, expected, {
      binary, check, sleep, renderWaitMode: renderWait.mode,
    });
    try { renderDeleted = await project.deleteSequence(render); } catch (_) { /* Harmless render clone retained. */ }

    // Runs entirely in-panel now -- no /v1/lowend round trip. See
    // local-dsp.js's file-level comment: this is an RBJ-cookbook bandpass
    // port, not a bit-identical match to service/lowend.py's scipy
    // Butterworth filter -- an A/B listening check against the old
    // server-side output is recommended.
    say(`Enhancing "${entry.name}"...`);
    const {sampleRate, channels: decoded} = readWavFloat(bytes);
    const {output, report} = enhanceLowEnd(decoded, sampleRate, intensity);
    const outBytes = writeWavFloat(sampleRate, output);
    const outFile = await outputFolder.createFile(`lowend-${entry.trackIndex}-${entry.index}-${unique}.wav`, {overwrite: false});
    await outFile.write(outBytes, {format: binary});
    try { await scratchFile.delete(); scratchFile = null; } catch (_) {}

    if (before !== await snapshot(sequence, count)) throw new Error('Timeline changed during low-end enhancement. No edits applied.');
    say(`Placing enhanced "${entry.name}"...`);
    const {added} = await host.importIntoBin(project, [outFile.nativePath], 'Could not import the enhanced clip.');
    let imported;
    for (const candidate of added) {
      const clip = ppro.ClipProjectItem.cast(candidate);
      if (clip && pathKey(await clip.getMediaFilePath()) === pathKey(outFile.nativePath)) imported = {item: candidate, clip};
    }
    if (!imported) throw new Error('Could not identify the imported enhanced clip; timeline unchanged.');
    const newName = `${entry.name} low-end enhanced`;
    host.transaction(project, 'WTV: name low-end clip', c => c.addAction(imported.item.createSetNameAction(newName)));
    host.transaction(project, 'WTV: set low-end clip range', c => c.addAction(imported.clip.createSetInOutPointsAction(ppro.TickTime.TIME_ZERO, entry.end.subtract(entry.start))));
    if (before !== await snapshot(sequence, count)) throw new Error('Timeline changed during low-end enhancement. No edits applied.');

    const beforeOverwrite = await inventory(sequence);
    const editor = ppro.SequenceEditor.getEditor(sequence);
    const isTouched = c => c.trackIndex === entry.trackIndex && c.start.ticks === entry.start.ticks && c.end.ticks === entry.end.ticks;
    let placed = false;
    try {
      host.transaction(project, 'WTV: enhance low end', c => c.addAction(editor.createOverwriteItemAction(imported.item, entry.start, -1, entry.trackIndex)));
      placed = true;
      const after = await inventory(sequence);
      const replaced = after.find(c => isTouched(c) && c.enabled);
      if (!replaced || replaced.sourceId === entry.sourceId) throw new Error('Could not verify the enhanced placement.');
      const untouchedBefore = beforeOverwrite.filter(c => !isTouched(c)).map(c => [c.trackIndex, c.sourceId, c.start.ticks, c.end.ticks, c.enabled, c.muted]);
      const untouchedAfter = after.filter(c => !isTouched(c)).map(c => [c.trackIndex, c.sourceId, c.start.ticks, c.end.ticks, c.enabled, c.muted]);
      if (JSON.stringify(untouchedBefore) !== JSON.stringify(untouchedAfter)) throw new Error('Clips outside the enhanced range changed unexpectedly.');
    } catch (error) {
      let recovered = false;
      if (placed) {
        try {
          host.transaction(project, 'WTV: restore clip after failed low-end verification',
            c => c.addAction(editor.createOverwriteItemAction(originalProjectItem, entry.start, -1, entry.trackIndex)));
          recovered = true;
        } catch (_) { /* Restoration attempt failed; original clip may be gone. */ }
      }
      throw new Error(`${error.message} ${recovered ? 'The original clip was restored.' : 'Inspect the track and use Undo if needed.'}`);
    }
    // Fix a pop recognizes clips by source media path (see deplosive.js's
    // locate()). Overwriting clean/pop-fixed dialogue with a new low-end file
    // must register that file or Fix a pop no longer finds the clip.
    if (context?.dialoguePaths?.length && originalPath) {
      const known = new Set(context.dialoguePaths.map(pathKey));
      if (known.has(originalPath)) context.dialoguePaths.push(outFile.nativePath);
    }
    return {name: entry.name, output_path: outFile.nativePath, exportWait: {render: renderWait.mode, stabilize: stabilizeWait}, ...report};
  } finally {
    if (!renderDeleted) { try { await project.deleteSequence(render); } catch (_) {} }
    if (scratchFile) { try { await scratchFile.delete(); } catch (_) {} }
  }
}

async function run({fs, binary, request, check, say, sleep, outputFolder, intensity=1, context}) {
  if (!Number.isFinite(intensity) || intensity < 0.2 || intensity > 3) throw Error("Low-end intensity must be between 0.2 and 3×.");
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  const settings = await sequence.getSettings();
  const rate = Math.round((await settings.getAudioSampleRate()).value);
  const channels = await settings.getAudioChannelCount();
  if (![1, 2].includes(channels) || ![44100, 48000, 96000].includes(rate)) throw new Error('This preview supports mono/stereo sequences at 44.1, 48 or 96 kHz.');
  const preset = await getWavPreset(fs, {rate, channels});

  const selected = await selectedClips(sequence);
  if (!selected.length) throw new Error('Select one or more audio clips on the timeline before enhancing low end.');

  const results = [];
  for (const entry of selected) {
    check();
    try {
      results.push(await enhanceOne(project, sequence, entry, {fs, binary, request, say, sleep, check, outputFolder, preset, rate, channels, intensity, context}));
    } catch (error) {
      results.push({name: entry.name, error: error.message});
    }
  }
  const succeeded = results.filter(r => !r.error).length;
  return {clips: results.length, succeeded, failed: results.length - succeeded, results};
}

module.exports = {run};
