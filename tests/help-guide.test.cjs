// Help: operator guide (2026-10-14).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const {createMenu} = require('../plugin/panel-menu.js');

test('the plugin ships an identical copy of the operator guide (update both: docs/ is the source)', () => {
  const docs = read('docs/WTVAudioWizard-Guide.html').replace(/\r\n/g, '\n');
  const bundled = read('plugin/help/WTVAudioWizard-Guide.html').replace(/\r\n/g, '\n');
  assert.ok(bundled === docs, 'plugin/help/WTVAudioWizard-Guide.html differs from docs/WTVAudioWizard-Guide.html; copy docs over it');
});

test('the manifest may open folders and .html files, nothing broader', () => {
  const manifest = JSON.parse(read('plugin/manifest.json'));
  assert.deepEqual(manifest.requiredPermissions.launchProcess, {extensions: ['', '.html']});
});

test('the Help menu item calls its own hook', () => {
  const calls = [];
  const menu = createMenu({entrypoints: {setup() {}, getPanel() { throw new Error('n/a'); }}, panelId: 'wtvAudioWizard', version: '1', hooks: {
    click: id => calls.push(['click', id]), toggleConnection() {}, getCompact: () => false, setCompact() {}, openHelp: () => calls.push(['help']),
  }});
  menu.invoke('help');
  assert.deepEqual(calls, [['help']]);
});

test('the panel opens the bundled guide and falls back to telling the user where it is', () => {
  const main = read('plugin/main.js');
  assert.match(main, /const GUIDE_PATH = 'help\/WTVAudioWizard-Guide\.html';/);
  assert.match(main, /openHelp: \(\) => \{ void openGuide\(\); \}/);
  const fn = main.slice(main.indexOf('async function openGuide()'), main.indexOf('// Folder picker for the export folder.'));
  assert.match(fn, /fs\.getPluginFolder\(\)/);
  assert.match(fn, /uxp\.shell\.openPath\(nativePath,/);
  assert.match(fn, /navigator\.clipboard\.writeText\(nativePath\)/);
  assert.match(fn, /Open this file in your web browser/);
  assert.doesNotMatch(main, /action\('openGuide'/, 'help must not be blocked while busy');
});
