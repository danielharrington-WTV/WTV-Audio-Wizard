const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

const AMPLIFY_MIN_DB = -96, AMPLIFY_MAX_DB = 48;
const dbToNormalized = db => (db - AMPLIFY_MIN_DB) / (AMPLIFY_MAX_DB - AMPLIFY_MIN_DB);
const MUTE_SUFFIX = ' · WTV muted';

// Builds a sequence with one audio track holding `specs` clips:
// {name, muted (db, or true for AMPLIFY_MIN_DB), selected, suffix}.
function setup(specs) {
  const calls = [];
  function makeParam(displayName, value) {
    return {
      displayName,
      getValueAtTime: async () => value,
    };
  }
  function makeComponent(isAmplify, db, mono) {
    const v = dbToNormalized(db ?? 0);
    // Mono uses the live 2026-09-25 layout: controls + "Gain" + unnamed slots.
    const params = !isAmplify ? [] : mono
      ? [makeParam('Bypass', 0), makeParam('Channel Count', 1), makeParam('Link Sliders', 0), makeParam('Gain', v),
         ...Array.from({length: 31}, () => makeParam('', 0.5)), makeParam('Link Keyframes', 0)]
      : [makeParam('Left', v), makeParam('Right', v)];
    return {
      getDisplayName: async () => isAmplify ? 'Amplify' : 'Volume',
      getMatchName: async () => isAmplify ? 'AE.ADBE.Amplify' : 'AE.ADBE.Volume',
      getParamCount: async () => params.length,
      getParam: async i => params[i],
    };
  }
  const entries = specs.map((spec, index) => {
    const components = spec.otherEffect ? [makeComponent(false)] : [];
    if (spec.muted) components.push(makeComponent(true, spec.muted === true ? AMPLIFY_MIN_DB : spec.muted, spec.mono));
    let name = spec.name + (spec.suffix ? MUTE_SUFFIX : '');
    const chain = {
      getComponentCount: async () => components.length,
      getComponentAtIndex: async i => components[i],
      createRemoveComponentAction: component => () => {
        const i = components.indexOf(component);
        if (i >= 0) { components.splice(i, 1); calls.push(`remove-component:${spec.name}`); }
      },
    };
    const item = {
      getIsSelected: async () => spec.selected !== false,
      getComponentChain: async () => chain,
      getName: async () => name,
      createSetNameAction: newName => () => { name = newName; calls.push(`rename:${spec.name}->${newName}`); },
    };
    return {item, trackIndex: spec.trackIndex ?? 0, index, sourceId: `${spec.name}-src`, start: {ticks: String(index)}, end: {ticks: String(index + 1)},
      duration: 1, get name() { return name; }, enabled: spec.enabled !== false, muted: false, transitions: 0, trackName: spec.trackName ?? null};
  });

  let selection = null;
  const sequence = {
    getAudioTrackCount: async () => 1,
    setSelection: sel => { selection = sel; calls.push(`set-selection:${sel.items.length}`); return true; },
  };
  const project = {
    getActiveSequence: async () => sequence,
    lockedAccess(fn) { fn(); },
    executeTransaction(build) { const actions = []; build({addAction: a => actions.push(a)}); actions.forEach(a => a()); return true; },
  };
  const ppro = {
    Project: {getActiveProject: async () => project},
    TickTime: {createWithSeconds: () => ({})},
    // Mirrors Adobe's real signature: addItem(trackItem, skipDuplicateCheck) --
    // both here and in mute-tools.js itself, everything happens inside this
    // callback, matching the "valid for the lifetime and scope of the
    // callback" contract in Adobe's reference.
    TrackItemSelection: {
      createEmptySelection: cb => cb({items: [], addItem(item, skipDuplicateCheck) { this.items.push(item); return typeof skipDuplicateCheck === 'boolean'; }}),
    },
  };

  function load(name, requireFn) {
    const box = {module: {exports: {}}, require: requireFn};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../plugin/${name}.js`), 'utf8'), box);
    return box.module.exports;
  }
  const host = load('premiere', n => n === './export-sync.js' ? {} : ppro);
  const api = load('mute-tools', n => ({
    'premierepro': ppro,
    './premiere.js': host,
    './per-clip.js': {inventory: async () => entries},
    './amplify-params.js': load('amplify-params', () => { throw new Error('no deps'); }),
    './music-select.js': require('../plugin/music-select.js'),
  }[n]));

  return {api, calls, entries, sequence, project, get selection() { return selection; }};
}

test('unmute removes the muting Amplify and strips the name suffix from selected clips', async () => {
  const s = setup([{name: 'clip-1', muted: true, suffix: true, selected: true}]);
  const result = await s.api.unmute({say: () => {}});
  assert.equal(result.clips, 1);
  assert.equal(result.names.length, 1);
  assert.equal(result.names[0], 'clip-1');
  assert.equal(s.entries[0].name, 'clip-1');
  assert.ok(s.calls.includes('remove-component:clip-1'));
  assert.ok(s.calls.some(c => c.startsWith('rename:clip-1')));
});

test('unmute finds a muted clip by Amplify value even if the name suffix rename failed', async () => {
  const s = setup([{name: 'clip-1', muted: true, suffix: false, selected: true}]);
  const result = await s.api.unmute({say: () => {}});
  assert.equal(result.clips, 1);
  assert.equal(s.entries[0].name, 'clip-1');
});

test('unmute ignores selected clips that are not muted', async () => {
  const s = setup([{name: 'clip-1', muted: false, selected: true}]);
  await assert.rejects(() => s.api.unmute({say: () => {}}), /are muted by WTVAudioWizard/);
});

test('unmute requires a selection', async () => {
  const s = setup([{name: 'clip-1', muted: true, suffix: true, selected: false}]);
  await assert.rejects(() => s.api.unmute({say: () => {}}), /Select one or more/);
});

test('unmute leaves an unrelated effect on the clip alone', async () => {
  const s = setup([{name: 'clip-1', muted: true, suffix: true, selected: true, otherEffect: true}]);
  await s.api.unmute({say: () => {}});
  assert.equal(await s.entries[0].item.getComponentChain().then(c => c.getComponentCount()), 1);
});

test('selectMuted scans every clip on the sequence (not just selected) and sets the timeline selection', async () => {
  const s = setup([
    {name: 'clip-1', muted: true, suffix: true, selected: false},
    {name: 'clip-2', muted: false, selected: true},
    {name: 'clip-3', muted: true, suffix: false, selected: false},
  ]);
  const result = await s.api.selectMuted({say: () => {}});
  assert.equal(result.clips, 2);
  assert.equal(JSON.stringify(result.names.slice().sort()), JSON.stringify(['clip-1' + MUTE_SUFFIX, 'clip-3'].sort()));
  assert.equal(s.selection.items.length, 2);
});

test('selectMuted throws when nothing on the sequence is muted', async () => {
  const s = setup([{name: 'clip-1', muted: false}]);
  await assert.rejects(() => s.api.selectMuted({say: () => {}}), /No clips muted/);
});

test('mono clips: a muted Amplify is found by its "Gain" slider, not just Left/Right (live layout 2026-09-25)', async () => {
  const s = setup([
    {name: 'mono-muted', muted: true, mono: true, suffix: false, selected: false},
    {name: 'mono-loud', muted: -6, mono: true, suffix: false, selected: false},
  ]);
  const result = await s.api.selectMuted({say: () => {}});
  assert.equal(result.clips, 1);
  assert.equal(result.names[0], 'mono-muted');
});

// Select music (2026-10-13)
test('selectMusic selects every enabled clip whose clip or track name contains the filter', async () => {
  const s = setup([
    {name: 'ANW1234_01_Big Drums.wav', trackIndex: 2},
    {name: 'Interview A cam', trackIndex: 0},
    {name: 'anw5678 sting.wav', trackIndex: 3},
    {name: 'bed.wav', trackIndex: 4, trackName: 'ANW music'},
    {name: 'ANW9999 disabled.wav', trackIndex: 2, enabled: false},
  ]);
  const result = await s.api.selectMusic({terms: ['ANW'], say: () => {}});
  assert.equal(result.clips, 3);
  assert.deepEqual(result.names, ['ANW1234_01_Big Drums.wav', 'anw5678 sting.wav', 'bed.wav']);
  assert.deepEqual([...result.tracks], [3, 4, 5]);
  assert.equal(s.selection.items.length, 3);
  assert.ok(s.calls.includes('set-selection:3'));
});

test('selectMusic takes several words and explains an empty result', async () => {
  const s = setup([{name: 'APM_track.wav'}, {name: 'dialogue.wav'}]);
  assert.equal((await s.api.selectMusic({terms: ['ANW', 'apm'], say: () => {}})).clips, 1);
  const none = setup([{name: 'dialogue.wav'}]);
  await assert.rejects(none.api.selectMusic({terms: ['ANW'], say: () => {}}), /No audio clips with "ANW".*Options > Ducking/);
  assert.equal(none.selection, null);
  await assert.rejects(none.api.selectMusic({terms: [], say: () => {}}), /Set the Select music filter/);
});
