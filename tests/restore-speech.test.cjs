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

// Harness copied from extract-ambience.test.cjs; Restore Speech reuses that
// pipeline with RESTORE_KIND (dialogue stem, restored-* files) and then mutes
// the originals through per-clip.js's silenceRawClips.
// One entry per `specs` item, on trackIndex 0 unless given: {name, start, end, selected, muted, disabled, transitions, speed, reversed, trackIndex}.
function setup(specs = [{name: 'clip-1', start: 0, end: 4, selected: true}], {rate = 48000, channels = 2, placementScale = 1, mutedNames = [], muteThrows = null} = {}) {
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
  const silenced = [];
  const perClip = {inventory: async s => s.entries, silenceRawClips: async (_project, context, clips) => {
    if (muteThrows) throw new Error(muteThrows);
    calls.push(`silence:${context.sequenceId}`); silenced.push(...clips);
  }};
  const extract = load('extract-ambience', n => ({
    'premierepro': ppro,
    './premiere.js': host,
    './export-sync.js': exportSync,
    './per-clip.js': perClip,
    './wav.js': {...wavMockWithStableRead(),waitForStableWavFile:async(file,expected,opts)=>{opts.check();wavMockWithStableRead().inspectWav(await file.read(),expected);}},
    './export-presets.js': {getWavPreset: async () => ({nativePath: 'preset'})},
  }[n]));
  const api = load('restore-speech', n => ({
    'premierepro': ppro,
    './extract-ambience.js': extract,
    './per-clip.js': perClip,
    './mute-tools.js': {isMuted: async entry => mutedNames.includes(entry.name)},
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
    const resultMatch = route.match(/^\/v1\/jobs\/([^/]+)\/result\/dialogue$/);
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
      const renderMatch = name.match(/^restored-render-\d+-(\d+)-/);
      const spec = renderMatch ? specs[Number(renderMatch[1])] : null;
      const readBytes = spec ? wav(Math.round((spec.end - spec.start) * rate), rate, channels) : new ArrayBuffer(44);
      const file = {nativePath: name, written: null, read: async () => readBytes, write: async bytes => { file.written = bytes;outputDurations.set(name,(bytes.byteLength-44)/(rate*channels*2)); }, delete: async () => { record.deleted = true; calls.push(`delete-file:${name}`); }};
      return file;
    },
  };
  const settings = api.restoreSettings({enhancer: 'gap_urgenet', separate_ambience: true, separate_music: true, ambience_only: true, dialogue_postprocess: true, deess_declick: true, separator: 'provided_stems', stems: []});
  const hooks = {check: () => {}, say: () => {}, sleep: async () => {}, binary: 'binary', outputFolder, request, settings};
  return {api, hooks, calls, sequences, project, assets, jobs, files, silenced};
}

test('happy path: Sidon job, restored clip on a new Restored speech track, original muted', async () => {
  const s = setup();
  const result = await s.api.run(s.hooks);
  assert.equal(result.succeeded, 1);
  assert.equal(result.trackAdded, true);
  assert.equal(result.muted, 1);
  assert.equal(result.muteError, null);
  const original = s.sequences[0];
  assert.equal(original.trackMeta[1].name, 'Rebuilt speech');
  assert.ok(original.entries.find(e => e.trackIndex === 1), 'restored clip placed on the new track');
  assert.equal(original.entries[0].sourceId, 'clip-1-original', 'original clip stays in place');
  assert.deepEqual(s.silenced.map(c => [c.trackIndex, c.name, c.start.seconds, c.end.seconds]), [[0, 'clip-1', 0, 4]]);
  assert.ok(s.calls.includes('WTV: add rebuilt speech track'));
  assert.equal(s.assets.size, 0);
  const [job] = [...s.jobs.values()];
  assert.equal(job, undefined, 'job deleted after download');
});

test('job settings: Sidon only, no separation, no finishing, sequence output rate', async () => {
  const s = setup([{name: 'clip-1', start: 0, end: 1, selected: true}], {rate: 44100, channels: 1});
  const seen = [];
  const request = s.hooks.request;
  s.hooks.request = async (route, options = {}) => {
    if (route === '/v1/jobs' && options.method === 'POST') seen.push(JSON.parse(options.body).settings);
    return request(route, options);
  };
  await s.api.run(s.hooks);
  assert.equal(seen.length, 1);
  const settings = seen[0];
  assert.equal(settings.enhancer, 'sidon');
  assert.equal(settings.enhancer_wet, 1);
  assert.equal(settings.separator, 'bandit_v2');
  assert.equal(settings.ambience_only, false);
  assert.equal(settings.separate_ambience, false);
  assert.equal(settings.separate_music, false);
  assert.equal(settings.dialogue_postprocess, false);
  assert.equal(settings.deess_declick, false);
  assert.equal(settings.output_rate, 44100);
});

test('a clip already muted by WTVAudioWizard is refused, the rest of the batch continues', async () => {
  const s = setup([
    {name: 'raw', start: 0, end: 2, selected: true},
    {name: 'clip-b', start: 2, end: 4, selected: true},
  ], {mutedNames: ['raw']});
  const result = await s.api.run(s.hooks);
  assert.equal(result.succeeded, 1);
  assert.match(result.results.find(r => r.name === 'raw').error, /muted by WTVAudioWizard/);
  assert.deepEqual(s.silenced.map(c => c.name), ['clip-b'], 'only the restored original is muted');
});

test('overlapping selections go to separate Restored speech lanes and every original is muted', async () => {
  const s = setup([
    {name: 'a', start: 0, end: 3, selected: true, trackIndex: 0},
    {name: 'b', start: 1, end: 4, selected: true, trackIndex: 1},
  ]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.succeeded, 2);
  const original = s.sequences[0];
  assert.equal(original.entries.filter(e => e.trackIndex >= 2).length, 2);
  assert.notEqual(original.entries.find(e => e.trackIndex === 2)?.trackIndex, original.entries.find(e => e.trackIndex === 3)?.trackIndex);
  assert.deepEqual(s.silenced.map(c => c.name).sort(), ['a', 'b']);
});

test('nothing placed means nothing muted', async () => {
  const s = setup([{name: 'a', start: 0, end: 2, selected: true, transitions: 1}]);
  const result = await s.api.run(s.hooks);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].error, /rebuilding speech/);
  assert.equal(result.muted, 0);
  assert.equal(s.silenced.length, 0);
});

test('a mute failure is reported, not thrown; the restored clip stays', async () => {
  const s = setup(undefined, {muteThrows: 'Amplify missing'});
  const result = await s.api.run(s.hooks);
  assert.equal(result.succeeded, 1);
  assert.equal(result.muted, 0);
  assert.equal(result.muteError, 'Amplify missing');
});

test('Cancel after the first clip still mutes that clip\'s original, then stops', async () => {
  const s = setup([
    {name: 'a', start: 0, end: 2, selected: true},
    {name: 'b', start: 2, end: 4, selected: true},
  ]);
  let placements = 0;
  const say = s.hooks.say;
  s.hooks.say = text => { if (/^Placing/.test(text)) placements++; say(text); };
  s.hooks.check = () => { if (placements >= 1 && s.silenced.length === 0 && s.calls.includes('WTV: add rebuilt speech track')) throw new Error('Rebuild Speech stopped.'); };
  await assert.rejects(s.api.run(s.hooks), /Rebuild Speech stopped\. The 1 original clip\(s\) rebuilt before the stop were muted\./);
  assert.deepEqual(s.silenced.map(c => c.name), ['a']);
});

test('requires a selection', async () => {
  const s = setup([{name: 'a', start: 0, end: 2, selected: false}]);
  await assert.rejects(s.api.run(s.hooks), /Select one or more audio clips on the timeline before rebuilding speech/);
});

test('sidonProblem explains a stale service or a missing install', () => {
  const s = setup();
  assert.match(s.api.sidonProblem([{id: 'gap_urgenet', available: true}]), /Restart the updated service/);
  assert.match(s.api.sidonProblem([{id: 'sidon', available: false}]), /setup-sidon\.bat/);
  assert.equal(s.api.sidonProblem([{id: 'sidon', available: true}]), null);
});

test('Auto mute off: restored clips are placed but originals stay audible (2026-10-01)', async () => {
  const s = setup();
  const result = await s.api.run({...s.hooks, autoMute: false});
  assert.equal(result.succeeded, 1);
  assert.equal(result.muted, 0);
  assert.equal(result.autoMute, false);
  assert.equal(s.silenced.length, 0);
});
