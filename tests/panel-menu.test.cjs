// Panel menu and compact layout (2026-10-06).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {menuItems, createMenu, CLICK_TARGETS} = require('../plugin/panel-menu.js');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'plugin', name), 'utf8');

function harness({compact = false, setupThrows = false, noRuntimeItems = false} = {}) {
  const calls = [], item = {checked: compact};
  let state = compact, config = null;
  const entrypoints = {
    setup(value) { if (setupThrows) throw new Error('setup not supported'); config = value; },
    getPanel() { if (noRuntimeItems) throw new Error('no menuItems'); return {menuItems: {getItem: id => (assert.equal(id, 'compact'), item)}}; },
  };
  const menu = createMenu({entrypoints, panelId: 'wtvAudioWizard', version: '9.9.9', hooks: {
    click: id => calls.push(['click', id]), toggleConnection: () => calls.push(['connection']),
    getCompact: () => state, setCompact: value => { state = value; calls.push(['compact', value]); },
  }});
  return {menu, calls, item, config: () => config, state: () => state};
}

test('the menu is registered for the manifest panel id with a no-op show handler', () => {
  const h = harness();
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(h.menu.installed, true);
  assert.deepEqual(Object.keys(h.config().panels), [manifest.entrypoints[0].id]);
  const panel = h.config().panels.wtvAudioWizard;
  assert.equal(typeof panel.show, 'function');
  assert.equal(typeof panel.invokeMenu, 'function');
  assert.deepEqual(panel.menuItems.filter(i => i !== '-').map(i => i.label), ['Copy report', 'Open export folder', 'Change export folder…', 'Connection settings', 'Save settings…', 'Load settings…', 'Compact panel', 'WTVAudioWizard v9.9.9']);
  assert.equal(panel.menuItems.at(-1).enabled, false);
});

test('menu actions click the matching panel control, so busy and disabled rules still apply', () => {
  const h = harness();
  for (const id of CLICK_TARGETS) h.config().panels.wtvAudioWizard.invokeMenu(id);
  assert.deepEqual(h.calls, CLICK_TARGETS.map(id => ['click', id]));
  const html = read('index.html');
  for (const id of CLICK_TARGETS) assert.ok(html.includes(`id="${id}"`), `${id} must exist in the panel`);
  h.menu.invoke('about'); h.menu.invoke('unknown');
  assert.equal(h.calls.length, CLICK_TARGETS.length);
});

test('Compact panel toggles, is remembered through the hook and updates its tick', () => {
  const h = harness();
  h.menu.invoke('compact');
  assert.equal(h.state(), true); assert.equal(h.item.checked, true);
  h.menu.invoke('compact');
  assert.equal(h.state(), false); assert.equal(h.item.checked, false);
  assert.equal(menuItems({version: '1', compact: true}).find(i => i.id === 'compact').checked, true);
  const noRuntime = harness({noRuntimeItems: true});
  assert.doesNotThrow(() => noRuntime.menu.invoke('compact'));
  assert.equal(noRuntime.state(), true);
});

test('Connection settings goes to its own hook', () => {
  const h = harness();
  h.menu.invoke('connectionSettings');
  assert.deepEqual(h.calls, [['connection']]);
});

test('a host without panel menus leaves the panel working and reports why', () => {
  const h = harness({setupThrows: true});
  assert.equal(h.menu.installed, false);
  assert.match(h.menu.error, /setup not supported/);
});

test('compact layout only hides controls the menu offers, and can only be turned on from the menu', () => {
  const css = read('style.css');
  const hidden = [...css.matchAll(/body\.compact[^{]*#(\w+)[^{]*\{\s*display:none/g)].map(m => m[1]);
  const all = css.match(/body\.compact #copyReport, body\.compact #changeFolder \{ display:none; \}/);
  assert.ok(all, 'Copy report and Change are hidden in compact');
  assert.ok(hidden.includes('connectionBlock') && hidden.includes('cancel'));
  assert.match(css, /body\.compact #cancel\.is-disabled \{ display:none; \}/, 'Cancel is hidden only while idle');
  assert.match(css, /body\.compact\.is-connected:not\(\.show-connection\) #connectionBlock/, 'Connection hides only while connected');
  const main = read('main.js');
  assert.equal((main.match(/setCompact\(/g) || []).length, 1, 'setCompact is only defined, never called outside the menu hook');
  assert.ok(main.includes("document.body.classList.toggle('is-connected', connected)"));
});
