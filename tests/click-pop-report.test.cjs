const test = require('node:test');
const assert = require('node:assert/strict');
const {formatTimestamp, summarize, note, report} = require('../plugin/click-pop-report.js');

test('formatTimestamp renders mm:ss.mmm', () => {
  assert.equal(formatTimestamp(0), '00:00.000');
  assert.equal(formatTimestamp(1.234), '00:01.234');
  assert.equal(formatTimestamp(75.5), '01:15.500');
});

test('summarize/report: nothing processed yet', () => {
  const summary = summarize(null, null, () => []);
  assert.equal(summary.ran, false);
  assert.equal(report(summary), 'No processed batch yet. Run Batch Process Dialogue first.');
  assert.equal(note(summary), '');
});

test('summarize/report: per-clip batch with de-click/de-ess off reports it was off', () => {
  const context = {mode: 'per_clip', clips: [{name: 'Clip 1', trackIndex: 0, start: {seconds: 5}, result: {deess_declick: null}}]};
  const summary = summarize(context, null, () => []);
  assert.equal(summary.ran, true);
  assert.equal(summary.anyEnabled, false);
  assert.equal(report(summary), 'De-click & de-ess dialogue was off for this batch. No click/pop report available.');
  assert.equal(note(summary), '');
});

test('summarize/report: per-clip batch aggregates counts and timeline positions across clips', () => {
  const context = {mode: 'per_clip', clips: [
    {id: 'clip-001', name: 'Clip A', trackIndex: 0, start: {seconds: 10}, result: {deess_declick: {clicks_repaired: 2, repairs: [
      {start_seconds: 0.5, duration_seconds: 0.001, channels: [0, 1]}, {start_seconds: 1.0, duration_seconds: 0.001, channels: [0]}]}}},
    {id: 'clip-002', name: 'Clip B', trackIndex: 1, start: {seconds: 0}, result: {deess_declick: {clicks_repaired: 1, repairs: [
      {start_seconds: 2.0, duration_seconds: 0.001, channels: [0, 1]}]}}}]};
  const clickPopEvents = ctx => ctx.clips.flatMap(c => c.result.deess_declick.repairs.map(r =>
    ({timeline_seconds: c.start.seconds + r.start_seconds, clip_name: c.name, track_index: c.trackIndex})))
    .sort((a, b) => a.timeline_seconds - b.timeline_seconds);
  const summary = summarize(context, null, clickPopEvents);
  assert.equal(summary.ran, true);
  assert.equal(summary.anyEnabled, true);
  assert.equal(summary.total, 3);
  assert.equal(summary.clips, 2);
  assert.deepEqual(summary.events.map(e => e.timeline_seconds), [2, 10.5, 11]);
  const text = report(summary);
  const lines = text.split('\n');
  assert.equal(lines[0], '3 clicks/pops repaired across 2 clips.');
  assert.equal(lines[1], '00:02.000 — Track A2 — Clip B');
  assert.equal(lines[2], '00:10.500 — Track A1 — Clip A');
  assert.equal(lines[3], '00:11.000 — Track A1 — Clip A');
  assert.equal(note(summary), ' 3 clicks/pops repaired — see Click/pop report.');
});

test('summarize/report: full-sequence job reads repairs directly (no per-clip offset)', () => {
  const jobResult = {deess_declick: {clicks_repaired: 1, repairs: [{start_seconds: 3.25, duration_seconds: 0.001, channels: [0]}]}};
  const summary = summarize(null, jobResult, () => []);
  assert.equal(summary.ran, true);
  assert.equal(summary.clips, null);
  const text = report(summary);
  assert.equal(text.split('\n')[0], '1 click/pop repaired.');
  assert.equal(text.split('\n')[1], '00:03.250');
});

test('summarize: per-clip jobResult sentinel is ignored for the full-sequence branch', () => {
  // main.js sets jobResult = {mode: 'per_clip'} as an apply-gate sentinel for
  // per-clip batches; it must not be mistaken for a full-sequence result.
  const summary = summarize(null, {mode: 'per_clip'}, () => []);
  assert.equal(summary.ran, false);
});

test('singular wording for exactly one click/pop', () => {
  const jobResult = {deess_declick: {clicks_repaired: 1, repairs: [{start_seconds: 0, duration_seconds: 0.001, channels: [0]}]}};
  const summary = summarize(null, jobResult, () => []);
  assert.equal(report(summary).split('\n')[0], '1 click/pop repaired.');
  assert.equal(note(summary), ' 1 click/pop repaired — see Click/pop report.');
});
