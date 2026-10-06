const ppro = require('premierepro');
const host = require('./premiere.js');
const {exportSequenceWithRenderWait} = require('./export-sync.js');
const {amplifyGainParamIndexes} = require('./amplify-params.js');
const key = sequence => sequence.guid.toString();
const normalizePath = host.normalizePath;
// Timeline position + source identity -- not the per-track item index, which
// can drift across clone/render sequences even when the same clip is present.
function clipKey(c) {
  return `${c.trackIndex}:${c.sourceId}:${String(c.start.ticks)}:${String(c.end.ticks)}`;
}
function sameClip(a, b) {
  return a.trackIndex === b.trackIndex && a.sourceId === b.sourceId
    && String(a.start.ticks) === String(b.start.ticks) && String(a.end.ticks) === String(b.end.ticks);
}

function freezeTick(t) {
  const seconds = t.seconds, ticks = String(t.ticks);
  return {seconds, ticks, subtract(other) { return freezeTick({seconds: seconds - other.seconds, ticks: String(Number(ticks) - Number(other.ticks))}); }};
}

const TICKS_PER_SECOND = 254016000000;
// How a clip's clean stem must be exported and placed so Premiere's frame
// quantisation can't shorten it. Confirmed live (2026-09-14, 29.97 sequence):
// a raw clip spanning 970.9996 frames -- its start and end both 0.6 sample
// past a sample boundary, sub-frame -- was placed by createOverwriteItemAction
// with its start floored to the frame grid and its duration floored to 970
// whole frames, leaving the stem one frame (33 ms) short at the tail. Exact-
// tick verification then failed deterministically on every retry.
//
// For such an off-grid clip the stem's out point is set to the whole-frame
// span that covers the raw clip (floor(start)..ceil(end)), and the render
// export runs one further frame so the imported WAV is never shorter than
// that out point (an out point past media end would just be clamped and
// floored again). The extra exported audio is silence -- every other clip on
// the render is disabled -- and sits beyond the raw clip's end, so nothing
// audible changes. Clips already on whole frames keep today's exact span.
// Tick values stay well under 2^53, so Number arithmetic here is exact.
//
// 2026-09-17: the export now also *starts* on the floored frame (gridStart)
// for an off-grid clip, not at the raw clip's exact start. Premiere places
// the stem at gridStart regardless, so exporting from the raw start meant
// the stem's audio played up to one frame (33 ms) early -- inaudible when
// the raw clip is silenced/replaced, but a comb filter the moment raw and
// clean are summed for a timeline mix. The lead-in between gridStart and
// the raw start is silence on the render (every other clip is disabled and
// the raw clip hasn't started), so the stem is sample-aligned to the raw
// clip in every case now.
function placementGeometry(clip, frameTicks) {
  const start = Number(clip.start.ticks), end = Number(clip.end.ticks), span = end - start;
  const exact = {outTicks: String(span), exportStartTicks: String(start), exportEndTicks: String(end), exportDuration: clip.duration, offGrid: false};
  if (!frameTicks) return exact;
  const gridStart = start - start % frameTicks;
  const gridEnd = end % frameTicks ? end - end % frameTicks + frameTicks : end;
  const cover = gridEnd - gridStart;
  if (cover === span) return exact;
  const exportEnd = gridEnd + frameTicks;
  return {outTicks: String(cover), exportStartTicks: String(gridStart), exportEndTicks: String(exportEnd), exportDuration: (exportEnd - gridStart) / TICKS_PER_SECOND, offGrid: true};
}

// Source trims are relative to the project item's start, not embedded timecode.
// Missing/ambiguous bounds leave this clip on the existing exact-cut path.
async function addHandles(clip, seconds, frameTicks) {
  const unavailable = reason => { clip.handles = {version: 1, requested: seconds, head: 0, tail: 0, reason}; };
  try {
    const item = clip.item;
    const source = ppro.ClipProjectItem.cast(await item.getProjectItem());
    if (!source || !await source.getMediaFilePath()) return unavailable('No file-backed source');
    for (const method of ['isOffline', 'isMergedClip', 'isMulticamClip', 'isSequence']) {
      if (typeof source[method] !== 'function') return unavailable('Source type cannot be verified');
      if (await source[method]()) return unavailable('Offline, merged or sequence source');
    }
    if (await item.getSpeed() !== 1 || await item.isSpeedReversed()) return unavailable('Normal-speed forward clips only');
    for (const method of ['createSetInPointAction','createSetOutPointAction','createSetStartAction','createSetEndAction']) {
      if (typeof item[method] !== 'function') return unavailable('Host does not support clip trimming');
    }
    const media = await source.getMedia();
    const duration = typeof media?.getDuration === 'function' ? await media.getDuration() : await media?.duration;
    const length = Number(duration?.ticks);
    const sourceIn = Number((await item.getInPoint()).ticks), sourceOut = Number((await item.getOutPoint()).ticks);
    const start = Number(clip.start.ticks), end = Number(clip.end.ticks);
    if (![length, sourceIn, sourceOut].every(Number.isSafeInteger) || length <= 0 || sourceIn < 0 || sourceOut > length || Math.abs(sourceOut-sourceIn-(end-start)) > Math.max(1, frameTicks || 0)) return unavailable('Source bounds unavailable or retimed');
    // (Tolerance is one sequence frame: an off-grid clip, e.g. 970.9996 frames on the timeline over 971 source frames, is not retimed; live 2026-09-21, C0021.MP4.)
    const requested = Math.round(seconds * TICKS_PER_SECOND);
    let head = Math.min(requested, sourceIn, start), tail = Math.min(requested, length-sourceOut);
    // Premiere snaps trims of video-backed clips to whole frames, so an exact
    // 0.5 s (14.985 frames at 29.97) came back different and failed the
    // read-back check (live, 2026-09-21). Floor each side to whole sequence
    // frames so every requested in/out/start/end stays on the frame grid.
    if (frameTicks) { head -= head % frameTicks; tail -= tail % frameTicks; }
    clip.handles = {version: 1, requested: seconds, head: head/TICKS_PER_SECOND, tail: tail/TICKS_PER_SECOND,
      sourceInTicks: String(sourceIn), sourceOutTicks: String(sourceOut), sourceDurationTicks: String(length),
      startTicks: String(start-head), endTicks: String(end+tail), inTicks: String(sourceIn-head), outTicks: String(sourceOut+tail)};
    if (!head && !tail) { clip.handles.reason = 'No source media beyond the cut'; return; }
    // Export on the frame grid; media trim restores the existing visible cover.
    const visibleStart = Number(clip.exportStartTicks);
    let exportStart = start-head, exportEnd = Math.max(end+tail, Number(clip.exportEndTicks));
    if (frameTicks) {
      exportStart -= exportStart % frameTicks;
      exportEnd = Math.ceil(exportEnd/frameTicks)*frameTicks;
    }
    clip.mediaInTicks = String(visibleStart-exportStart);
    clip.exportStartTicks = String(exportStart); clip.exportEndTicks = String(exportEnd);
    clip.exportDuration = (exportEnd-exportStart)/TICKS_PER_SECOND;
  } catch (error) { unavailable(`Source bounds unavailable: ${error.message}`); }
}

async function extendRenderClip(context, clip) {
  const h = clip.handles;
  const render = await host.findSequence(context.project, context.renderSequenceId);
  const target = (await inventory(render, {tracks:[clip.trackIndex]})).find(c=>sameClip(c,clip));
  if (!target) throw Error('Handle source changed before export. Run Batch Process Dialogue again.');
  if (String((await target.item.getInPoint()).ticks)!==h.sourceInTicks || String((await target.item.getOutPoint()).ticks)!==h.sourceOutTicks) throw Error('Source trims changed before handle export. Run Batch Process Dialogue again.');
  const time = ticks => timelineTime({ticks, seconds:Number(ticks)/TICKS_PER_SECOND});
  context.renderHandleClip = clip; // Retain scratch on any uncertain mutation/export.
  // Premiere's trim semantics were unknown (first live runs: exact read-back of
  // all four values after one combined transaction failed). Apply in two
  // steps -- source in/out first, then timeline start/end only if trimming
  // did not already move them -- and read the clip back after each step, so
  // both the result and, on failure, a step-by-step trace are available.
  const mid = (Number(clip.start.ticks)+Number(clip.end.ticks))/2;
  const trace = [];
  let fresh, extended;
  const readBack = async label => {
    fresh = await host.findSequence(context.project, context.renderSequenceId);
    const lane = await inventory(fresh, {tracks:[clip.trackIndex]});
    // The clip is located by overlap with the original cut, not by exact ticks,
    // so a clip Premiere moved or resized is still found and reported.
    const near = lane.filter(c=>Number(c.start.ticks)<=mid && Number(c.end.ticks)>mid);
    const summaries = [];
    extended = undefined;
    for (const c of near) {
      const inT = String((await c.item.getInPoint()).ticks), outT = String((await c.item.getOutPoint()).ticks);
      summaries.push(`${c.sourceId===clip.sourceId?'':'(other source) '}start ${c.start.ticks} end ${c.end.ticks} in ${inT} out ${outT}${c.enabled?'':' disabled'}`);
      if (c.sourceId===clip.sourceId && inT===h.inTicks && outT===h.outTicks && String(c.start.ticks)===h.startTicks && String(c.end.ticks)===h.endTicks) extended = c;
    }
    trace.push(`${label}: ${summaries.length ? summaries.join(' | ') : 'no clip at the cut'}`);
    return near.find(c=>c.sourceId===clip.sourceId);
  };
  host.transaction(context.project, 'WTV: extend scratch clip source trims', c => {
    c.addAction(target.item.createSetInPointAction(time(h.inTicks)));
    c.addAction(target.item.createSetOutPointAction(time(h.outTicks)));
  });
  let current = await readBack('after in/out');
  if (!extended && current) {
    host.transaction(context.project, 'WTV: extend scratch clip timeline bounds', c => {
      c.addAction(current.item.createSetStartAction(time(h.startTicks)));
      c.addAction(current.item.createSetEndAction(time(h.endTicks)));
    });
    await readBack('after start/end');
  }
  if (!extended) {
    throw Error(`Premiere did not preserve the requested handle trims. Scratch retained; original cuts are unchanged. Expected start ${h.startTicks} end ${h.endTicks} in ${h.inTicks} out ${h.outTicks}. Trace: ${trace.join(' ; ')} [sequence frame: ${context.frameTicks || 'unknown'}].`);
  }
  const audible = (await inventory(fresh)).filter(c=>c.enabled);
  if (audible.length!==1 || !sameClip(audible[0],extended) || String((await fresh.getInPoint()).ticks)!==clip.exportStartTicks || String((await fresh.getOutPoint()).ticks)!==clip.exportEndTicks) throw Error('Handle export isolation changed. Scratch retained; prepare again.');
  return fresh;
}

// Raw clips renamed by an earlier run (` · WTV muted` / ` · WTV mix`, see
// setClipGains) must still map to the same id and produce clean stem names.
const WTV_NAME_SUFFIX = /(\s\u00b7\sWTV (muted|mix))+$/;
const stripWtvSuffix = name => String(name || '').replace(WTV_NAME_SUFFIX, '');
function stableClipId(clip) {
  const base = stripWtvSuffix(clip.name || 'clip').replace(/\.[A-Za-z0-9]{2,4}$/, '').replace(/[<>:"/\\|?*\u0000-\u001F\s]+/g, '_').slice(0, 40) || 'clip';
  return `${base}-A${clip.trackIndex + 1}-${String(clip.start.ticks)}`;
}
function timelineTime(clipStart) {
  // Prefer the exact tick value already captured in `clipStart.ticks` over
  // reconstructing from `.seconds`: ticks-per-second (254016000000) isn't a
  // power of two, so ticks -> seconds -> ticks is a lossy round trip and can
  // land 1 tick off the original position. Immaterial on its own, but on a
  // heavily-cut single track (many adjacent/back-to-back clips from the same
  // source, e.g. a multicam interview edit) that drift can shift a later
  // clip's start by a tick relative to what it was recorded as at Prepare
  // time, which then fails apply()'s exact-tick placement verification
  // (observed 2026-09-14: "Stem placement verification failed" on an 8-clip
  // batch with 5 adjacent clips from the same source file on one track).
  // createWithTicks(ticks: string) takes the ticks value as a string, not a
  // number (per Adobe's own reference) -- clipStart.ticks is already a string
  // (see freezeTick()), so pass it through as-is.
  if (ppro.TickTime?.createWithTicks) return ppro.TickTime.createWithTicks(clipStart.ticks);
  if (ppro.TickTime?.createWithSeconds) return ppro.TickTime.createWithSeconds(clipStart.seconds);
  return clipStart;
}

async function findClipTrackItem(sequence, clip) {
  const track = await sequence.getAudioTrack(clip.trackIndex);
  for (const item of await host.clipTrackItems(track, ppro.Constants.TrackItemType.CLIP)) {
    const start = await item.getStartTime(), end = await item.getEndTime();
    if (String(start.ticks) === String(clip.start.ticks) && String(end.ticks) === String(clip.end.ticks)) return item;
  }
  return null;
}

// Static per-clip gain via a native Amplify (-96..+48 dB range confirmed live
// in music-effects.js; same createKeyframe + createSetValueAction(key, true)
// pattern normalize-music.js uses live). `locate(sequence)` returns the live
// track item each time, since handles go stale after every transaction.
// `record` ({index}) remembers which chain slot holds *our* Amplify so a
// later call (Update mix) rewrites it instead of stacking another one; when
// the slot no longer holds an Amplify, a fresh one is appended and recorded.
const AMPLIFY_MIN_DB = -96, AMPLIFY_MAX_DB = 48;
const dbToNormalized = db => (db - AMPLIFY_MIN_DB) / (AMPLIFY_MAX_DB - AMPLIFY_MIN_DB);
const isAmplify = async c => (typeof c.getDisplayName === 'function' && String(await c.getDisplayName()).trim().toLowerCase() === 'amplify') || /amplify/i.test((await c.getMatchName()) || '');
// One walk per audio track: returns {byKey: Map(clipKey -> item),
// bySource: Map(`${track}:${sourceId}` -> item)} for the given tracks, so a
// batch of N clips costs one pass per lane instead of N (2026-09-17: a
// 158-clip in-place apply was re-walking a 300-item lane per clip, per
// phase, and looked frozen with every button greyed).
async function indexTrackItems(sequence, trackIndexes) {
  const byKey = new Map(), bySource = new Map();
  const count = await sequence.getAudioTrackCount();
  for (const trackIndex of [...new Set(trackIndexes)].filter(t => t >= 0 && t < count)) {
    const track = await sequence.getAudioTrack(trackIndex);
    for (const item of await host.clipTrackItems(track, ppro.Constants.TrackItemType.CLIP)) {
      const start = await item.getStartTime(), end = await item.getEndTime();
      byKey.set(`${trackIndex}:${String(start.ticks)}:${String(end.ticks)}`, item);
      let source = null;
      try { source = await item.getProjectItem(); } catch (_) { /* ignore */ }
      if (source && typeof source.getId === 'function') {
        const k = `${trackIndex}:${source.getId()}`;
        if (!bySource.has(k)) bySource.set(k, item);
      }
    }
  }
  return {byKey, bySource};
}
const rawLocator = clip => ({trackIndex: clip.trackIndex, find: idx => idx.byKey.get(`${clip.trackIndex}:${String(clip.start.ticks)}:${String(clip.end.ticks)}`) || null});
const stemLocator = stem => ({trackIndex: stem.trackIndex, find: idx => idx.bySource.get(`${stem.trackIndex}:${stem.sourceId}`) || null});

// Premiere's API cannot rename an effect (Component has only getDisplayName;
// the Effect Controls panel can't rename one by hand either), so the Amplify
// that silences or mixes a raw clip would just read "Amplify". To make it
// obvious on the timeline, the raw *clip* gets a name suffix instead
// (` · WTV muted` / ` · WTV mix`), applied once in the same transaction as the
// gain and never stacked; Undo removes it together with the effect.
const MUTE_SUFFIX = ' \u00b7 WTV muted';
// Batched static gains. `entries`: [{locator, db, record, label, suffix?}]. Three
// phases, each one track-index build and (at most) one transaction for the
// whole batch: append missing Amplifys; set Left/Right; read back.
async function setClipGains(project, context, entries, {say = () => {}} = {}) {
  if (!entries.length) return;
  for (const e of entries) if (e.db < AMPLIFY_MIN_DB || e.db > AMPLIFY_MAX_DB) throw new Error(`Gain ${e.db.toFixed(1)} dB is outside Amplify's ${AMPLIFY_MIN_DB}..${AMPLIFY_MAX_DB} dB range.`);
  const factory = ppro.AudioFilterFactory;
  if (!factory || typeof factory.createComponentByDisplayName !== 'function') throw new Error('This Premiere build cannot create native audio effects.');
  const amplifyName = (await factory.getDisplayNames()).find(n => String(n).toLowerCase() === 'amplify');
  if (!amplifyName) throw new Error('Native Amplify effect not found.');
  const lanes = entries.map(e => e.locator.trackIndex);
  const locateAll = async () => {
    const sequence = await host.resolveContextSequence(context);
    const idx = await indexTrackItems(sequence, lanes);
    for (const e of entries) { e.item = e.locator.find(idx); if (!e.item) throw new Error(`Could not find “${e.label}” on the sequence. Run Batch Process Dialogue again.`); }
  };
  // Phase 1: append an Amplify where the recorded slot no longer holds one.
  say(`Gain: checking ${entries.length} clip effect(s)…`);
  await locateAll();
  const appends = [];
  for (const e of entries) {
    e.chain = await e.item.getComponentChain();
    const n = await e.chain.getComponentCount();
    const idx = e.record.index;
    const reusable = Number.isInteger(idx) && idx < n && await isAmplify(await e.chain.getComponentAtIndex(idx));
    if (reusable) continue;
    e.record.index = n;
    appends.push({e, component: await factory.createComponentByDisplayName(amplifyName, e.item)});
  }
  if (appends.length) {
    say(`Gain: adding ${appends.length} Amplify effect(s)…`);
    host.transaction(project, `WTV: add mix gain (${appends.length} clip(s))`, c => { for (const {e, component} of appends) c.addAction(e.chain.createAppendComponentAction(component)); });
    await locateAll();
    for (const {e} of appends) {
      e.chain = await e.item.getComponentChain();
      if (await e.chain.getComponentCount() !== e.record.index + 1) throw new Error(`Premiere did not add the gain effect to “${e.label}”.`);
      if (!await isAmplify(await e.chain.getComponentAtIndex(e.record.index))) throw new Error(`Unexpected effect installed on “${e.label}”.`);
    }
  }
  // Static gain requires non-time-varying parameters. Commit that prerequisite
  // first; 26.5.1 additionally requires value-action creation inside the transaction.
  say(`Gain: preparing ${entries.length} static level(s)...`);
  await locateAll();
  const staticActions = [];
  for (const e of entries) {
    const chain = await e.item.getComponentChain();
    const installed = await chain.getComponentAtIndex(e.record.index);
    // Gain sliders = named, non-control Amplify params: "Left"/"Right" on
    // stereo, "Gain" on mono (live 2026-09-25). See amplify-params.js.
    const {indexes, names} = await amplifyGainParamIndexes(installed);
    e.targets = indexes;
    if (!e.targets.length) throw new Error(`Could not identify Amplify gain parameter(s) on “${e.label}” (found: ${names.join(', ') || 'none'}).`);
    for (const i of e.targets) { const param = await installed.getParam(i); if (await param.isTimeVarying()) staticActions.push(param); }
  }
  if (staticActions.length) {
    host.transaction(project, 'WTV: prepare static clip gain', c => {for (const param of staticActions) c.addAction(param.createSetTimeVaryingAction(false));});
  }
  // Refresh ALL chains after the transaction, including previously owned effects.
  await locateAll();
  say(`Gain: setting ${entries.length} level(s)…`);
  const actions = [];
  for (const e of entries) {
    const chain = await e.item.getComponentChain();
    const installed = await chain.getComponentAtIndex(e.record.index);
    if (!await isAmplify(installed)) throw new Error(`Gain effect changed on “${e.label}”.`);
    for (const i of e.targets) {
      const param = await installed.getParam(i);
      if (await param.isTimeVarying()) throw new Error(`Premiere did not make Amplify static on “${e.label}”.`);
      const key = param.createKeyframe(dbToNormalized(e.db));
      actions.push({param,key});
    }
  }
  try {
    host.transaction(project, `WTV: set mix gain (${entries.length} clip(s))`, c => { for (const {param,key} of actions) c.addAction(param.createSetValueAction(key, true)); });
  } catch (error) {
    // "Script action failed to execute" alone is undiagnosable (live 2026-09-21); say what was being set.
    throw new Error(`${error.message} [setting ${actions.length} gain action(s) on ${entries.map(e => `"${e.label}" Amplify slot ${e.record.index} params ${JSON.stringify(e.targets)} to ${e.db.toFixed(1)} dB`).join('; ')}]`);
  }
  // Phase 3: read back.
  say(`Gain: verifying ${entries.length} level(s)…`);
  await locateAll();
  for (const e of entries) {
    const chain = await e.item.getComponentChain();
    const readback = await chain.getComponentAtIndex(e.record.index);
    for (const i of e.targets) {
      const param = await readback.getParam(i);
      const raw = await param.getValueAtTime(ppro.TickTime.createWithSeconds(0));
      const value = typeof raw === 'number' ? raw : raw && typeof raw === 'object' ? Number(raw.value) : Number(raw);
      if (!Number.isFinite(value) || Math.abs(value - dbToNormalized(e.db)) > 1e-4) throw new Error(`Gain on “${e.label}” did not take: ${param.displayName} read back ${JSON.stringify(raw)}.`);
    }
    e.record.db = e.db;
  }
  // Label the clip (` · WTV muted` / ` · WTV mix`) in its own transaction AFTER the
  // gain is verified, with fresh handles: the label is cosmetic, so a rename
  // failure must not fail (and roll back) Apply.
  const renames = entries.filter(e => e.suffix);
  if (renames.length) {
    try {
      await locateAll();
      const renameActions = [];
      for (const e of renames) {
        if (typeof e.item.createSetNameAction !== 'function') continue;
        let current = null;
        try { current = typeof e.item.getName === 'function' ? await e.item.getName() : null; } catch (_) { current = null; }
        if (current != null && !current.endsWith(e.suffix)) renameActions.push(e.item.createSetNameAction(`${current}${e.suffix}`));
      }
      if (renameActions.length) host.transaction(project, `WTV: label mix gain (${renameActions.length} clip(s))`, c => { for (const action of renameActions) c.addAction(action); });
    } catch (_) { /* Cosmetic label only. */ }
  }
  for (const e of entries) { delete e.item; delete e.chain; delete e.targets; }
}
async function setClipGain(project, context, locate, db, record = {}, label = 'clip') {
  // Single-entry convenience over setClipGains; `locate` may be a locator
  // object ({trackIndex, find}) or a legacy (sequence) => item function.
  const locator = typeof locate === 'function' ? {trackIndex: -1, find: null, fn: locate} : locate;
  if (locator.fn) {
    // Legacy path: no lane known; do a direct lookup via a one-off index-free locate.
    const sequence = await host.resolveContextSequence(context);
    const item = await locator.fn(sequence);
    if (!item) throw new Error(`Could not find “${label}” on the sequence. Run Batch Process Dialogue again.`);
    const start = await item.getStartTime(), end = await item.getEndTime();
    const trackIndex = typeof item.getTrackIndex === 'function' ? await item.getTrackIndex() : -1;
    if (trackIndex < 0) throw new Error('Track index unavailable for gain lookup.');
    const clipLike = {trackIndex, start, end};
    await setClipGains(project, context, [{locator: rawLocator(clipLike), db, record, label}]);
    return record;
  }
  await setClipGains(project, context, [{locator, db, record, label}]);
  return record;
}
async function silenceRawClips(project, context, clips, hooks = {}) {
  await setClipGains(project, context, clips.map(clip => ({locator: rawLocator(clip), db: AMPLIFY_MIN_DB, record: (clip.silence = clip.silence || {}), label: clip.name, suffix: MUTE_SUFFIX})), hooks);
}

// `tracks`: optional list of audio track indexes to scan (default: all).
// The per-clip export loop passes just the one or two lanes it touches
// instead of re-walking every lane of a large sequence for every clip.
async function inventory(sequence, {tracks = null} = {}) {
  const clips = [];
  const count = await sequence.getAudioTrackCount();
  const wanted = tracks ? tracks.filter(t => t >= 0 && t < count) : null;
  for (const trackIndex of wanted ?? Array.from({length: count}, (_, i) => i)) {
    const track = await sequence.getAudioTrack(trackIndex);
    const muted = await track.isMuted();
    let trackName = null;
    try { trackName = track.name != null ? String(track.name) : null; } catch (_) { /* optional */ }
    const items = await host.clipTrackItems(track, ppro.Constants.TrackItemType.CLIP);
    // Per-clip adjacency, not "this track has a transition anywhere": a
    // transition sitting entirely between two OTHER clips has nothing to do
    // with a given clip and must not block (or, in prepare()'s strip step,
    // remove) it. Spans are read once per track and reused for every clip.
    const transitionSpans = [];
    for (const t of await host.clipTrackItems(track, ppro.Constants.TrackItemType.TRANSITION)) {
      try { transitionSpans.push({start: await t.getStartTime(), end: await t.getEndTime()}); }
      catch (_) { /* Host rejected read; skip rather than false-block every clip on the track. */ }
    }
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const start = await item.getStartTime(), end = await item.getEndTime();
      // `enabled` means "usable at all" (not disabled in Premiere) and does NOT
      // factor in track mute -- mute is tracked separately so an explicit
      // selection (see prepare()) can override it, while automatic/full-track
      // detection still treats a muted track as excluded (e.g. a dialogue
      // track a previous WTVAudioWizard run already muted after cleaning).
      clips.push({item, trackIndex, index, start, end, duration: end.seconds - start.seconds,
        name: await item.getName(), sourceId: await host.trackItemSourceKey(item, trackIndex, start, end),
        muted, trackName, enabled: !await item.isDisabled(),
        transitions: transitionSpans.some(t => host.transitionTouchesSpan(t.start, t.end, start, end)) ? 1 : 0});
    }
  }
  return clips;
}

async function validate(clips, {selectedOnly = false, requireNoTransitions = true, sequence = null} = {}) {
  const enabled = clips.filter(c => c.enabled);
  if (!enabled.length) throw new Error('No enabled audio clips.');
  const idx = sequence ? await indexTrackItems(sequence, enabled.map(c => c.trackIndex)) : null;
  for (const clip of enabled) {
    const item = idx ? rawLocator(clip).find(idx) : clip.item;
    if (!item || !await host.trackItemHasLinkedMedia(item)) {
      throw new Error(`“${clip.name}” on audio track ${clip.trackIndex + 1} has no linked project media. Replace offline clips, flatten nested sequences, or use Full sequence mode.`);
    }
    if (requireNoTransitions && clip.transitions) {
      throw new Error(`Remove audio transitions on track ${clip.trackIndex + 1} before per-clip processing, or use Full sequence mode.`);
    }
    if (!(clip.start.seconds >= 0 && clip.duration > 0 && clip.duration <= 1800)) throw new Error(`Unsupported duration: ${clip.name}. Select a clip longer than zero and no longer than 30 minutes.`);
    if (clips.some(other => other !== clip && other.trackIndex === clip.trackIndex && other.start.seconds < clip.end.seconds && other.end.seconds > clip.start.seconds)) {
      throw new Error(`Overlapping clips on track ${clip.trackIndex + 1} need Full sequence mode.`);
    }
  }
  return enabled;
}

async function prepare(selectedOnly = false, {inPlace = false, handlesEnabled = false, handleSeconds = 0.5} = {}) {
  if (handlesEnabled && (!Number.isFinite(handleSeconds) || handleSeconds <= 0 || handleSeconds > 2)) throw Error('Handles must be more than 0 and at most 2 seconds per side.');
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  const all = await inventory(sequence);
  const selection = new Set();
  if (selectedOnly) {
    // Explicit selection overrides mute: a user deliberately selecting clips
    // on a muted track means "process these", not "this track doesn't count".
    for (const clip of all) if (clip.enabled && await clip.item.getIsSelected()) selection.add(clipKey(clip));
    if (!selection.size) throw Error('Select dialogue clips on dedicated tracks before running Batch Process Dialogue.');
  }
  // Automatic (non-selection) detection still skips muted tracks entirely --
  // e.g. a dialogue track a previous run already muted after cleaning it.
  const chosen = clips => selectedOnly ? clips.filter(c=>selection.has(clipKey(c))) : clips.filter(c=>!c.muted);
  const options = {selectedOnly};
  await validate(chosen(all), {...options, requireNoTransitions: false}); // Fail before creating a duplicate (or, in-place, before touching the real sequence at all).
  const context = inPlace ? await host.useActive() : await host.cloneActive();
  context.mode = 'per_clip';
  const lanes = [...new Set(chosen(all).map(c => c.trackIndex))];
  const chosenOnClone = chosen(await inventory(context.sequence));
  context.crossfadePlan = await host.captureAudioCrossfadePlan(context.sequence, lanes, chosenOnClone);
  // stripAudioTransitions runs many transactions in a row on the clone; it
  // takes the sequence's id (not the handle) and refetches internally, since
  // any transaction can invalidate the handle we hold here. Refetch again
  // ourselves afterward before touching context.sequence again. Scoped to
  // chosenOnClone: a transition sitting entirely between two other,
  // unprocessed clips on the same track is left untouched.
  await host.stripAudioTransitions(context.project, context.sequenceId, lanes, chosenOnClone);
  context.sequence = await host.resolveContextSequence(context);
  context.signature = await host.signature(context.sequence);
  context.frameTicks = await host.sequenceFrameTicks(context.sequence);
  try {
    context.clips = (await validate(chosen(await inventory(context.sequence)), options))
      // Stable id: source name + lane + start ticks, not the batch position.
      // The same clip selected again in a later run maps to the same file
      // names, so its export and processed stems can be reused (2026-09-17).
      .map(clip => ({...clip, name: stripWtvSuffix(clip.name), start: freezeTick(clip.start), end: freezeTick(clip.end), id: stableClipId(clip)}))
      .map(clip => ({...clip, ...placementGeometry(clip, context.frameTicks)}));
  } catch (error) {
    if (/transitions on track/.test(error.message)) {
      throw new Error('Audio crossfades are still present on a dialogue track in the pending clone. Remove them on that track, use clip volume keyframes instead of crossfades, or switch to Full sequence mode.');
    }
    throw error;
  }
  if (handlesEnabled) for (const clip of context.clips) {
    await addHandles(clip, handleSeconds, context.frameTicks);
    // Separate every geometry, including equal-length head/tail combinations.
    const h = clip.handles;
    clip.exportIdentity = JSON.stringify({version:1, signature:context.signature, handles:h, exportStart:clip.exportStartTicks, exportEnd:clip.exportEndTicks, mediaIn:clip.mediaInTicks||'0'});
    clip.id += `-h1-${Math.round(handleSeconds*1000)}-${Number(clip.mediaInTicks||0).toString(36)}-${Number(clip.exportEndTicks).toString(36)}-${Number(h.sourceInTicks||0).toString(36)}-${Number(h.sourceOutTicks||0).toString(36)}`;
  }
  context.renderSequences = [];
  context.renderSequence = null;
  return context;
}

async function ensureRenderSequence(context) {
  await host.resolveContextSequence(context);
  if (context.renderSequenceId) {
    const render = await host.findSequence(context.project, context.renderSequenceId);
    if (render) { context.renderSequence = render; return render; }
    context.renderSequenceId = null;
    context.renderSequence = null;
  }
  if (context.renderSequence) return context.renderSequence;
  const before = new Set((await host.listSequences(context.project)).map(key));
  const beforeItems = await host.snapshotProjectItems(context.project);
  host.transaction(context.project, 'WTV: prepare clip render', c => c.addAction(context.sequence.createCloneAction()));
  const excludeIds = [context.originalId, key(context.sequence)].filter(Boolean);
  const createdSequence = await host.identifyNewSequence(context.project, before, excludeIds, 'clip render sequence', beforeItems);
  const renderId = key(createdSequence);
  const item = await createdSequence.getProjectItem();
  if (!item || typeof item.createSetNameAction !== 'function') throw new Error('Could not access the clip render sequence in the project. Save the project and prepare again.');
  host.transaction(context.project, 'WTV: name clip render', c => c.addAction(item.createSetNameAction(`${context.name}_RENDER`)));
  // Re-fetch: the naming transaction just above may have invalidated the
  // `created[0]` handle even though it targeted the project item, not the
  // sequence directly.
  const render = await host.findSequence(context.project, renderId);
  if (!render) throw new Error('Could not identify the clip render sequence.');
  context.renderSequence = render;
  context.renderSequenceId = renderId;
  context.renderSequences = [render];
  context.renderIsolatedKey = null; // fresh clone: nothing disabled yet
  return render;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
// Confirmed on a real host (2026-09-14): the isolate transaction's in/out
// point actions can silently misfire -- observed specifically on the first
// clip encountered on a *different* audio track than every clip exported so
// far in the batch (e.g. the first A2 clip right after a run of A1 clips),
// producing a nonsensical readback (a large negative tick value, not merely
// "unchanged"). Retrying the exact same transaction immediately after
// reliably succeeds, so this retries in place -- up to 3 attempts with a
// short pause -- instead of throwing on the first miss and requiring a
// manual "Prepare"/resume click for something that self-heals a moment later.
//
// Incremental (2026-09-17): the first clip of a batch disables every other
// clip on the render once; later clips only re-enable their own item and
// disable the previously isolated one (`previous`), two actions instead of
// N, and the caller only had to scan the affected lanes. `all` is the full
// render inventory on the first pass, or just the affected lanes after.
async function isolateClipOnRender(context, render, all, target, inTime, inTicks, outTime, outTicks, previous = null) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    host.transaction(context.project, 'WTV: isolate clip audio', compound => {
      if (context.renderIsolatedKey) {
        compound.addAction(target.item.createSetDisabledAction(false));
        if (previous && previous !== target) compound.addAction(previous.item.createSetDisabledAction(true));
      } else {
        for (const entry of all) compound.addAction(entry.item.createSetDisabledAction(false));
        for (const entry of all) if (entry !== target) compound.addAction(entry.item.createSetDisabledAction(true));
      }
      compound.addAction(render.createSetInPointAction(inTime));
      compound.addAction(render.createSetOutPointAction(outTime));
    });
    // That transaction called actions directly on `render` -- re-fetch before
    // reading anything off it again, since the handle can go stale the moment
    // its own transaction commits.
    render = await host.findSequence(context.project, context.renderSequenceId);
    if (!render) throw new Error('The clip render sequence changed. Run Batch Process Dialogue again.');
    const renderInTicks = String((await render.getInPoint()).ticks);
    const renderOutTicks = String((await render.getOutPoint()).ticks);
    if (renderInTicks === inTicks && renderOutTicks === outTicks) {
      context.renderIsolatedKey = clipKey(target);
      return {render, renderInTicks, renderOutTicks};
    }
    if (attempt === 3) {
      throw new Error(`Render in/out points did not take effect for "${target.name}" after ${attempt} attempts (expected ${inTicks}-${outTicks}, got ${renderInTicks}-${renderOutTicks}). Run Batch Process Dialogue again.`);
    }
    await sleep(300);
  }
}
async function exportClip(context, clip, preset, path, hooks = {}) {
  // The full-sequence fingerprint (assertUnchanged) walks every clip on
  // every track -- hundreds of API calls on a large edit -- so during a batch
  // it runs at most once per `assertIntervalMs` (default 15 s) rather than
  // before every single export; a mid-batch edit is still caught within that
  // window, and the cheap handle refresh happens every time regardless.
  const interval = context.assertIntervalMs ?? 15000;
  if (!context.lastAssertMs || Date.now() - context.lastAssertMs >= interval) {
    await host.assertUnchanged(context);
    context.lastAssertMs = Date.now();
  } else await host.resolveContextSequence(context);
  // One shared render sequence is reconfigured per clip. Premiere exports run
  // sequentially and main.js waits for each WAV to finish before the next clip,
  // so isolation settings never overlap a queued export.
  if (context.renderHandleClip) {
    if (!context.renderHandleClip.exportVerified) throw Error('Previous handle export is unconfirmed. Its scratch sequence has been retained. Run Batch Process Dialogue again after the export finishes.');
    await releaseRender(context);
    context.renderHandleClip = null;
  }
  let render = await ensureRenderSequence(context);
  // First clip of a batch: full scan (everything gets disabled). After that,
  // only the target's lane and the previously isolated clip's lane.
  const previousKey = context.renderIsolatedKey;
  const previousLane = previousKey ? Number(previousKey.split(':')[0]) : null;
  const all = previousKey ? await inventory(render, {tracks: [...new Set([clip.trackIndex, previousLane])]}) : await inventory(render);
  const target = all.find(c => sameClip(c, clip));
  if (!target) throw new Error('Clip changed while preparing its export.');
  const previous = previousKey ? all.find(c => clipKey(c) === previousKey) || null : null;
  if (previousKey && !previous) { context.renderIsolatedKey = null; } // Lost track of the isolate state: fall back to a full pass next time.
  if (previousKey && !previous) return exportClip(context, clip, preset, path, hooks);
  // Off-grid clips export one frame past their whole-frame cover (see
  // placementGeometry); everything else keeps the clip's own end, passed
  // through as the live TickTime exactly as before.
  const outTicks = clip.exportEndTicks ?? String(target.end.ticks);
  const outTime = outTicks === String(target.end.ticks) ? target.end
    : timelineTime({ticks: outTicks, seconds: Number(outTicks) / TICKS_PER_SECOND});
  // Off-grid clips also export from the floored frame so the placed stem is
  // sample-aligned with the raw clip (see placementGeometry).
  const inTicks = clip.exportStartTicks ?? String(target.start.ticks);
  const inTime = inTicks === String(target.start.ticks) ? target.start
    : timelineTime({ticks: inTicks, seconds: Number(inTicks) / TICKS_PER_SECOND});
  const isolated = await isolateClipOnRender(context, render, all, target, inTime, inTicks, outTime, outTicks, previous);
  render = isolated.render;
  if (clip.handles && (clip.handles.head || clip.handles.tail)) render = await extendRenderClip(context, clip);
  context.renderSequence = render;
  clip.renderInTicks = isolated.renderInTicks;
  clip.renderOutTicks = isolated.renderOutTicks;
  // The render clone inherited the source track's mute state. An explicitly
  // selected clip on a muted track (see prepare()) must still be audible in
  // its isolated export, so unmute only the target's own track here; every
  // other clip on the render is already disabled above and contributes
  // nothing regardless of its track's mute state.
  if (target.muted) {
    const track = await render.getAudioTrack(target.trackIndex);
    if (!await track.setMute(false)) throw new Error('Could not unmute the render for this clip.');
  }
  clip.render = render;
  // The render fingerprint is only ever compared for the LAST exported clip
  // (assertExportsUnchanged), so a batch defers it and calls sealRender()
  // once at the end instead of walking the whole render after every clip.
  if (!context.deferRenderSignature) clip.renderSignature = await host.signature(render);
  else clip.renderSignature = null;
  const extension = await ppro.EncoderManager.getExportFileExtension(render, preset);
  if (String(extension).replace('.', '').toLowerCase() !== 'wav') throw new Error('Premiere could not use the bundled WAV preset.');
  const manager = await ppro.EncoderManager.getManager();
  return exportSequenceWithRenderWait({
    ppro,
    manager,
    sequence: render,
    exportType: ppro.Constants.ExportType.IMMEDIATELY,
    outputFile: path,
    presetFile: preset,
    exportFull: false,
    outputNativePath: path,
    check: hooks.check,
    sleep: hooks.sleep,
    verifyOutput: hooks.verifyOutput,
    deadlineMs: hooks.deadlineMs || 5 * 60 * 1000,
    rejectedMessage: `Premiere did not accept export of ${clip.name}.`,
  });
}

// Fingerprint the render for whichever clip it is currently isolated on
// (the last exported one); see exportClip's deferRenderSignature note.
async function sealRender(context) {
  if (!context.renderSequenceId && !context.renderSequence) return;
  const render = await host.findSequence(context.project, context.renderSequenceId || key(context.renderSequence));
  if (!render) return;
  const inTicks = String((await render.getInPoint()).ticks), outTicks = String((await render.getOutPoint()).ticks);
  const clip = context.clips.find(c => c.renderInTicks === inTicks && c.renderOutTicks === outTicks);
  if (clip) clip.renderSignature = await host.signature(render);
}
async function assertExportsUnchanged(context) {
  await host.assertUnchanged(context);
  if (!context.renderSequenceId && !context.renderSequence) return;
  const renderKey = context.renderSequenceId || key(context.renderSequence);
  // Look each id up individually (not via a getSequences() set): a render
  // clone made from a nested sequence is not listed there (live 2026-09-17).
  const present = async k => Boolean(await host.findSequence(context.project, k));
  if (!await present(renderKey)) throw new Error('The clip render sequence changed. Run Batch Process Dialogue again.');
  for (const r of context.renderSequences) if (!await present(key(r))) throw new Error('The clip render sequence changed. Run Batch Process Dialogue again.');
  const render = await host.findSequence(context.project, renderKey);
  context.renderSequence = render;
  const inTicks = String((await render.getInPoint()).ticks);
  const outTicks = String((await render.getOutPoint()).ticks);
  const clip = context.clips.find(c => c.renderInTicks === inTicks && c.renderOutTicks === outTicks);
  if (clip && clip.renderSignature == null) throw new Error('The export batch was not finalized. Click Batch Process Dialogue to resume it.');
  if (!clip || clip.renderSignature !== await host.signature(render)) {
    throw new Error('The clip render sequence changed. Run Batch Process Dialogue again.');
  }
}

async function releaseRender(context) {
  if (!context.renderSequenceId && !context.renderSequence) return;
  const renderKey = context.renderSequenceId || key(context.renderSequence);
  const render = await host.findSequence(context.project, renderKey);
  if (render) try { await context.project.deleteSequence(render); } catch (_) { /* Harmless render clone retained. */ }
  for (const clip of context.clips) if (clip.render === context.renderSequence || (render && clip.render === render)) clip.render = null;
  context.renderSequence = null;
  context.renderSequenceId = null;
  context.renderSequences = [];
}

// Finds the start of a contiguous run of completely empty audio tracks
// (zero clips) trailing at the end of the sequence, if any -- so new stem
// lanes can reuse that already-existing empty space instead of always
// piling new tracks on below every track the sequence happens to have,
// including ones that were never actually in use. Only ever looks at a
// TRAILING run (never a gap in the middle of otherwise-used tracks): reusing
// an isolated empty track buried among active ones could scramble whatever
// order the editor is relying on, whereas trailing empty tracks are, by
// definition, not part of any existing arrangement.
async function firstReusableTrackIndex(sequence, count) {
  let index = count;
  while (index > 0) {
    const items = await host.clipTrackItems(await sequence.getAudioTrack(index - 1), ppro.Constants.TrackItemType.CLIP);
    if (items.length) break;
    index--;
  }
  return index;
}

async function videoSnapshot(sequence) {
  const result = [];
  for (let index = 0; index < await sequence.getVideoTrackCount(); index++) {
    const items = await host.clipTrackItems(await sequence.getVideoTrack(index), ppro.Constants.TrackItemType.CLIP);
    for (const item of items) {
      const start = await item.getStartTime(), end = await item.getEndTime();
      result.push([index, await host.trackItemSourceKey(item, index, start, end, 'video'), start.ticks, end.ticks,
      (await item.getInPoint()).ticks, (await item.getOutPoint()).ticks, await item.isDisabled(), await item.getSpeed()]);
    }
  }
  return JSON.stringify(result);
}

async function audioSnapshot(sequence, count) {
  const result = [];
  for (let index = 0; index < count; index++) {
    const track = await sequence.getAudioTrack(index);
    for (const item of await host.clipTrackItems(track, ppro.Constants.TrackItemType.CLIP)) {
      const start = await item.getStartTime(), end = await item.getEndTime();
      result.push([index, await host.trackItemSourceKey(item, index, start, end), start.ticks,
        end.ticks, (await item.getInPoint()).ticks, (await item.getOutPoint()).ticks,
        await item.isDisabled(), await item.getSpeed(), await item.isSpeedReversed()]);
    }
  }
  return JSON.stringify(result);
}

async function apply(context, {say = () => {}} = {}) {
  if (context.failedApply) throw new Error('Inspect the pending clone after the failed insertion. Run Batch Process Dialogue again to retry.');
  const n = context.clips.length;
  say(`Add clean tracks: checking the sequence (${n} clip${n === 1 ? '' : 's'})…`);
  await host.assertUnchanged(context);
  await validate(context.clips, {sequence: context.sequence});
  const roles = [['dialogue', 'Clean dialogue'], ['effects', 'Ambience'], ['music', 'Music']]
    .filter(([name]) => (context.outputStems || ['dialogue']).includes(name));
  if (!context.clips.every(c => roles.every(([role]) => c.outputs && c.outputs[role] && c.outputs[role].path)
    && c.result && c.result.sample_rate === context.rate && c.result.channels === context.channels
    && Math.abs(c.result.samples / context.rate - (c.exportDuration ?? c.duration)) <= 1 / context.rate)) {
    throw new Error('Every clip must finish processing with the matching duration and format before adding tracks.');
  }
  const project = context.project;
  // `sequence` is reassigned after every transaction below instead of being
  // held as one `const` for the whole function: a committed transaction can
  // invalidate the handle even when it targeted a track item, not the
  // sequence itself, and this function runs many transactions in sequence.
  let sequence = context.sequence;
  const count = await sequence.getAudioTrackCount();
  // New stem lanes start at the first of any trailing empty tracks, reusing
  // that space instead of always landing beyond every track that exists
  // (see firstReusableTrackIndex). Falls back to `count` (today's behavior:
  // brand-new tracks only) when there is no trailing empty run.
  const insertAt = await firstReusableTrackIndex(sequence, count);
  const raw = await audioSnapshot(sequence, insertAt), video = await videoSnapshot(sequence);
  const lanes = [...new Set(context.clips.map(c => c.trackIndex))].sort((a, b) => a - b);
  const oldTracks = [];
  for (let i = 0; i < count; i++) {
    const track = await sequence.getAudioTrack(i);
    oldTracks.push({track, muted: await track.isMuted()});
  }
  const additions = [];
  roles.forEach(([role, label], group) => lanes.forEach((sourceTrack, lane) => {
    context.clips.filter(c => c.trackIndex === sourceTrack).sort((a,b) => a.start.seconds-b.start.seconds)
      .forEach(clip => additions.push({clip, role, label: `${label} · A${sourceTrack + 1}`,
        trackIndex: insertAt + group * lanes.length + lane, path: clip.outputs[role].path}));
  }));
  say(`Add clean tracks: importing ${additions.length} stem file${additions.length === 1 ? '' : 's'}…`);
  const {byPath} = await host.importIntoBin(project, additions.map(a => a.path), 'Could not import processed stems.');
  for (const addition of additions) Object.assign(addition, byPath.get(normalizePath(addition.path)));
  if (additions.some(a => !a.imported)) throw new Error('Could not identify every imported stem; timeline unchanged.');
  host.transaction(project, 'WTV: set stem ranges', compound => {
    for (const {clip, imported, label} of additions) {
      // Same exact-ticks preference as timelineTime(): derive the span from
      // the recorded ticks rather than the seconds-based duration. For an
      // off-grid clip this is the whole-frame cover from placementGeometry()
      // (Premiere floors the out point to frames; a cover has nothing to
      // floor), otherwise exactly end - start. createWithTicks(ticks: string)
      // wants a string, so the numeric delta is never passed as a number.
      const outTicks = clip.outTicks ?? String(Number(clip.end.ticks) - Number(clip.start.ticks));
      const span = ppro.TickTime?.createWithTicks ? ppro.TickTime.createWithTicks(outTicks)
        : ppro.TickTime?.createWithSeconds ? ppro.TickTime.createWithSeconds(Number(outTicks) / TICKS_PER_SECOND) : clip.end.subtract(clip.start);
      const mediaIn = Number(clip.mediaInTicks || 0);
      const mediaTime = n => timelineTime({ticks:String(n),seconds:n/TICKS_PER_SECOND});
      compound.addAction(imported.createSetInOutPointsAction(mediaIn ? mediaTime(mediaIn) : ppro.TickTime.TIME_ZERO, mediaIn ? mediaTime(mediaIn+Number(outTicks)) : span));
      compound.addAction(imported.createSetNameAction(`${clip.name} · ${label}`));
    }
  });
  await host.assertUnchanged(context);
  sequence = context.sequence; // Refresh: assertUnchanged re-fetches internally.
  context.failedApply = true;
  try {
    // Create each new lane with its first clip -- via overwrite for a reused,
    // already-existing empty track, or insert (which grows the sequence by
    // one track) once destinations reach the tracks that don't exist yet.
    // Later clips overwrite only that lane, preserving gaps without rippling
    // any raw or video clips.
    for (let destination = insertAt; destination < insertAt + roles.length * lanes.length; destination++) {
      const entries = additions.filter(a => a.trackIndex === destination);
      say(`Add clean tracks: placing lane ${destination - insertAt + 1}/${roles.length * lanes.length} (${entries.length} clip${entries.length === 1 ? '' : 's'})…`);
      let editor = ppro.SequenceEditor.getEditor(sequence);
      host.transaction(project, 'WTV: add stem lane', compound => {
        if (destination < count) compound.addAction(editor.createOverwriteItemAction(entries[0].item, timelineTime(entries[0].clip.start), -1, destination));
        else compound.addAction(editor.createInsertProjectItemAction(entries[0].item, timelineTime(entries[0].clip.start), -1, destination, true));
      });
      // That transaction may have invalidated `sequence` (and the editor
      // bound to it), even though it targeted a track item -- re-fetch
      // before the next read or transaction on this sequence.
      sequence = await host.resolveContextSequence(context);
      if (entries.length > 1) {
        editor = ppro.SequenceEditor.getEditor(sequence);
        host.transaction(project, 'WTV: place remaining stem clips', compound => {
          entries.slice(1).forEach(({clip, item}) => compound.addAction(editor.createOverwriteItemAction(item, timelineTime(clip.start), -1, destination)));
        });
        sequence = await host.resolveContextSequence(context);
      }
      const track = await sequence.getAudioTrack(destination);
      if (!host.tryNameTrack(project, track, entries[0].label)) context.defaultTrackNames = true;
      sequence = await host.resolveContextSequence(context); // tryNameTrack may itself transact.
    }
    say('Add clean tracks: verifying placement…');
    if (raw !== await audioSnapshot(sequence, insertAt) || video !== await videoSnapshot(sequence)) {
      throw new Error('Raw audio or video changed unexpectedly');
    }
    // Placement tolerance. The stem must cover the raw clip: its start may not
    // be later, nor its end earlier, than the raw clip's by more than one
    // audio sample (the same one-sample tolerance the exported WAV's duration
    // already passes through -- inspectWav and the result check above). In the
    // other direction, an on-grid clip is likewise held to one sample, while
    // an off-grid clip (see placementGeometry) may start up to one frame early
    // and end up to one frame late: Premiere floors a new item's start to the
    // frame grid, and the whole-frame cover we set as its out point then ends
    // on the frame after the raw clip's end. That overhang is the exported
    // silence beyond the raw clip, so nothing audible moves. Lane, source and
    // enabled state are always exact.
    const ticksPerSample = Math.round(TICKS_PER_SECOND / context.rate);
    const slack = clip => clip.offGrid && context.frameTicks ? Math.max(context.frameTicks, ticksPerSample) : ticksPerSample;
    const delta = (actual, expected) => Number(actual) - Number(expected);
    const placed = (c, a) => c.trackIndex === a.trackIndex && c.sourceId === a.item.getId() && c.enabled
      && delta(c.start.ticks, a.clip.start.ticks) <= ticksPerSample && delta(c.start.ticks, a.clip.start.ticks) >= -slack(a.clip)
      && delta(c.end.ticks, a.clip.end.ticks) >= -ticksPerSample && delta(c.end.ticks, a.clip.end.ticks) <= slack(a.clip);
    let missing = [], after = [];
    // Separately from the tolerance, the isolate-transaction retry in
    // exportClip() confirmed a real, transient Premiere/UXP flakiness where an
    // action commits but doesn't take visible effect immediately, and simply
    // redoing it fixes it. Same treatment here: rather than aborting an entire
    // large batch (requiring a full re-Prepare/re-export) over one flaky
    // placement, re-issue only the mismatched addition's own overwrite action
    // up to 2 extra times before giving up.
    for (let attempt = 1; attempt <= 3; attempt++) {
      after = (await inventory(sequence)).filter(c => c.trackIndex >= insertAt);
      missing = additions.filter(a => !after.some(c => placed(c, a)));
      if (after.length === additions.length && !missing.length) break;
      if (attempt === 3) break;
      const editor = ppro.SequenceEditor.getEditor(sequence);
      host.transaction(project, 'WTV: retry stem placement', compound => {
        for (const a of missing) compound.addAction(editor.createOverwriteItemAction(a.item, timelineTime(a.clip.start), -1, a.trackIndex));
      });
      sequence = await host.resolveContextSequence(context);
      await sleep(300);
    }
    if (missing.length || after.length !== additions.length) {
      // Report what is actually on the lane next to each expected span, not
      // just what was expected -- the delta (in ticks and samples), whether
      // the source matched, and whether it's enabled -- so the next failure
      // is diagnosable from the panel alone. A bare "verification failed"
      // gave no lead on a 42-clip batch.
      const describe = a => {
        const span = [Number(a.clip.start.ticks), Number(a.clip.end.ticks)];
        const candidates = after.filter(c => c.trackIndex === a.trackIndex
          && Number(c.end.ticks) > span[0] - 254016000000 && Number(c.start.ticks) < span[1] + 254016000000);
        const found = candidates.length ? candidates.map(c => {
          const dStart = Number(c.start.ticks) - span[0], dEnd = Number(c.end.ticks) - span[1];
          const samples = t => (t / ticksPerSample).toFixed(2);
          return `found ${c.start.ticks}-${c.end.ticks} (Δstart ${dStart} ticks = ${samples(dStart)} samples, Δend ${dEnd} ticks = ${samples(dEnd)} samples, source ${c.sourceId === a.item.getId() ? 'matches' : 'differs'}, ${c.enabled ? 'enabled' : 'DISABLED'})`;
        }).join('; ') : 'nothing on that lane within 1 s of the expected span';
        const grid = a.clip.offGrid ? `, off-grid raw clip placed with a ${a.clip.outTicks}-tick whole-frame cover` : '';
        return `${a.clip.id} "${a.clip.name}" (from A${a.clip.trackIndex + 1} @ ${a.clip.start.seconds.toFixed(2)}s, destination lane ${a.trackIndex}, expected ticks ${a.clip.start.ticks}-${a.clip.end.ticks}${grid}: ${found})`;
      };
      const detail = (missing.length ? missing.map(describe).join(', ')
        : `expected ${additions.length} placed clips, found ${after.length}`)
        + ` [sequence frame: ${context.frameTicks ? `${context.frameTicks} ticks` : 'unknown'}]`;
      throw new Error(`Stem placement verification failed after retrying: ${detail}`);
    }
    // Correct timeline bounds alone do not prove that hidden handles were trimmed.
    for (const a of additions) if (a.clip.mediaInTicks) {
      const c = after.find(c=>placed(c,a));
      const sourceIn = Number((await c.item.getInPoint()).ticks);
      const sourceOut = Number((await c.item.getOutPoint()).ticks);
      if (Math.abs(sourceIn-Number(a.clip.mediaInTicks))>ticksPerSample || Math.abs(sourceOut-sourceIn-Number(a.clip.outTicks))>ticksPerSample) {
        throw Error(`Handle media trim verification failed for ${a.clip.name}. Added tracks have been muted.`);
      }
    }
    say('Add clean tracks: restoring crossfades…');
    context.crossfadeReport = await host.reapplyDialogueCrossfades(project, context.sequenceId, context, {insertAt, lanes});
    sequence = await host.resolveContextSequence(context); // Crossfade restore transacts per boundary.
    // Remember where each clip's Clean dialogue stem landed so a timeline
    // mix can find it again later (Update mix), by lane + imported source.
    for (const a of additions) if (a.role === 'dialogue') a.clip.stem = {trackIndex: a.trackIndex, sourceId: a.item.getId()};
    // Main tab's "Auto mute" (2026-10-01): off leaves every raw clip and lane
    // audible; Dan mutes what he wants himself.
    if (context.autoMute === false) say('Add clean tracks: Mute raw when done is off \u2014 raw audio left audible.');
    else {
    // When every enabled clip on a source track was processed, mute the whole
    // raw lane (today's behavior). Partial selection only disables the raw clips
    // that got clean replacements so unselected siblings stay audible.
    say('Add clean tracks: muting raw lanes…');
    const laneInventory = await inventory(sequence, {tracks: lanes});
    const toSilence = [], toDisable = [];
    for (const lane of lanes) {
      const processedOnLane = context.clips.filter(c => c.trackIndex === lane);
      const enabledOnLane = laneInventory.filter(c => c.trackIndex === lane && c.enabled);
      const fullLane = enabledOnLane.length > 0 && enabledOnLane.every(c => processedOnLane.some(p => sameClip(p, c)));
      if (fullLane) {
        if (!await (await sequence.getAudioTrack(lane)).setMute(true)) throw new Error('Could not mute a raw track in clone');
        sequence = await host.resolveContextSequence(context);
      } else if (context.inPlace) {
        // In place, the raw clip is Dan's real clip, and disabling an audio
        // item that's linked to video disables the video too (live
        // 2026-09-17). Silence it with a native Amplify at -96 dB instead --
        // audio-only, Undo-able, and visible in Effect Controls. Batched
        // across all partial lanes: three transactions total, not per clip.
        toSilence.push(...processedOnLane);
      } else {
        toDisable.push(...processedOnLane);
      }
    }
    if (toSilence.length) {
      await silenceRawClips(project, context, toSilence, {say: m => say(`Add clean tracks: ${m}`)});
      sequence = await host.resolveContextSequence(context);
    }
    if (toDisable.length) {
      const idx = await indexTrackItems(sequence, toDisable.map(c => c.trackIndex));
      const items = toDisable.map(clip => { const item = rawLocator(clip).find(idx); if (!item) throw new Error(`Could not find “${clip.name}” on the clone. Run Batch Process Dialogue again.`); return item; });
      host.transaction(project, 'WTV: disable processed raw clips', compound => {
        for (const item of items) compound.addAction(item.createSetDisabledAction(true));
      });
      sequence = await host.resolveContextSequence(context);
    }
    }
    if (!context.inPlace) {
      const item = await sequence.getProjectItem();
      host.transaction(project, 'WTV: finish clean sequence', c => c.addAction(item.createSetNameAction(context.name)));
    }
    context.failedApply = false;
    context.dialoguePaths = context.clips.map(c=>c.outputs.dialogue.path);
    context.applied = true;
  } catch (error) {
    let incomplete = false;
    for (const {track, muted} of oldTracks) { try { if (!await track.setMute(muted)) incomplete = true; } catch (_) { incomplete = true; } }
    // Mute from insertAt, not count: a reused (previously empty) track may
    // now hold a partial stem lane and must not play back any more than a
    // brand-new one would.
    for (let i = insertAt; i < await sequence.getAudioTrackCount(); i++) {
      try { if (!await (await sequence.getAudioTrack(i)).setMute(true)) incomplete = true; } catch (_) { incomplete = true; }
    }
    throw new Error(`${error.message}. ${context.inPlace ? 'Inspect the sequence; use Undo if unsure.' : 'Inspect the pending clone; original sequence is intact.'} ${incomplete ? 'Mute recovery incomplete; inspect before playback.' : 'Raw mute states restored and added tracks muted.'}`);
  }
  await project.openSequence(sequence);
  await project.setActiveSequence(sequence);
  await releaseRender(context);
}


module.exports = {prepare, exportClip, apply, inventory, validate, assertExportsUnchanged, sealRender, releaseRender, clipKey, sameClip, silenceRawClips};
