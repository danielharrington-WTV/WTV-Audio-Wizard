// Learn noise / Remove noise (2026-10-15): learn-noise.js, remove-noise.js,
// noise-prints.js and their panel wiring.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const {exportSync} = require('./plugin-test-require.cjs');
const prints = require('../plugin/noise-prints.js');

const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32);
function wav(samples, rate = 48000, channels = 2) {
  const b = new ArrayBuffer(44 + samples * channels * 2), v = new DataView(b);
  const tag = (offset, text) => [...text].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, b.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, b.byteLength - 44, true); return b;
}
function load(name, requireFn) {
  const box = {module: {exports: {}}, require: requireFn, console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../plugin/${name}.js`), 'utf8'), box);
  return box.module.exports;
}
const read = name => fs.readFileSync(path.join(__dirname, `../plugin/${name}`), 'utf8');

test('noise prints are remembered per project, newest 40 kept, bad entries dropped', () => {
  let raw = prints.remember('{}', '/a.prproj', {profileId: ID, serviceUrl: 'http://192.168.0.176:8756', summary: {seconds: 2, noise_rms_dbfs: -52.4}}, 10);
  raw = prints.remember(raw, '/b.prproj', {profileId: ID2, summary: {seconds: 1}}, 20);
  assert.equal(prints.printFor(raw, '/a.prproj').profileId, ID);
  assert.equal(prints.printFor(raw, '/b.prproj').summary.noise_rms_dbfs, null);
  assert.equal(prints.printFor(raw, null), null);
  assert.equal(prints.printFor(prints.forget(raw, '/a.prproj'), '/a.prproj'), null);
  assert.equal(prints.printFor(prints.remember(raw, '/c', {profileId: 'nope'}), '/c'), null);
  assert.deepEqual(prints.parse('not json'), {projects: {}});
  let many = '{}';
  for (let i = 0; i < 45; i++) many = prints.remember(many, `/p${i}`, {profileId: ID}, i);
  const kept = Object.keys(prints.parse(many).projects);
  assert.equal(kept.length, prints.MAX_PROJECTS); assert.ok(!kept.includes('/p0') && kept.includes('/p44'));
  assert.match(prints.describe(prints.printFor(raw, '/a.prproj'), () => 'today'), /^Noise print: 2\.0 s, -52 dBFS, learned today\.$/);
  assert.match(prints.describe(null), /Learn noise/);
});

test('Remove noise settings: raw path, the print, no finishing; ranges checked', () => {
  const api = load('remove-noise', n => ({'./extract-ambience.js': {}, './restore-speech.js': {}, './mute-tools.js': {}})[n]);
  const factory = {enhancer: 'gap_urgenet', dialogue_postprocess: true, level_dialogue: true, deess: true, separate_music: true, denoise_profile_id: null, output_rate: 48000};
  const s = api.noiseSettings(factory, ID, {reduction: 18, threshold: 3});
  assert.deepEqual([s.enhancer, s.dialogue_postprocess, s.level_dialogue, s.deess, s.separate_music, s.separate_ambience, s.denoise_profile_id, s.denoise_reduction_db, s.denoise_threshold_db],
    ['none', false, false, false, false, false, ID, 18, 3]);
  assert.equal(factory.enhancer, 'gap_urgenet', 'factory untouched');
  assert.equal(api.noiseSettings(factory, ID).denoise_reduction_db, 12);
  assert.throws(() => api.noiseSettings(factory, ID, {reduction: 41}), /Noise reduction must be 0 to 40/);
  assert.throws(() => api.noiseSettings(factory, ID, {threshold: -7}), /Noise threshold must be -6 to 24/);
  assert.throws(() => api.noiseSettings(factory, null), /Learn noise/);
  assert.throws(() => api.noiseSettings({enhancer: 'none'}, ID), /Update it/);
  assert.throws(() => api.noiseSettings(null, ID), /Connect/);
});

test('Remove noise runs the per-clip pipeline with its own kind and mutes what it placed', async () => {
  const seen = [];
  const results = [{name: 'a', source: {name: 'a'}}, {name: 'b', error: 'nope'}];
  const make = ({mute = async placed => placed.length, fail = null} = {}) => load('remove-noise', n => ({
    './extract-ambience.js': {run: async hooks => { seen.push(hooks.kind); if (fail) { const e = new Error(fail); e.results = results; throw e; } return {results, succeeded: 1, clips: 2}; }},
    './restore-speech.js': {muteOriginals: mute},
    './mute-tools.js': {isMuted: async entry => entry.name === 'muted'},
  })[n]);
  const out = await make().run({settings: {}});
  assert.equal(seen[0].track, 'Noise removed'); assert.equal(seen[0].stem, 'dialogue'); assert.equal(seen[0].clipSuffix, ' · Denoised');
  assert.equal(out.muted, 1);
  assert.equal((await make().run({autoMute: false})).muted, 0);
  assert.match((await make({mute: async () => { throw new Error('locked'); }}).run({})).muteError, /locked/);
  await assert.rejects(make({fail: 'Stopped.'}).run({}), /Stopped\. The 1 original clip\(s\) denoised before the stop were muted\./);
  await assert.rejects(seen[0].preflight({name: 'muted'}), /Unmute it first/);
});

function learnSetup({inSeconds = 10, outSeconds = 12, rate = 48000, channels = 2, renderSeconds, noiseDb = -50} = {}) {
  const calls = [];
  const bytes = wav(Math.round((renderSeconds ?? outSeconds - inSeconds) * rate), rate, channels);
  const file = {nativePath: '/tmp/noise.wav', written: false, deleted: false, read: async () => bytes, delete: async () => { file.deleted = true; }};
  const sequence = {
    getInPoint: async () => ({seconds: inSeconds}), getOutPoint: async () => ({seconds: outSeconds}),
    getSettings: async () => ({getAudioSampleRate: async () => ({value: rate}), getAudioChannelCount: async () => channels}),
  };
  const ppro = {
    Project: {getActiveProject: async () => ({getActiveSequence: async () => sequence})},
    Constants: {ExportType: {IMMEDIATELY: 1}},
    EncoderManager: {getManager: async () => ({exportSequence: async (seq, type, out, preset, full) => { calls.push({export: {seq: seq === sequence, out, full}}); file.written = true; return true; }})},
  };
  const api = load('learn-noise', n => ({
    'premierepro': ppro, './export-sync.js': exportSync,
    './export-presets.js': {getWavPreset: async (_fs, spec) => { calls.push({preset: spec}); return {nativePath: 'preset.epr'}; }},
  })[n]);
  const request = async (route, options = {}) => {
    calls.push({route, method: options.method || 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined});
    if (route === '/v1/assets') return {json: async () => ({asset_id: 'c'.repeat(32)})};
    if (route === '/v1/noise-profile') return {json: async () => ({profile_id: ID, summary: {seconds: outSeconds - inSeconds, noise_rms_dbfs: noiseDb}})};
    return {json: async () => ({})};
  };
  const hooks = {
    fs: {getTemporaryFolder: async () => ({createFile: async () => file})}, binary: 'binary', request, sleep: async () => {}, say: () => {},
    io: {lstat: async () => ({size: file.written ? bytes.byteLength : 0})},
  };
  return {api, calls, file, hooks};
}

test('Learn noise renders the In/Out range of the active sequence, learns, and cleans up', async () => {
  const {api, calls, file, hooks} = learnSetup();
  const learned = await api.run(hooks);
  assert.equal(learned.profileId, ID); assert.equal(learned.inSeconds, 10);
  const exp = calls.find(c => c.export).export;
  assert.deepEqual([exp.seq, exp.full], [true, false], 'the active sequence, In/Out range only');
  assert.deepEqual({...calls.find(c => c.preset).preset}, {rate: 48000, channels: 2});
  assert.deepEqual(calls.filter(c => c.route).map(c => `${c.method} ${c.route}`), ['POST /v1/assets', 'POST /v1/noise-profile', `DELETE /v1/assets/${'c'.repeat(32)}`]);
  assert.equal(calls.find(c => c.route === '/v1/noise-profile').body.asset_id, 'c'.repeat(32));
  assert.ok(file.deleted);
});

test('Learn noise refuses a missing or too long range, a wrong-length render and silence', async () => {
  for (const [a, b] of [[0, 0.3], [0, 300]]) {
    const {api, hooks, calls} = learnSetup({inSeconds: a, outSeconds: b});
    await assert.rejects(api.run(hooks), /Mark In and Out .*0\.5–60 seconds of background noise only/);
    assert.ok(!calls.some(c => c.export), 'nothing rendered');
  }
  const short = learnSetup({renderSeconds: 1.5});
  await assert.rejects(short.api.run(short.hooks), /1\.50 s, not the 2\.00 s In\/Out range/);
  const silent = learnSetup({noiseDb: -120});
  await assert.rejects(silent.api.run(silent.hooks), /rendered as silence/);
  assert.ok(silent.calls.some(c => c.route === `/v1/assets/${'c'.repeat(32)}` && c.method === 'DELETE'), 'upload removed even on failure');
});

test('panel wiring: buttons, Options fields, route, per-project print and the service guard', () => {
  const html = read('index.html'), main = read('main.js');
  for (const id of ['learnNoise', 'removeNoise', 'noisePrintStatus', 'noiseReduction', 'noiseThreshold']) assert.ok(html.includes(`id="${id}"`), id);
  const options = html.slice(html.indexOf('id="cleanDialogueSection"'), html.indexOf('id="toggleLevelsStems"'));
  assert.ok(options.includes('id="noiseReduction"') && options.includes('id="noiseThreshold"'), 'in Options > Clean dialogue');
  const mainTab = html.slice(0, html.indexOf('id="tabOptions"'));
  assert.ok(mainTab.includes('id="learnNoise"') && mainTab.includes('id="removeNoise"'), 'buttons on the Main tab');
  assert.match(main, /action\('learnNoise'/); assert.match(main, /action\('removeNoise'/);
  assert.match(main, /serviceCapabilities\.includes\('noise_profile_v1'\)/);
  assert.match(main, /noisePrints\.remember\(storedNoisePrints\(\), key, print\)/);
  const api = require('../plugin/local-api.js');
  assert.match(fs.readFileSync(require.resolve('../plugin/local-api.js'), 'utf8'), /noise-profile/);
  assert.equal(typeof api.requestLocal, 'function');
});
