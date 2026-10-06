// The panel version is written in six places; they must agree. The service
// has its own version (0.7.1), which Connect checks exactly, so a panel-only
// release must not change it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const plugin = name => fs.readFileSync(path.join(__dirname, '..', 'plugin', name), 'utf8');
const version = JSON.parse(plugin('manifest.json')).version;

test('panel version is the same in the manifest, the heading, saved settings, the report and the network help', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(plugin('index.html').includes(`>v${version}<`), 'index.html heading');
  assert.ok(plugin('settings-file.js').includes(`plugin_version:'${version}'`), 'settings-file.js');
  assert.ok(plugin('main.js').includes(`'WTVAudioWizard panel v${version}'`), 'Copy report header');
  assert.ok(plugin('main.js').includes(`version: '${version}'`), 'panel menu About line');
  assert.ok(plugin('local-api.js').includes(`panel v${version}. Confirm UXP Developer Tool lists version ${version}.`), 'network help');
});

test('Connect still expects service 0.7.1, independent of the panel version', () => {
  assert.ok(plugin('main.js').includes("health.service_version !== '0.7.1'"));
});

test('settings saved by an older panel version still load', () => {
  const {validate, capture} = require('../plugin/settings-file.js');
  const saved = capture(id => ({checked: true, value: ({mode: 'per_clip', enhancer: 'gap_urgenet', handleSeconds: '0.5', dialogue: '-24', music: '-28', effects: '-30', duck: '10', speechThreshold: '-40', attack: '100', release: '500', loudnessTarget: '-24', loudnessTolerance: '1', peakFlag: '-6', peakMerge: '2', qualityThreshold: '1.5'})[id]}));
  assert.equal(saved.plugin_version, version);
  assert.doesNotThrow(() => validate({...saved, plugin_version: '0.8.1'}));
  assert.doesNotThrow(() => validate({...saved, plugin_version: undefined}));
});
