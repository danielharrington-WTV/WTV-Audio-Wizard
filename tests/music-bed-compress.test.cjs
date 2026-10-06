const test = require('node:test');
const assert = require('node:assert/strict');
const { bedCompressionDb, summarizeBedCompression } = require('../plugin/music-bed-compress.js');

test('summarizeBedCompression handles long timelines without stack overflow', () => {
  const n = 70000;
  const peaks = new Float64Array(n);
  const levels = new Float64Array(n);
  const comp = new Float64Array(n);
  peaks[0] = 1;
  levels[0] = 0.5;
  summarizeBedCompression(peaks, levels, comp);
});

test('bed compression reduces crest on hot peaks', () => {
  const peaks = new Float64Array([1, 0.5, 0.25, 0.5]);
  const levels = new Float64Array([0.4, 0.35, 0.2, 0.35]);
  const comp = bedCompressionDb(peaks, -20);
  const report = summarizeBedCompression(peaks, levels, comp);
  assert.ok(comp[0] < -1);
  assert.ok(report.blocks_compressed >= 1);
});
