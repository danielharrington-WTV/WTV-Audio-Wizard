// Delivery targets and the YouTube preset (2026-10-15).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const d = require('../plugin/delivery.js');
const settings = require('../plugin/settings-file.js');
const read = name => fs.readFileSync(path.join(__dirname, '../plugin', name), 'utf8');

test('YouTube is -14 LUFS +/- 1 with sample peaks flagged over -2 dBFS; Broadcast keeps -24 / 1 / -6', () => {
  assert.deepEqual(d.deliveryValues('youtube'), {loudnessTarget: -14, loudnessTolerance: 1, peakFlag: -2});
  assert.deepEqual(d.deliveryValues('broadcast'), {loudnessTarget: -24, loudnessTolerance: 1, peakFlag: -6});
  assert.equal(d.deliveryValues('custom'), null);
  assert.equal(d.detectDelivery({loudnessTarget: '-14', loudnessTolerance: '1', peakFlag: '-2'}), 'youtube');
  assert.equal(d.detectDelivery({loudnessTarget: -14, loudnessTolerance: 2, peakFlag: -2}), 'custom');
});

test('the Delivery menu and Speech level field are in the panel', () => {
  const html = read('index.html');
  const loud = html.slice(html.indexOf('id="loudnessSection"'), html.indexOf('id="toggleQuality"'));
  assert.match(loud, /<select id="loudnessDelivery"><option value="broadcast">Broadcast \(-24 LUFS\)<\/option><option value="youtube">YouTube \(-14 LUFS\)<\/option><option value="custom">Custom<\/option><\/select>/);
  assert.match(html, /<input id="speechLevel" type="number" value="-23" min="-40" max="-12" step="1">/);
  for (const id of ['dialogue', 'music', 'effects']) assert.match(html, new RegExp(`<input id="${id}" type="number" value="-?\\d+" min="-70" max="-3">`));
  const main = read('main.js');
  assert.match(main, /if \('dialogue_level_dbfs' in factory\) result\.dialogue_level_dbfs = speechLevel;/);
  assert.match(main, /\$\('loudnessDelivery'\)\.addEventListener\('change'/);
});

test('the YouTube preset is a valid built-in aiming at -14 LUFS', () => {
  const main = read('main.js');
  const src = main.slice(main.indexOf('const PRESETS ='), main.indexOf('const DEFAULT_PRESET')) + main.slice(main.indexOf('const FACTORY_DEFAULT_VALUES ='), main.indexOf('const CHANGED_SETTINGS_LABELS'));
  const box = {}; vm.runInNewContext(src + '\nthis.PRESETS = PRESETS; this.F = FACTORY_DEFAULT_VALUES;', box);
  const yt = box.PRESETS.find(p => p.id === 'youtube');
  assert.equal(yt.label, 'YouTube');
  assert.deepEqual({...yt.defaults}, {dialogue: -4, speechLevel: -16, music: -20, effects: -10, loudnessDelivery: 'youtube', loudnessTarget: -14, loudnessTolerance: 1, peakFlag: -2});
  const full = {...box.F, ...yt.defaults};
  assert.doesNotThrow(() => settings.validate({format: 'WTVAudioWizard settings', schema: 1, values: full}));
  assert.equal(d.detectDelivery(full), 'youtube');
  assert.equal(box.F.speechLevel, -23); assert.equal(box.F.loudnessDelivery, 'broadcast');
});

test('compressor and music peak controls sit in visible Options sections (not the hidden duckingLevelOptions block)', () => {
  const html = read('index.html');
  const hidden = html.slice(html.indexOf('<div id="duckingLevelOptions"'), html.indexOf('</div>', html.indexOf('<div id="duckingLevelOptions"')));
  for (const id of ['musicPeakThreshold', 'musicPeakRatio', 'compAttack', 'compRelease', 'compKnee', 'compMaxReduction', 'levelSpeech']) {
    assert.ok(html.includes(`id="${id}"`), id); assert.ok(!hidden.includes(`id="${id}"`), id);
  }
  const levels = html.slice(html.indexOf('id="levelsStemsSection"'), html.indexOf('id="toggleDucking"'));
  for (const id of ['compAttack', 'compRelease', 'compKnee', 'compMaxReduction', 'levelSpeech', 'speechLevel']) assert.ok(levels.includes(`id="${id}"`), id);
  const ducking = html.slice(html.indexOf('id="duckingSection"'), html.indexOf('id="toggleLoudness"'));
  for (const id of ['musicPeakThreshold', 'musicPeakRatio']) assert.ok(ducking.includes(`id="${id}"`), id);
});
