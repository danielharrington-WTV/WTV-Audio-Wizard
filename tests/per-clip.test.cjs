const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { exportSync } = require('./plugin-test-require.cjs');
// True only while a transaction's build callback is running. The Amplify
// mocks use it to reproduce Premiere 26.5.1's live behavior (2026-09-22):
// ComponentParam.createSetValueAction() built OUTSIDE the transaction that
// commits it throws "The script object is no longer valid".
let IN_TX = false;

// frameTicks: when set, the mock sequence behaves like a real host with that
// video timebase -- Sequence.getTimebase() is exposed (unless exposeTimebase is
// false) and, as confirmed live 2026-09-14, createOverwriteItemAction floors
// both the placed start and the item's out point to whole frames.
function setup({tickTimeOverrides = {}, frameTicks = null, exposeTimebase = true} = {}) {
  const tick = seconds => ({seconds, ticks: String(Math.round(seconds * 254016000000)), subtract(other) {return tick(this.seconds - other.seconds);}});
  const frameSeconds = frameTicks ? frameTicks / 254016000000 : 0;
  const snapToFrame = seconds => frameSeconds ? Math.floor(seconds / frameSeconds + 1e-9) * frameSeconds : seconds;
  const crossfadeAdds = [];
  const projectItem = (id, nativePath) => ({name: id, nativePath, getId: () => id,
    getMediaFilePath: async () => nativePath || 'C:/source.wav',
    isOffline: async()=>false, isMergedClip: async()=>false, isMulticamClip: async()=>false, isSequence: async()=>false,
    getMedia: async()=>({getDuration:()=>tick(60)}),
    createSetNameAction(name) {return () => {this.name = name;};},
    createSetInOutPointsAction(start, end) {return () => {this.inPoint = start; this.outPoint = end;};}});
  function clip(source, start, end, inPoint = 0, disabled = false, speed = 1) {
    const components = [];
    return {source, start, end, inPoint, disabled, speed, components,
      // Native effect chain (used by in-place silencing and timeline mix).
      async getComponentChain() {return {async getComponentCount() {return components.length;}, async getComponentAtIndex(i) {return components[i];},
        createAppendComponentAction(comp) {return () => {components.push(comp);};}};},
      getName: async function () {return this.name ?? source.name;}, createSetNameAction(value) {return () => {this.name = value;};}, getProjectItem: async () => source,
      async getStartTime() {return tick(this.start);}, async getEndTime() {return tick(this.end);},
      async getInPoint() {return tick(this.inPoint);}, async getOutPoint() {return tick(this.sourceOut ?? (this.inPoint + (this.end - this.start) * this.speed));},
      createSetInPointAction(t) {return ()=>{this.inPoint=t.seconds;};},
      createSetOutPointAction(t) {return ()=>{this.sourceOut=t.seconds;};},
      createSetStartAction(t) {return ()=>{this.start=t.seconds;};},
      createSetEndAction(t) {return ()=>{this.end=t.seconds;};},
      async isDisabled() {return this.disabled;}, async getSpeed() {return this.speed;}, isSpeedReversed: async () => false,
      async getIsSelected() {return this.selected === true;},
      createSetDisabledAction(value) {return () => {this.disabled = value;};},
      createAddAudioTransitionAction(transition, options) {
        return () => { crossfadeAdds.push({transition, options, start: this.start}); };
      }};
  }
  function audioTransition(start, end, matchName = 'AE.ADBE Constant Power') {
    return {getStartTime: async () => tick(start), getEndTime: async () => tick(end), getMatchName: async () => matchName};
  }
  const track = (clips, muted = false) => ({clips, muted, name: 'Audio', transitions: [],
    async getTrackItems(type) {return type === 2 ? this.transitions : this.clips;},
    async isMuted() {return this.muted;}, async setMute(value) {this.muted = value; return true;},
    createSetNameAction(value) {return () => {this.name = value;};}});
  let serial = 0;
  const calls = [], exports = [];
  function makeBin(name) {
    const items = [];
    return {name, items, getItems: async () => items.slice(), getId: () => `bin-${name}`};
  }
  const rootItems = [];
  const root = {name: 'Root', getItems: async () => rootItems.slice(), getId: () => 'root',
    createBinAction(name) {return () => {rootItems.push(makeBin(name));};}};
  const project = {sequences: [], items: rootItems, lockedAccess: fn => fn(),
    executeTransaction(build) {const actions = []; IN_TX = true; try { build({addAction: a => actions.push(a)}); } finally { IN_TX = false; } actions.forEach(a => a()); return true;},
    async getActiveSequence() {return this.sequences[0];}, async getSequences() {return this.sequences;},
    async getRootItem() {return root;},
    async importFiles(paths, _suppress, target) {
      const dest = target.items ?? rootItems;
      dest.push(...paths.map(p => projectItem(p, p)));
      return true;
    },
    async openSequence(s) {this.opened = s;}, async setActiveSequence() {},
    async deleteSequence(s) {this.sequences = this.sequences.filter(other => other !== s); return true;}};
  function sequence(tracks, videos) {
    const id = `sequence-${serial++}`, item = projectItem(id);
    const seq = {name: id, guid: {toString: () => id}, tracks, videos, inTime: tick(0), outTime: tick(12),
      ...(frameTicks && exposeTimebase ? {getTimebase: async () => String(frameTicks)} : {}),
      getSettings: async () => ({getAudioSampleRate: async () => ({value: 48000}), getAudioChannelCount: async () => 2}),
      getEndTime: async () => tick(12), getProjectItem: async () => item,
      async getInPoint() {return this.inTime;}, async getOutPoint() {return this.outTime;},
      createSetInPointAction(t) {return () => {this.inTime = t;};}, createSetOutPointAction(t) {return () => {this.outTime = t;};},
      getAudioTrackCount: async () => tracks.length, getAudioTrack: async i => tracks[i],
      getVideoTrackCount: async () => videos.length, getVideoTrack: async i => videos[i],
      createCloneAction: () => () => {
        const copy = t => {
          const nt = track(t.clips.map(c => Object.assign(clip(c.source, c.start, c.end, c.inPoint, c.disabled, c.speed), c.sourceOut === undefined ? {} : {sourceOut: c.sourceOut})), t.muted);
          nt.transitions = t.transitions.slice();
          return nt;
        };
        project.sequences.push(sequence(tracks.map(copy), videos.map(copy)));
      }};
    return seq;
  }
  const source = projectItem('linked-camera');
  const original = sequence([
    track([clip(source, 1, 3, 7), clip(source, 5, 7, 20, false, 2), clip(source, 9, 10, 0, true)]),
    track([clip(projectItem('music'), 2, 6)]),
    track([clip(projectItem('muted'), 0, 12)], true)
  ], [track([clip(source, 1, 3, 7), clip(source, 5, 7, 20, false, 2)])]);
  project.sequences.push(original);
  const ppro = {Project: {getActiveProject: async () => project}, Constants: {TrackItemType: {CLIP: 1, TRANSITION: 2}, ExportType: {IMMEDIATELY: 1}, MediaType: {AUDIO: 'audio'}},
    // createWithTicks(ticks: string) takes a string per Adobe's own reference
    // (developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/ticktime);
    // passing a number threw "Illegal parameter type" on a real host
    // (2026-09-14). Enforced here so a regression can't pass a number again
    // without every test that exercises this path failing loudly.
    TickTime: {TIME_ZERO: tick(0), createWithSeconds: s => tick(s), createWithTicks: t => {
      if (typeof t !== 'string') throw new Error('Illegal parameter type');
      return tick(Number(t) / 254016000000);
    }, ...tickTimeOverrides},
    ClipProjectItem: {cast: x => x}, AudioClipTrackItem: {cast: x => x},
    FolderItem: {cast: item => item && item.items ? item : null}, FolderProjectItem: {cast: item => item && item.items ? item : null},
    TransitionFactory: {createAudioTransition: name => ({matchName: name})},
    AddTransitionOptions: class { setDuration(value) { this.duration = value; } },
    TrackItemSelection: {createEmptySelection(cb) { const sel = {_items: [], addItem(item) { this._items.push(item); return true; } }; cb(sel); }},
    EncoderManager: {getExportFileExtension: async () => 'wav', getManager: async () => ({exportSequence: async (...args) => {exports.push(args); return true;}})},
    SequenceEditor: {getEditor: seq => ({createInsertProjectItemAction(item, time, video, audio, limitShift) {
      assert.equal(limitShift, true); assert.equal(audio, seq.tracks.length);
      return () => {seq.tracks.push(track([])); this.createOverwriteItemAction(item,time,video,audio)();};
    }, createOverwriteItemAction(item, time, video, audio) {
      assert.equal(video, -1);
      return () => {
        calls.push({time: time.seconds, audio, item});
        const start = snapToFrame(time.seconds), end = start + snapToFrame(item.outPoint.seconds - item.inPoint.seconds);
        const t = seq.tracks[audio];
        t.clips = t.clips.filter(c => c.end <= start || c.start >= end);
        t.clips.push(clip(item, start, end, item.inPoint.seconds)); t.clips.sort((a,b) => a.start-b.start);
      };
    }, createRemoveItemsAction(selection) {
      return () => {
        const items = selection._items || [];
        for (const t of seq.tracks) t.transitions = t.transitions.filter(tr => !items.includes(tr));
      };
    }})}};
  function load(name, require) {
    const box = {module: {exports: {}}, require, setTimeout};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../plugin/${name}.js`), 'utf8'), box);
    return box.module.exports;
  }
  const host = load('premiere', n => n === './export-sync.js' ? exportSync : ppro);
  const api = load('per-clip', name => {
    if (name === 'premierepro') return ppro;
    if (name === './export-sync.js') return exportSync;
    if (name === './amplify-params.js') return load('amplify-params', () => { throw new Error('amplify-params has no deps'); });
    return host;
  });
  return {api, host, original, project, exports, calls, track, clip, projectItem, crossfadeAdds, audioTransition, ppro};
}

test('prepare({inPlace: true}) works directly on the active sequence with no clone', async()=>{
  const {api,original,project}=setup();
  original.tracks[0].clips.forEach(c=>c.selected=true);
  const context=await api.prepare(true, {inPlace: true}); ready(context);
  assert.equal(project.sequences.length,1); // no clone of the active sequence itself
  assert.equal(context.sequence,original);
  assert.equal(context.inPlace,true);
  await api.apply(context);
  assert.equal(original.name,'sequence-0');
  assert.equal(context.sequence.tracks[0].muted,true);
  assert.equal(context.applied,true);
});
test('in-place on a multicam/nest: neither the source nor its render clone is listed by getSequences() or active; the clone is found via its new project item (live 2026-09-17)', async()=>{
  const {api,original,project,exports}=setup();
  original.tracks[0].clips.forEach(c=>c.selected=true);
  // Simulate the multicam source: hidden from getSequences(); its clone is
  // hidden too and does NOT become active -- it only shows up as a new
  // project item in the root bin whose getSequence() returns it.
  const hidden=new Set([original]);
  const realClone=original.createCloneAction;
  original.createCloneAction=()=>()=>{ realClone()(); const made=project.sequences[project.sequences.length-1]; hidden.add(made);
    project.items.push({name:'clone item',getId:()=>'item-'+made.guid.toString(),getSequence:async()=>made}); };
  project.getSequences=async()=>project.sequences.filter(s=>!hidden.has(s));
  project.getActiveSequence=async()=>original;
  const context=await api.prepare(true,{inPlace:true});
  await api.exportClip(context, context.clips[0], 'wav.epr', 'nest.wav');
  assert.equal(exports.length,1);
  assert.ok(context.renderSequenceId);
  await api.releaseRender(context);
  assert.equal(project.sequences.length,1);
});
test('in-place partial lane silences the processed raw clip with Amplify -96 dB instead of disabling it (linked video stays enabled; live 2026-09-17)', async()=>{
  const {api,original,ppro}=setup();
  mockAmplify(ppro);
  const target=original.tracks[0].clips[0]; target.selected=true; // one of two enabled clips on A1 -> partial lane
  const context=await api.prepare(true,{inPlace:true}); ready(context);
  assert.equal(context.clips.length,1);
  await api.apply(context);
  assert.equal(context.applied,true);
  assert.equal(original.tracks[0].muted,false);
  assert.equal(target.disabled,false);
  assert.equal(target.components.length,1);
  assert.deepEqual(target.components[0].params.slice(1).map(p=>p.value),[0,0]);
  assert.equal(original.tracks[0].clips[1].components.length,0);
});
test('mono clip: Amplify Gain slider is the target when there is no Left/Right (live layout 2026-09-25)', async()=>{
  const {api,original,ppro}=setup();
  mockAmplifyMono(ppro);
  const target=original.tracks[0].clips[0]; target.selected=true; // one of two enabled clips on A1 -> partial lane
  const context=await api.prepare(true,{inPlace:true}); ready(context);
  await api.apply(context);
  assert.equal(context.applied,true);
  assert.equal(target.components.length,1);
  const params=target.components[0].params;
  assert.equal(params[3].displayName,'Gain');
  assert.equal(params[3].value,0); // -96 dB normalized: (-96-(-96))/144
  // Controls and hidden channel slots untouched.
  for (const i of [0,1,2,4,params.length-1]) assert.equal(params[i].value,0.6666666865348816);
});
test('clip ids are stable across runs (source name + lane + start ticks), not batch positions (2026-09-17)', async()=>{
  const {api,original}=setup();
  original.tracks[0].clips[1].selected=true;
  const first=await api.prepare(true);
  assert.equal(first.clips.length,1);
  assert.match(first.clips[0].id,/^linked-camera-A1-\d+$/);
  original.tracks[0].clips[0].selected=true; // widen the selection: the same clip keeps the same id
  const second=await api.prepare(true);
  assert.equal(second.clips.length,2);
  assert.ok(second.clips.some(c=>c.id===first.clips[0].id));
  assert.notEqual(second.clips[0].id,second.clips[1].id);
});
test('in-place partial lanes are silenced in one batch: one add + one set transaction for N clips, not per clip', async()=>{
  const {api,original,ppro,project}=setup();
  mockAmplify(ppro);
  // Lane 0 has two enabled clips; selecting one makes it partial. Lane 1 (music) untouched.
  original.tracks[0].clips[0].selected=true;
  const context=await api.prepare(true,{inPlace:true}); ready(context);
  const labels=[];
  const real=project.executeTransaction.bind(project);
  project.executeTransaction=(build,label)=>{labels.push(label||'');return real(build,label);};
  await api.apply(context);
  assert.equal(context.applied,true);
  assert.equal(original.tracks[0].muted,false);
  assert.equal(labels.filter(l=>/add mix gain/.test(l)).length,1);
  assert.equal(labels.filter(l=>/set mix gain/.test(l)).length,1);
  assert.equal(original.tracks[0].clips[0].components.length,1);
  assert.equal(original.tracks[0].clips[1].components.length,0);
  // The silenced raw clip is renamed so the Amplify's purpose is obvious; siblings are not.
  assert.equal(await original.tracks[0].clips[0].getName(),'linked-camera \u00b7 WTV muted');
  assert.equal(await original.tracks[0].clips[1].getName(),'linked-camera');
  // A later run on the renamed clip keeps the same stable id and a clean display name.
  const again=await api.prepare(true,{inPlace:true});
  assert.equal(again.clips[0].id,context.clips[0].id);
  assert.equal(again.clips[0].name,'linked-camera');
});
test('selected dialogue excludes existing music and preserves its audible lane', async()=>{
  const {api,original}=setup();
  original.tracks[0].clips.forEach(c=>c.selected=true);
  const context=await api.prepare(true); ready(context);
  assert.equal(context.clips.length,2);
  await api.apply(context);
  assert.equal(context.sequence.tracks[1].muted,false);
  assert.equal(context.sequence.tracks[0].muted,true);
  assert.equal(context.dialoguePaths.length,2);
});
test('explicitly selecting dialogue on a muted track overrides the mute gate, and its export is unmuted', async()=>{
  const {api,original,exports}=setup();
  original.tracks[2].clips.forEach(c=>c.selected=true); // the always-muted 'muted' track
  const context=await api.prepare(true);
  assert.equal(context.clips.length,1);
  assert.equal(context.clips[0].trackIndex,2);
  assert.equal(context.clips[0].muted,true);
  await api.exportClip(context, context.clips[0], 'wav.epr', 'muted-clip.wav');
  const [renderSeq] = exports[0];
  assert.equal(renderSeq.tracks[2].muted, false, 'the isolated render must unmute the selected clip\'s own track');
});
test('exportClip fails fast (rather than exporting a wrong-length WAV) if the render in/out points do not take effect (regression: 2026-09-14)', async()=>{
  const {api,original}=setup();
  original.tracks[0].clips[0].selected=true; // clip A: 1-3
  original.tracks[0].clips[1].selected=true; // clip B: 5-7, a different span
  const context=await api.prepare(true);
  assert.equal(context.clips.length,2);
  await api.exportClip(context, context.clips[0], 'wav.epr', 'first.wav'); // sets render in/out to clip A's span, still correct
  // Simulate the isolate transaction silently not applying, as suspected on
  // a real host for a clip that's first on its track after a long leading
  // gap: createSetInPointAction/createSetOutPointAction commit but the
  // render's in/out points stay wherever they were left (clip A's span)
  // instead of moving to clip B's.
  const render = context.renderSequence;
  render.createSetInPointAction = () => () => {};
  render.createSetOutPointAction = () => () => {};
  await assert.rejects(
    api.exportClip(context, context.clips[1], 'wav.epr', 'second.wav'),
    /Render in\/out points did not take effect for "[^"]+" after 3 attempts/
  );
});
test('exportClip retries the isolate transaction in place and succeeds if a later attempt takes effect (regression: 2026-09-14)', async()=>{
  const {api,original,exports}=setup();
  original.tracks[0].clips[0].selected=true;
  original.tracks[0].clips[1].selected=true;
  const context=await api.prepare(true);
  await api.exportClip(context, context.clips[0], 'wav.epr', 'first.wav');
  const render = context.renderSequence;
  const realSetIn = render.createSetInPointAction.bind(render), realSetOut = render.createSetOutPointAction.bind(render);
  let misses = 0;
  render.createSetInPointAction = t => { if (misses < 1) { misses++; return () => {}; } return realSetIn(t); };
  render.createSetOutPointAction = t => misses < 1 ? () => {} : realSetOut(t);
  await api.exportClip(context, context.clips[1], 'wav.epr', 'second.wav'); // first attempt misses, second succeeds -- no throw
  assert.equal(exports.length, 2);
  assert.equal(context.clips[1].renderInTicks, String(context.clips[1].start.ticks));
});
test('single selected clip is keyed by timeline identity, not track-item index', async()=>{
  const {api, original} = setup();
  original.tracks[2].clips[0].selected = true; // lone clip on its track
  const context = await api.prepare(true);
  assert.equal(context.clips.length, 1);
  const cloneItems = await api.inventory(context.sequence);
  const shifted = cloneItems.find(c => api.sameClip(c, context.clips[0]));
  assert.ok(shifted, 'clone still contains the selected clip');
  shifted.index = 99;
  assert.notEqual(shifted.index, context.clips[0].index);
  assert.equal(api.clipKey(shifted), api.clipKey(context.clips[0]));
});
test('empty dialogue selection stops before cloning; partial lane selection is allowed', async()=>{
  const {api,original,project}=setup();
  await assert.rejects(api.prepare(true),/Select dialogue/);
  original.tracks[0].clips[0].selected=true;
  const context=await api.prepare(true);
  assert.equal(context.clips.length,1);
  assert.equal(project.sequences.length,2);
});
test('partial dialogue selection disables only processed raw clips and leaves siblings audible', async()=>{
  const {api,original,exports}=setup();
  original.tracks[0].clips[0].selected=true;
  const context=await api.prepare(true);
  assert.equal(context.clips.length,1);
  await api.exportClip(context, context.clips[0], 'wav.epr', 'partial.wav');
  assert.equal(exports.length,1);
  ready(context);
  await api.apply(context);
  assert.equal(context.applied,true);
  assert.equal(context.sequence.tracks[0].muted,false);
  assert.equal(context.sequence.tracks[0].clips[0].disabled,true);
  assert.equal(context.sequence.tracks[0].clips[1].disabled,false);
});
test('apply() places stems using exact ticks, not a lossy seconds round trip (regression: 2026-09-14)', async () => {
  // 254016000000 ticks/second is not a power of two, so converting a tick
  // count to seconds and back can land on a different tick than the one
  // recorded at Prepare time. This forces that: createWithSeconds here always
  // returns a tick 1 off from the exact value, while createWithTicks (which
  // apply()'s placement should now prefer) stays exact. Reported by Dan as
  // "Stem placement verification failed" on a real 8-clip batch with several
  // adjacent clips from the same source file on one track.
  const {api, original} = setup({tickTimeOverrides: {createWithSeconds: s => {
    const ticks = Math.round(s * 254016000000) + 1;
    return {seconds: ticks / 254016000000, ticks: String(ticks), subtract(other) { return {seconds: this.seconds - other.seconds}; }};
  }}});
  original.tracks[0].clips.forEach(c => c.selected = true);
  const context = await api.prepare(true); ready(context);
  await api.apply(context); // would throw "Stem placement verification failed" if placement used createWithSeconds
  assert.equal(context.applied, true);
  const placed = (await api.inventory(context.sequence)).filter(c => c.trackIndex >= 3);
  for (const clip of context.clips) assert.ok(placed.some(c => c.start.ticks === clip.start.ticks), `clip ${clip.id} landed on its exact recorded tick`);
});

test('a mismatched stem placement names exactly which clip and lane failed to verify (regression: 2026-09-14)', async () => {
  // Reported live on a 42-clip batch as a bare "Stem placement verification
  // failed" with no lead on which of the many clips (several sharing the
  // same source file, so the clip's *name* alone can't disambiguate --
  // simulated here too, since all clips in this fixture share one source)
  // actually failed. This forces one specific placement to land 1 second off
  // and confirms the resulting message identifies it by its own clip id and
  // timeline position, not just its (possibly duplicate) source name.
  const {api, original, ppro} = setup();
  original.tracks[0].clips.forEach(c => c.selected = true);
  const context = await api.prepare(true); ready(context);
  const badClipId = context.clips[1].id;
  const badSeconds = context.clips[1].start.seconds; // placement time is keyed by source-clip position, not by the item's (post-rename, source-derived and possibly duplicate) name
  const shiftIfBad = (real) => (item, time, ...rest) =>
    real(item, time.seconds === badSeconds ? {...time, seconds: time.seconds + 1} : time, ...rest);
  const realGetEditor = ppro.SequenceEditor.getEditor;
  ppro.SequenceEditor.getEditor = seq => {
    const editor = realGetEditor(seq);
    return {...editor,
      createOverwriteItemAction: shiftIfBad(editor.createOverwriteItemAction.bind(editor)),
      createInsertProjectItemAction: shiftIfBad(editor.createInsertProjectItemAction.bind(editor))};
  };
  await assert.rejects(api.apply(context), new RegExp(`Stem placement verification failed after retrying:.*${badClipId}`));
});
// Placement tolerance. Live 2026-09-14: clip-042's raw boundaries sat 0.6 of a
// 48 kHz sample past a sample boundary (sub-frame too), so Premiere snapped the
// placed stem onto the grid and exact-tick verification failed on every retry
// even though the stem was within 20 µs of the raw clip. Sub-sample drift is
// forgiven; anything beyond one sample is still a real placement error.
function shiftEveryPlacementBy(ppro, seconds) {
  const realGetEditor = ppro.SequenceEditor.getEditor;
  ppro.SequenceEditor.getEditor = seq => {
    const editor = realGetEditor(seq);
    const shift = (real) => (item, time, ...rest) => real(item, {...time, seconds: time.seconds + seconds}, ...rest);
    return {...editor,
      createOverwriteItemAction: shift(editor.createOverwriteItemAction.bind(editor)),
      createInsertProjectItemAction: shift(editor.createInsertProjectItemAction.bind(editor))};
  };
}
test('a stem snapped by Premiere to within one sample of the raw clip still verifies (regression: 2026-09-14, off-grid clip-042)', async () => {
  const {api, ppro} = setup();
  const context = await api.prepare(); ready(context);
  shiftEveryPlacementBy(ppro, 0.6 / 48000); // the exact live deviation: 0.6 sample = 3,175,200 ticks
  await api.apply(context);
  assert.equal(context.applied, true);
});
test('a stem more than one sample off the raw clip still fails verification', async () => {
  const {api, ppro} = setup();
  const context = await api.prepare(); ready(context);
  shiftEveryPlacementBy(ppro, 3 / 48000);
  await assert.rejects(api.apply(context), /Stem placement verification failed after retrying:.*Δstart 15876000 ticks = 3\.00 samples/);
});
test('apply() retries a single flaky placement in place and succeeds, without discarding the whole batch (regression: 2026-09-14)', async () => {
  // Reported live on a different, larger (42-clip) batch: placement of the
  // very last clip in the batch mismatched once, exactly the same shape of
  // transient flakiness already confirmed for the export-side isolate
  // transaction. This confirms apply() self-heals the same way instead of
  // requiring a full re-Prepare/re-export over one flaky placement.
  const {api, original, ppro} = setup();
  const context = await api.prepare(); ready(context);
  const badSeconds = context.clips.find(c => c.trackIndex === 0 && c.start.seconds === 5).start.seconds;
  let misses = 0;
  const realGetEditor = ppro.SequenceEditor.getEditor;
  ppro.SequenceEditor.getEditor = seq => {
    const editor = realGetEditor(seq);
    return {...editor, createOverwriteItemAction(item, time, ...rest) {
      const shift = (time.seconds === badSeconds && misses < 1) ? (misses++, 1) : 0;
      return editor.createOverwriteItemAction(item, shift ? {...time, seconds: time.seconds + shift} : time, ...rest);
    }};
  };
  await api.apply(context); // must not throw -- the one miss self-heals within the retry loop
  assert.equal(context.applied, true);
});
// Native Amplify mock: Bypass/Left/Right, default 0 dB = (0+96)/144.
function mockAmplify(ppro) {
  // Starts time-varying (as a fresh live Amplify did) and refuses value
  // actions built outside a transaction or before static mode is committed.
  const makeParam=name=>{const p={displayName:name,value:0.6666666865348816,varying:true,
    async isTimeVarying(){return this.varying;},createKeyframe(v){return {v};},
    createSetTimeVaryingAction(){return ()=>{p.varying=false;};},
    createSetValueAction(key){
      if(!IN_TX) throw new Error('The script object is no longer valid.');
      if(p.varying) throw new Error('Param is still time-varying; commit static mode first.');
      return ()=>{p.value=key.v;};},
    async getValueAtTime(){return {value:this.value};}};return p;};
  const makeAmplify=()=>{const params=[makeParam('Bypass'),makeParam('Left'),makeParam('Right')];
    return {async getMatchName(){return 'ADBE Amplify';},async getParamCount(){return params.length;},async getParam(i){return params[i];},params};};
  ppro.AudioFilterFactory={getDisplayNames:async()=>['Amplify','Multiband Compressor'],createComponentByDisplayName:async()=>makeAmplify()};
}
// Mono variant, matching the real layout read live on 2026-09-25:
// Bypass, Channel Count, Link Sliders, Gain, 31 unnamed hidden channel
// slots, Link Keyframes. The only gain slider in use is "Gain" (index 3).
function mockAmplifyMono(ppro) {
  // Starts time-varying (as a fresh live Amplify did) and refuses value
  // actions built outside a transaction or before static mode is committed.
  const makeParam=name=>{const p={displayName:name,value:0.6666666865348816,varying:true,
    async isTimeVarying(){return this.varying;},createKeyframe(v){return {v};},
    createSetTimeVaryingAction(){return ()=>{p.varying=false;};},
    createSetValueAction(key){
      if(!IN_TX) throw new Error('The script object is no longer valid.');
      if(p.varying) throw new Error('Param is still time-varying; commit static mode first.');
      return ()=>{p.value=key.v;};},
    async getValueAtTime(){return {value:this.value};}};return p;};
  const makeAmplify=()=>{const params=[makeParam('Bypass'),makeParam('Channel Count'),makeParam('Link Sliders'),makeParam('Gain'),
      ...Array.from({length:31},()=>makeParam('')),makeParam('Link Keyframes')];
    return {async getMatchName(){return 'ADBE Amplify';},async getParamCount(){return params.length;},async getParam(i){return params[i];},params};};
  ppro.AudioFilterFactory={getDisplayNames:async()=>['Amplify','Multiband Compressor'],createComponentByDisplayName:async()=>makeAmplify()};
}
const gainDb=comp=>comp.params[1].value*144-96;
function ready(context) {
  context.outputStems = ['dialogue','effects','music'];
  for (const clip of context.clips) {
    clip.outputs = Object.fromEntries(['dialogue','effects','music'].map(role => [role, {path: `C:/outputs/${clip.id}-${role}.wav`}]));
    clip.result = {sample_rate: 48000, channels: 2, samples: Math.round((clip.exportDuration ?? clip.duration) * 48000)};
  }
}

// The live off-grid clip (2026-09-14): C0021.MP4 on a 29.97 sequence, start
// and end both 0.6 sample past a 48 kHz sample boundary, spanning 970.9996
// frames. Premiere placed its stem floored to 970 whole frames.
const FRAME_2997 = 8475667200;
const LIVE_START_TICKS = 110005685647200, LIVE_END_TICKS = 118235555323200;
function offGridSetup(options = {}) {
  const env = setup({frameTicks: FRAME_2997, ...options});
  const {original, clip, projectItem} = env;
  const source = projectItem('C0021.MP4');
  original.tracks[0].clips = [clip(source, LIVE_START_TICKS / 254016000000, LIVE_END_TICKS / 254016000000)];
  original.tracks[0].clips[0].selected = true;
  return env;
}
test('the mock reproduces the live failure: without the sequence timebase, Premiere\'s frame flooring leaves the stem one frame short and verification fails (2026-09-14)', async () => {
  const {api} = offGridSetup({exposeTimebase: false});
  const context = await api.prepare(true); ready(context);
  assert.equal(context.frameTicks, null);
  assert.equal(context.clips[0].offGrid, false);
  await assert.rejects(api.apply(context), /Δend -8473550400 ticks = -1601\.20 samples, source matches, enabled.*\[sequence frame: unknown\]/);
});
test('an off-grid raw clip is exported one frame long and placed with a whole-frame cover, so the stem fully covers it despite frame flooring (regression: 2026-09-14, clip-042/043 "C0021.MP4")', async () => {
  const {api, exports} = offGridSetup();
  const context = await api.prepare(true);
  assert.equal(context.frameTicks, FRAME_2997);
  const [target] = context.clips;
  assert.equal(target.offGrid, true);
  assert.equal(target.outTicks, String(971 * FRAME_2997), 'out point is the 971 whole frames that cover a 970.9996-frame clip');
  assert.equal(Number(target.exportStartTicks), Number(target.start.ticks) - Number(target.start.ticks) % FRAME_2997, 'export starts on the floored frame so the placed stem is sample-aligned (2026-09-17)');
  assert.equal(Number(target.exportEndTicks) - Number(target.exportStartTicks), 972 * FRAME_2997, 'export runs one frame past the cover');
  assert.ok(Math.abs(target.exportDuration - 972 * FRAME_2997 / 254016000000) < 1e-9);
  await api.exportClip(context, target, 'wav.epr', 'c0021.wav');
  assert.equal(exports.length, 1);
  assert.equal(target.renderInTicks, target.exportStartTicks, 'the render in point is the floored frame');
  assert.equal(target.renderOutTicks, target.exportEndTicks, 'the render out point is the padded export end');
  ready(context);
  await api.apply(context);
  assert.equal(context.applied, true);
  const stem = context.sequence.tracks.flatMap(t => t.clips).find(c => c.source.nativePath === target.outputs.dialogue.path);
  assert.ok(stem, 'stem placed on the new lane');
  const stemStart = Number((await stem.getStartTime()).ticks), stemEnd = Number((await stem.getEndTime()).ticks);
  assert.ok(stemStart <= Number(target.start.ticks) + 5292000 && stemStart > Number(target.start.ticks) - FRAME_2997, 'stem starts at the floored frame, not later than the raw clip');
  assert.ok(stemEnd >= Number(target.end.ticks) - 5292000 && stemEnd <= Number(target.end.ticks) + FRAME_2997, 'stem ends on the frame after the raw clip ends, never before it');
  assert.equal(stemEnd - stemStart, 971 * FRAME_2997);
});
test('on-grid clips on a sequence with a known timebase keep the exact-span export and placement', async () => {
  const {api, exports} = setup({frameTicks: 8467200000}); // 30 fps: the mock's 1-3 s / 5-7 s clips sit on whole frames
  const context = await api.prepare(); ready(context);
  for (const clip of context.clips) {
    assert.equal(clip.offGrid, false);
    assert.equal(clip.exportStartTicks, clip.start.ticks);
    assert.equal(clip.exportEndTicks, clip.end.ticks);
    assert.equal(clip.outTicks, String(Number(clip.end.ticks) - Number(clip.start.ticks)));
    assert.equal(clip.exportDuration, clip.duration);
  }
  await api.exportClip(context, context.clips[0], 'wav.epr', 'a.wav');
  assert.equal(context.clips[0].renderOutTicks, context.clips[0].end.ticks);
  await api.apply(context);
  assert.equal(context.applied, true);
  assert.equal(exports.length, 1);
});
test('sequenceFrameTicks falls back to SequenceSettings.getVideoFrameRate().ticksPerFrame and rejects implausible values', async () => {
  const {host} = setup();
  assert.equal(await host.sequenceFrameTicks({getSettings: async () => ({getVideoFrameRate: async () => ({ticksPerFrame: FRAME_2997, value: 29.97})})}), FRAME_2997);
  assert.equal(await host.sequenceFrameTicks({getSettings: async () => ({getVideoFrameRate: async () => ({value: 25})})}), 10160640000);
  assert.equal(await host.sequenceFrameTicks({getTimebase: async () => 'nonsense', getSettings: async () => ({})}), null);
  assert.equal(await host.sequenceFrameTicks({getTimebase: async () => '0'}), null);
  assert.equal(await host.sequenceFrameTicks({getTimebase: async () => { throw new Error('host'); }}), null);
  assert.equal(await host.sequenceFrameTicks({}), null);
});

for (const names of [['dialogue'], ['dialogue','effects'], ['dialogue','music'], ['dialogue','effects','music']]) {
  test(`only requested lanes inserted: ${names.join(', ')}`, async () => {
    const {api, calls} = setup();
    const context = await api.prepare(); ready(context);
    context.outputStems = names;
    for (const clip of context.clips) for (const name of Object.keys(clip.outputs)) if (!names.includes(name)) delete clip.outputs[name];
    await api.apply(context);
    assert.equal(calls.length, 3 * names.length);
    assert.equal(context.sequence.tracks.length, 3 + 2 * names.length);
    const labels = {dialogue:'Clean dialogue',effects:'Ambience',music:'Music'};
    assert.deepEqual(context.sequence.tracks.slice(3).map(t => t.name), names.flatMap(n => [`${labels[n]} · A1`,`${labels[n]} · A2`]));
    assert.equal(context.sequence.tracks[0].clips[0].inPoint, 7);
  });
}

test('per-clip plan retains gaps, source trims, repeated sources and cross-track overlaps; skips muted/disabled audio', async () => {
  const {api, original} = setup();
  const context = await api.prepare();
  assert.equal(context.mode, 'per_clip');
  assert.deepEqual(Array.from(context.clips, c => [c.trackIndex, c.start.seconds, c.end.seconds]), [[0,1,3],[0,5,7],[1,2,6]]);
  assert.equal((await context.clips[1].item.getInPoint()).seconds, 20);
  assert.equal(await context.clips[1].item.getSpeed(), 2);
  assert.equal(original.tracks[0].clips[0].disabled, false);
});

test('batch export: full-sequence check throttled, isolation incremental, render fingerprinted once via sealRender (2026-09-17)', async () => {
  const {api, original, host, project} = setup();
  const context = await api.prepare();
  let signatures = 0, asserts = 0;
  const realSignature = host.signature, realAssert = host.assertUnchanged;
  host.signature = async (...args) => { signatures++; return realSignature(...args); };
  host.assertUnchanged = async (...args) => { asserts++; return realAssert(...args); };
  context.deferRenderSignature = true;
  context.lastAssertMs = 0;
  for (const clip of context.clips) await api.exportClip(context, clip, 'wav.epr', `${clip.id}.wav`, {verifyOutput: async () => {}});
  // Three exports within 15 s: exactly one full-sequence check, and no render fingerprint yet.
  assert.equal(asserts, 1, `assertUnchanged calls: ${asserts}`);
  assert.equal(signatures, 0, `render signatures computed: ${signatures}`);
  assert.ok(context.clips.every(c => c.renderSignature === null));
  // The render is isolated on the last clip only: everything else disabled.
  const render = project.sequences.find(s => s !== original && s !== context.sequence);
  const last = context.clips[context.clips.length - 1];
  for (const track of render.tracks) for (const c of track.clips) {
    const isLast = track === render.tracks[last.trackIndex] && c.start === last.start.seconds;
    assert.equal(c.disabled, !isLast, `clip at ${c.start} on lane ${render.tracks.indexOf(track)}`);
  }
  await assert.rejects(api.assertExportsUnchanged(context), /not finalized/);
  await api.sealRender(context);
  assert.equal(signatures, 1);
  assert.ok(last.renderSignature);
  await api.assertExportsUnchanged(context);
  // Original untouched by isolation.
  assert.ok(original.tracks[0].clips.every(c => c.disabled === (c.start === 9)));
});

test('exports reuse one isolated render sequence and each clip range', async () => {
  const {api, original, exports, project} = setup();
  const context = await api.prepare();
  let verified=0;
  for (const clip of context.clips) {
    const signal=await api.exportClip(context, clip, 'wav.epr', `${clip.id}.wav`, {verifyOutput:async({check})=>{check();verified++;}});
    assert.equal(signal.outputVerified,true);
  }
  assert.equal(verified,context.clips.length);
  assert.equal(new Set(exports.map(e => e[0])).size, 1);
  assert.equal(project.sequences.filter(s => s !== original && s !== context.sequence).length, 1);
  for (let i = 0; i < exports.length; i++) {
    const [, , , preset, full] = exports[i];
    assert.equal(full, false); assert.equal(preset, 'wav.epr');
    assert.equal(context.clips[i].renderInTicks, context.clips[i].start.ticks);
    assert.equal(context.clips[i].renderOutTicks, context.clips[i].end.ticks);
  }
  assert.equal(original.tracks[0].clips.filter(c => !c.disabled).length, 2);
  await api.assertExportsUnchanged(context);
  context.renderSequence.inTime = context.clips[1].start;
  await assert.rejects(api.assertExportsUnchanged(context), /render sequence changed/);
  await api.releaseRender(context);
  assert.equal(project.sequences.filter(s => s !== original && s !== context.sequence).length, 0);
});

test('a track that returns a null gap placeholder from getTrackItems does not crash apply() (regression: 2026-09-14)', async () => {
  // Real hosts have been observed returning `null` entries from
  // getTrackItems(CLIP, false) for gap regions even though the
  // includeEmptyTrackItems flag is false -- reported by Dan as
  // "Cannot read properties of null (reading 'getStartTime')" in
  // signature(), called from assertUnchanged() during apply(), on a real
  // sequence whose stem lanes (added by an earlier per-clip batch in the
  // same session) only partially covered the timeline and so had gaps.
  const {api, original} = setup();
  original.tracks[0].clips.forEach(c => c.selected = true);
  const context = await api.prepare(true); ready(context);
  context.sequence.tracks[0].clips.push(null); // simulate the gap placeholder
  await api.apply(context); // would throw if signature()/inventory() didn't filter nulls
  assert.equal(context.applied, true);
});
test('stems occupy additional grouped lanes without changing raw trims, speed, video or original sequence', async () => {
  const {api, original, project, calls} = setup();
  const context = await api.prepare(); ready(context);
  await api.apply(context);
  assert.deepEqual(calls.map(c => [c.audio, c.time]), [[3,1],[3,5],[4,2],[5,1],[5,5],[6,2],[7,1],[7,5],[8,2]]);
  assert.equal(context.applied, true);
  assert.equal(project.opened, context.sequence);
  assert.equal(original.tracks[0].clips[0].source.getId(), 'linked-camera');
  assert.equal(context.sequence.tracks[0].clips[2].disabled, true);
  assert.equal(context.sequence.tracks[2].muted, true);
  assert.equal(context.sequence.videos[0].clips[0].start, 1);
  assert.equal(context.sequence.tracks[0].clips[0].inPoint, 7);
  assert.equal(context.sequence.tracks[0].clips[1].speed, 2);
  assert.equal(context.sequence.tracks[0].muted, true);
  assert.equal(original.tracks[0].muted, false);
  assert.deepEqual(context.sequence.tracks.slice(3).map(t => t.name), ['Clean dialogue · A1','Clean dialogue · A2','Ambience · A1','Ambience · A2','Music · A1','Music · A2']);
});

test('add clean tracks reuses a trailing empty audio track instead of landing further below it', async () => {
  const {api, original, track} = setup();
  original.tracks.push(track([])); // a pre-existing, completely empty 4th audio track
  const context = await api.prepare(); ready(context);
  assert.equal(context.sequence.tracks.length, 4); // the clone inherited the empty track too
  await api.apply(context);
  assert.equal(context.applied, true);
  // Without reuse this would be 10 (4 original + 6 brand-new lanes). Landing
  // at 9 proves the pre-existing empty track (index 3) was filled instead of
  // skipped over.
  assert.equal(context.sequence.tracks.length, 9);
  const labels = {dialogue:'Clean dialogue',effects:'Ambience',music:'Music'};
  assert.deepEqual(context.sequence.tracks.slice(3).map(t => t.name),
    ['dialogue','effects','music'].flatMap(n => [`${labels[n]} · A1`,`${labels[n]} · A2`]));
  // The two original dialogue source tracks are muted; the reused track and
  // the never-touched 'muted' track (index 2) are left as they were.
  assert.equal(context.sequence.tracks[0].muted, true);
  assert.equal(context.sequence.tracks[1].muted, true);
});
test('changed source trim blocks replacement even when timeline boundaries have not moved', async () => {
  const {api, calls} = setup();
  const context = await api.prepare(); ready(context);
  context.clips[0].item.inPoint++;
  await assert.rejects(api.apply(context), /changed/);
  assert.equal(calls.length, 0);
});

test('partial insertion failure restores raw mute states, mutes added lanes and prevents retry', async () => {
  const {api, original, ppro} = setup();
  const context = await api.prepare(); ready(context);
  // Corrupt every attempt (not just the first), including the in-place
  // retries introduced for the isolated "one flaky action" case above -- this
  // simulates a genuinely persistent placement failure, which retrying
  // cannot and must not paper over: it must still exhaust retries and fall
  // through to the existing failedApply recovery path.
  const realGetEditor = ppro.SequenceEditor.getEditor;
  ppro.SequenceEditor.getEditor = seq => {
    const editor = realGetEditor(seq);
    return {...editor, createOverwriteItemAction(item, time, ...rest) {
      return editor.createOverwriteItemAction(item, {...time, seconds: time.seconds + 1}, ...rest);
    }};
  };
  await assert.rejects(api.apply(context), /placement verification failed/);
  assert.equal(context.failedApply, true);
  assert.equal(context.sequence.tracks[0].muted, false);
  assert.equal(context.sequence.tracks[0].clips[0].inPoint, 7);
  assert.ok(context.sequence.tracks.slice(3).every(t => t.muted));
  assert.equal(original.tracks.length, 3);
  await assert.rejects(api.apply(context), /Run Batch Process Dialogue again to retry/);
});

for (const mode of ['missing', 'throws']) test(`optional track naming ${mode} does not interrupt stem placement`, async () => {
  const {api, original} = setup();
  const context = await api.prepare(); ready(context);
  const getTrack = context.sequence.getAudioTrack;
  context.sequence.getAudioTrack = async index => {
    const track = await getTrack(index);
    if (index >= 3) track.createSetNameAction = mode === 'missing' ? undefined : () => {throw Error('Unsupported API');};
    return track;
  };
  await api.apply(context);
  assert.equal(context.applied, true);
  assert.equal(context.failedApply, false);
  assert.equal(context.defaultTrackNames, true);
  assert.equal(context.sequence.tracks.length, 9);
  assert.ok(context.sequence.tracks.slice(3).every(t => !t.muted));
  assert.equal(context.sequence.tracks[0].clips[0].inPoint, 7);
  assert.equal(original.tracks[0].muted, false);
});

test('audio transitions on a processed track are removed on the pending clone during prepare', async () => {
  const {api, original, project, audioTransition} = setup();
  original.tracks[0].transitions.push(audioTransition(2.5, 5.5));
  const context = await api.prepare();
  assert.equal(project.sequences.length, 2);
  assert.equal(context.sequence.tracks[0].transitions.length, 0);
  assert.ok(context.clips.length);
});

test('a transition between two other, unselected clips on the same track is neither removed nor blocks a selected clip with no transition of its own', async () => {
  const {api, original, clip, audioTransition} = setup();
  const source = original.tracks[0].clips[0].source;
  original.tracks[0].clips.push(clip(source, 11, 13), clip(source, 13, 15));
  original.tracks[0].transitions.push(audioTransition(12.5, 13.5)); // between the two new, unselected clips
  original.tracks[0].clips[0].selected = true; // [1,3], no transition of its own
  const context = await api.prepare(true);
  assert.equal(context.clips.length, 1);
  assert.equal(context.crossfadePlan.length, 0);
  assert.equal(context.sequence.tracks[0].transitions.length, 1, 'an unrelated transition elsewhere on the track must survive strip');
});

test('capture crossfade plan only for boundaries between processed clips', async () => {
  const {api, original, audioTransition} = setup();
  original.tracks[0].transitions.push(audioTransition(2.5, 5.5));
  const full = await api.prepare();
  assert.equal(full.crossfadePlan.length, 1);
  assert.equal(full.crossfadePlan[0].rightStartTicks, String(Math.round(5 * 254016000000)));
  original.tracks[0].clips[0].selected = true;
  const partial = await api.prepare(true);
  assert.equal(partial.crossfadePlan.length, 0);
});

test('apply restores crossfades on the clean dialogue stem lane when the host supports it', async () => {
  const {api, original, crossfadeAdds, audioTransition} = setup();
  original.tracks[0].transitions.push(audioTransition(2.5, 5.5));
  const context = await api.prepare();
  ready(context);
  context.outputStems = ['dialogue'];
  for (const clip of context.clips) {
    clip.outputs = {dialogue: clip.outputs.dialogue};
    delete clip.outputs.effects;
    delete clip.outputs.music;
  }
  await api.apply(context);
  assert.equal(context.applied, true);
  assert.equal(context.crossfadeReport.applied, 1);
  assert.equal(crossfadeAdds.length, 1);
});

test('incomplete results stop before importing', async () => {
  const {api, project} = setup();
  const context = await api.prepare();
  await assert.rejects(api.apply(context), /Every clip/);
  assert.equal(project.items.length, 0);
});

test('unlinked media on other tracks does not crash prepare; unlinked dialogue is rejected', async () => {
  const {api, original, project, clip, projectItem} = setup();
  const ghost = clip(projectItem('ghost'), 0, 1);
  ghost.getProjectItem = async () => null;
  original.tracks[1].clips.push(ghost);
  original.tracks[0].clips.forEach(c => { c.selected = true; });
  const context = await api.prepare(true);
  assert.ok(context.clips.length);
  assert.equal(project.sequences.length, 2);
  const bad = clip(projectItem('offline'), 4, 5);
  bad.selected = true;
  bad.getProjectItem = async () => null;
  original.tracks[0].clips.push(bad);
  await assert.rejects(api.prepare(true), /linked project media/);
});

test('prepare accepts a 30-minute selected clip and rejects longer clips before cloning',async()=>{
 const {api,original,project}=setup();
 const clip=original.tracks[0].clips[0];clip.start=0;clip.end=1800;clip.selected=true;
 const context=await api.prepare(true);assert.equal(context.clips[0].duration,1800);
 const other=setup();other.original.tracks[0].clips[0].start=0;other.original.tracks[0].clips[0].end=1800.01;other.original.tracks[0].clips[0].selected=true;
 await assert.rejects(other.api.prepare(true),/30 minutes/);
});


test('handles extend scratch source only and import with hidden trims, leaving visible cut unchanged', async()=>{
  const {api,original,calls}=setup();
  const raw=original.tracks[0].clips[0]; raw.selected=true;
  const context=await api.prepare(true,{handlesEnabled:true,handleFrames:15});
  const c=context.clips[0];
  assert.equal(c.handles.head,0.5); assert.equal(c.handles.tail,0.5);
  assert.equal(c.exportDuration,3); assert.equal(Number(c.mediaInTicks)/254016000000,0.5);
  await api.exportClip(context,c,'wav.epr','handles.wav');
  const scratch=context.renderSequence.tracks[0].clips[0];
  assert.equal(scratch.start,0.5); assert.equal(scratch.end,3.5);
  assert.equal(scratch.inPoint,6.5); assert.equal(scratch.sourceOut,9.5);
  assert.equal(raw.start,1); assert.equal(raw.end,3); assert.equal(raw.inPoint,7);
  c.exportVerified=true; ready(context); await api.apply(context);
  assert.equal(calls[0].item.inPoint.seconds,0.5); assert.equal(calls[0].item.outPoint.seconds,2.5);
  assert.equal(context.sequence.tracks[3].clips[0].start,1);
  assert.equal(context.sequence.tracks[3].clips[0].end,3);
});

test('handles clamp separately at source and timeline boundaries and skip retimed media', async()=>{
  const {api,original}=setup(); const raw=original.tracks[0].clips[0];
  raw.selected=true; raw.start=0.2; raw.end=2.2; raw.inPoint=57.9;
  const context=await api.prepare(true,{handlesEnabled:true,handleFrames:15});
  assert.equal(context.clips[0].handles.head,0.2); assert.equal(context.clips[0].handles.tail,0.1);
  raw.selected=false; original.tracks[0].clips[1].selected=true;
  const retimed=await api.prepare(true,{handlesEnabled:true});
  assert.match(retimed.clips[0].handles.reason,/Normal-speed/); assert.equal(retimed.clips[0].mediaInTicks,undefined);
});

test('handles unavailable on old hosts safely retain exact-cut processing',async()=>{
  const {api,original}=setup(); const raw=original.tracks[0].clips[0]; raw.selected=true;
  raw.source.getMedia=async()=>({});
  const c=(await api.prepare(true,{handlesEnabled:true})).clips[0];
  assert.match(c.handles.reason,/bounds unavailable/); assert.equal(c.exportDuration,c.duration);
});

test('handled exports use fresh scratch clones and cannot discard an unconfirmed export',async()=>{
  const {api,original}=setup(); original.tracks[0].clips[0].selected=true; original.tracks[1].clips[0].selected=true;
  const context=await api.prepare(true,{handlesEnabled:true});
  await api.exportClip(context,context.clips[0],'p','a.wav'); const first=context.renderSequenceId;
  await assert.rejects(api.exportClip(context,context.clips[1],'p','b.wav'),/unconfirmed/);
  context.clips[0].exportVerified=true;
  await api.exportClip(context,context.clips[1],'p','b.wav'); assert.notEqual(context.renderSequenceId,first);
});

test('off-grid handles retain frame cover and sample alignment, with separate cache identities',async()=>{
  const env=offGridSetup(); const raw=env.original.tracks[0].clips[0]; raw.inPoint=2;
  raw.source.getMedia=async()=>({getDuration:()=>env.ppro.TickTime.createWithSeconds(1000)});
  const a=await env.api.prepare(true,{handlesEnabled:true,handleFrames:15});
  const c=a.clips[0], placementStart=Math.floor(Number(c.start.ticks)/FRAME_2997)*FRAME_2997;
  assert.equal(Number(c.exportStartTicks)+Number(c.mediaInTicks),placementStart);
  assert.equal(Number(c.outTicks)%FRAME_2997,0);
  ready(a); await env.api.apply(a);
  const b=await env.api.prepare(true,{handlesEnabled:true,handleFrames:30});
  assert.notEqual(c.id,b.clips[0].id);
});


test('handles are whole sequence frames: 15 frames at 29.97 is exactly 15 frames each side (frames since 2026-10-14)',async()=>{
  const env=offGridSetup(); const raw=env.original.tracks[0].clips[0]; raw.inPoint=2;
  raw.source.getMedia=async()=>({getDuration:()=>env.ppro.TickTime.createWithSeconds(1000)});
  const c=(await env.api.prepare(true,{handlesEnabled:true,handleFrames:15})).clips[0];
  const headTicks=Math.round(c.handles.head*254016000000), tailTicks=Math.round(c.handles.tail*254016000000);
  assert.ok(headTicks>0&&tailTicks>0);
  assert.equal(headTicks%FRAME_2997,0); assert.equal(tailTicks%FRAME_2997,0);
  assert.equal(headTicks,15*FRAME_2997); assert.equal(tailTicks,15*FRAME_2997);
  assert.equal(c.handles.headFrames,15); assert.equal(c.handles.tailFrames,15); assert.equal(c.handles.requestedFrames,15);
});


test('off-grid clips (source span one frame longer than the timeline span) still get handles instead of "retimed" (live 2026-09-21, C0021.MP4)',async()=>{
  const env=offGridSetup(); const raw=env.original.tracks[0].clips[0]; raw.inPoint=2;
  raw.sourceOut=2+971*FRAME_2997/254016000000;
  raw.source.getMedia=async()=>({getDuration:()=>env.ppro.TickTime.createWithSeconds(1000)});
  const c=(await env.api.prepare(true,{handlesEnabled:true,handleFrames:15})).clips[0];
  assert.ok(c.handles.head>0&&c.handles.tail>0,JSON.stringify(c.handles));
  assert.equal(c.handles.reason,undefined);
});


test('scratch trim readback failure prevents any export and preserves original cuts',async()=>{
 const {api,original,project,exports}=setup(); original.tracks[0].clips[0].selected=true;
 const context=await api.prepare(true,{handlesEnabled:true});
 const clone=context.sequence.createCloneAction;
 context.sequence.createCloneAction=()=>()=>{clone()();const scratch=project.sequences.at(-1);scratch.tracks[0].clips[0].createSetInPointAction=()=>()=>{};};
 await assert.rejects(api.exportClip(context,context.clips[0],'p','a.wav'),/did not preserve/);
 assert.equal(exports.length,0);assert.equal(original.tracks[0].clips[0].inPoint,7);
 assert.ok(context.renderHandleClip);
});

test('30-minute cut may export additional handles and off setting preserves old geometry',async()=>{
 const {api,original,ppro}=setup();const raw=original.tracks[0].clips[0];
 original.tracks[0].clips=[raw];raw.selected=true;raw.start=1;raw.end=1801;raw.inPoint=3;
 raw.source.getMedia=async()=>({getDuration:()=>ppro.TickTime.createWithSeconds(2000)});
 const c=(await api.prepare(true,{handlesEnabled:true})).clips[0];assert.equal(c.exportDuration,1802); // default 30 frames = 1 s per side (30 fps assumed here)
 const off=(await api.prepare(true)).clips[0];assert.equal(off.exportDuration,1800);assert.equal(off.handles,undefined);assert.notEqual(off.id,c.id);
});

test('Auto mute off: a full raw lane stays unmuted after Add clean tracks (2026-10-01)', async()=>{
  const {api,original}=setup();
  original.tracks[0].clips.forEach(c=>c.selected=true);
  const context=await api.prepare(true,{inPlace:true}); ready(context);
  context.autoMute=false;
  await api.apply(context);
  assert.equal(context.applied,true);
  assert.equal(original.tracks[0].muted,false);
});
test('Auto mute off: a partial lane gets no -96 dB Amplify and no WTV muted name (2026-10-01)', async()=>{
  const {api,original,ppro}=setup();
  mockAmplify(ppro);
  const target=original.tracks[0].clips[0]; target.selected=true;
  const context=await api.prepare(true,{inPlace:true}); ready(context);
  context.autoMute=false;
  await api.apply(context);
  assert.equal(context.applied,true);
  assert.equal(target.components.length,0);
  assert.equal(target.disabled,false);
  assert.ok(!(await target.getName()).endsWith('WTV muted'));
});

test('handle frames must be a whole number from 1 to 300 (2026-10-14)',async()=>{
 const {api,original}=setup(); original.tracks[0].clips[0].selected=true;
 for(const handleFrames of [0,301,12.5,NaN]) await assert.rejects(api.prepare(true,{handlesEnabled:true,handleFrames}),/whole number of frames from 1 to 300/);
 const c=(await api.prepare(true,{handlesEnabled:true,handleFrames:30})).clips[0];
 assert.equal(c.handles.requestedFrames,30); assert.match(c.id,/-h2-30f-/);
});
