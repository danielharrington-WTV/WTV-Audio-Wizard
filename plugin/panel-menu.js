// Panel menu (2026-10-06): the menu on the panel's tab in Premiere. It holds
// actions that do not need a button on the Main tab, so the panel can be
// shown in a compact layout. Pure helpers: no DOM, no UXP require.
//
// Safety rule: every menu action also exists as a control in the panel, and
// the compact layout that hides some of those controls can only be switched
// on from this menu. If a host never shows the menu, nothing becomes
// unreachable.
const COMPACT_KEY = 'compact';

// Menu ids that simply click the panel control with the same id.
const CLICK_TARGETS = ['copyReport', 'openDestinationFolder', 'changeFolder', 'saveSettings', 'loadSettings'];

function menuItems({version, compact}) {
  return [
    {id: 'copyReport', label: 'Copy report'},
    {id: 'openDestinationFolder', label: 'Open export folder'},
    {id: 'changeFolder', label: 'Change export folder…'},
    '-',
    {id: 'connectionSettings', label: 'Connection settings'},
    '-',
    {id: 'saveSettings', label: 'Save settings…'},
    {id: 'loadSettings', label: 'Load settings…'},
    '-',
    {id: 'compact', label: 'Compact panel', checked: Boolean(compact)},
    '-',
    {id: 'about', label: `WTVAudioWizard v${version}`, enabled: false},
  ];
}

// hooks: click(id), toggleConnection(), getCompact(), setCompact(bool).
function createMenu({entrypoints, panelId, version, hooks}) {
  function setChecked(value) {
    // Runtime menu updates are optional: without them the tick mark is only
    // right after the next panel load.
    try { entrypoints.getPanel(panelId).menuItems.getItem('compact').checked = Boolean(value); } catch (_) {}
  }
  function invoke(id) {
    if (id === 'compact') {
      const next = !hooks.getCompact();
      hooks.setCompact(next);
      setChecked(next);
    } else if (id === 'connectionSettings') hooks.toggleConnection();
    else if (CLICK_TARGETS.includes(id)) hooks.click(id);
  }
  let installed = false, error = null;
  try {
    entrypoints.setup({panels: {[panelId]: {
      show() {},
      menuItems: menuItems({version, compact: hooks.getCompact()}),
      invokeMenu: invoke,
    }}});
    installed = true;
  } catch (e) { error = e && e.message ? e.message : String(e); }
  return {installed, error, invoke, setChecked};
}

module.exports = {menuItems, createMenu, CLICK_TARGETS, COMPACT_KEY};
