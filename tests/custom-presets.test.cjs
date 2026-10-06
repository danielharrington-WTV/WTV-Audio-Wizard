const test = require('node:test'), assert = require('node:assert/strict');
const cp = require('../plugin/custom-presets.js');
const BUILT_IN = ['Promo/Action', 'Interview', 'Camcorder', 'Natural (MossFormer)'];

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
  for (const id of ['promo', 'interview', 'camcorder', 'natural']) assert.equal(cp.isCustomPresetId(id), false);
});
