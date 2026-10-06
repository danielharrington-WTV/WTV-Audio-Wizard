const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Simulated Premiere WAV writer: header with placeholder sizes first, data
// appended over time, sizes patched in only when the render completes.
function wavWriter(frames, channels = 2, rate = 48000, trailing = 0) {
  const align = channels * 2, dataBytes = frames * align;
  const buffer = Buffer.alloc(44 + dataBytes + (trailing ? 8 + trailing : 0));
  if (trailing) { buffer.write('LIST', 44 + dataBytes); buffer.writeUInt32LE(trailing, 48 + dataBytes); }
  buffer.write('RIFF', 0); buffer.writeUInt32LE(0, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * align, 28); buffer.writeUInt16LE(align, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(0, 40);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    // -20 dBFS tone, plus a single -3 dBFS hit at frame 48000 on channel 1.
    let v = 0.1 * Math.sin(2 * Math.PI * 1000 * f / rate);
    if (f === 48000 && c === 0) v = Math.pow(10, -3 / 20);
    buffer.writeInt16LE(Math.round(v * 32767), 44 + f * align + c * 2);
  }
  const state = {written: 44, done: false, buffer};
  return {
    state,
    grow(bytes) { state.written = Math.min(buffer.length, state.written + bytes); },
    finish() { state.written = buffer.length; buffer.writeUInt32LE(buffer.length - 8, 4); buffer.writeUInt32LE(dataBytes, 40); state.done = true; },
  };
}
function memoryIo(files) {
  const handles = new Map(); let next = 1;
  return {
    async lstat(p) { const w = files.get(p); if (!w) throw new Error('ENOENT'); return {size: w.state.written}; },
    async open(p) { const w = files.get(p); if (!w) throw new Error('ENOENT'); const fd = next++; handles.set(fd, w); return fd; },
    async close(fd) { handles.delete(fd); },
    async read(fd, buffer, offset, length, position) {
      const w = handles.get(fd); const avail = Math.max(0, Math.min(length, w.state.written - position));
      if (avail > 0) new Uint8Array(buffer, offset, avail).set(w.state.buffer.subarray(position, position + avail));
      return {bytesRead: avail};
    },
    openHandles: () => handles.size,
  };
}
function setup({frames = 48000 * 3, trailing = 0} = {}) {
  const files = new Map();
  const io = memoryIo(files);
  const exportCalls = [];
  let currentSig = 'sig-A';
  const sequence = {guid: {toString: () => 'seq-1'}, getSettings: async () => ({getAudioChannelCount: async () => 2}), getEndTime: async () => ({seconds: frames / 48000})};
  const project = {getActiveSequence: async () => sequence, lockedAccess: fn => fn(), executeTransaction(build) {const a = []; build({addAction: x => a.push(x)}); a.forEach(x => x()); return true;}};
  const ppro = {Project: {getActiveProject: async () => project}, EncoderManager: {getManager: async () => ({})}, Constants: {ExportType: {IMMEDIATELY: 1}},
    TickTime: {TIME_ZERO: {seconds: 0}, createWithSeconds: s => ({seconds: s})}};
  const host = {signature: async () => currentSig, transaction(p, l, b) {p.executeTransaction(b, l);}};
  const deleted = [];
  const fsMock = {getTemporaryFolder: async () => ({createFile: async name => {const p = `T:/${name}`; const w = wavWriter(frames, 2, 48000, trailing); files.set(p, w); return {nativePath: p, async delete() { deleted.push(p); files.delete(p); }};}})};
  let writer = null;
  const exportSync = {
    async exportSequenceWithRenderWait({outputNativePath, verifyOutput}) {
      exportCalls.push(outputNativePath);
      writer = files.get(outputNativePath);
      await verifyOutput({check: () => {}});
      return {outputVerified: true};
    },
  };
  // Each sleep advances the "render" by ~0.4 s of audio; finish after the data is all written.
  const sleep = async () => { if (writer && !writer.state.done) { if (writer.state.written < writer.state.buffer.length) writer.grow(48000 * 4 * 0.4); else writer.finish(); } };
  const box = {module: {exports: {}}, require: name => ({
    premierepro: ppro, './premiere.js': host, './per-clip.js': {inventory: async () => []}, './music-effects.js': {snapshot: async () => ''},
    './export-presets.js': {getWavPreset: async () => ({nativePath: 'preset.epr'})}, './export-sync.js': exportSync,
    './music-wav.js': require('../plugin/music-wav.js'), './loudness-meter.js': require('../plugin/loudness-meter.js'),
  })[name], Date, Error, JSON, Math, String, Number, Uint8Array, ArrayBuffer, DataView, Array, Promise, setTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/loudness-pass.js'), 'utf8'), box);
  const api = box.module.exports;
  const run = extra => api.run({fs: fsMock, io, sleep, addMarkers: false, ...extra});
  return {api, run, exportCalls, deleted, io, files, bumpSignature: () => { currentSig = 'sig-B'; }};
}

test('analysis streams while the render is still writing, and the result matches a from-scratch analysis', async () => {
  const {run, io} = setup();
  const progress = [];
  const result = await run({onProgress: p => progress.push(p)});
  assert.equal(result.render, 'streamed');
  assert.equal(result.channels, 2);
  assert.ok(Math.abs(result.duration_seconds - 3) < 1e-6);
  assert.ok(Math.abs(result.sample_peak_dbfs + 3) < 0.05, `peak ${result.sample_peak_dbfs}`);
  assert.equal(result.over_threshold_count, 1);
  assert.ok(Math.abs(result.over_threshold_events[0].position_seconds - 1) < 1e-6);
  assert.ok(progress.length > 3 && progress.every((p, i) => i === 0 || p > progress[i - 1]), 'progress climbs monotonically');
  assert.equal(progress[progress.length - 1], 100);
  assert.equal(io.openHandles(), 0, 'no file handle left open');
});

test('a trailing chunk after the data (bext/LIST) does not force a second full analysis: streamed frames never run past the data end', async () => {
  const {run} = setup({trailing: 1000});
  const result = await run({});
  assert.equal(result.render, 'streamed', result.stream_fallback_reason || '');
  assert.ok(Math.abs(result.duration_seconds - 3) < 1e-6);
  assert.equal(result.over_threshold_count, 1);
});

test('every run renders afresh even on an unchanged timeline (solo/mixer state is invisible to the API), and each render is deleted once measured (v0.8.1)', async () => {
  const {run, exportCalls, deleted} = setup();
  const first = await run({});
  assert.equal(first.render, 'streamed');
  assert.equal(exportCalls.length, 1);
  assert.deepEqual([...deleted], [exportCalls[0]], 'first render removed after measuring');
  const second = await run({peakFlagDbfs: -1}); // same timeline signature
  assert.equal(second.render, 'streamed');
  assert.equal(exportCalls.length, 2, 'no reuse: a second export happened');
  assert.equal(second.over_threshold_count, 0, 'new flag level applied to the fresh render');
  assert.equal(deleted.length, 2);
  assert.equal(deleted[1], exportCalls[1]);
});

test('streamingHeader finds fmt/data before the sizes are patched in, and returns null until both are present', async () => {
  const {api, io, files} = setup();
  const w = wavWriter(10); files.set('T:/x.wav', w);
  w.state.written = 20; // header not fully written yet
  let fd = await io.open('T:/x.wav');
  assert.equal(await api.streamingHeader(io, fd, 20), null);
  await io.close(fd);
  w.state.written = 44 + 8; // complete header (placeholder sizes) plus two frames
  fd = await io.open('T:/x.wav');
  const h = await api.streamingHeader(io, fd, 52);
  await io.close(fd);
  assert.equal(h.dataOffset, 44);
  assert.equal(h.channels, 2);
  assert.equal(h.rate, 48000);
  assert.equal(h.align, 4);
});
