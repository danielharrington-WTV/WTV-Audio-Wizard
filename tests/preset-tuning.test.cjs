// Preset tuning, handles on by default, and "Don't use cached files" (2026-10-09).
// Runs slices of the real main.js, as preset-reset.test.cjs does.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const settings = require('../plugin/settings-file.js');
const main = fs.readFileSync(require.resolve('../plugin/main.js'), 'utf8');
const slice = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
const run = (code, box = {}) => { vm.runInNewContext(code, box); return box; };

const {PRESETS, FACTORY_DEFAULT_VALUES} = run(
  slice('const PRESETS =', 'const DEFAULT_PRESET') + slice('const FACTORY_DEFAULT_VALUES =', 'const CHANGED_SETTINGS_LABELS')
  + '\nglobalThis.PRESETS = PRESETS; globalThis.FACTORY_DEFAULT_VALUES = FACTORY_DEFAULT_VALUES;');
const full = id => ({...FACTORY_DEFAULT_VALUES, ...(PRESETS.find(p => p.id === id).defaults || {})});

test('clip handles are on at 30 frames for every built-in preset', () => {
  for (const preset of PRESETS) { assert.equal(full(preset.id).handlesEnabled, true, preset.id); assert.equal(full(preset.id).handleFrames, 30); }
  assert.match(fs.readFileSync(require.resolve('../plugin/index.html'), 'utf8'), /<input id="handleFrames" type="number" value="30" min="1" max="300" step="1"/);
  assert.match(fs.readFileSync(require.resolve('../plugin/index.html'), 'utf8'), /<input id="handlesEnabled" type="checkbox" checked>/);
});

test('Promo/Action, Interview and Camcorder are distinct and valid', () => {
  const [promo, interview, camcorder] = ['promo', 'interview', 'camcorder'].map(full);
  assert.equal(promo.rawBlend, 15); assert.equal(promo.dialogue, -10); assert.equal(promo.duck, 12);
  assert.equal(promo.attack, 100); assert.equal(promo.release, 800);
  assert.equal(interview.rawBlend, 0); assert.equal(interview.attack, 250); assert.equal(interview.release, 1500); assert.equal(interview.speechThreshold, -45);
  assert.equal(camcorder.rawBlend, 10); assert.equal(camcorder.deessDeclick, true); assert.equal(camcorder.maxBoost, 12); assert.equal(camcorder.speechThreshold, -48);
  const differ = (a, b) => settings.fieldIds.filter(id => a[id] !== b[id]).length;
  assert.ok(differ(promo, interview) >= 3 && differ(promo, camcorder) >= 3 && differ(interview, camcorder) >= 3);
  for (const preset of PRESETS) {
    for (const id of Object.keys(preset.defaults || {})) assert.ok(settings.fieldIds.includes(id), `${preset.id}.${id}`);
    assert.doesNotThrow(() => settings.validate({format: 'WTVAudioWizard settings', schema: 1, values: full(preset.id)}), preset.id);
  }
});

test('one-time migration resets the retuned presets, turns handles on elsewhere and moves handles to 30 frames', () => {
  const store = new Map(), saved = values => JSON.stringify({format: 'WTVAudioWizard settings', schema: 1, values});
  const key = id => `wtv-last-settings-v1:${id}`;
  store.set(key('promo'), saved({duck: 3})); store.set(key('stems'), saved({handlesEnabled: false, handleSeconds: 1, duck: 4}));
  store.set(key('custom-1'), saved({handlesEnabled: false})); store.set(key('natural'), '{broken');
  const localStore = {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
  const box = run(slice('const PRESET_DEFAULTS_REVISION_KEY', 'migratePresetDefaults();') + '\nglobalThis.migrate = migratePresetDefaults;',
    {allPresets: () => [...PRESETS, {id: 'custom-1'}], presetSettingsKey: key});
  box.migrate(localStore);
  assert.equal(store.has(key('promo')), false);
  assert.deepEqual(JSON.parse(store.get(key('stems'))).values, {handlesEnabled: true, duck: 4, handleFrames: 30});
  assert.equal(JSON.parse(store.get(key('custom-1'))).values.handlesEnabled, true);
  assert.equal(store.get(key('natural')), '{broken');
  assert.equal(store.get('wtv-preset-defaults-revision'), '3');
  store.set(key('promo'), saved({duck: 3})); box.migrate(localStore);
  assert.ok(store.has(key('promo')), 'runs once');
});

test('panels already on revision 2 keep their settings and only move handles to frames', () => {
  const store = new Map([['wtv-preset-defaults-revision', '2']]), key = id => `wtv-last-settings-v1:${id}`;
  store.set(key('promo'), JSON.stringify({values: {duck: 3, handlesEnabled: false, handleSeconds: 1}}));
  const localStore = {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
  const box = run(slice('const PRESET_DEFAULTS_REVISION_KEY', 'migratePresetDefaults();') + '\nglobalThis.migrate = migratePresetDefaults;',
    {allPresets: () => PRESETS, presetSettingsKey: key});
  box.migrate(localStore);
  assert.deepEqual(JSON.parse(store.get(key('promo'))).values, {duck: 3, handlesEnabled: false, handleFrames: 30});
  assert.equal(store.get('wtv-preset-defaults-revision'), '3');
});

test("Don't use cached files marks job submissions fresh, and needs a service that understands it", () => {
  const box = run(slice('let serviceCapabilities', 'async function request') + '\nglobalThis.fresh = freshJobBody; globalThis.setCaps = c => { serviceCapabilities = c; };', {noCache: true});
  const post = {method: 'POST', body: JSON.stringify({tracks: [], settings: {}})};
  assert.throws(() => box.fresh(post), /Restart the updated service/);
  box.setCaps(['fresh_jobs_v1']);
  assert.equal(JSON.parse(box.fresh(post).body).fresh, true);
  assert.equal(box.fresh({method: 'GET'}).method, 'GET');
  box.noCache = false;
  assert.equal(box.fresh(post), post);
  assert.match(main, /if \(path === '\/v1\/jobs'\) options = freshJobBody\(options\);/);
  assert.match(main, /const canReuse = !noCache && /);
  assert.match(main, /context\.reuse = noCache \? null : await loadPreviousManifest/);
  assert.match(main, /storage:localStorage,noCache,/);
});

test('Keep raw mix maps to the service model share; Max level boost to max_boost_db', () => {
  assert.match(main, /result\.enhancer_wet = Math\.round\(\(1 - rawShare\) \* 1000\) \/ 1000;/);
  assert.match(main, /const rawShare = \$\('enableEnhancer'\)\.checked \? Number\(\$\('rawBlend'\)\.value\) \/ 100 : 0;/);
  assert.match(main, /if \('max_boost_db' in factory\) result\.max_boost_db = boost;/);
});
