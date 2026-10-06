const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { exportSync } = require('./plugin-test-require.cjs');

function setup() {
  const tracks = () => [{name: 'Original audio', muted: false, createSetNameAction(value) {return () => {this.name = value;};}, async isMuted() {return this.muted;}, async setMute(value) {this.muted = value; return true;}, async getTrackItems() {return [];}}];
  function makeBin(name, {hostListing = true} = {}) {
    const items = [];
    const raw = {name, items, getId: () => `bin-${name}`};
    if (hostListing) raw.getItems = async () => items.slice();
    raw.folderView = {getItems: async () => items.slice()};
    return raw;
  }
  const rootItems = [];
  const root = {name: 'Root', getItems: async () => rootItems.slice(), getId: () => 'root',
    createBinAction(name) {return () => {rootItems.push(makeBin(name));};}};
  function sequence(key) {
    const s = {guid: {toString: () => key}, name: key, tracks: tracks(), duration: 10,
      async getSettings() {return {getAudioSampleRate: async () => ({value: 48000}), getAudioChannelCount: async () => 2};},
      async getEndTime() {return {seconds: this.duration, ticks: String(this.duration*100)};},
      async getAudioTrackCount() {return this.tracks.length;}, async getVideoTrackCount() {return 0;},
      async getAudioTrack(i) {return this.tracks[i];},
      async getProjectItem() {return {createSetNameAction: name => () => {s.name = name;}};},
      createCloneAction: () => () => project.sequences.push(sequence('clone'))};
    return s;
  }
  const project = {sequences: [], items: rootItems,
    async getActiveSequence() {return this.sequences[0];}, async getSequences() {return this.sequences;},
    lockedAccess(fn) {fn();}, executeTransaction(build) {const actions=[]; build({addAction(a) {actions.push(a);}}); actions.forEach(a => a()); return true;},
    async getRootItem() {return root;},
    async importFiles(paths, _suppress, target) {
      const dest = target.items ?? rootItems;
      dest.push(...paths.map(p => ({getId: () => p, getMediaFilePath: async () => p})));
      return true;
    },
    async openSequence(s) {this.opened = s; return true;}, async setActiveSequence() {return true;}};
  project.sequences.push(sequence('original'));
  const calls = [];
  const ppro = {Project: {getActiveProject: async () => project}, Constants: {TrackItemType: {CLIP: 1}, ExportType: {IMMEDIATELY: 1}}, TickTime: {TIME_ZERO: 0},
    ClipProjectItem: {cast: x => x}, FolderItem: {cast: item => item && item.items ? item.folderView : null}, FolderProjectItem: {cast: item => item && item.items ? item.folderView : null},
    SequenceEditor: {getEditor: s => ({createInsertProjectItemAction(item, time, video, audio, limited) {
      return () => {calls.push({item, time, video, audio, limited}); s.tracks.push(...tracks());};
    }})},
    EncoderManager: {getExportFileExtension: async () => 'wav', getManager: async () => ({exportSequence: async (...args) => {calls.push(args); return true;}})}};
  const box = {module: {exports: {}}, require: name => name === './export-sync.js' ? exportSync : ppro, Set, Map, Date, Error, JSON};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/premiere.js'), 'utf8'), box);
  return {host: box.module.exports, project, calls, rootItems, makeBin};
}
test('resumeAppliedClone reconstructs a usable context from an already-finished clone, including Clean dialogue paths', async () => {
  const {host, project} = setup();
  const finished = project.sequences[0];
  finished.name = 'Foo_WTVAudioWizard_1234567890';
  const cleanItem = {
    getStartTime: async () => ({ticks: '0', seconds: 0}), getEndTime: async () => ({ticks: '100', seconds: 1}),
    isDisabled: async () => false,
    getProjectItem: async () => ({getId: () => 'clean-1', getMediaFilePath: async () => 'C:/clean.wav'}),
  };
  finished.tracks = [
    {name: 'Clean dialogue', muted: false, async isMuted() {return false;}, async getTrackItems() {return [cleanItem];}},
    {name: 'Raw audio', muted: true, async isMuted() {return true;}, async getTrackItems() {return [];}},
  ];
  const resumed = await host.resumeAppliedClone();
  assert.ok(resumed);
  assert.equal(resumed.applied, true);
  assert.equal(resumed.failedApply, false);
  assert.equal(resumed.originalId, null);
  assert.equal(resumed.rate, 48000);
  assert.equal(resumed.channels, 2);
  assert.equal(resumed.dialoguePaths.length, 1);
  assert.equal(resumed.dialoguePaths[0], 'C:/clean.wav');
});

test('resumeAppliedClone returns null for a sequence that is not one of this plugin\'s finished clones', async () => {
  const {host, project} = setup();
  project.sequences[0].name = 'An ordinary untouched sequence';
  assert.equal(await host.resumeAppliedClone(), null);
  project.sequences[0].name = 'Foo_WTVAudioWizard_1234_PENDING';
  assert.equal(await host.resumeAppliedClone(), null);
});

test('clones and applies only to new tracks, preserving original', async () => {
  const {host, project, calls} = setup();
  const original = project.sequences[0];
  const context = await host.cloneActive();
  await host.applyStems(context, ['C:/a.wav', 'C:/b.wav', 'C:/c.wav']);
  assert.equal(original.name, 'original');
  assert.equal(original.tracks.length, 1);
  assert.equal(original.tracks[0].muted, false);
  assert.equal(context.sequence.tracks[0].muted, true);
  assert.deepEqual(calls.map(x => x.audio), [1, 2, 3]);
  assert.ok(calls.every(x => x.time === 0 && x.video === -1 && x.limited));
  assert.equal(project.opened, context.sequence);
  await assert.rejects(host.applyStems(context, []));
});

for (const labels of [['Clean dialogue'], ['Clean dialogue','Ambience'], ['Clean dialogue','Music']]) {
  test(`full sequence inserts only ${labels.join(', ')}`, async () => {
    const {host, calls} = setup();
    const context = await host.cloneActive();
    await host.applyStems(context, labels.map((_,i) => `C:/${i}.wav`), labels);
    assert.equal(calls.length, labels.length);
    assert.deepEqual(context.sequence.tracks.slice(1).map(t => t.name), labels);
  });
}

for (const mode of ['missing', 'throws']) test(`full sequence completes when track naming ${mode}`, async () => {
  const {host, project} = setup();
  const context = await host.cloneActive();
  const getTrack = context.sequence.getAudioTrack.bind(context.sequence);
  context.sequence.getAudioTrack = async index => {
    const track = await getTrack(index);
    if (index > 0) track.createSetNameAction = mode === 'missing' ? undefined : () => {throw Error('Unsupported API');};
    return track;
  };
  await host.applyStems(context, ['C:/dialogue.wav', 'C:/ambience.wav', 'C:/music.wav']);
  assert.equal(context.applied, true);
  assert.equal(context.defaultTrackNames, true);
  assert.equal(project.sequences[0].tracks[0].muted, false);
  assert.equal(context.sequence.tracks[0].muted, true);
  assert.ok(context.sequence.tracks.slice(1).every(t => !t.muted));
});
test('rejects clone changes before import', async () => {
  const {host, project} = setup();
  const context = await host.cloneActive();
  context.sequence.duration = 11;
  await assert.rejects(host.applyStems(context, ['a']), /changed/);
  assert.equal(project.items.length, 0);
});
test('imports stems into an Audio Wizard bin', async () => {
  const {host, project} = setup();
  const context = await host.cloneActive();
  await host.applyStems(context, ['C:/a.wav', 'C:/b.wav']);
  const root = await project.getRootItem();
  const bins = await root.getItems();
  assert.equal(bins.length, 1);
  assert.equal(bins[0].name, 'Audio Wizard');
  assert.equal((await bins[0].folderView.getItems()).length, 2);
});
test('imports when the bin ProjectItem lacks getItems but FolderItem.cast lists children', async () => {
  const {host, project, calls, rootItems, makeBin} = setup();
  rootItems.length = 0;
  rootItems.push(makeBin('Audio Wizard', {hostListing: false}));
  const context = await host.cloneActive();
  await host.applyStems(context, ['C:/a.wav']);
  assert.equal(calls.length, 1);
  assert.equal((await rootItems[0].folderView.getItems()).length, 1);
});
test('rejects ambiguous clone identity', async () => {
  const {host, project} = setup();
  project.sequences[0].createCloneAction = () => () => {};
  await assert.rejects(host.cloneActive(), /unique clone/);
});
test('rejects ambiguous clone identity with diagnostic candidate names', async () => {
  const {host, project} = setup();
  // Simulate two genuinely new, unrelated sequences appearing in the same
  // diff window (a real ambiguous case, not the nest false-positive below).
  project.sequences[0].createCloneAction = () => () => {
    project.sequences.push({guid: {toString: () => 'clone-a'}, name: 'clone-a'});
    project.sequences.push({guid: {toString: () => 'clone-b'}, name: 'clone-b'});
  };
  await assert.rejects(host.cloneActive(), /found 2 candidate sequence\(s\): "clone-a", "clone-b"/);
});
test('cloneActive is not fooled into ambiguity when the active sequence is missing from its own pre-clone snapshot (as editing inside a nest may cause)', async () => {
  const {host, project} = setup();
  const original = project.sequences[0];
  const realGetSequences = project.getSequences.bind(project);
  let first = true;
  project.getSequences = async () => {
    if (first) { first = false; return (await realGetSequences()).filter(s => s !== original); }
    return realGetSequences();
  };
  const context = await host.cloneActive();
  assert.notEqual(context.sequenceId, original.guid.toString());
  assert.equal(context.originalId, original.guid.toString());
  assert.equal(project.sequences.length, 2);
});
test('full export passes the clone and exportFull', async () => {
  const {host, calls} = setup();
  const context = await host.cloneActive();
  let verified=false;
  const signal=await host.exportWav(context, 'preset.epr', 'audio.wav', {verifyOutput:async({check})=>{check();verified=true;}});
  assert.equal(verified,true);assert.equal(signal.outputVerified,true);
  assert.equal(calls[0][0], context.sequence);
  assert.equal(calls[0][4], true);
});
test('useActive returns a working context on the active sequence with no clone created', async () => {
  const {host, project} = setup();
  const original = project.sequences[0];
  const context = await host.useActive();
  assert.equal(project.sequences.length, 1);
  assert.equal(context.sequence, original);
  assert.equal(context.sequenceId, original.guid.toString());
  assert.equal(context.originalId, null);
  assert.equal(context.inPlace, true);
  assert.equal(context.rate, 48000);
  assert.equal(context.channels, 2);
});
test('in-place context on a nest still resolves when getSequences() omits the active sequence (live 2026-09-17)', async () => {
  const {host, project} = setup();
  const original = project.sequences[0];
  project.getSequences = async () => []; // a nested sequence is not listed, only active
  const context = await host.useActive();
  assert.equal(await host.resolveContextSequence(context), original);
  await host.assertUnchanged(context);
  await host.applyStems(context, ['C:/a.wav']);
  assert.equal(context.applied, true);
});
test('a null entry in project.getSequences() does not crash lookups (live 2026-09-17, clip 115/158)', async () => {
  const {host, project} = setup();
  const original = project.sequences[0];
  project.sequences.push(null, {guid: null});
  assert.equal(await host.findSequence(project, original.guid.toString()), original);
  assert.equal((await host.listSequences(project)).length, 1);
  const context = await host.useActive();
  await host.assertUnchanged(context);
});
test('applyStems with an in-place context does not rename the sequence', async () => {
  const {host, project} = setup();
  const original = project.sequences[0];
  const context = await host.useActive();
  await host.applyStems(context, ['C:/a.wav']);
  assert.equal(project.sequences.length, 1);
  assert.equal(original.name, 'original');
  assert.equal(context.applied, true);
  assert.equal(context.sequence.tracks[0].muted, true);
});
test('applyStems failure on an in-place context reports the sequence, not a clone, as retained', async () => {
  const {host} = setup();
  const context = await host.useActive();
  const old = context.sequence.tracks[0];
  old.setMute = async value => {if (value) return false; old.muted = value; return true;};
  await assert.rejects(host.applyStems(context, ['a', 'b', 'c']), /Original sequence retained for inspection; use Undo if unsure\./);
});
test('mute failure restores old tracks and mutes added stems', async () => {
  const {host} = setup();
  const context = await host.cloneActive();
  const old = context.sequence.tracks[0];
  old.setMute = async value => {if (value) return false; old.muted = value; return true;};
  await assert.rejects(host.applyStems(context, ['a', 'b', 'c']), /restored/);
  assert.equal(old.muted, false);
  assert.ok(context.sequence.tracks.slice(1).every(t => t.muted));
  assert.equal(context.applied, false);
});

test('applyStems with Auto mute off leaves the raw tracks audible (2026-10-01)', async () => {
  const {host} = setup();
  const context = await host.useActive();
  context.autoMute = false;
  await host.applyStems(context, ['C:/a.wav']);
  assert.equal(context.applied, true);
  assert.equal(context.sequence.tracks[0].muted, false);
});
