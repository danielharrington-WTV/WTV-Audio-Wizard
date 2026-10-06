// Standalone utilities for the -96 dB Amplify "mute" workaround per-clip.js's
// apply() falls back to for a partial, in-place lane -- disabling a clip item
// linked to video also disables the video (live 2026-09-17, see per-clip.js's
// toSilence/silenceRawClips comment), so muting goes through a native Amplify
// instead, renaming the clip with MUTE_SUFFIX as a cosmetic marker. That
// marker isn't visually obvious on the timeline, so:
//   - unmute() reverses it on the current selection: removes the Amplify and
//     strips the suffix.
//   - selectMuted() scans the WHOLE active sequence (every audio track, not
//     just a WTV session's clips) and selects every clip still muted this
//     way, so Dan can find them.
// Both are independent of any WTV clone/context, like lowend.js/deplosive.js's
// enhanceLowEnd -- they work on whatever sequence is active, regardless of
// workflow state.
const ppro = require('premierepro');
const host = require('./premiere.js');
const {inventory} = require('./per-clip.js');
const {amplifyGainParamIndexes} = require('./amplify-params.js');

// Mirrors per-clip.js's own constants -- kept separate rather than exported
// from there to avoid widening that file's module surface for two read-only
// values; see per-clip.js's own comment block above its AMPLIFY_MIN_DB.
const MUTE_SUFFIX = ' · WTV muted';
const AMPLIFY_MIN_DB = -96, AMPLIFY_MAX_DB = 48;
const dbToNormalized = db => (db - AMPLIFY_MIN_DB) / (AMPLIFY_MAX_DB - AMPLIFY_MIN_DB);
const isAmplify = async c => (typeof c.getDisplayName === 'function' && String(await c.getDisplayName()).trim().toLowerCase() === 'amplify') || /amplify/i.test((await c.getMatchName()) || '');

// Finds the Amplify component (if any) sitting at AMPLIFY_MIN_DB on either
// channel -- the same signature silenceRawClips()/setClipGains() writes.
// Detected by value rather than by trusting the name suffix alone: the
// suffix is applied in its own best-effort transaction AFTER the gain is
// verified (setClipGains's comment: "a rename failure must not fail Apply"),
// so a clip can be genuinely muted with no suffix if that rename failed.
async function findMuteAmplify(item) {
  let chain;
  try { chain = await item.getComponentChain(); } catch (_) { return null; }
  if (!chain) return null;
  const count = await chain.getComponentCount();
  for (let i = 0; i < count; i++) {
    const component = await chain.getComponentAtIndex(i);
    if (!await isAmplify(component)) continue;
    // Same gain-slider rule as setClipGains: "Left"/"Right" on stereo,
    // "Gain" on mono (see amplify-params.js).
    const {indexes} = await amplifyGainParamIndexes(component);
    for (const p of indexes) {
      const param = await component.getParam(p);
      const raw = await param.getValueAtTime(ppro.TickTime.createWithSeconds(0));
      const value = typeof raw === 'number' ? raw : raw && typeof raw === 'object' ? Number(raw.value) : Number(raw);
      if (Number.isFinite(value) && Math.abs(value - dbToNormalized(AMPLIFY_MIN_DB)) < 1e-3) return {chain, component};
    }
  }
  return null;
}

async function isMuted(entry) {
  if (entry.name && entry.name.endsWith(MUTE_SUFFIX)) return true;
  return Boolean(await findMuteAmplify(entry.item));
}

async function selectedEntries(sequence) {
  const all = await inventory(sequence);
  const selected = [];
  for (const entry of all) if (await entry.item.getIsSelected()) selected.push(entry);
  return selected;
}

// Removes the muting Amplify and strips the name suffix from every selected
// clip that carries either -- one transaction for the whole selection, like
// setClipGains's own batched phases. Handles are fresh from this call's own
// inventory() and untouched by any prior transaction in this run, so no
// re-locate is needed before building the actions (contrast with
// setClipGains, which re-locates because it runs several transactions back to
// back).
async function unmute({say = () => {}} = {}) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  const selected = await selectedEntries(sequence);
  if (!selected.length) throw new Error('Select one or more clips on the timeline before unmuting.');

  const targets = [];
  for (const entry of selected) {
    const found = await findMuteAmplify(entry.item);
    const hasSuffix = Boolean(entry.name && entry.name.endsWith(MUTE_SUFFIX));
    if (!found && !hasSuffix) continue;
    targets.push({entry, found, hasSuffix});
  }
  if (!targets.length) throw new Error('None of the selected clips are muted by WTVAudioWizard.');

  say(`Unmuting ${targets.length} clip(s)...`);
  try {
    host.transaction(project, `WTV: unmute (${targets.length} clip(s))`, compound => {
      for (const {entry, found, hasSuffix} of targets) {
        if (found) compound.addAction(found.chain.createRemoveComponentAction(found.component));
        if (hasSuffix) compound.addAction(entry.item.createSetNameAction(entry.name.slice(0, -MUTE_SUFFIX.length)));
      }
    });
  } catch (error) {
    throw new Error(`${error.message} [unmuting ${targets.map(t => `"${t.entry.name}"`).join(', ')}]`);
  }
  return {clips: targets.length, names: targets.map(t => t.entry.name)};
}

// Scans every audio track on the active sequence (not just the current WTV
// session's clips) for clips muted via the Amplify workaround, and makes
// that the sequence's visible timeline selection -- Sequence.setSelection(),
// synchronous and boolean-returning as of Premiere 26.3 (confirmed against
// Adobe's UXP reference). Selecting rather than merely listing lets Dan see
// exactly which clips are muted, since it isn't otherwise visible on the
// timeline.
//
// Both addItem() and setSelection() are called SYNCHRONOUSLY INSIDE
// createEmptySelection()'s callback, never on a reference kept past it --
// Adobe's reference is explicit that "the selection object is valid for the
// lifetime and scope of the callback; it's not recommended to extract or use
// the selection object from outside the callback." An earlier version of
// this function extracted `selection` and called addItem/setSelection on it
// afterward, which threw "A nullptr was dereferenced" live (2026-09-25) --
// most likely this scope violation, compounded by addItem's second,
// undocumented-here-until-now, REQUIRED `skipDuplicateCheck` boolean
// argument, which that version also omitted.
async function selectMuted({say = () => {}} = {}) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  say('Scanning the timeline for muted clips...');
  const all = await inventory(sequence);
  const muted = [];
  for (const entry of all) if (await isMuted(entry)) muted.push(entry);
  if (!muted.length) throw new Error('No clips muted by WTVAudioWizard were found on this sequence.');
  if (!ppro.TrackItemSelection?.createEmptySelection || typeof sequence.setSelection !== 'function') {
    throw new Error('This Premiere build cannot set the timeline selection.');
  }
  let built = false, applied = false, addFailures = 0;
  ppro.TrackItemSelection.createEmptySelection(sel => {
    built = true;
    for (const entry of muted) { if (!sel.addItem(entry.item, false)) addFailures++; }
    applied = sequence.setSelection(sel);
  });
  if (!built) throw new Error('Premiere did not create a selection group.');
  if (!applied) throw new Error(`Premiere did not accept the new selection.${addFailures ? ` ${addFailures} clip(s) could not be added.` : ''}`);
  return {clips: muted.length, names: muted.map(e => e.name)};
}

module.exports = {unmute, selectMuted, isMuted, findMuteAmplify, MUTE_SUFFIX};
