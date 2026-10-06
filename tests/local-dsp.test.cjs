const test = require('node:test'), assert = require('node:assert/strict');
const {readWavFloat, writeWavFloat, attenuatePop, enhanceLowEnd} = require('../plugin/local-dsp.js');

function tone(length, freq, rate, amp = 0.5) {
  const arr = new Float32Array(length);
  for (let i = 0; i < length; i++) arr[i] = amp * Math.sin(2 * Math.PI * freq * i / rate);
  return arr;
}

test('WAV codec round-trips float audio (encode then decode)', () => {
  const rate = 48000;
  const left = tone(4800, 440, rate);
  const right = tone(4800, 220, rate);
  const buffer = writeWavFloat(rate, [left, right]);
  const decoded = readWavFloat(buffer);
  assert.equal(decoded.sampleRate, rate);
  assert.equal(decoded.channels.length, 2);
  assert.equal(decoded.channels[0].length, 4800);
  for (let i = 0; i < 4800; i += 137) {
    assert.ok(Math.abs(decoded.channels[0][i] - left[i]) < 1e-6);
    assert.ok(Math.abs(decoded.channels[1][i] - right[i]) < 1e-6);
  }
});

test('WAV codec decodes 16-bit PCM (not just the float format it writes)', () => {
  const rate = 44100;
  const frames = 100;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const writeTag = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeTag(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); writeTag(8, 'WAVE');
  writeTag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeTag(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, i < 50 ? 16384 : -16384, true);
  const decoded = readWavFloat(buffer);
  assert.equal(decoded.sampleRate, rate);
  assert.equal(decoded.channels.length, 1);
  assert.ok(Math.abs(decoded.channels[0][0] - 0.5) < 1e-4);
  assert.ok(Math.abs(decoded.channels[0][50] - -0.5) < 1e-4);
});

test('attenuatePop reduces a burst around the seed and leaves the rest mostly alone', () => {
  const rate = 48000;
  const length = rate * 2;
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = 0.01 * Math.sin(i * 0.05);
  const seedSample = rate; // 1.0s
  for (let i = seedSample - 500; i < seedSample + 500; i++) x[i] += 0.9 * Math.sin(i * 0.9);
  const {output, report} = attenuatePop([x], rate, 1.0);
  assert.equal(report.seed_seconds, 1.0);
  assert.ok(report.duration_seconds > 0);
  assert.ok(report.max_reduction_db === 16);
  // Peak inside the detected window should be meaningfully reduced.
  const before = Math.max(...Array.from(x.slice(seedSample - 200, seedSample + 200)).map(Math.abs));
  const after = Math.max(...Array.from(output[0].slice(seedSample - 200, seedSample + 200)).map(Math.abs));
  assert.ok(after < before * 0.7, `expected the burst peak to shrink meaningfully (before=${before}, after=${after})`);
  // Far from the seed, the signal is untouched.
  assert.equal(output[0][100], x[100]);
});

test('attenuatePop rejects a seed outside the signal', () => {
  const x = new Float32Array(1000);
  assert.throws(() => attenuatePop([x], 48000, 10), /outside the/);
});

test('enhanceLowEnd boosts 150-500Hz content and stays under the -1dBFS safety ceiling', () => {
  const rate = 48000;
  const length = rate; // 1s
  const x = tone(length, 300, rate, 0.6); // inside the boosted band
  const {output, report} = enhanceLowEnd([x], rate, 1.0);
  assert.equal(report.algorithm, 'whisper-body-v1-js');
  assert.ok(report.applied);
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(output[0][i]));
  const ceilingLinear = Math.pow(10, -1 / 20);
  assert.ok(peak <= ceilingLinear + 1e-6, `output peak ${peak} exceeds the -1dBFS safety ceiling`);
});

test('enhanceLowEnd rejects an out-of-range intensity', () => {
  const x = new Float32Array(1000);
  assert.throws(() => enhanceLowEnd([x], 48000, 5), /between 0.2 and 3.0/);
});

test('enhanceLowEnd rejects an unsupported sample rate', () => {
  const x = new Float32Array(1000);
  assert.throws(() => enhanceLowEnd([x], 4000, 1), /8-96 kHz/);
});
