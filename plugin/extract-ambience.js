// Standalone: extracts an Ambience/background stem for every eligible clip
// currently selected on the active sequence, and ADDS it as a new clip on a
// dedicated "Ambience" track below the existing tracks -- the raw clip and
// every other track are left completely untouched (no mute, no overwrite,
// no disable). Deliberately independent of any WTV clone/context, same as
// lowend.js: works on whatever is selected, on any sequence, regardless of
// Clean dialogue workflow state. Mirrors lowend.js's per-clip
// render/isolate/export pipeline closely (see that file for the reasoning
// behind each step), but calls the async job API instead of a synchronous
// endpoint -- ambience separation is a model job, not local DSP -- and adds
// a clip instead of replacing one. Overlapping selections use separate lanes,
// and all existing clips are checked after each placement. Follows the same
// insert-then-overwrite pattern per-clip.js's apply() uses for a new stem
// lane (first clip on a brand-new track: insert, which grows the sequence
// by one track; every later clip on that same lane: overwrite).
const ppro = require('premierepro');
const host = require('./premiere.js');
const safeSequences = async project => host.listSequences ? host.listSequences(project) : ((await project.getSequences()) || []).filter(s => s && s.guid);
const {inventory} = require('./per-clip.js');
const {waitForStableWavFile, inspectWav} = require('./wav.js');
const {getWavPreset} = require('./export-presets.js');
const {exportSequenceWithRenderWait} = require('./export-sync.js');
const id = sequence => sequence.guid.toString();
const pathKey = path => path.replace(/\\/g, '/').toLowerCase();

// What this pipeline produces. The default is Extract ambience; Restore Speech
// (restore-speech.js) passes its own kind and reuses the same render /
// upload / job / place pipeline, fetching the service's dialogue stem instead
// of effects. Every Extract ambience string below is unchanged.
const AMBIENCE_KIND = {
  action: 'Extract ambience', gerund: 'extracting ambience', process: 'ambience extraction', Process: 'Ambience extraction',
  noun: 'ambience', result: 'ambience', resultClip: 'extracted ambience', title: 'Ambience', uploadFor: 'ambience separation',
  track: 'Ambience', clipSuffix: ' · Ambience', renderName: 'WTV_AMBIENCE_RENDER', filePrefix: 'ambience', stem: 'effects',
};

async function snapshot(sequence, count) {
  const result = [];
  const all = await inventory(sequence);
  for (let index = 0; index < count; index++) {
    for (const entry of all.filter(e => e.trackIndex === index)) {
      result.push([index, entry.sourceId, entry.start.ticks, entry.end.ticks, entry.enabled, entry.muted]);
    }
  }
  return JSON.stringify(result);
}

// Every currently-selected clip on the sequence's audio tracks, whether or
// not it is actually eligible (checked per-clip in extractOne() below, so an
// ineligible selected clip is reported with a clear reason, not silently
// skipped).
async function selectedClips(sequence) {
  const all = await inventory(sequence);
  const selected = [];
  for (const entry of all) if (await entry.item.getIsSelected()) selected.push(entry);
  return selected;
}

async function extractOne(project, sequence, entry, {fs, binary, request, say, sleep, check, outputFolder, preset, rate, channels, settings, destinationTrack, kind: K = AMBIENCE_KIND}) {
  if (!entry.enabled) throw new Error('Clip is disabled.');
  if (entry.muted) throw new Error('Clip is on a muted track.');
  if (entry.transitions) throw new Error(`Remove audio transitions on this track before ${K.gerund}.`);
  if (await entry.item.getSpeed() !== 1 || await entry.item.isSpeedReversed()) throw new Error(`${K.action} currently requires a normal-speed, forward clip.`);
  if (K.preflight) await K.preflight(entry);

  const count = await sequence.getAudioTrackCount();
  const before = await snapshot(sequence, count);
  say(`Rendering "${entry.name}" for ${K.process}...`);

  const beforeSequences = new Set((await safeSequences(project)).map(id));
  const beforeItems=await host.snapshotProjectItems(project);
  host.transaction(project, `WTV: prepare ${K.noun} render`, c => c.addAction(sequence.createCloneAction()));
  const render=await host.identifyNewSequence(project,beforeSequences,[id(sequence)],`${K.noun} render sequence`,beforeItems);
  if (id(sequence) === id(render)) throw new Error(`Invalid ${K.noun} render sequence.`);
  let renderDeleted = false, exportStarted=false, exportVerified=false;
  let scratchFile = null;
  let assetId = null;
  let jobId = null;
  try {
    const all = await inventory(render);
    const target = all.find(c => c.trackIndex === entry.trackIndex && c.index === entry.index && c.sourceId === entry.sourceId
      && c.start.ticks === entry.start.ticks && c.end.ticks === entry.end.ticks);
    if (!target || !target.enabled) throw new Error('The clip changed while preparing its render.');
    const item = await render.getProjectItem();
    host.transaction(project, `WTV: isolate ${K.noun} clip`, compound => {
      compound.addAction(item.createSetNameAction(K.renderName));
      for (const e of all) compound.addAction(e.item.createSetDisabledAction(e !== target));
      compound.addAction(render.createSetInPointAction(target.start));
      compound.addAction(render.createSetOutPointAction(target.end));
    });
    if (target.muted) {
      const track = await render.getAudioTrack(target.trackIndex);
      if (!await track.setMute(false)) throw new Error('Could not unmute the render for this clip.');
    }
    // Random suffix (like deplosive.js's/lowend.js's) avoids collisions
    // across fast back-to-back clips in the same batch.
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = await outputFolder.createFile(`${K.filePrefix}-render-${entry.trackIndex}-${entry.index}-${unique}.wav`, {overwrite: false});
    scratchFile = file;
    const manager = await ppro.EncoderManager.getManager();
    const expected = {rate, channels, duration: target.duration};
    exportStarted=true;
    const renderWait = await exportSequenceWithRenderWait({
      ppro, manager, sequence: render,
      exportType: ppro.Constants.ExportType.IMMEDIATELY,
      outputFile: file.nativePath, presetFile: preset.nativePath, exportFull: false,
      outputNativePath: file.nativePath, check, sleep,
      rejectedMessage: `Premiere did not accept the ${K.noun} export.`,
      verifyOutput: async ({check:verifyCheck})=>{
        await waitForStableWavFile(file,expected,{check:verifyCheck,sleep,pollIntervalMs:200});
        exportVerified=true;
      },
    });
    check();
    // Read the verified WAV once for upload, rather than on every poll.
    const bytes=await file.read({format:binary});
    inspectWav(bytes,expected);
    exportVerified=true;
    check();
    try { renderDeleted = await project.deleteSequence(render); } catch (_) { /* Harmless render clone retained. */ }

    say(`Uploading "${entry.name}" for ${K.uploadFor}...`);
    const asset = await (await request('/v1/assets', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: bytes})).json();
    assetId = asset.asset_id;
    const submitted = await (await request('/v1/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tracks: [{asset_id: asset.asset_id, role: 'mixture'}], settings})})).json();
    if (submitted.reused) { try { await request(`/v1/assets/${assetId}`, {method: 'DELETE'}); } catch (_) {} assetId = null; }
    jobId = submitted.job_id;
    let result;
    while (true) {
      check();
      const job = await (await request(`/v1/jobs/${jobId}`)).json();
      say(`${K.title} · "${entry.name}" · ${job.stage} · ${job.progress}%`);
      if (job.status === 'done') { result = job.result; break; }
      if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error ? job.error.message : `${K.Process} cancelled.`);
      await sleep(1000);
    }
    if (!result || result.sample_rate !== rate || result.channels !== channels || Math.abs(result.samples / rate - target.duration) > 1 / rate) {
      throw new Error('Processed clip duration or format changed.');
    }

    say(`Downloading ${K.result} for "${entry.name}"...`);
    const outBytes = await (await request(`/v1/jobs/${jobId}/result/${K.stem}`)).arrayBuffer();
    inspectWav(outBytes, expected);
    const outFile = await outputFolder.createFile(`${K.filePrefix}-${entry.trackIndex}-${entry.index}-${unique}.wav`, {overwrite: false});
    await outFile.write(outBytes, {format: binary});
    try { await scratchFile.delete(); scratchFile = null; } catch (_) {}

    check();
    const active=await project.getActiveSequence();
    if(!active || id(active)!==id(sequence)) {const error=new Error('Active sequence changed. Batch stopped before placement.');error.fatal=true;throw error;}
    if (before !== await snapshot(sequence, count)) {const error=new Error(`Timeline changed during ${K.process}. Batch stopped before placement.`);error.fatal=true;throw error;}
    say(`Placing ${K.result} for "${entry.name}"...`);
    const {added} = await host.importIntoBin(project, [outFile.nativePath], `Could not import the ${K.resultClip} clip.`);
    let imported;
    for (const candidate of added) {
      const clip = host.clipProjectItem(candidate);
      if (clip && pathKey(await clip.getMediaFilePath()) === pathKey(outFile.nativePath)) imported = {item: candidate, clip};
    }
    if (!imported) throw new Error(`Could not identify the imported ${K.noun} clip; timeline unchanged.`);
    const newName = `${entry.name}${K.clipSuffix}`;
    host.transaction(project, `WTV: name ${K.noun} clip`, c => c.addAction(imported.item.createSetNameAction(newName)));

    const beforeInsert = [...await inventory(sequence)];
    let mutationAttempted = false;
    try {
      const existing=beforeInsert.filter(c=>c.trackIndex===destinationTrack.index);
      if(existing.some(c=>c.start.seconds<entry.end.seconds && c.end.seconds>entry.start.seconds))throw new Error(`${K.track} destination is occupied.`);
      const editor = ppro.SequenceEditor.getEditor(sequence);
      mutationAttempted=true;
      if (!destinationTrack.created) {
        // First clip on the new track: insert, which grows the sequence by
        // one track. Every later clip on this run reuses the same track via
        // overwrite, never re-inserting (matches per-clip.js apply()).
        host.transaction(project, `WTV: add ${K.noun} track`, c => c.addAction(editor.createInsertProjectItemAction(imported.item, entry.start, -1, destinationTrack.index, true)));
        destinationTrack.created = true;
        const track = await sequence.getAudioTrack(destinationTrack.index);
        if (!host.tryNameTrack(project, track, K.track)) destinationTrack.defaultName = true;
      } else {
        host.transaction(project, `WTV: place ${K.noun} clip`, c => c.addAction(editor.createOverwriteItemAction(imported.item, entry.start, -1, destinationTrack.index)));
      }

      const after = await inventory(sequence);
      const ticksPerSample = Math.round(254016000000 / rate);
      const match = after.find(c => c.trackIndex === destinationTrack.index && c.sourceId === imported.item.getId() && c.enabled
        && Math.abs(Number(c.start.ticks) - Number(entry.start.ticks)) <= ticksPerSample * 4
        && Math.abs(Number(c.end.ticks)-Number(entry.end.ticks)) <= ticksPerSample * 4);
      if (!match) throw new Error(`Could not verify the ${K.noun} placement.`);
      const untouchedBefore = beforeInsert.map(c => [c.trackIndex, c.sourceId, c.start.ticks, c.end.ticks, c.enabled, c.muted]);
      const untouchedAfter = after.filter(c => c !== match).map(c => [c.trackIndex, c.sourceId, c.start.ticks, c.end.ticks, c.enabled, c.muted]);
      if (JSON.stringify(untouchedBefore) !== JSON.stringify(untouchedAfter)) throw new Error(`Clips outside the ${K.noun} track changed unexpectedly.`);
    } catch (error) {
      if(mutationAttempted) {
        let muted=false;
        try{muted=await (await sequence.getAudioTrack(destinationTrack.index)).setMute(true);}catch(_){}
        const failure=new Error(`${error.message} Batch stopped after a placement failure. ${muted?`Affected ${K.track} track muted.`:'Inspect audio tracks before playback.'} Use Undo to inspect/revert the latest insertion.`);
        failure.fatal=true;throw failure;
      }
      throw error;
    }
    return {name: entry.name, output_path: outFile.nativePath, exportWait: renderWait.mode, source: {trackIndex: entry.trackIndex, start: entry.start, end: entry.end, name: entry.name}, ...result};
  } finally {
    if ((!exportStarted || exportVerified) && !renderDeleted) { try { await project.deleteSequence(render); } catch (_) {} }
    if ((!exportStarted || exportVerified) && scratchFile) { try { await scratchFile.delete(); } catch (_) {} }
    // Only an upload that never reached a job is removed here. Once a job uses it the
    // service keeps it (DELETE would answer 409) and its age-based cleanup removes it.
    if (assetId && !jobId) { try { await request(`/v1/assets/${assetId}`, {method: 'DELETE'}); } catch (_) {} }
    if (jobId) { try { await request(`/v1/jobs/${jobId}`, {method: 'DELETE'}); } catch (_) {} }
  }
}

async function run({fs, binary, request, check, say, sleep, outputFolder, settings, kind = AMBIENCE_KIND}) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  const seqSettings = await sequence.getSettings();
  const rate = Math.round((await seqSettings.getAudioSampleRate()).value);
  const channels = await seqSettings.getAudioChannelCount();
  if (![1, 2].includes(channels) || ![44100, 48000, 96000].includes(rate)) throw new Error('This preview supports mono/stereo sequences at 44.1, 48 or 96 kHz.');
  const preset = await getWavPreset(fs, {rate, channels});

  const selected = await selectedClips(sequence);
  if (!selected.length) throw new Error(`Select one or more audio clips on the timeline before ${kind.gerund}.`);

  const lanes=[];
  // Caller's settings don't know the active sequence's rate (there's no
  // big WTV session here to carry it); set it here instead of asking the
  // caller to guess.
  const jobSettings = {...settings, output_rate: rate};
  const results = [];
  // Any error leaving the batch (fatal placement failure or Cancel) carries
  // the clips already placed, so restore-speech.js can still mute their
  // originals.
  try {
  for (const entry of selected) {
    check();
    let destinationTrack=lanes.find(lane=>lane.spans.every(span=>entry.end.seconds<=span[0] || entry.start.seconds>=span[1]));
    if(!destinationTrack){destinationTrack={index:await sequence.getAudioTrackCount(),created:false,spans:[]};lanes.push(destinationTrack);}
    try {
      results.push(await extractOne(project, sequence, entry, {fs, binary, request, say, sleep, check, outputFolder, preset, rate, channels, settings: jobSettings, destinationTrack, kind}));
      destinationTrack.spans.push([entry.start.seconds,entry.end.seconds]);
    } catch (error) {
      if(error.fatal)throw error;
      check();
      results.push({name: entry.name, error: error.message});
      if(!destinationTrack.created)lanes.splice(lanes.indexOf(destinationTrack),1);
    }
  }
  } catch (error) { if (!Array.isArray(error.results)) error.results = results; throw error; }
  const succeeded = results.filter(r => !r.error).length;
  return {clips: results.length, succeeded, failed: results.length - succeeded, results, trackAdded: lanes.some(lane=>lane.created)};
}

module.exports = {run, AMBIENCE_KIND};
