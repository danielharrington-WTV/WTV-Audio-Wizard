// Select music filter helpers (2026-10-13).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ms = require('../plugin/music-select.js');

test('the filter is comma-separated words, trimmed, de-duplicated without regard to case', () => {
  assert.deepEqual(ms.parseFilter('ANW'), ['ANW']);
  assert.deepEqual(ms.parseFilter(' ANW ,  apm music, anw,, '), ['ANW', 'apm music']);
  assert.deepEqual(ms.parseFilter(''), []);
  assert.deepEqual(ms.parseFilter(null), []);
});

test('a clip matches on its clip name or its track name, ignoring case', () => {
  assert.ok(ms.matchesMusic({name: 'ANW1234_01.wav'}, ['anw']));
  assert.ok(ms.matchesMusic({name: 'bed.wav', trackName: 'Music ANW'}, ['ANW']));
  assert.ok(!ms.matchesMusic({name: 'Interview', trackName: 'Dialogue'}, ['ANW']));
  assert.ok(!ms.matchesMusic({name: 'ANW.wav'}, []));
});

test('the saved filter is used unless it is empty or missing; the default is ANW', () => {
  const store = v => ({getItem: () => v});
  assert.equal(ms.DEFAULT_MUSIC_FILTER, 'ANW');
  assert.equal(ms.loadFilter(store(null)), 'ANW');
  assert.equal(ms.loadFilter(store(' , ')), 'ANW');
  assert.equal(ms.loadFilter(store('ANW, APM')), 'ANW, APM');
  assert.equal(ms.loadFilter({getItem() { throw new Error('no storage'); }}), 'ANW');
});

test('the Select music button sits left of Level & duck music, icon only, in the same green, with its filter in Options > Ducking', () => {
  const html = fs.readFileSync(path.join(__dirname, '../plugin/index.html'), 'utf8');
  const row = html.slice(html.indexOf('<div id="selectMusic"'), html.indexOf('<div id="fixPop"'));
  assert.ok(row.indexOf('id="selectMusic"') < row.indexOf('id="musicPass"'), 'left of Level & duck music');
  assert.match(row, /<div id="selectMusic" role="button" class="step step4 icon-button" aria-label="Select music"/);
  assert.match(row, /<img class="icon-arrow" src="icons\/select-arrow\.svg" alt="">\s*<\/div>/, 'no text label');
  assert.ok(fs.existsSync(path.join(__dirname, '../plugin/icons/select-arrow.svg')));
  const ducking = html.slice(html.indexOf('id="duckingSection"'), html.indexOf('id="musicReference"'));
  assert.match(ducking, /<input id="musicSelectFilter" type="text"[^>]*value="ANW"/);
  const main = fs.readFileSync(path.join(__dirname, '../plugin/main.js'), 'utf8');
  assert.match(main, /action\('selectMusic'/);
  assert.match(main, /\$\('selectMusic'\)\.disabled = busy;/);
});
