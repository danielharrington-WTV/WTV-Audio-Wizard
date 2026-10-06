const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createMeter} = require('../plugin/loudness-meter.js');

const db = x => Math.pow(10, x / 20);
function feed(meter, seconds, level = 0, channel = 0, channels = 2) {
  const n = Math.round(seconds * 48000);
  for (let i = 0; i < n; i++) { const v = new Array(channels).fill(level); meter.push(v); }
}
function hit(meter, levelDb, channel = 0, channels = 2) {
  const v = new Array(channels).fill(0); v[channel] = db(levelDb); meter.push(v);
}

test('every sample over the flag level is an event, not just the single loudest; hits within the merge window fold into one', () => {
  const meter = createMeter(2, {peakFlagDbfs: -6, mergeSeconds: 2});
  feed(meter, 1);                 // silence to 1.0 s
  hit(meter, -3);                 // event A at 1.0 s
  feed(meter, 0.5);
  hit(meter, -1, 1);              // 0.5 s later: same event, louder, channel 2
  feed(meter, 3);                 // > 2 s gap
  hit(meter, -5.5);               // event B at ~4.5 s
  feed(meter, 1.9999);
  hit(meter, -2);                 // within 2 s of B's last hit: still B
  feed(meter, 1);
  hit(meter, -7);                 // under the flag: ignored
  const r = meter.finish();
  assert.equal(r.over_threshold_dbfs, -6);
  assert.equal(r.over_threshold_count, 2);
  assert.equal(r.over_threshold_truncated, false);
  const [a, b] = r.over_threshold_events;
  assert.ok(Math.abs(a.position_seconds - 1) < 1e-6);
  assert.ok(Math.abs(a.peak_dbfs + 1) < 1e-6, 'event peak tracks the loudest sample in the event');
  assert.equal(a.channel, 2);
  assert.equal(a.samples_over, 2);
  assert.ok(Math.abs(a.end_seconds - 1.5) < 1e-4);
  assert.ok(Math.abs(b.position_seconds - 4.5) < 1e-3);
  assert.ok(Math.abs(b.peak_dbfs + 2) < 1e-6);
  assert.equal(b.samples_over, 2);
  assert.ok(Math.abs(r.sample_peak_dbfs + 1) < 1e-6, 'overall sample peak unchanged');
});

test('a gap just past the merge window starts a new event; a sustained hot passage is one event', () => {
  const meter = createMeter(1, {peakFlagDbfs: -6, mergeSeconds: 2});
  hit(meter, -3, 0, 1);
  feed(meter, 2.0001, 0, 0, 1);
  hit(meter, -3, 0, 1);
  feed(meter, 3, 0, 0, 1);
  feed(meter, 3, db(-2), 0, 1); // 3 s continuously over
  const r = meter.finish();
  assert.equal(r.over_threshold_count, 3);
  const sustained = r.over_threshold_events[2];
  assert.ok(Math.abs(sustained.end_seconds - sustained.position_seconds - 3) < 1e-3);
  assert.equal(sustained.samples_over, 3 * 48000);
});

test('threshold and window are configurable; nothing flagged below the level', () => {
  const meter = createMeter(2, {peakFlagDbfs: -1, mergeSeconds: 0.5});
  hit(meter, -3); feed(meter, 1); hit(meter, -3);
  assert.equal(meter.finish().over_threshold_count, 0);
  const tight = createMeter(2, {peakFlagDbfs: -6, mergeSeconds: 0.5});
  hit(tight, -3); feed(tight, 1); hit(tight, -3);
  assert.equal(tight.finish().over_threshold_count, 2);
});

test('event list is capped at 500 and reports truncation', () => {
  const meter = createMeter(1, {peakFlagDbfs: -6, mergeSeconds: 0});
  for (let i = 0; i < 600; i++) { hit(meter, -1, 0, 1); meter.push([0]); }
  const r = meter.finish();
  assert.equal(r.over_threshold_count, 500);
  assert.equal(r.over_threshold_truncated, true);
});

test('placePeakMarkers replaces old WTV peak markers and adds one Comment marker per event at the event start', async () => {
  const added = [], removed = [];
  const existing = [{name: 'WTV peak -2.0 dBFS', async getName() {return this.name;}}, {name: 'Editor note', async getName() {return this.name;}}];
  const markersObj = {
    async getMarkers() {return existing;},
    createAddMarkerAction: (name, type, start, duration, comments) => () => added.push({name, type, start: start.seconds, duration: duration.seconds, comments}),
    createRemoveMarkerAction: marker => () => removed.push(marker.name),
  };
  const ppro = {Markers: {getMarkers: async () => markersObj}, TickTime: {TIME_ZERO: {seconds: 0}, createWithSeconds: s => ({seconds: s})}};
  const project = {lockedAccess: fn => fn(), executeTransaction(build) {const a = []; build({addAction: x => a.push(x)}); a.forEach(x => x()); return true;}};
  const host = {transaction(p, label, build) {let ok = false; p.lockedAccess(() => { ok = p.executeTransaction(build, label); }); if (!ok) throw new Error(label);}};
  const box = {module: {exports: {}}, require: name => name === 'premierepro' ? ppro : name === './premiere.js' ? host : {}, Date, Error, JSON, Math, String, Number};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/loudness-pass.js'), 'utf8'), box);
  const events = [
    {position_seconds: 1, end_seconds: 1.5, peak_dbfs: -1.234, peak_position_seconds: 1.5, channel: 2, samples_over: 2},
    {position_seconds: 4.5, end_seconds: 4.5, peak_dbfs: -5.5, peak_position_seconds: 4.5, channel: 1, samples_over: 1},
  ];
  const result = await box.module.exports.placePeakMarkers(project, {}, events, -6);
  assert.equal(result.added, 2);
  assert.equal(result.removed, 1);
  assert.equal(JSON.stringify(removed), JSON.stringify(['WTV peak -2.0 dBFS']));
  assert.equal(added.length, 2);
  assert.equal(added[0].name, 'WTV peak -1.2 dBFS');
  assert.equal(added[0].type, 'Comment');
  assert.equal(added[0].start, 1);
  assert.equal(added[0].duration, 0);
  assert.match(added[0].comments, /Over -6 dBFS .* channel 2, 2 sample\(s\) over/);
  assert.equal(added[1].start, 4.5);
  // Host without a Markers API: no-op, not an error.
  const noApi = {module: {exports: {}}, require: name => name === 'premierepro' ? {} : name === './premiere.js' ? host : {}, Date, Error, JSON, Math, String, Number};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../plugin/loudness-pass.js'), 'utf8'), noApi);
  assert.equal(await noApi.module.exports.placePeakMarkers(project, {}, events, -6), null);
});
