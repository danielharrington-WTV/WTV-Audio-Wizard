const test = require('node:test');
const assert = require('node:assert/strict');
const defaults = require('../plugin/defaults.json');

test('panel keeps experimental repair and optional stems off by default', () => {
  assert.equal(defaults.deess_declick, false);
  assert.equal(defaults.enhancer, 'gap_urgenet');
  assert.equal(defaults.separate_ambience, false);
  assert.equal(defaults.separate_music, false);
});
