const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFingerprint,
  packSummary,
  unpackSummary,
  validateSummary,
  load,
  save,
  hashString,
} = require('../plugin/music-analysis-cache.js');

function summary(blocks = 100, rate = 48000) {
  const samples = blocks * 960;
  const levels = new Float64Array(blocks);
  const peaks = new Float64Array(blocks);
  for (let i = 0; i < blocks; i++) { levels[i] = 0.1; peaks[i] = 0.2; }
  return { rate, channels: 2, samples, peak: 0.2, levels, peaks };
}

test('pack and unpack preserves analysis summaries', () => {
  const original = summary(50);
  const restored = unpackSummary(packSummary(original));
  assert.equal(restored.rate, original.rate);
  assert.equal(restored.samples, original.samples);
  assert.deepEqual(Array.from(restored.levels), Array.from(original.levels));
});

test('fingerprint changes when duck settings or reference change', () => {
  const base = {
    passSignature: '{"seq":1}',
    stripClipVolume: true,
    analysisSettings: { duck_db: 10 },
    dialogueReference: { mode: 'tracks', trackIds: ['5', '9'] },
    rate: 48000,
    channels: 2,
    duration: 120,
    presetPath: 'preset.epr',
  };
  const a = buildFingerprint(base);
  const b = buildFingerprint({ ...base, analysisSettings: { duck_db: 12 } });
  const c = buildFingerprint({ ...base, dialogueReference: { mode: 'tracks', trackIds: ['5'] } });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(buildFingerprint(base), a);
});

test('load returns cached summaries for matching fingerprint', async () => {
  const storage = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } };
  const files = new Map();
  const folder = {
    async createFile(name) {
      const record = { name, text: '' };
      files.set(name, record);
      return {
        async write(text) { record.text = text; },
        async read() { return record.text; },
        async delete() { files.delete(name); },
      };
    },
    async getEntry(name) {
      const record = files.get(name);
      if (!record) throw new Error('missing');
      return { async read() { return record.text; }, async delete() { files.delete(name); } };
    },
  };
  const fs = {
    async getDataFolder() {
      return {
        async getEntry() { throw new Error('missing'); },
        async createFolder() { return folder; },
      };
    },
  };
  const expected = { rate: 48000, channels: 2, duration: 1 };
  const fingerprint = buildFingerprint({
    passSignature: 'sig',
    stripClipVolume: false,
    analysisSettings: { target_dbfs: -20 },
    dialogueReference: { mode: 'clean', trackIds: [] },
    rate: 48000,
    channels: 2,
    duration: 1,
    presetPath: 'p.epr',
  });
  const payloads = { dialogue: summary(50) };
  await save(fs, storage, fingerprint, payloads);
  const hit = await load(fs, storage, fingerprint, expected);
  assert.ok(hit);
  assert.equal(hit.dialogue.samples, payloads.dialogue.samples);
});

test('validateSummary rejects duration mismatch', () => {
  const s = summary(50);
  assert.ok(validateSummary(s, { rate: 48000, channels: 2, duration: s.samples / s.rate }));
  assert.ok(!validateSummary(s, { rate: 48000, channels: 2, duration: 999 }));
});

test('hashString is stable', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
});
