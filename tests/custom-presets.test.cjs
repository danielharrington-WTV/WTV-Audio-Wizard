const test = require('node:test'), assert = require('node:assert/strict');
const cp = require('../plugin/custom-presets.js');
const BUILT_IN = ['Promo/Action', 'Interview', 'Camcorder', 'Natural (MossFormer)', 'Stem separation'];

test('a new preset name is trimmed and inner whitespace collapsed', () => {
  assert.equal(cp.validateNewName('   Podcast    Voice  ', BUILT_IN), 'Podcast Voice');
});

test('empty and over-long names are rejected with a message the user can act on', () => {
  assert.throws(() => cp.validateNewName('   ', BUILT_IN), /Type a name/);
  assert.throws(() => cp.validateNewName('x'.repeat(cp.MAX_NAME_LENGTH + 1), BUILT_IN), /up to 40 characters/);
  assert.equal(cp.validateNewName('x'.repeat(cp.MAX_NAME_LENGTH), BUILT_IN).length, cp.MAX_NAME_LENGTH);
});

test('duplicate names are rejected case-insensitively, against built-in and custom presets', () => {
  assert.throws(() => cp.validateNewName('interview', BUILT_IN), /already exists/);
  assert.throws(() => cp.validateNewName('natural (mossformer)', BUILT_IN), /already exists/);
  assert.throws(() => cp.validateNewName('My Mix', [...BUILT_IN, 'my  mix']), /already exists/);
});

test('stored list is read defensively: malformed, non-custom and duplicate entries are dropped', () => {
  const stored = JSON.stringify([
    {id: 'custom-a', label: ' Podcast ', defaults: {enhancer: 'mossformer2'}},
    {id: 'promo', label: 'Hijack a built-in'},
    {id: 'custom-a', label: 'Duplicate id'},
    {id: 'custom-b', label: '   '},
    {id: 'custom-c', label: 'No defaults', defaults: [1, 2]},
    null, 42,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(cp.parseCustomPresets(stored))), [
    {id: 'custom-a', label: 'Podcast', defaults: {enhancer: 'mossformer2'}},
    {id: 'custom-c', label: 'No defaults', defaults: {}},
  ]);
  assert.deepEqual(cp.parseCustomPresets('not json'), []);
  assert.deepEqual(cp.parseCustomPresets(null), []);
  assert.deepEqual(cp.parseCustomPresets('{"id":"custom-x"}'), []);
});

test('generated ids are custom-prefixed, distinct, and never collide with built-in ids', () => {
  const a = cp.makePresetId(1790000000000, 0.1), b = cp.makePresetId(1790000000000, 0.2);
  assert.ok(cp.isCustomPresetId(a) && cp.isCustomPresetId(b));
  assert.notEqual(a, b);
  for (const id of ['promo', 'interview', 'camcorder', 'natural', 'stems']) assert.equal(cp.isCustomPresetId(id), false);
});

test('the Stem separation preset turns on both stems and keeps everything else at factory defaults', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugin', 'main.js'), 'utf8');
  assert.match(main, /\{id:'stems',label:'Stem separation',defaults:\{ambienceStem:true,musicStem:true\}\}/);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugin', 'index.html'), 'utf8');
  assert.match(html, /<option value="stems">Stem separation<\/option>/);
  assert.equal(cp.validateNewName('Stem Separation 2', BUILT_IN), 'Stem Separation 2');
  assert.throws(() => cp.validateNewName('stem separation', BUILT_IN), /already exists/);
});

test('the preset dropdown ends with "+ New preset…", which opens the form without switching presets (2026-10-13)', () => {
  const main = require('node:fs').readFileSync(require.resolve('../plugin/main.js'), 'utf8');
  const render = main.slice(main.indexOf('function renderPresetOptions()'), main.indexOf('function showNewPresetForm()'));
  assert.match(render, /create\.value = NEW_PRESET_OPTION; create\.textContent = '\+ New preset\\u2026'/);
  assert.ok(render.indexOf('allPresets()') < render.indexOf('NEW_PRESET_OPTION'), 'listed after every preset');
  const show = main.slice(main.indexOf('function showNewPresetForm()'), main.indexOf('function showNewPresetForm()') + 600);
  assert.match(show, /\$\('presetSelect'\)\.value = activePreset/);
  assert.match(show, /setActiveTab\('options'\)/);
  assert.match(show, /setPresetsOpen\(true\)/);
  assert.match(show, /\$\('newPresetName'\)\.focus\(\)/);
  assert.match(main, /if \(\$\('presetSelect'\)\.value === NEW_PRESET_OPTION\) showNewPresetForm\(\);\n  else loadPreset/);
  assert.match(main, /\$\('newPresetName'\)\.addEventListener\('keydown', event => \{ if \(event\.key === 'Enter'\) \$\('createPreset'\)\.click\(\); \}\)/);
});
