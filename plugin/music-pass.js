const ppro=require('premierepro');
const host=require('./premiere.js');
const safeSequences=async project=>host.listSequences ? host.listSequences(project) : ((await project.getSequences())||[]).filter(s=>s && s.guid);
const {inventory}=require('./per-clip.js');
const effects=require('./music-effects.js');
const {readSummary}=require('./music-wav.js');
const {analyze}=require('./music-analysis.js');
const {getWavPreset}=require('./export-presets.js');
const {exportSequenceWithRenderWait}=require('./export-sync.js');
const analysisCache=require('./music-analysis-cache.js');
const {buildFingerprint, analysisSettingsForCache, load: loadAnalysisCache, save: saveAnalysisCache}=analysisCache;
const id=sequence=>sequence.guid.toString();
const KEYFRAME_BATCH_KEY_LIMIT=500;
function keyCount(prepared) {
  return prepared.curve.length*prepared.parameters.length;
}
function createTimingRecorder() {
  const started=Date.now();
  const phases={};
  let guardSeconds=0;
  return {
    phases,
    renders:{},
    mark(name) {
      const t0=Date.now();
      return () => { phases[name]=(phases[name]||0)+(Date.now()-t0)/1000; };
    },
    addGuard(seconds) { guardSeconds+=seconds; },
    finish(meta) {
      if (guardSeconds) phases.guard_unchanged=(phases.guard_unchanged||0)+guardSeconds;
      return {wall_seconds:(Date.now()-started)/1000, phases, renders:this.renders, ...meta};
    },
  };
}
function formatMusicPassTimingReport(timing) {
  if (!timing) return '';
  const parts=[`wall ${formatDuration(timing.wall_seconds)}`];
  for (const name of ['collect','reconcile','prep','volume_strip','render_dialogue','analyze','apply_effects','apply_configure','apply_keyframes','apply_verify','guard_unchanged']) {
    if (Number.isFinite(timing.phases?.[name]) && timing.phases[name]>0.05) parts.push(`${name} ${formatDuration(timing.phases[name])}`);
  }
  return parts.join(' \u00b7 ');
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '\u2014';
  const total=Math.round(seconds);
  const h=Math.floor(total/3600), m=Math.floor((total%3600)/60), s=total%60;
  if (h>0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  if (m>0) return `${m}:${String(s).padStart(2,'0')}`;
  return `${s}s`;
}
// Explicit choices follow track IDs, not track positions. Clean mode follows
// inserted media paths, including replacement media recorded by pop repair.
const pathKey=path=>path.replace(/\\/g,'/').toLowerCase();
function parseIdentity(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}
// Stored records may use the legacy 5-tuple (includes per-track item index) or
// the current 4-tuple (track, source, source in/out only). Index drift on a
// track must not block an otherwise identical music rerun.
function identityMatches(storedRaw, clip) {
  if (storedRaw === clip.identity) return true;
  const stored=parseIdentity(storedRaw), current=parseIdentity(clip.identity);
  if (!stored || !current) return false;
  if (stored.length === 5 && current.length === 4) {
    return stored[0] === current[0] && stored[2] === current[1]
      && stored[3] === current[2] && stored[4] === current[3];
  }
  if (stored.length === 4 && current.length === 4) {
    return stored.every((value, index) => value === current[index]);
  }
  return false;
}
function findPreviousClipRecord(previous, clip) {
  return previous?.clips.find(record => identityMatches(record.identity, clip)) ?? null;
}
function recordedOwnedMatchName(record) {
  try { return JSON.parse(record.after)[record.effectIndex]?.[0]; } catch (_) { return null; }
}
async function ownedComponent(chain, record) {
  if (!record) return null;
  const expectedName=recordedOwnedMatchName(record);
  const count=await chain.getComponentCount();
  if (expectedName) {
    for (let i=0;i<count;i++) {
      const component=await chain.getComponentAtIndex(i);
      if (await component.getMatchName()===expectedName) return component;
    }
    // A different effect at the old index is not ours to replace.
    return null;
  }
  if (record.effectIndex>=0 && record.effectIndex<count) return chain.getComponentAtIndex(record.effectIndex);
  return null;
}
async function reconcilePreviousPass(previous, sequence, selectedMusic) {
  if (!previous?.clips?.length) return null;
  const entries=await inventory(sequence);
  const described=[];
  for (const entry of entries) described.push(await describe(entry));
  const selected=new Set(selectedMusic.map(clip => clip.identity));
  const clips=[];
  for (const record of previous.clips) {
    const clip=described.find(entry => identityMatches(record.identity, entry));
    if (!clip) continue;
    if (await ownedComponent(clip.chain, record)) clips.push(record);
    else if (selected.has(clip.identity)) clips.push(record);
  }
  if (!clips.length) return null;
  return {...previous, clips};
}
function normalizeReference(value) {
  if(!value) return {mode:'clean',trackIds:[]};
  if(!['clean','tracks'].includes(value.mode) || !Array.isArray(value.trackIds)
    || value.trackIds.some(v=>typeof v!=='string' || !v.length)) throw Error('Invalid dialogue track choice. Choose the dialogue reference again.');
  return {mode:value.mode,trackIds:[...new Set(value.trackIds)]};
}
const referenceKey=context=>`wtv-duck-reference-v1-${id(context.sequence)}`;
function loadReference(storage,context) {
  if(!context) return normalizeReference();
  try { return normalizeReference(JSON.parse(storage.getItem(referenceKey(context)))); }
  catch(_) { return normalizeReference(); }
}
function saveReference(storage,context,value) {
  storage.setItem(referenceKey(context),JSON.stringify(normalizeReference(value)));
}

// "Clean dialogue" used to mean only the exact media paths the CURRENT panel
// session inserted (context.dialoguePaths) -- so after a panel reload, an
// in-place run, a second batch, or an offline music-only session, the
// reference came up empty and Dan had to fall back to Choose tracks
// (2026-09-18). The inserted stems carry durable markers of their own:
// every WTV dialogue stem file is named `*-dialogue.wav` (per-clip and
// full-sequence alike) and the placed item is named "… · Clean dialogue · A#"
// (per-clip) or sits on a track named "Clean dialogue" (full sequence). Any
// of those identifies a clean stem regardless of which session made it.
const DIALOGUE_STEM_FILE=/-dialogue\.wav$/i, CLEAN_DIALOGUE_LABEL=/clean dialogue/i;
async function isCleanDialogueClip(entry,paths=new Set()) {
  let source=null;
  try { source=ppro.ClipProjectItem.cast(await entry.item.getProjectItem()); } catch(_) {}
  if(source) {
    let media=null;
    try { media=await source.getMediaFilePath(); } catch(_) {}
    if(media) {
      if(paths.has(pathKey(media))) return true;
      if(DIALOGUE_STEM_FILE.test(String(media).split(/[\\/]/).pop()||'')) return true;
    }
  }
  try { if(typeof entry.item.getName==='function' && CLEAN_DIALOGUE_LABEL.test(await entry.item.getName()||'')) return true; } catch(_) {}
  if(entry.trackName && CLEAN_DIALOGUE_LABEL.test(entry.trackName)) return true;
  return false;
}
async function reference(context,value) {
  if(!context || !context.applied || context.failedApply) throw Error('Open a sequence and choose dialogue tracks for music ducking.');
  const project=await ppro.Project.getActiveProject();
  const sequence=project && await project.getActiveSequence();
  if(!sequence || id(sequence)!==id(context.sequence) || id(sequence)===context.originalId) throw Error('Activate the sequence chosen for music ducking.');
  const choice=normalizeReference(value), all=await inventory(sequence), tracks=[];
  const count=await sequence.getAudioTrackCount();
  for(let index=0;index<count;index++) {
    const track=await sequence.getAudioTrack(index);
    tracks.push({id:track.id==null ? null : String(track.id),index,
      label:`A${index+1}${track.name ? ' \u00b7 '+track.name : ''}`,muted:await track.isMuted()});
  }
  const paths=new Set((context.dialoguePaths || []).map(pathKey));
  const requested=new Set(choice.trackIds), candidates=[];
  for(const entry of all) {
    if(choice.mode==='tracks') {
      if(requested.has(tracks[entry.trackIndex]?.id)) candidates.push(entry);
    } else if(await isCleanDialogueClip(entry,paths)) candidates.push(entry);
  }
  const dialogue=candidates.filter(e=>e.enabled && !e.muted);
  const used=new Set(dialogue.map(e=>e.trackIndex));
  const labels=tracks.filter(t=>choice.mode==='tracks' ? requested.has(t.id) : used.has(t.index)).map(t=>t.label);
  const label=(choice.mode==='clean' ? 'Clean dialogue' : 'Chosen tracks')+(labels.length ? ' \u00b7 '+labels.join(', ') : '');
  let error=null;
  if(choice.mode==='tracks') {
    if(!requested.size) error='Choose at least one dialogue track before running the music pass.';
    else if([...requested].some(key=>!tracks.some(t=>t.id===key))) error='A chosen dialogue track is no longer available. Choose tracks again.';
    else {
      const unavailable=tracks.filter(t=>requested.has(t.id) && !dialogue.some(e=>e.trackIndex===t.index));
      if(unavailable.length) error=`No enabled, unmuted dialogue on ${unavailable.map(t=>t.label).join(', ')}. Unmute and enable dialogue there, or change your track choice.`;
    }
  } else if(!dialogue.length) error='No enabled, unmuted Clean dialogue clips found. Make the inserted clean dialogue audible, or use Choose tracks.';
  return {project,sequence,all,tracks,candidates,dialogue,choice,label,error};
}

async function describe(entry) {
  const item=entry.item;
  let name=entry.sourceId || 'clip';
  try {
    if (typeof item.getName === 'function') name=await item.getName();
  } catch (_) { /* best-effort label for diagnostics */ }
  if (!entry.start?.ticks || !entry.end?.ticks) {
    throw Error(`Could not read timeline position for "${name}" (track A${entry.trackIndex + 1}). Save the project and retry the music pass.`);
  }
  const sourceIn=await item.getInPoint(), sourceOut=await item.getOutPoint();
  if (!sourceIn?.ticks || !sourceOut?.ticks) {
    throw Error(`Could not read source in/out for "${name}" (track A${entry.trackIndex + 1}). Replace offline clips or retry after saving the project.`);
  }
  const inPoint=sourceIn.seconds;
  const result={item,trackIndex:entry.trackIndex,index:entry.index,sourceId:entry.sourceId,
    start:entry.start.seconds,end:entry.end.seconds,inPoint, enabled:entry.enabled};
  result.key=JSON.stringify([entry.trackIndex,entry.index,entry.sourceId,entry.start.ticks,entry.end.ticks,sourceIn.ticks,sourceOut.ticks]);
  // Same as `key` but without timeline position (start/end ticks). Amplify's
  // keyframes are written in clip/source-relative time (see music-effects.js's
  // clipCurve(), anchored at clip.inPoint) -- moving a clip along the track
  // without retrimming it changes nothing about its own effect chain, and
  // every run already recomputes the duck curve fresh from the *current*
  // timeline anyway. So a clip that kept its source in/out points but moved
  // is still the "same clip" for rerun-continuity purposes; only a change to
  // which source media/frames are exposed (sourceId/sourceIn/sourceOut)
  // really invalidates the previous pass's ownership record.
  result.identity=JSON.stringify([entry.trackIndex,entry.sourceId,sourceIn.ticks,sourceOut.ticks]);
  result.chain=await item.getComponentChain();
  return result;
}

async function collect(context,choice) {
  const ref=await reference(context,choice);
  if(ref.error) throw Error(ref.error);
  const {project,sequence,all}=ref, music=[],dialogue=[];
  const candidates=new Set(ref.candidates), audible=new Set(ref.dialogue);
  for(const entry of all) {
    const selected=await entry.item.getIsSelected();
    if(selected && candidates.has(entry)) throw Error('Select only music clips; deselect clips used as the dialogue reference.');
    if(selected && (!entry.enabled || entry.muted)) throw Error('Unmute and enable the selected music clips before running this pass.');
    if(selected || audible.has(entry)) {
      if(await entry.item.getSpeed()!==1 || await entry.item.isSpeedReversed()) throw Error('The music pass currently requires normal-speed, forward music and dialogue clips.');
      // Transitions on a selected music clip are no longer rejected: every
      // render below isolates the selected/reference clips by disabling
      // every other clip, and a disabled sibling contributes silence across
      // the transition boundary -- exactly the right substitute for
      // isolating this clip's own audible envelope (including whatever fade
      // shape the transition itself gives it). The duck automation this pass
      // adds is a per-clip Amplify effect, which composes with an adjacent
      // transition the same way any per-clip effect always does in Premiere
      // (effects apply before a transition mixes its two sides) -- nothing
      // about a transition being present changes how that composition
      // works.
      const descriptor=await describe(entry);
      if(selected) music.push(descriptor); else dialogue.push(descriptor);
    }
  }
  if(!music.length) throw Error('Select the music clips to duck.');
  if(music.length>100) throw Error('Select at most 100 music clips.');
  return {project,sequence,music,dialogue,reference:{choice:ref.choice,label:ref.label},duration:(await sequence.getEndTime()).seconds};
}

// Place a span's 20 ms summary into a full-length, otherwise-silent summary
// starting at `offsetSeconds`, so downstream analysis sees timeline time.
function padSummary(summary,offsetSeconds,duration) {
  const blockSeconds=0.02, blockSize=Math.round(summary.rate*blockSeconds);
  const fullSamples=Math.round(duration*summary.rate), count=Math.ceil(fullSamples/blockSize);
  const offset=Math.round(offsetSeconds/blockSeconds);
  const levels=new Float64Array(count), peaks=new Float64Array(count);
  const n=Math.min(summary.levels.length,Math.max(0,count-offset));
  for(let i=0;i<n;i++){levels[offset+i]=summary.levels[i];peaks[offset+i]=summary.peaks[i];}
  return {...summary,levels,peaks,samples:fullSamples};
}
async function run(context, settings, {fs,binary,check,say,sleep,storage,onPlan=()=>{},dialogueReference,onReference=()=>{},onProgress=()=>{}}) {
  for(const [name,min,max] of [['duck_db',0,30],['attack_ms',10,1000],['release_ms',50,3000],['threshold_dbfs',-60,-15]]) {
    if(settings[name]!==undefined && (!Number.isFinite(settings[name]) || settings[name]<min || settings[name]>max)) throw Error(`${name} must be between ${min} and ${max}.`);
  }
  const stripClipVolume=settings.strip_clip_volume===true;
  const catalog={};
  const timer=createTimingRecorder();
  const exportWaitTally={events:0,poll:0};
  const noteExportWait=signal=>{if(signal?.mode==='events') exportWaitTally.events++; else exportWaitTally.poll++;};
  let endPhase=timer.mark('collect');
  const state=await collect(context,dialogueReference);
  endPhase();
  onReference(state.reference);
  say(`Duck against: ${state.reference.label}`);
  const {project,sequence,music,dialogue,duration}=state;
  if(!(duration>=.4)) throw Error('The music pass needs at least 0.4 seconds of sequence duration.');
  const ownershipKey=`wtv-music-v1-${id(sequence)}`;
  const saved=storage.getItem(ownershipKey);
  const parsed=saved ? JSON.parse(saved) : null;
  let previous=parsed;
  if(previous && previous.pending) throw Error('Previous music pass needs inspection. Undo it or use a fresh cleanup clone.');
  endPhase=timer.mark('reconcile');
  if (previous) {
    previous=await reconcilePreviousPass(previous, sequence, music);
    if (!previous) storage.removeItem(ownershipKey);
  }
  endPhase();
  const clipsUnchangedOnTimeline=previous ? previous.clips.filter(record => !music.some(clip => identityMatches(record.identity, clip))).length : 0;
  const clipsFresh=music.filter(clip => !findPreviousClipRecord(previous, clip)).length;
  const clipsUpdated=music.length-clipsFresh;
  const partialUpdate=clipsUnchangedOnTimeline>0;
  if (partialUpdate) {
    say(`Updating ${music.length} selected music clip(s); ${clipsUnchangedOnTimeline} other ducked clip(s) unchanged. Analysis uses only the current selection.`);
  } else if (previous && clipsFresh) {
    say(`Ducking ${music.length} selected clip(s); ${clipsFresh} new or retrimmed since the last pass.`);
  }
  if(previous && music.some(clip => {
    const record=findPreviousClipRecord(previous, clip);
    return record && record.key !== clip.key;
  })) say('Selected music moved since the previous pass; recomputing ducking at the new position.');
  endPhase=timer.mark('prep');
  const passSignature=await host.musicPassSignature(sequence,music,dialogue);
  const dialogueBefore=await Promise.all(dialogue.map(c=>effects.snapshot(c.chain)));
  // What the dialogue reference render actually depends on: the dialogue
  // lanes (clips, trims, mute) and the dialogue clips' effects -- NOT which
  // music clips are selected. Keying the analysis cache on the full pass
  // signature (music lanes included) meant ducking the whole sequence and
  // then one clip re-rendered the same 22 minutes of dialogue (2026-09-18,
  // "analysis_cache: miss" with an unchanged reference).
  const dialogueSignature=JSON.stringify([await host.musicPassSignature(sequence,[],dialogue),dialogueBefore]);
  async function refreshMusicChains() {
    const active=await project.getActiveSequence();
    if(!active || id(active)!==id(sequence)) throw Error('Timeline changed during music Apply.');
    const entries=await inventory(active);
    for(const clip of music) {
      const entry=entries.find(e=>e.trackIndex===clip.trackIndex && e.index===clip.index && e.sourceId===clip.sourceId);
      if(!entry) throw Error('Selected music clip disappeared during Apply.');
      const fresh=await describe(entry);
      if(fresh.key!==clip.key) throw Error('Selected music clip changed during Apply.');
      clip.item=fresh.item;clip.chain=fresh.chain;
    }
  }
  async function guardEffects() {
    for(let i=0;i<music.length;i++) if(music[i].before!==await effects.snapshot(music[i].chain)) throw Error('Music effects changed during analysis.');
    for(let i=0;i<dialogue.length;i++) if(dialogueBefore[i]!==await effects.snapshot(dialogue[i].chain)) throw Error('Dialogue effects changed during analysis.');
  }
  async function guardTimeline() {
    const active=await project.getActiveSequence();
    if(!active || id(active)!==id(sequence)) throw Error('Timeline changed during music analysis. No automation applied.');
    if(passSignature!==await host.musicPassSignature(sequence,music,dialogue)) throw Error('Timeline changed during music analysis. No automation applied.');
  }
  async function unchanged() {
    const t0=Date.now();
    check();
    await guardTimeline();
    await guardEffects();
    timer.addGuard((Date.now()-t0)/1000);
  }
  const folder=await (await fs.getTemporaryFolder()).createFolder(`wtv-music-${Date.now()}`);
  const preset=await getWavPreset(fs,context);
  const expected={rate:context.rate,channels:context.channels,duration};
  const analysisSettings=analysisSettingsForCache(settings);
  // Render only the part of the timeline the selected music actually spans
  // (plus attack/release/hold margin), not the whole sequence: ducking one
  // clip in a 22-minute edit used to export all 22 minutes of dialogue
  // reference on every dialogue change (2026-09-18). The exported span is
  // padded back to a full-length summary (silence outside), so analysis and
  // keyframe mapping are unchanged. Spans covering most of the sequence
  // just render the whole thing, and a whole-sequence cache entry serves any
  // later sub-span.
  const marginSeconds=1+((settings.attack_ms ?? 200)+(settings.release_ms ?? 1200)+200)/1000;
  const musicStart=Math.min(...music.map(c=>c.start)), musicEnd=Math.max(...music.map(c=>c.end)); // describe() stores plain seconds
  let span={start:Math.max(0,Math.floor(musicStart-marginSeconds)),end:Math.min(duration,Math.ceil(musicEnd+marginSeconds))};
  const fullSpan={start:0,end:duration};
  if(!(span.end>span.start) || (span.end-span.start)>=0.8*duration) span=fullSpan;
  const spanIsFull=span.start===0 && span.end===duration;
  const makeFingerprint=sp=>buildFingerprint({
    passSignature: JSON.stringify([dialogueSignature, sp.start===0 && sp.end===duration ? 'full' : [sp.start,sp.end]]),
    stripClipVolume,
    analysisSettings,
    dialogueReference,
    rate: context.rate,
    channels: context.channels,
    duration,
    presetPath: preset.nativePath,
  });
  const fingerprint=makeFingerprint(span), fullFingerprint=makeFingerprint(fullSpan);
  const progressStage = (label, percent) => onProgress({stage: label, percent: Math.max(0, Math.min(100, percent))});
  let analysisCacheResult='miss';
  let cachedSummaries=null;
  try { cachedSummaries=await loadAnalysisCache(fs, storage, fingerprint, expected); } catch (_) { cachedSummaries=null; }
  if(!cachedSummaries && !spanIsFull) { try { cachedSummaries=await loadAnalysisCache(fs, storage, fullFingerprint, expected); } catch (_) { cachedSummaries=null; } }
  async function removeClipVolumeBeforeAnalysis() {
    const backups=[];
    for (const clip of music) {
      const volumes=await effects.listVolumeComponents(clip.chain);
      if (volumes.length) backups.push({clip,volumes});
    }
    if (!backups.length) {
      for (let i=0;i<music.length;i++) music[i].before=await effects.snapshot(music[i].chain);
      return backups;
    }
    progressStage('Removing clip Volume', 2);
    host.transaction(project,'WTV: remove clip Volume before music ducking',compound=>{
      for (const {clip,volumes} of backups) effects.addRemoveVolumeActions(compound,clip.chain,volumes);
    });
    for (let i=0;i<music.length;i++) music[i].before=await effects.snapshot(music[i].chain);
    say(`Removed clip Volume on ${backups.length} selected music clip(s); ducking uses Amplify only. Premiere Undo can restore Volume separately from the duck pass.`);
    return backups;
  }
  let volumeBackups=[], restoreVolumeOnFailure=false;
  if (stripClipVolume) {
    const endVolume=timer.mark('volume_strip');
    volumeBackups=await removeClipVolumeBeforeAnalysis();
    endVolume();
    restoreVolumeOnFailure=volumeBackups.length>0;
  } else {
    for (let i=0;i<music.length;i++) music[i].before=await effects.snapshot(music[i].chain);
  }
  endPhase();
  for (let i=0;i<music.length;i++) {
    const record=findPreviousClipRecord(previous, music[i]);
    // Replace every Amplify on selected music, even without saved ownership.
    // Capture positions after optional Volume removal for exact rollback.
    music[i].amplifies=await effects.listAmplifyComponents(music[i].chain);
    const withoutAmplify=snapshot=>JSON.stringify(JSON.parse(snapshot).filter(row=>!/amplify/i.test(row[0] || '')));
    if(record && music[i].amplifies.length && withoutAmplify(record.after)!==withoutAmplify(music[i].before) && !stripClipVolume) throw Error('Music effects/keyframes were edited after the previous pass. They have been preserved; use a fresh clone to rebuild automation.');
  }
  async function render(label,entries,range={start:0,end:20},renderKey='misc',renderSpan=null) {
    const renderTimes={};
    const markSub=name=>{const t0=Date.now();return ()=>{renderTimes[name]=(renderTimes[name]||0)+(Date.now()-t0)/1000;};};
    await unchanged();
    progressStage(label, range.start);
    say(`${label} \u00b7 temporary analysis render; keep the timeline unchanged.`);
    let done=markSub('clone_isolate');
    const before=new Set((await safeSequences(project)).map(id));
    host.transaction(project,'WTV: music analysis copy',c=>c.addAction(sequence.createCloneAction()));
    const created=(await safeSequences(project)).filter(s=>!before.has(id(s)));
    if(created.length!==1) throw Error('Could not identify the music analysis sequence.');
    const renderSequence=created[0], trackItems=await inventory(renderSequence), keep=new Set(entries.map(e=>e.identity));
    scratch.push({sequence:renderSequence,finished:false});
    await project.setActiveSequence(sequence);
    const clips=[];
    for(const e of trackItems) clips.push(await describe(e));
    const retained=clips.filter(e=>keep.has(e.identity));
    if(retained.length!==entries.length) throw Error('Music analysis copy does not match the original clip layout.');
    const projectItem=await renderSequence.getProjectItem();
    for (const index of new Set(retained.map(c => c.trackIndex))) {
      const track = await renderSequence.getAudioTrack(index);
      if (await track.isMuted() && !await track.setMute(false)) {
        throw new Error(`Could not unmute track A${index + 1} for ${label}. Unmute the selected music track on the timeline and retry.`);
      }
    }
    const partial=Boolean(renderSpan && !(renderSpan.start===0 && renderSpan.end===duration)
      && typeof renderSequence.createSetInPointAction==='function' && typeof renderSequence.createSetOutPointAction==='function' && ppro.TickTime?.createWithSeconds);
    host.transaction(project,'WTV: isolate analysis audio',compound=>{
      compound.addAction(projectItem.createSetNameAction(`WTV_${label}_ANALYSIS`));
      for (const clip of clips) compound.addAction(clip.item.createSetDisabledAction(false));
      for (const clip of clips) if (!keep.has(clip.identity)) compound.addAction(clip.item.createSetDisabledAction(true));
      if(partial) {
        compound.addAction(renderSequence.createSetInPointAction(ppro.TickTime.createWithSeconds(renderSpan.start)));
        compound.addAction(renderSequence.createSetOutPointAction(ppro.TickTime.createWithSeconds(renderSpan.end)));
      }
    });
    const renderExpected=partial ? {...expected,duration:renderSpan.end-renderSpan.start} : expected;
    done();
    const renderSignature=await host.musicPassSignature(renderSequence,music,dialogue);
    const renderEffects=await Promise.all(retained.map(c=>effects.snapshot(c.chain)));
    const file=await folder.createFile(`${label}.wav`,{overwrite:false});
    files.push(file);
    done=markSub('export');
    const manager=await ppro.EncoderManager.getManager();
    const exportAcceptMs=Math.max(6*60*1000,Math.ceil(expected.duration*3)*1000);
    let exportHeartbeat=0;
    progressStage(`${label} · exporting`, range.start+0.3);
    say(`${label} · exporting ~${formatDuration(renderExpected.duration)} of ${partial ? 'the selected span' : 'sequence audio'} to a temporary WAV. Premiere may take several minutes on long timelines.`);
    const renderWait=await exportSequenceWithRenderWait({
      ppro, manager, sequence: renderSequence,
      exportType: ppro.Constants.ExportType.IMMEDIATELY,
      outputFile: file.nativePath, presetFile: preset.nativePath, exportFull: !partial,
      outputNativePath: file.nativePath, check, sleep,
      eventWaitMs: 3 * 1000,
      exportAcceptTimeoutMs: exportAcceptMs,
      rejectedMessage: `${label}: Premiere refused the analysis export.`,
      exportTimeoutMessage: `${label}: Premiere did not finish starting the export within ${Math.round(exportAcceptMs/1000)}s (~${formatDuration(exportAcceptMs/1000)}). Dismiss any export or error dialog, confirm the sequence plays, then retry. Temporary analysis sequence may remain in the project.`,
      onExportWait: ({ phase, seconds }) => {
        if (phase !== 'export_accept') return;
        if (seconds-exportHeartbeat<15 && seconds>0) return;
        exportHeartbeat=seconds;
        progressStage(`${label} · exporting (${seconds}s)`, range.start+1);
        say(`${label} · waiting for Premiere to accept the export request (${seconds}s elapsed). If this exceeds ~${formatDuration(expected.duration*2)}, check for a blocking export dialog.`);
      },
    });
    noteExportWait(renderWait);
    renderTimes.export_wait=renderWait.mode;
    done();
    done=markSub('wav_read');
    const raw=await readSummary(file,renderExpected,{check,sleep,renderWaitMode:renderWait.mode,exportLabel:label,
      onWait:()=>progressStage(`${label} - waiting for export`,range.start+1),
      onRead:fraction=>progressStage(`${label} - reading audio locally`,range.start+(range.end-range.start)*fraction)});
    const summary=partial ? padSummary(raw,renderSpan.start,duration) : raw;
    renderTimes.wav_stabilize=summary.exportWait;
    renderTimes.span=partial ? [renderSpan.start,renderSpan.end] : 'full';
    done();
    scratch[scratch.length-1].finished=true;
    const t0=Date.now();
    await guardTimeline();
    await guardEffects();
    timer.addGuard((Date.now()-t0)/1000);
    if(renderSignature!==await host.musicPassSignature(renderSequence,music,dialogue)) throw Error('Analysis sequence changed during export.');
    for(let i=0;i<retained.length;i++) if(renderEffects[i]!==await effects.snapshot(retained[i].chain)) throw Error('Analysis effects changed during export.');
    timer.renders[renderKey]=renderTimes;
    return summary;
  }
  const scratch=[], files=[];
  try {
    let dialogueAsset;
    if (cachedSummaries) {
      analysisCacheResult='hit';
      say('Using cached dialogue measurements (reference and duck settings unchanged). Skipping the Premiere export.');
      progressStage('Using cached dialogue measurements', 66);
      dialogueAsset=cachedSummaries.dialogue;
    } else {
      endPhase=timer.mark('render_dialogue');
      dialogueAsset=await render('Dialogue reference',dialogue,{start:0,end:66},'dialogue',span);
      endPhase();
      try {
        await saveAnalysisCache(fs, storage, fingerprint, { dialogue: dialogueAsset });
      } catch (_) { /* Cache is optional; analysis still proceeds. */ }
    }
    progressStage('Generating duck keyframes from dialogue', 70);
    say('Generating duck keyframes from dialogue\u2026');
    endPhase=timer.mark('analyze');
    const plan=await analyze(dialogueAsset,
      Object.fromEntries(Object.entries(settings).filter(([key,value])=>key!=='strip_clip_volume' && value!==undefined)),
      {check,yieldUI:()=>sleep(0)});
    endPhase();
    await unchanged();
    progressStage('Generating duck keyframes from dialogue', 78);
    if(!Array.isArray(plan.points) || plan.points.length<2 || plan.points.some(([t,g],i)=>!Number.isFinite(t)||!Number.isFinite(g)||g< -90||g>18||(i&&t<=plan.points[i-1][0]))) throw Error('Invalid music automation response.');
    if(plan.points[0][0]!==0 || Math.abs(plan.points[plan.points.length-1][0]-duration)>1/context.rate) throw Error('Music automation duration mismatch.');
    onPlan(plan);
    progressStage('Applying duck keyframes to music clips', 82);
    if((settings.duck_db ?? 10)>0 && plan.speech_regions===0) throw Error(`No dialogue detected above ${plan.threshold_dbfs ?? -40} dBFS. Music was not changed. Check the clean dialogue is audible, or lower Speech floor and retry. Copy report includes the detection measurements.`);
    // Reject oversized curves before appending/removing final Amplify effects.
    const MAX_KEYS_PER_PARAM = 8000;
    for(const clip of music) effects.fitClipCurve(plan.points,clip,context.rate,MAX_KEYS_PER_PARAM);
    // Delete completed scratch sequences before the final transaction, keeping
    // music Apply as the most recent undoable edit on a successful run.
    for(const copy of scratch) if(copy.finished) copy.deleted=await project.deleteSequence(copy.sequence);
    await refreshMusicChains();
    for(const clip of music) clip.amplifies=await effects.listAmplifyComponents(clip.chain);
    const created=[];
    for(const clip of music) created.push(await effects.createComponent(clip,catalog));
    await unchanged();
    // Durable write-ahead marker prevents stacking after an interrupted Apply.
    storage.setItem(ownershipKey,JSON.stringify({pending:true,previous}));
    let committed=false;
    let prepared=[];

    try {
      const endEffects=timer.mark('apply_effects');
      host.transaction(project,'WTV: conform and duck selected music (effect)',compound=>{
        for(const c of created) {
          effects.addRemoveAmplifyActions(compound,c.clip.chain,c.clip.amplifies);
          compound.addAction(c.clip.chain.createAppendComponentAction(c.component));
        }
      });
      endEffects();
      committed=true;
      await refreshMusicChains();
      const endConfigure=timer.mark('apply_configure');
      for (let i = 0; i < created.length; i++) {
        const clip=created[i].clip, found=await effects.listAmplifyComponents(clip.chain);
        if (found.length!==1) {
          const names=[];
          for(let n=0;n<await clip.chain.getComponentCount();n++) {
            const effect=await clip.chain.getComponentAtIndex(n);
            names.push({index:n,match:await effect.getMatchName(),display:typeof effect.getDisplayName==='function'?await effect.getDisplayName():null});
          }
          throw Error(`Amplify replacement verification failed on A${clip.trackIndex+1} at ${clip.start.toFixed(2)}s: expected 1, found ${found.length}; removed ${clip.amplifies.length}. Effects: ${JSON.stringify(names)}`);
        }
        progressStage(`Applying duck keyframes (${i + 1}/${created.length})`, 82 + 14 * (i / Math.max(1, created.length)));
        const built = await effects.configure(await effects.installed(created[i].clip), created[i].clip, plan.points, context.rate, {maxKeysPerParam: MAX_KEYS_PER_PARAM});
        prepared.push(built);
      }
      endConfigure();
      progressStage('Writing Amplify keyframes', 96);
      const endKeyframes=timer.mark('apply_keyframes');
      async function writePrepared(batch) {
        host.transaction(project,'WTV: conform and duck selected music (keyframes)',compound=>{
          for (const item of batch) effects.addActions(compound,item);
        });
      }
      let batch=[], batchKeys=0;
      for (let i = 0; i < prepared.length; i++) {
        progressStage(`Writing duck keyframes (${i + 1}/${prepared.length})`, 96 + 3 * (i / Math.max(1, prepared.length)));
        const item=prepared[i], keys=keyCount(item);
        if (keys>KEYFRAME_BATCH_KEY_LIMIT) {
          if (batch.length) { await writePrepared(batch); batch=[]; batchKeys=0; }
          await writePrepared([item]);
          const v0=Date.now();
          await effects.verify(item);
          timer.phases.apply_verify=(timer.phases.apply_verify||0)+(Date.now()-v0)/1000;
          continue;
        }
        if (batch.length && batchKeys+keys>KEYFRAME_BATCH_KEY_LIMIT) {
          await writePrepared(batch);
          batch=[]; batchKeys=0;
        }
        batch.push(item);
        batchKeys+=keys;
      }
      if (batch.length) {
        await writePrepared(batch);
        for (const item of batch) {
          const v0=Date.now();
          await effects.verify(item);
          timer.phases.apply_verify=(timer.phases.apply_verify||0)+(Date.now()-v0)/1000;
        }
      }
      endKeyframes();
      if(passSignature!==await host.musicPassSignature(sequence,music,dialogue)) throw Error('Timeline clip structure changed during music Apply.');
      const records=[];
      if (previous) {
        for (const prev of previous.clips) {
          const updated=music.find(clip => identityMatches(prev.identity, clip));
          if (updated) {
            records.push({key:updated.key,identity:updated.identity,effectIndex:await updated.chain.getComponentCount()-1,after:await effects.snapshot(updated.chain)});
          } else records.push(prev);
        }
        for (const clip of music) {
          if (!findPreviousClipRecord(previous, clip)) {
            records.push({key:clip.key,identity:clip.identity,effectIndex:await clip.chain.getComponentCount()-1,after:await effects.snapshot(clip.chain)});
          }
        }
      } else {
        for (const clip of music) records.push({key:clip.key,identity:clip.identity,effectIndex:await clip.chain.getComponentCount()-1,after:await effects.snapshot(clip.chain)});
      }
      storage.setItem(ownershipKey,JSON.stringify({pending:false,clips:records,plan}));
      progressStage('Music ducking complete', 100);
    } catch(error) {
      // Restore every replaced Amplify from the captured clip chain. Unknown transaction
      // failures stay marked pending for inspection, never silently stacked.
      if(committed) {
        try {
          host.transaction(project,'WTV: restore music effects after failed verification',compound=>{
            for(const c of created) {
              compound.addAction(c.clip.chain.createRemoveComponentAction(c.component));
              // Restore original order, including manual/unrecorded Amplify.
              for (const old of c.clip.amplifies) compound.addAction(c.clip.chain.createInsertComponentAction(old.component,old.index));
            }
          });
          for(const clip of music) if(clip.before!==await effects.snapshot(clip.chain)) throw Error('Music restoration could not be verified.');
          if(previous) storage.setItem(ownershipKey,JSON.stringify(previous)); else storage.removeItem(ownershipKey);
        } catch(_) { /* Pending marker remains; user must inspect/Undo. */ }
      }
      const message=error.message || String(error);
      if (/Inspect the music effects and use Undo/.test(message)) throw error;
      throw Error(`${message} Inspect the music effects and use Undo if needed before retrying.`);
    }
    restoreVolumeOnFailure=false;
    const mergedWarnings = [...(plan.warnings || [])];
    const keyframeOptimization={method:'linear_db_corners',
      native_keys:prepared.reduce((n,p)=>n+p.curve.length*p.parameters.length,0),
      legacy_native_keys:prepared.reduce((n,p)=>n+p.legacyKeyCount*p.parameters.length,0)};
    const passTiming=timer.finish({
      sequence_duration_s:duration,
      music_clips:music.length,
      dialogue_clips:dialogue.length,
      curve_points:plan.points.length,
    });
    passTiming.exportWait=exportWaitTally;
    passTiming.analysis_cache=analysisCacheResult;
    return {timing:passTiming,keyframe_optimization:keyframeOptimization,clips:music.length,clips_updated:clipsUpdated,clips_fresh:clipsFresh,clips_unchanged:clipsUnchangedOnTimeline,keyframes:prepared.reduce((n,p)=>n+p.curve.length,0),volume_clips_stripped:volumeBackups.length,partial_update:partialUpdate,warnings:mergedWarnings,...plan};
  } finally {
    if (restoreVolumeOnFailure && volumeBackups.length) {
      try {
        host.transaction(project,'WTV: restore clip Volume after failed music pass',compound=>{
          for (const {clip,volumes} of volumeBackups) effects.addRestoreVolumeActions(compound,clip.chain,volumes);
        });
      } catch (_) { /* Volume may already be partially changed; user Undo remains. */ }
    }
    for(const copy of scratch) if(copy.finished && !copy.deleted) {try {await project.deleteSequence(copy.sequence);} catch(_) {}}
    if(scratch.every(c=>c.finished)) {
      for(const file of files) {try {await file.delete();} catch(_) {}}
      try {await folder.delete();} catch(_) {}
    }
  }
}
async function resolveMusicContext(existing) {
  const project=await ppro.Project.getActiveProject(),sequence=project && await project.getActiveSequence();
  if(!sequence) throw Error('Activate a sequence for music ducking.');
  if(existing?.sequence && id(existing.sequence)===id(sequence)) {
    if(existing.failedApply || !existing.applied) throw Error('Finish or inspect the pending cleanup sequence before ducking music.');
    return {...existing,sequence};
  }
  const resumed=await host.resumeAppliedClone();
  if(resumed) return resumed;
  const settings=await sequence.getSettings();
  const rate=Math.round((await settings.getAudioSampleRate()).value),channels=await settings.getAudioChannelCount();
  if(![44100,48000,96000].includes(rate)||![1,2].includes(channels)) throw Error('Music ducking supports mono/stereo sequences at 44.1, 48 or 96 kHz.');
  return {sequence,applied:true,musicOnly:true,originalId:null,rate,channels,dialoguePaths:[]};
}
module.exports={run,collect,describe,reference,loadReference,saveReference,resolveMusicContext,formatMusicPassTimingReport,padSummary};
