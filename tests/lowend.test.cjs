const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { exportSync, wavMockWithStableRead } = require('./plugin-test-require.cjs');
// local-dsp.js is pure JS with no dependencies, so it's loaded for real here
// rather than mocked -- both to synthesize realistic test WAVs and because
// lowend.js now runs enhanceLowEnd in-panel instead of calling the
// /v1/lowend service (2026-09-22).
const localDsp = require('../plugin/local-dsp.js');

function tick(seconds) {
  return {seconds, ticks: String(Math.round(seconds * 254016000000)), subtract(other) { return tick(this.seconds - other.seconds); }};
}

function makeTestWav(rate, channels) {
  const length = rate * 4; // fixed-length synthetic clip; mock render/export doesn't validate duration
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) arr[i] = 0.2 * Math.sin(2 * Math.PI * 300 * i / rate);
    chans.push(arr);
  }
  return localDsp.writeWavFloat(rate, chans);
}

// Builds a sequence with one clip per `specs` entry:
// {name, start, end, selected, muted, disabled, transitions, speed, reversed}.
function setup(specs = [{name: 'clip-1', start: 0, end: 4, selected: true}], {rate = 48000, channels = 2} = {}) {
  const calls = [];
  function makeEntries(specList) {
    return specList.map((spec, index) => {
      const source = {getId: () => `${spec.name}-original`, getMediaFilePath: async () => `C:/${spec.name}.wav`};
      const item = {
        getInPoint: async () => tick(0), getOutPoint: async () => tick(spec.end - spec.start),
        getProjectItem: async () => source, getSpeed: async () => spec.speed ?? 1, isSpeedReversed: async () => spec.reversed ?? false,
        getName: async () => spec.name, createSetDisabledAction: () => () => {},
        getIsSelected: async () => spec.selected !== false,
      };
      return {item, trackIndex: 0, index, sourceId: `${spec.name}-original`, start: tick(spec.start), end: tick(spec.end),
        duration: spec.end - spec.start, name: spec.name, enabled: !spec.disabled, muted: Boolean(spec.muted), transitions: spec.transitions || 0};
    });
  }

  function makeSequence(entries) {
    const seq = {
      guid: {toString: () => `seq-${seq.serial}`}, serial: makeSequence.serial = (makeSequence.serial ?? -1) + 1,
      entries,
      getSettings: async () => ({getAudioSampleRate: async () => ({value: rate}), getAudioChannelCount: async () => channels}),
      getAudioTrackCount: async () => 1,
      getAudioTrack: async () => ({setMute: async () => { calls.push('unmute-render'); return true; }}),
      getProjectItem: async () => ({createSetNameAction: () => () => {}}),
      createSetInPointAction: () => () => {}, createSetOutPointAction: () => () => {},
      createCloneAction: () => () => {
        const clone = makeSequence(entries.map(e => ({...e})));
        sequences.push(clone);
      },
    };
    return seq;
  }
  const sequences = [];
  const original = makeSequence(makeEntries(specs));
  sequences.push(original);

  const rootItems = [];
  let nextId = 1;
  function makeBin(name) {
    const items = [];
    return {name, items, getItems: async () => items.slice(), getId: () => `bin-${name}`};
  }
  const root = {name: 'Root', getItems: async () => rootItems.slice(), getId: () => 'root',
    createBinAction(name) {return () => {rootItems.push(makeBin(name));};}};
  const project = {
    getActiveSequence: async () => original,
    getSequences: async () => sequences,
    lockedAccess(fn) { fn(); },
    executeTransaction(build) { const actions = []; build({addAction: a => actions.push(a)}); actions.forEach(a => a()); return true; },
    deleteSequence: async s => { calls.push('delete-scratch'); const i = sequences.indexOf(s); if (i >= 0) sequences.splice(i, 1); return true; },
    importFiles: async (paths, _suppress, target) => {
      const dest = target.items ?? rootItems;
      for (const p of paths) dest.push({getId: () => `imported-${nextId++}`, getMediaFilePath: async () => p, createSetNameAction: () => () => {}, createSetInOutPointsAction: () => () => {}});
      return true;
    },
    getRootItem: async () => root,
  };

  function editorFor(seq) {
    return {createOverwriteItemAction: (item, startTick, ripple, trackIndex) => () => {
      const idx = seq.entries.findIndex(e => e.trackIndex === trackIndex && e.start.ticks === startTick.ticks);
      if (idx < 0) throw new Error('No clip at that position to overwrite');
      const old = seq.entries[idx];
      const newItem = {
        getInPoint: async () => tick(0), getOutPoint: async () => tick(old.end.seconds - old.start.seconds),
        getProjectItem: async () => item, getSpeed: async () => 1, isSpeedReversed: async () => false,
        getName: async () => `${old.name} fixed`, createSetDisabledAction: () => () => {}, getIsSelected: async () => false,
      };
      seq.entries[idx] = {...old, sourceId: item.getId(), item: newItem};
    }};
  }

  const ppro = {
    Project: {getActiveProject: async () => project},
    ClipProjectItem: {cast: x => x},
    FolderItem: {cast: item => item && item.items ? item : null},
    FolderProjectItem: {cast: item => item && item.items ? item : null},
    TickTime: {TIME_ZERO: tick(0)},
    Constants: {ExportType: {IMMEDIATELY: 1}},
    EncoderManager: {getManager: async () => ({exportSequence: async () => { calls.push('render'); return true; }})},
    SequenceEditor: {getEditor: seq => editorFor(seq)},
  };

  function load(name, requireFn) {
    const box = {module: {exports: {}}, require: requireFn};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../plugin/${name}.js`), 'utf8'), box);
    return box.module.exports;
  }
  const host = load('premiere', n => n === './export-sync.js' ? exportSync : ppro);
  const realTransaction = host.transaction;
  host.transaction = (project, label, build) => { calls.push(label); return realTransaction(project, label, build); };
  const api = load('lowend', n => ({
    'premierepro': ppro,
    './premiere.js': host,
    './export-sync.js': exportSync,
    './per-clip.js': {inventory: async s => s.entries},
    './wav.js': wavMockWithStableRead(),
    './export-presets.js': {getWavPreset: async () => ({nativePath: 'preset'})},
    './local-dsp.js': localDsp,
  }[n]));

  const audio = makeTestWav(rate, channels);

  const files = new Map();
  const outputFolder = {
    createFile: async (name) => {
      if (files.has(name)) throw new Error(`Duplicate file name in test: ${name}`);
      const record = {deleted: false};
      files.set(name, record);
      const file = {
        nativePath: name, written: null,
        read: async () => audio,
        write: async (bytes) => { file.written = bytes; },
        delete: async () => { record.deleted = true; calls.push(`delete-file:${name}`); },
      };
      return file;
    },
  };
  const hooks = {
    check: () => {}, say: () => {}, sleep: async () => {}, binary: 'binary', outputFolder,
    // No longer called by lowend.js (enhanceLowEnd runs in-panel now), but
    // kept since run()'s signature still destructures it -- harmless if
    // unused (see HANDOFF.md's 2026-09-22 entry).
    request: async () => { throw new Error('lowend.js should not call request/the network any more'); },
  };
  return {api, hooks, calls, sequences, project, files};
}

test('happy path: enhances the one selected clip and overwrites just its range', async () => {
  const s = setup();
  const result = await s.api.run(s.hooks);
  assert.equal(result.clips, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  assert.equal(s.sequences.length, 1); // render clone was deleted
  assert.notEqual(s.sequences[0].entries[0].sourceId, 'clip-1-original');
  assert.ok(s.calls.includes('render'));
  assert.ok(s.calls.includes('WTV: enhance low end'));
  assert.equal(result.results[0].algorithm, 'whisper-body-v1-js');
});

test('batch: every selected clip is enhanced independently', async () => {
  const s = setup([
    {name: 'clip-a', start: 0, end: 2, selected: true},
    {name: 'clip-b', start: 2, end: 4, selected: true},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.clips, 2);
  assert.equal(result.succeeded, 2);
  // .map()/.sort() on a vm-context array produce a vm-context array, which
  // deepEqual would (correctly) treat as structurally distinct from an
  // outer-realm literal despite identical contents -- compare via a plain
  // outer-realm array instead.
  const names = Array.from(result.results, r => r.name).sort();
  assert.deepEqual(names, ['clip-a', 'clip-b']);
  assert.notEqual(s.sequences[0].entries[0].sourceId, 'clip-a-original');
  assert.notEqual(s.sequences[0].entries[1].sourceId, 'clip-b-original');
});

test('unselected clips are left completely untouched', async () => {
  const s = setup([
    {name: 'clip-a', start: 0, end: 2, selected: true},
    {name: 'clip-b', start: 2, end: 4, selected: false},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.clips, 1);
  assert.equal(result.results[0].name, 'clip-a');
  assert.equal(s.sequences[0].entries[1].sourceId, 'clip-b-original');
});

test('an ineligible selected clip fails with a clear reason but does not stop the rest of the batch', async () => {
  const s = setup([
    {name: 'clip-a', start: 0, end: 2, selected: true, muted: true},
    {name: 'clip-b', start: 2, end: 4, selected: true},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.clips, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const failure = result.results.find(r => r.name === 'clip-a');
  assert.match(failure.error, /muted/);
  // The other selected clip still succeeded despite clip-a's failure.
  assert.notEqual(s.sequences[0].entries[1].sourceId, 'clip-b-original');
});

test('rejects a selected clip with audio transitions, reporting per-clip', async () => {
  const s = setup([{name: 'clip-a', start: 0, end: 2, selected: true, transitions: 1}]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /transitions/);
});

test('rejects a selected sped-up or reversed clip, reporting per-clip', async () => {
  const s = setup([{name: 'clip-a', start: 0, end: 2, selected: true, speed: 2}]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /normal-speed/);
});

test('requires at least one selected clip', async () => {
  const s = setup([{name: 'clip-a', start: 0, end: 2, selected: false}]);
  await assert.rejects(s.api.run(s.hooks), /Select one or more/);
});

test('requires an active sequence', async () => {
  const s = setup();
  s.project.getActiveSequence = async () => null;
  await assert.rejects(s.api.run(s.hooks), /Activate a sequence/);
});

test('the enhanced clip\'s output file is never deleted; the scratch render export is', async () => {
  const s = setup();
  const result = await s.api.run(s.hooks);
  const outputPath = result.results[0].output_path;
  const outputRecord = s.files.get(outputPath);
  assert.ok(outputRecord, 'output file was created');
  assert.equal(outputRecord.deleted, false);
  const scratchDeletes = [...s.files.entries()].filter(([name]) => name !== outputPath);
  assert.ok(scratchDeletes.length >= 1);
  for (const [, record] of scratchDeletes) assert.equal(record.deleted, true);
});

test('regression: enhancing clean dialogue updates context.dialoguePaths so Fix a pop still recognizes the clip', async () => {
  const s = setup();
  const context = {dialoguePaths: ['C:/clip-1.wav']};
  const result = await s.api.run({...s.hooks, context});
  assert.equal(result.succeeded, 1);
  assert.equal(context.dialoguePaths.length, 2);
  assert.ok(context.dialoguePaths.includes('C:/clip-1.wav'));
  assert.ok(context.dialoguePaths.includes(result.results[0].output_path));
});

test('selected intensity reaches the DSP call unchanged; omitted intensity defaults to one', async () => {
  for (const intensity of [undefined, .2, 3]) {
    const s = setup();
    const result = await s.api.run({...s.hooks, intensity});
    assert.equal(result.results[0].intensity, intensity ?? 1);
  }
});

test('invalid intensity fails before timeline operations', async () => {
  const s = setup();
  await assert.rejects(s.api.run({...s.hooks, intensity: 3.1}), /intensity/);
  assert.equal(s.calls.length, 0);
});

test('never calls the network any more: enhance low end runs entirely in-panel (2026-09-22)', async () => {
  const s = setup();
  await s.api.run(s.hooks); // hooks.request throws if called; not calling it is the assertion
});
