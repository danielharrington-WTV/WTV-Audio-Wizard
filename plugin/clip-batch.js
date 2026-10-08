const {inspectWav} = require('./wav.js');

function manifest(context, state) {
  return {version: 1, mode: 'per_clip', state, sequence: context.name, original_sequence_id: context.originalId,
    sample_rate: context.rate, channels: context.channels, output_stems: context.outputStems || ['dialogue'], linking: 'manual', settings: context.batchSettings || null,
    crossfades: context.crossfadePlan || [],
    clips: context.clips.map(c => ({id: c.id, name: c.name, source_id: c.sourceId, track_index: c.trackIndex,
      export_identity: c.exportIdentity || null, handles: c.handles || null, media_in_ticks: c.mediaInTicks || "0", visible_duration_ticks: c.outTicks, start_ticks: c.start.ticks, end_ticks: c.end.ticks, export_start_ticks: c.exportStartTicks ?? c.start.ticks, export_end_ticks: c.exportEndTicks ?? c.end.ticks, input: c.inputFile ? c.inputFile.nativePath : null,
      dialogue_stage: c.dialogueStage || null, job_id: c.jobId || null, outputs: c.outputs ? Object.fromEntries(Object.entries(c.outputs).map(([key, value]) => [key, value.path])) : null, result: c.result || null}))};
}

async function saveManifest(context, state) {
  // overwrite: the export folder is reused across runs now (see main.js clipsFolder).
  if (!context.manifestFile) context.manifestFile = await context.folder.createFile('clip-batch.json', {overwrite: true});
  await context.manifestFile.write(JSON.stringify(manifest(context, state), null, 2));
}

// Stem file names are derived from the clip id, so re-processing a clip whose
// previous stem is already imported and placed on the timeline targets a file
// Premiere holds open. Windows then refuses the overwrite ("resource busy or
// locked"). Fall back to a uniquely suffixed name instead; the manifest records
// the real path, so reuse and Apply follow it.
async function writeStem(folder, name, bytes, binary) {
  try {
    const file = await folder.createFile(name, {overwrite: true});
    await file.write(bytes, {format: binary});
    return file;
  } catch (error) {
    if (!/busy|locked|in use|EBUSY|EPERM|EACCES|denied/i.test(String(error && error.message || error))) throw error;
    const alternate = name.replace(/\.wav$/i, `-${Date.now().toString(36)}.wav`);
    const file = await folder.createFile(alternate, {overwrite: false});
    await file.write(bytes, {format: binary});
    return file;
  }
}

// Cache only native dialogue inference; final jobs retain the existing joint finishing.
// Both passes upload/use clip.inputFile (raw), never a processed dialogue stem.
async function prepareDialogueBatch(context, settings, hooks) {
  const {request,binary,check,onJob,onProgress,say,sleep,prefetch}=hooks;
  const health=await (await request('/v1/health')).json();
  if (!health.capabilities?.includes('grouped_model_batch_v1')) throw Error('Restart the updated service to use grouped dialogue and stem processing.');
  const assets=new Map();
  const cleanSettings={...settings,separate_ambience:false,separate_music:false};
  for(let index=0;index<context.clips.length;index++) {
    const clip=context.clips[index];check();onJob(null);
    onProgress?.({phase:'dialogue',clipIndex:index,clipCount:context.clips.length});
    say(`Dialogue pass ${index+1}/${context.clips.length} - ${clip.name}`);
    // Interleaved batch (prefetch.js): this clip may already be uploaded and its
    // dialogue job started while later clips were exporting.
    const early=prefetch?.take(clip.id);
    let asset=early&&early.kind==='dialogue'?early.asset:null;
    if(!asset) {
      const bytes=await clip.inputFile.read({format:binary});check();
      asset=await (await request('/v1/assets',{method:'POST',headers:{'Content-Type':'audio/wav'},body:bytes})).json();
    }
    if(asset.sample_rate!==context.rate || asset.channels!==context.channels || Math.abs(asset.samples/asset.sample_rate-(clip.exportDuration??clip.duration))>1/context.rate) throw Error('Service read a different clip format or duration.');
    assets.set(clip.id,asset);check();
    const submitStage=async()=>(await (await request('/v1/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage_mode:'dialogue_cache',tracks:[{asset_id:asset.asset_id,role:'mixture'}],settings:cleanSettings})})).json()).job_id;
    // An early job that failed, was cancelled or is unknown to the service is replaced once.
    let early_job=early&&early.kind==='dialogue'&&early.jobId?early.jobId:null;
    let stageJobId=early_job||await submitStage();
    onJob(stageJobId);
    clip.dialogueStage={job_id:stageJobId,state:'processing'};
    const deadline=Date.now()+90*60*1000;
    let job;
    try {
      while(true) {
        check();
        try { job=await (await request(`/v1/jobs/${stageJobId}`)).json(); }
        catch(error) { if(!early_job) throw error; job={status:'failed'}; }
        if(early_job&&['failed','cancelled'].includes(job.status)) {
          early_job=null;stageJobId=await submitStage();onJob(stageJobId);clip.dialogueStage={job_id:stageJobId,state:'processing'};continue;
        }
        onProgress?.({phase:'dialogue',clipIndex:index,clipCount:context.clips.length,jobProgress:job.progress});
        if(job.status==='done')break;
        if(['failed','cancelled'].includes(job.status))throw Error(job.error?.message||'Dialogue pass cancelled.');
        if(Date.now()>deadline)throw Error('Dialogue pass timed out after 90 minutes.');
        await sleep(1000);
      }
      check();
    } catch(error) {try{await request(`/v1/jobs/${stageJobId}`,{method:'DELETE'});}catch(_){}throw error;}
    const result=job.result;
    if(!result || result.sample_rate!==context.rate || result.channels!==context.channels || Math.abs(result.samples/context.rate-(clip.exportDuration??clip.duration))>1/context.rate)throw Error('Cached dialogue format or duration changed.');
    clip.dialogueStage={job_id:stageJobId,state:'cached',timings:result.timings||null,cache_hit:Boolean(result.stage_cache?.dialogue)};
    await saveManifest(context,'dialogue_caching');
    onProgress?.({phase:'dialogue',clipIndex:index,clipCount:context.clips.length,done:true,reused:Boolean(result.stage_cache?.dialogue)});
  }
  onJob(null);return assets;
}

async function processBatch(context, settings, {request, binary, check, onJob, onProgress, say, sleep, prefetch = null}) {
  // exportDuration is the exported WAV's length, which for an off-grid clip
  // runs one frame past the timeline span (see per-clip.js placementGeometry);
  // the service preserves the sample count, so every stem shares it.
  const wavDuration = clip => clip.exportDuration ?? clip.duration;
  const expected = clip => ({rate: context.rate, channels: context.channels, duration: wavDuration(clip)});
  // Validate the complete batch first, so one unfinished export doesn't start
  // a long series of model jobs before the missing file is discovered.
  for (const clip of context.clips) {
    check();
    inspectWav(await clip.inputFile.read({format: binary}), expected(clip));
  }
  context.outputStems = ['dialogue'].concat(settings.separate_ambience ? ['effects'] : [], settings.separate_music ? ['music'] : []);
  context.batchSettings = JSON.parse(JSON.stringify(settings));
  await saveManifest(context, 'processing');
  // Reuse: a previous run in the same folder (clip-batch.json) processed
  // this exact clip id with these exact settings, and its stem files still
  // validate -- skip upload and job entirely. `context.reuse` is set by
  // main.js from the folder's manifest at Prepare time.
  const reusable = context.reuse && context.reuse.settings === JSON.stringify(settings) ? context.reuse.clips : null;
  const grouped = ['gap_urgenet','mossformer2'].includes(settings.enhancer) && (settings.separate_ambience || settings.separate_music);
  const assets = grouped ? await prepareDialogueBatch(context,settings,{request,binary,check,onJob,onProgress,say,sleep,prefetch}) : null;
  if(grouped) {
    const emit=onProgress;
    onProgress=e=>emit?.({...e,phase:'stems'});
    say('Dialogue pass complete. Extracting stems from raw audio and finishing clips.');
  }
  let reused = 0;
  for (let index = 0; index < context.clips.length; index++) {
    const clip = context.clips[index];
    check(); onJob(null);
    onProgress?.({clipIndex: index, clipCount: context.clips.length});
    const previous = reusable && reusable[clip.id];
    if (previous && (!clip.handles || previous.export_identity === clip.exportIdentity) && previous.result && previous.outputs && (context.outputStems || ['dialogue']).every(stem => previous.outputs[stem])) {
      let ok = true;
      const outputs = {};
      for (const stem of context.outputStems || ['dialogue']) {
        try {
          // Use the file name the manifest recorded: a locked earlier file may have been
          // superseded by a suffixed copy (see writeStem).
          const recorded = String(previous.outputs[stem]).split(/[\\/]/).pop();
          const file = await context.folder.getEntry(recorded || `${clip.id}-${stem}.wav`);
          inspectWav(await file.read({format: binary}), expected(clip));
          outputs[stem] = {path: file.nativePath, file};
        } catch (_) { ok = false; break; }
      }
      const r = previous.result;
      if (ok && r.sample_rate === context.rate && r.channels === context.channels && Math.abs(r.samples / context.rate - wavDuration(clip)) <= 1 / context.rate) {
        clip.outputs = outputs; clip.result = r; clip.jobId = previous.job_id || null; reused++;
        say(`Clip ${index + 1}/${context.clips.length} · ${clip.name} · reused previous result`);
        onProgress?.({clipIndex:index,clipCount:context.clips.length,done:true,reused:true});
        continue;
      }
    }
    // Interleaved batch (prefetch.js): the upload, and usually the job, were
    // started while later clips were exporting. Submitting the same job again
    // returns that job (the service matches on content and settings), so one
    // code path collects both early and normal clips.
    const early = grouped ? null : prefetch?.take(clip.id);
    const earlyAsset = early && early.kind === 'final' ? early.asset : null;
    say(`Clip ${index + 1}/${context.clips.length} · ${clip.name} · ${earlyAsset ? 'collecting' : 'uploading'}`);
    const bytes = await clip.inputFile.read({format: binary});
    inspectWav(bytes, expected(clip));
    check();
    const asset = assets?.get(clip.id) || earlyAsset || await (await request('/v1/assets', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: bytes})).json();
    if (asset.sample_rate !== context.rate || asset.channels !== context.channels || Math.abs(asset.samples / asset.sample_rate - wavDuration(clip)) > 1 / context.rate) throw new Error('Service read a different clip format or duration.');
    check();
    const submitted = await (await request('/v1/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tracks: [{asset_id: asset.asset_id, role: 'mixture'}], settings, ...(grouped ? {require_dialogue_cache:true} : {})})})).json();
    // A reused job means this upload is a spare copy; an early upload is the job's own input.
    if (submitted.reused && !earlyAsset) { try { await request(`/v1/assets/${asset.asset_id}`, {method: 'DELETE'}); } catch (_) {} }
    clip.jobId = submitted.job_id;
    onJob(clip.jobId);
    // Cancellation may arrive while submission is in flight.
    try { check(); } catch (error) { await request(`/v1/jobs/${clip.jobId}`, {method: 'DELETE'}); throw error; }
    const deadline = Date.now() + 90 * 60 * 1000;
    while (true) {
      check();
      const job = await (await request(`/v1/jobs/${clip.jobId}`)).json();
      onProgress?.({clipIndex: index, clipCount: context.clips.length, jobProgress: job.progress});
      say(`Clip ${index + 1}/${context.clips.length} · ${clip.name} · ${job.stage} · ${job.progress}%`);
      if (job.status === 'done') { clip.result = job.result; break; }
      if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error ? job.error.message : 'Clip processing cancelled.');
      if (Date.now() > deadline) {
        await request(`/v1/jobs/${clip.jobId}`, {method: 'DELETE'});
        throw new Error('Clip processing timed out after 90 minutes.');
      }
      await sleep(1000);
    }
    check();
    if (!clip.result || clip.result.sample_rate !== context.rate || clip.result.channels !== context.channels || Math.abs(clip.result.samples / context.rate - wavDuration(clip)) > 1 / context.rate) throw new Error('Processed clip duration or format changed.');
    clip.outputs = {};
    for (const stem of context.outputStems || ['dialogue']) {
    const output = await (await request(`/v1/jobs/${clip.jobId}/result/${stem}`)).arrayBuffer();
    inspectWav(output, expected(clip));
    check();
    const file = await writeStem(context.folder, `${clip.id}-${stem}.wav`, output, binary);
    clip.outputs[stem] = {path: file.nativePath, file};
    }
    await saveManifest(context, 'processing');
    onProgress?.({clipIndex:index,clipCount:context.clips.length,done:true,reused:Boolean(submitted.reused)});
  }
  onJob(null);
  context.reusedResults = reused;
  await saveManifest(context, 'ready');
}

// DORMANT since 0.6.2: no longer required/called by main.js (De-click &
// de-ess dialogue was removed from the panel UI -- see README.md and
// tests/test_deess_real_audio.py). Left in place, still covered by
// tests/clip-batch.test.cjs, for a future revival.
//
// Each clip's rendered WAV starts at local time 0, aligned with that clip's
// clip.start on the timeline (media in-point is zero; see PER-CLIP-MODE.md).
// So a repair reported at repair.start_seconds inside a clip maps to
// clip.start.seconds + repair.start_seconds on the timeline.
function clickPopEvents(context) {
  const events = [];
  for (const clip of context.clips) {
    const repairs = clip.result && clip.result.deess_declick && clip.result.deess_declick.repairs;
    if (!repairs) continue;
    for (const repair of repairs) {
      events.push({timeline_seconds: (clip.exportStartTicks == null ? clip.start.seconds : Number(clip.exportStartTicks)/254016000000) + repair.start_seconds, clip_name: clip.name,
        track_index: clip.trackIndex, duration_seconds: repair.duration_seconds, channels: repair.channels});
    }
  }
  events.sort((a, b) => a.timeline_seconds - b.timeline_seconds);
  return events;
}

// With `io` (node-style fs, as main.js passes), only the WAV header is read
// per stem instead of the whole file -- 158 full reads made Add clean tracks
// look frozen on a large batch (2026-09-17). Without `io`, falls back to
// reading the file object (tests / hosts without fs).
async function validateOutputs(context, binary, {io = null, say = () => {}} = {}) {
  const {header} = require('./music-wav.js');
  const total = context.clips.length;
  for (let i = 0; i < total; i++) {
    const clip = context.clips[i];
    if (i % 25 === 0) say(`Add clean tracks: validating outputs ${i + 1}/${total}…`);
    for (const stem of context.outputStems || ['dialogue']) {
      const output = clip.outputs && clip.outputs[stem];
      if (!output || !output.file) throw new Error('A processed stem file is missing. Retry processing.');
      const expected = {rate: context.rate, channels: context.channels, duration: clip.exportDuration ?? clip.duration};
      if (io && output.file.nativePath) {
        let fd;
        try {
          const stat = await io.lstat(output.file.nativePath);
          fd = await io.open(output.file.nativePath, 'r');
          await header(io, fd, stat.size, expected);
        } catch (error) { throw new Error(`Processed stem “${clip.name}” (${stem}) is missing or does not match: ${error.message}. Retry processing.`); }
        finally { if (fd !== undefined) { try { await io.close(fd); } catch (_) {} } }
      } else inspectWav(await output.file.read({format: binary}), expected);
    }
  }
}

module.exports = {processBatch, saveManifest, validateOutputs, clickPopEvents};
