const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { exportSync, wavMockWithStableRead } = require('./plugin-test-require.cjs');

function tick(seconds) {
  return {seconds, ticks: String(Math.round(seconds * 254016000000)), subtract(other) { return tick(this.seconds - other.seconds); }};
}
function wav(samples, rate = 48000, channels = 2) {
  const b = new ArrayBuffer(44 + samples * channels * 2), v = new DataView(b);
  const tag = (offset, text) => [...text].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, b.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, b.byteLength - 44, true); return b;
}

// One entry per `specs` item, on trackIndex 0 unless given: {name, start, end, selected, muted, disabled, transitions, speed, reversed, trackIndex}.
function setup(specs = [{name: 'clip-1', start: 0, end: 4, selected: true}], {rate = 48000, channels = 2, placementScale = 1} = {}) {
  const calls = [];
  const outputDurations=new Map();
  function makeEntries(specList) {
    return specList.map((spec, index) => ({
      item: {getIsSelected: async () => spec.selected !== false, getSpeed: async () => spec.speed ?? 1, isSpeedReversed: async () => spec.reversed ?? false,
        createSetDisabledAction: () => () => {}},
      trackIndex: spec.trackIndex ?? 0, index, sourceId: `${spec.name}-original`, start: tick(spec.start), end: tick(spec.end),
      duration: spec.end - spec.start, name: spec.name, enabled: !spec.disabled, muted: Boolean(spec.muted), transitions: spec.transitions || 0,
    }));
  }

  function makeSequence(entries, trackCount) {
    const seq = {
      guid: {toString: () => `seq-${seq.serial}`}, serial: makeSequence.serial = (makeSequence.serial ?? -1) + 1,
      entries, trackCount, trackMeta: {},
      getSettings: async () => ({getAudioSampleRate: async () => ({value: rate}), getAudioChannelCount: async () => channels}),
      getAudioTrackCount: async () => seq.trackCount,
      getAudioTrack: async i => {
        if (!seq.trackMeta[i]) seq.trackMeta[i] = {muted: false, name: null};
        const meta = seq.trackMeta[i];
        return {isMuted: async () => meta.muted, setMute: async v => { meta.muted = v; return true; }, createSetNameAction: name => () => { meta.name = name; }};
      },
      getProjectItem: async () => ({createSetNameAction: () => () => {}}),
      createSetInPointAction: () => () => {}, createSetOutPointAction: () => () => {},
      createCloneAction: () => () => {
        const clone = makeSequence(entries.map(e => ({...e})), seq.trackCount);
        sequences.push(clone);
      },
    };
    return seq;
  }
  const sequences = [];
  const trackCount = 1 + Math.max(0, ...specs.map(s => s.trackIndex ?? 0));
  const original = makeSequence(makeEntries(specs), trackCount);
  sequences.push(original);

  const rootItems = [];
  let nextId = 1;
  function makeBin(name) { const items = []; return {name, items, getItems: async () => items.slice(), getId: () => `bin-${name}`}; }
  const root = {name: 'Root', getItems: async () => rootItems.slice(), getId: () => 'root', createBinAction(name) { return () => { rootItems.push(makeBin(name)); }; }};
  const project = {
    getActiveSequence: async () => original,
    getSequences: async () => sequences,
    lockedAccess(fn) { fn(); },
    executeTransaction(build) { const actions = []; build({addAction: a => actions.push(a)}); actions.forEach(a => a()); return true; },
    deleteSequence: async s => { calls.push('delete-scratch'); const i = sequences.indexOf(s); if (i >= 0) sequences.splice(i, 1); return true; },
    importFiles: async (paths, _suppress, target) => {
      const dest = target.items ?? rootItems;
      // Stable id per imported item -- captured once at creation, not
      // recomputed on every getId() call (extract-ambience.js's placement
      // verification calls it more than once and must see the same value).
      for (const p of paths) { const id = `imported-${nextId++}`; dest.push({nativePath:p,getId: () => id, getMediaFilePath: async () => p, createSetNameAction: () => () => {}, createSetInOutPointsAction: () => () => {}}); }
      return true;
    },
    getRootItem: async () => root,
  };

  function editorFor(seq) {
    return {
      createOverwriteItemAction: (item, startTick, _ripple, trackIndex) => () => {
        const idx = seq.entries.findIndex(e => e.trackIndex === trackIndex && e.start.ticks === startTick.ticks);
        const placed = {item: {getIsSelected: async () => false, createSetDisabledAction: () => () => {}}, trackIndex, index: seq.entries.length, sourceId: item.getId(),
          start: startTick, end: tick(startTick.seconds + (outputDurations.get(item.path ?? item.nativePath)*placementScale)), duration: (outputDurations.get(item.path ?? item.nativePath)*placementScale), name: 'placed', enabled: true, muted: false, transitions: 0};
        if (idx >= 0) seq.entries[idx] = placed; else seq.entries.push(placed);
      },
      createInsertProjectItemAction: (item, startTick, _videoTrack, audioTrackIndex) => () => {
        if (audioTrackIndex >= seq.trackCount) seq.trackCount = audioTrackIndex + 1;
        seq.entries.push({item: {getIsSelected: async () => false, createSetDisabledAction: () => () => {}}, trackIndex: audioTrackIndex, index: seq.entries.length, sourceId: item.getId(),
          start: startTick, end: tick(startTick.seconds + (outputDurations.get(item.path ?? item.nativePath)*placementScale)), duration: (outputDurations.get(item.path ?? item.nativePath)*placementScale), name: 'placed', enabled: true, muted: false, transitions: 0});
      },
    };
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
  const api = load('extract-ambience', n => ({
    'premierepro': ppro,
    './premiere.js': host,
    './export-sync.js': exportSync,
    './per-clip.js': {inventory: async s => s.entries},
    './wav.js': {...wavMockWithStableRead(),waitForStableWavFile:async(file,expected,opts)=>{opts.check();wavMockWithStableRead().inspectWav(await file.read(),expected);}},
    './export-presets.js': {getWavPreset: async () => ({nativePath: 'preset'})},
  }[n]));

  // The samples uploaded as an "export" carry the real duration (encoded by
  // outputFolder.createFile below from the entry's own spec), so a
  // POST /v1/assets can record real sample counts per asset_id, and a
  // POST /v1/jobs looks that up by asset_id -- this keeps the duration
  // checks in extract-ambience.js (result vs. target.duration) honest for
  // clips of different lengths, not just a fixed 1-second stand-in.
  const assets = new Set();
  const assetSamples = new Map();
  const jobs = new Map();
  let serial = 0;
  function samplesFromWav(bytes) { return (bytes.byteLength - 44) / (channels * 2); }
  const request = async (route, options = {}) => {
    if (route === '/v1/assets' && options.method === 'POST') {
      const aid = `asset-${serial++}`; assets.add(aid);
      assetSamples.set(aid, samplesFromWav(options.body));
      return {json: async () => ({asset_id: aid})};
    }
    if (route === '/v1/jobs' && options.method === 'POST') {
      const jid = `job-${serial++}`;
      const body = JSON.parse(options.body);
      const samples = assetSamples.get(body.tracks[0].asset_id) ?? Math.round(rate);
      jobs.set(jid, {settings: body.settings, samples});
      return {json: async () => ({job_id: jid})};
    }
    const jobMatch = route.match(/^\/v1\/jobs\/([^/]+)$/);
    if (jobMatch && (!options.method || options.method === 'GET')) {
      const job = jobs.get(jobMatch[1]);
      return {json: async () => ({status: 'done', stage: 'separating', progress: 100,
        result: {sample_rate: rate, channels, samples: job.samples}})};
    }
    const resultMatch = route.match(/^\/v1\/jobs\/([^/]+)\/result\/effects$/);
    if (resultMatch) { const job = jobs.get(resultMatch[1]); return {arrayBuffer: async () => wav(job.samples, rate, channels)}; }
    if (options.method === 'DELETE') { assets.delete(route.split('/').at(-1)); jobs.delete(route.split('/').at(-1)); return {}; }
    throw new Error(`Unhandled route ${route}`);
  };

  const files = new Map();
  const outputFolder = {
    createFile: async name => {
      if (files.has(name)) throw new Error(`Duplicate file name in test: ${name}`);
      const record = {deleted: false};
      files.set(name, record);
      // Scratch render files are named ambience-render-<track>-<index>-<uniq>.wav
      // -- <index> matches the originating spec's position, so the fake
      // "export" can carry that clip's real duration.
      const renderMatch = name.match(/^ambience-render-\d+-(\d+)-/);
      const spec = renderMatch ? specs[Number(renderMatch[1])] : null;
      const readBytes = spec ? wav(Math.round((spec.end - spec.start) * rate), rate, channels) : new ArrayBuffer(44);
      const file = {nativePath: name, written: null, read: async () => readBytes, write: async bytes => { file.written = bytes;outputDurations.set(name,(bytes.byteLength-44)/(rate*channels*2)); }, delete: async () => { record.deleted = true; calls.push(`delete-file:${name}`); }};
      return file;
    },
  };
  const settings = {enhancer: 'none', separate_ambience: true, separate_music: false, dialogue_postprocess: false, deess_declick: false, separator: 'bandit_v2', stems: []};
  const hooks = {check: () => {}, say: () => {}, sleep: async () => {}, binary: 'binary', outputFolder, request, settings};
  return {api, hooks, calls, sequences, project, assets, jobs, files};
}

test('happy path: adds a new Ambience track and places the extracted clip; original untouched', async () => {
  const s = setup();
  const result = await s.api.run(s.hooks);
  assert.equal(result.clips, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(result.trackAdded, true);
  assert.equal(s.sequences.length, 1); // render clone was deleted
  const original = s.sequences[0];
  assert.equal(original.entries[0].sourceId, 'clip-1-original', 'original clip untouched');
  const ambience = original.entries.find(e => e.trackIndex === 1);
  assert.ok(ambience, 'a clip was placed on the new track');
  assert.equal(original.trackMeta[1].name, 'Ambience');
  assert.ok(s.calls.includes('render'));
  assert.ok(s.calls.includes('WTV: add ambience track'));
  assert.equal(s.assets.size, 1); // the job keeps its upload; the service's age-based cleanup removes it later
});

test('batch: multiple selected clips land on the same new Ambience track (insert once, then overwrite)', async () => {
  const s = setup([
    {name: 'clip-a', start: 0, end: 2, selected: true},
    {name: 'clip-b', start: 2, end: 4, selected: true},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.succeeded, 2);
  assert.equal(result.trackAdded, true);
  const original = s.sequences[0];
  const onAmbienceTrack = original.entries.filter(e => e.trackIndex === 1);
  assert.equal(onAmbienceTrack.length, 2, 'both extracted clips land on the same new track');
  assert.equal(original.entries.find(e => e.sourceId === 'clip-a-original').trackIndex, 0, 'raw clip-a untouched');
  assert.equal(original.entries.find(e => e.sourceId === 'clip-b-original').trackIndex, 0, 'raw clip-b untouched');
  assert.ok(s.calls.includes('WTV: add ambience track'));
  assert.ok(s.calls.includes('WTV: place ambience clip'));
});

test('unselected clips are left completely untouched and produce no extraction', async () => {
  const s = setup([
    {name: 'clip-a', start: 0, end: 2, selected: true},
    {name: 'clip-b', start: 2, end: 4, selected: false},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.clips, 1);
  assert.equal(result.results[0].name, 'clip-a');
});

test('an ineligible selected clip fails with a clear reason but does not stop the rest of the batch', async () => {
  const s = setup([
    {name: 'clip-a', start: 0, end: 2, selected: true, muted: true},
    {name: 'clip-b', start: 2, end: 4, selected: true},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  const failure = result.results.find(r => r.name === 'clip-a');
  assert.match(failure.error, /muted/);
});

test('rejects a selected clip with audio transitions, reporting per-clip', async () => {
  const s = setup([{name: 'clip-a', start: 0, end: 2, selected: true, transitions: 1}]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /transitions/);
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

test('the extracted output file is never deleted; the scratch render export is', async () => {
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

test('job settings reach the service with ambience-only flags and the sequence output_rate', async () => {
  const s = setup();
  let submitted;
  const request = s.hooks.request;
  s.hooks.request = async (route, options) => {
    if (route === '/v1/jobs' && options.method === 'POST') submitted = JSON.parse(options.body).settings;
    return request(route, options);
  };
  await s.api.run(s.hooks);
  assert.equal(submitted.enhancer, 'none');
  assert.equal(submitted.separate_ambience, true);
  assert.equal(submitted.separate_music, false);
  assert.equal(submitted.output_rate, 48000);
});

test('overlapping selections use separate ambience lanes without replacing either output', async()=>{
 const s=setup([{name:'a',start:0,end:2,trackIndex:0},{name:'b',start:0,end:2,trackIndex:1}]);
 const result=await s.api.run(s.hooks);assert.equal(result.succeeded,2);
 const placed=s.sequences[0].entries.filter(e=>e.sourceId.startsWith('imported'));
 assert.equal(placed.length,2);assert.notEqual(placed[0].trackIndex,placed[1].trackIndex);
 assert.ok(placed.every(e=>e.duration===2));
});
test('cancellation during unconfirmed export retains render and scratch WAV', async()=>{
 const s=setup();s.hooks.check=()=>{if(s.calls.includes('render'))throw Error('cancelled');};
 await assert.rejects(s.api.run(s.hooks),/cancelled/);
 assert.equal(s.sequences.length,2);assert.ok([...s.files.values()].every(f=>!f.deleted));
});

test('shortened placement stops the batch and mutes the affected output lane',async()=>{
 const s=setup([{name:'a',start:0,end:4},{name:'b',start:8,end:10}],{placementScale:.5});
 await assert.rejects(s.api.run(s.hooks),/Batch stopped.*muted/);
 assert.equal(s.calls.filter(c=>c==='render').length,1);
 assert.equal(s.sequences[0].trackMeta[1].muted,true);
});
