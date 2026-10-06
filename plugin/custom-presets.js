// User-created presets (v0.8.1). Pure helpers, no DOM or UXP, so they can be
// unit tested; main.js owns the UI and storage calls.
//
// A custom preset is {id, label, defaults}. Its settings live under the same
// per-preset key as the built-ins (main.js presetSettingsKey(id)); `defaults`
// is copied from the preset it was created from, so Reset on a preset made
// from Natural (MossFormer) still comes back to MossFormer2.
const CUSTOM_PRESETS_KEY = 'wtv-custom-presets-v1';
const MAX_NAME_LENGTH = 40;
const ID_PREFIX = 'custom-';

function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

// Returns the cleaned name, or throws a message fit to show the user.
// Names must be unique case-insensitively across built-in and custom presets.
function validateNewName(raw, existingLabels) {
  const name = normalizeName(raw);
  if (!name) throw new Error('Type a name for the new preset first.');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Preset names can be up to ${MAX_NAME_LENGTH} characters.`);
  if (existingLabels.some(label => normalizeName(label).toLowerCase() === name.toLowerCase())) {
    throw new Error(`A preset called "${name}" already exists.`);
  }
  return name;
}

// Reads the stored list defensively: anything malformed is dropped rather
// than breaking the preset menu.
function parseCustomPresets(json) {
  let list;
  try { list = JSON.parse(json); } catch (_) { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !p.id.startsWith(ID_PREFIX) || seen.has(p.id)) continue;
    const label = normalizeName(p.label);
    if (!label) continue;
    const defaults = p.defaults && typeof p.defaults === 'object' && !Array.isArray(p.defaults) ? {...p.defaults} : {};
    seen.add(p.id);
    out.push({id: p.id, label, defaults});
  }
  return out;
}

function makePresetId(now = Date.now(), rand = Math.random()) {
  return `${ID_PREFIX}${now.toString(36)}-${Math.floor(rand * 36 ** 4).toString(36).padStart(4, '0')}`;
}

function isCustomPresetId(id) {
  return typeof id === 'string' && id.startsWith(ID_PREFIX);
}

module.exports = {CUSTOM_PRESETS_KEY, MAX_NAME_LENGTH, normalizeName, validateNewName, parseCustomPresets, makePresetId, isCustomPresetId};
