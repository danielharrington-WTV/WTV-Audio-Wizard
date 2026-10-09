// Digital-silence check for exports (plugin/wav.js wavSilence, 2026-10-09).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {wavSilence, SILENCE_DBFS} = require('../plugin/wav.js');

function wav(bits, code, fill, frames = 48000 * 3, channels = 2) {
  const rate = 48000, align = channels * bits / 8;
  const buffer = new ArrayBuffer(44 + frames * align), v = new DataView(buffer);
  const tag = (i, s) => [...s].forEach((c, j) => v.setUint8(i + j, c.charCodeAt(0)));
  tag(0, 'RIFF'); v.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, code, true); v.setUint16(22, channels, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * align, true); v.setUint16(32, align, true); v.setUint16(34, bits, true); tag(36, 'data'); v.setUint32(40, frames * align, true);
  for (let n = 0, i = 44; i < buffer.byteLength; n++, i += bits / 8) {
    const x = fill(n);
    if (code === 3) v.setFloat32(i, x, true);
    else if (bits === 16) v.setInt16(i, Math.round(x * 32767), true);
    else { let q = Math.round(x * 8388607); if (q < 0) q += 0x1000000; v.setUint8(i, q & 255); v.setUint8(i + 1, (q >> 8) & 255); v.setUint8(i + 2, (q >> 16) & 255); }
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wtv-silence-')), 'x.wav');
  fs.writeFileSync(file, Buffer.from(buffer));
  let reads = 0;
  const io = {lstat: async p => fs.statSync(p), open: async p => fs.openSync(p, 'r'), close: async fd => fs.closeSync(fd),
    read: async (fd, out, offset, length, position) => { reads++; return {bytesRead: fs.readSync(fd, new Uint8Array(out), offset, length, position)}; }};
  return {file, io, expected: {rate, channels, duration: frames / rate}, reads: () => reads};
}

test('all-zero exports are silent in every format the preset can produce', async () => {
  for (const [bits, code] of [[16, 1], [24, 1], [32, 3]]) {
    const f = wav(bits, code, () => 0);
    const result = await wavSilence(f.file, f.expected, {io: f.io});
    assert.equal(result.silent, true, `${bits}-bit`); assert.equal(result.peakDb, null);
  }
});

test('below -90 dBFS counts as silence, quiet room tone does not', async () => {
  const faint = wav(32, 3, n => (n % 2 ? 1 : -1) * 10 ** (-95 / 20));
  assert.equal((await wavSilence(faint.file, faint.expected, {io: faint.io})).silent, true);
  const room = wav(24, 1, n => Math.sin(n / 7) * 10 ** (-60 / 20));
  const result = await wavSilence(room.file, room.expected, {io: room.io});
  assert.equal(result.silent, false); assert.ok(result.peakDb > SILENCE_DBFS && result.peakDb <= -60);
});

test('sound early in the file stops after the first block; sound only at the end is still found', async () => {
  const early = wav(16, 1, () => 0.1, 48000 * 60);
  assert.equal((await wavSilence(early.file, early.expected, {io: early.io})).silent, false);
  assert.ok(early.reads() <= 6, `reads ${early.reads()}`);
  const frames = 48000 * 30, late = wav(16, 1, n => (n === frames * 2 - 1 ? 0.5 : 0), frames);
  assert.equal((await wavSilence(late.file, late.expected, {io: late.io})).silent, false);
});

test('cancel during the check propagates', async () => {
  const f = wav(16, 1, () => 0);
  await assert.rejects(wavSilence(f.file, f.expected, {io: f.io, check: () => { throw Error('Batch stopped'); }}), /Batch stopped/);
});

test('Batch Process Dialogue checks new and reused exports and the full-sequence export', () => {
  const main = fs.readFileSync(path.join(__dirname, '../plugin/main.js'), 'utf8');
  assert.equal((main.match(/await silentExport\(/g) || []).length, 3);
  assert.match(main, /is silent; not kept and not sent to the service/);
  assert.match(main, /clip\.freshExport = true/);
  assert.match(main, /catch \(error\) \{ if \(cancelled\) throw error; return false; \}/);
});
