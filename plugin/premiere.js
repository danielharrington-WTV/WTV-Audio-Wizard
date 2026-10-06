const ppro = require('premierepro');
const {exportSequenceWithRenderWait} = require('./export-sync.js');
const id = sequence => sequence.guid.toString();
// project.getSequences() can contain null / guid-less entries (confirmed live
// 2026-09-17, clip 115 of a 158-clip batch: "Cannot read properties of null
// (reading 'guid')" from inside Array.find). Every caller goes through this
// so a transient bad entry never takes the batch down.
async function listSequences(project) {
  let list = [];
  try { list = await project.getSequences(); } catch (_) { list = []; }
  return (list || []).filter(s => { try { return Boolean(s && s.guid && s.guid.toString()); } catch (_) { return false; } });
}
const IMPORT_BIN_NAME = 'Audio Wizard';
const normalizePath = path => path.replace(/\\/g, '/').toLowerCase();

// `context.name` (derived from the active sequence's own name) is reused
// both as a Premiere sequence/track label AND, verbatim, as a real
// filesystem folder/file name (see main.js's `${context.name}-clips` /
// `${context.name}-input.wav`). An unbounded sequence name can carry
// characters Windows/macOS filenames reject (":", "/", "\", "?", "*", ...)
// or simply be long enough that appending this plugin's own suffixes
// (`_WTVAudioWizard_<13-digit timestamp>`, `_RENDER`, `-clips`, ...) pushes
// the final folder/file name past a 255-char filename-component limit, or
// the full path past Windows' legacy 260-char MAX_PATH. Capped and
// sanitized once here, at the one place `context.name` is built, so every
// downstream consumer (sequence naming, render clones, export folders/
// files) inherits a safe name automatically.
function sanitizeSequenceName(name, maxLength = 80) {
  const cleaned = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  const base = cleaned || 'Sequence';
  return base.length > maxLength ? base.slice(0, maxLength) : base;
}

function folderItem(item) {
  const FolderItem = ppro.FolderItem || ppro.FolderProjectItem;
  if (FolderItem && typeof FolderItem.cast === 'function') {
    try { return FolderItem.cast(item); } catch (_) { /* Host rejected cast. */ }
  }
  return item && typeof item.getItems === 'function' ? item : null;
}

function clipProjectItem(item) {
  const ClipProjectItem = ppro.ClipProjectItem;
  if (ClipProjectItem && typeof ClipProjectItem.cast === 'function') {
    try { return ClipProjectItem.cast(item); } catch (_) { /* Host rejected cast. */ }
  }
  return item && typeof item.getMediaFilePath === 'function' ? item : null;
}

// getTrackItems(type, includeEmptyTrackItems) can return `null` entries even
// with includeEmptyTrackItems=false (observed 2026-09-14: real host crash,
// "Cannot read properties of null (reading 'getStartTime')" in signature(),
// on a sequence with WTV-added stem lanes that only partially cover the
// timeline -- i.e. tracks with real gaps between clips). Adobe's own type
// declares this parameter as controlling whether *gap* placeholders (which
// are null) are included, but real hosts have been reported to include them
// regardless; every caller filters them out here rather than trusting the
// flag, since a null clearly is not a real clip to process either way.
async function clipTrackItems(track, type) {
  return (await track.getTrackItems(type, false)).filter(Boolean);
}

// Some track items (nested sequences, offline media, host quirks) return null
// from getProjectItem(). Never call .getId() blindly — use a timeline key for
// signatures, and assertLinkedMedia() before processing a clip.
async function trackItemSourceKey(item, trackIndex, start, end, media = 'audio') {
  let source = null;
  try { source = await item.getProjectItem(); } catch (_) { /* Host rejected read. */ }
  if (source && typeof source.getId === 'function') return source.getId();
  return `timeline:${media}:${trackIndex}:${String(start.ticks)}:${String(end.ticks)}`;
}

async function trackItemHasLinkedMedia(item) {
  try {
    const source = await item.getProjectItem();
    return Boolean(source && typeof source.getId === 'function');
  } catch (_) { return false; }
}

function transaction(project, label, build) {
  let ok = false;
  project.lockedAccess(() => { ok = project.executeTransaction(build, label); });
  if (!ok) throw new Error(`${label} failed`);
}

async function signature(sequence, audioCount) {
  const tracks = [];
  for (const media of ['Audio', 'Video']) {
    const count = media === 'Audio' && audioCount !== undefined ? audioCount : await sequence[`get${media}TrackCount`]();
    for (let index = 0; index < count; index++) {
      const track = await sequence[`get${media}Track`](index);
      const items = await clipTrackItems(track, ppro.Constants.TrackItemType.CLIP);
      const clips = [];
      for (const item of items) {
        const start = await item.getStartTime(), end = await item.getEndTime();
        clips.push([await trackItemSourceKey(item, index, start, end, media), item.getName ? await item.getName() : item.name, start.ticks, end.ticks,
          item.getInPoint ? (await item.getInPoint()).ticks : null, item.getOutPoint ? (await item.getOutPoint()).ticks : null,
          item.isDisabled ? await item.isDisabled() : null, item.getSpeed ? await item.getSpeed() : null,
          item.isSpeedReversed ? await item.isSpeedReversed() : null]);
      }
      tracks.push([media, index, track.name, media === 'Audio' ? await track.isMuted() : null, clips]);
    }
  }
  return JSON.stringify([id(sequence), (await sequence.getEndTime()).ticks, tracks]);
}

// Music ducking only needs fingerprinted audio lanes used as selected music or
// the dialogue reference -- not the full video tree or unrelated audio beds.
async function musicPassSignature(sequence, music, dialogue) {
  const watched = new Set([...music.map(c => c.trackIndex), ...dialogue.map(c => c.trackIndex)]);
  const tracks = [];
  const count = await sequence.getAudioTrackCount();
  for (let index = 0; index < count; index++) {
    if (!watched.has(index)) continue;
    const track = await sequence.getAudioTrack(index);
    const items = await clipTrackItems(track, ppro.Constants.TrackItemType.CLIP);
    const clips = [];
    for (const item of items) {
      const start = await item.getStartTime(), end = await item.getEndTime();
      clips.push([await trackItemSourceKey(item, index, start, end, 'Audio'), item.getName ? await item.getName() : item.name, start.ticks, end.ticks,
        item.getInPoint ? (await item.getInPoint()).ticks : null, item.getOutPoint ? (await item.getOutPoint()).ticks : null,
        item.isDisabled ? await item.isDisabled() : null, item.getSpeed ? await item.getSpeed() : null,
        item.isSpeedReversed ? await item.isSpeedReversed() : null]);
    }
    tracks.push(['Audio', index, track.name, await track.isMuted(), clips]);
  }
  return JSON.stringify([id(sequence), (await sequence.getEndTime()).ticks, tracks]);
}

function tryNameTrack(project, track, name) {
  // Some Premiere builds expose naming on project items but not audio tracks.
  // Track labels are cosmetic; failure must not interrupt verified placement.
  if (!track || typeof track.createSetNameAction !== 'function') return false;
  try {
    transaction(project, 'WTV: name stem track', c => c.addAction(track.createSetNameAction(name)));
    return true;
  } catch (_) { return false; }
}

const DEFAULT_AUDIO_CROSSFADE_MATCH = 'AE.ADBE Constant Power';

function clipTimelineKey(trackIndex, start, end) {
  return `${trackIndex}:${String(start.ticks)}:${String(end.ticks)}`;
}

// True if a transition's own span overlaps this clip's timeline span at all
// -- covers a two-sided crossfade extending across either of the clip's own
// edges, and a single-sided "dip"-style transition sitting on/around it.
// Exported so per-clip.js's inventory() can flag transitions per-clip
// instead of "this track has any transition anywhere", which used to block
// (and strip) clips that have nothing to do with a nearby unrelated
// transition between two other clips.
function transitionTouchesSpan(transitionStart, transitionEnd, start, end) {
  return transitionStart.seconds < end.seconds + 0.01 && transitionEnd.seconds > start.seconds - 0.01;
}

// Snapshot crossfades on source lanes before strip (pending clone only).
async function captureAudioCrossfadePlan(sequence, trackIndexes, processedClips) {
  const processed = new Set(processedClips.map(c => clipTimelineKey(c.trackIndex, c.start, c.end)));
  const plan = [];
  for (const trackIndex of [...new Set(trackIndexes)]) {
    const track = await sequence.getAudioTrack(trackIndex);
    const clipItems = await clipTrackItems(track, ppro.Constants.TrackItemType.CLIP);
    const clips = [];
    for (const item of clipItems) {
      if (await item.isDisabled()) continue;
      const start = await item.getStartTime(), end = await item.getEndTime();
      clips.push({start, end, key: clipTimelineKey(trackIndex, start, end)});
    }
    clips.sort((a, b) => a.start.seconds - b.start.seconds);
    const transitions = await clipTrackItems(track, ppro.Constants.TrackItemType.TRANSITION);
    for (let index = 0; index < clips.length - 1; index++) {
      const left = clips[index], right = clips[index + 1];
      if (!processed.has(left.key) || !processed.has(right.key)) continue;
      let matched = null;
      for (const transition of transitions) {
        let tStart, tEnd;
        try {
          tStart = await transition.getStartTime();
          tEnd = await transition.getEndTime();
        } catch (_) { continue; }
        if (!(tStart.seconds < right.start.seconds + 0.01 && tEnd.seconds > left.end.seconds - 0.01)) continue;
        let matchName = null;
        if (transition.getMatchName) try { matchName = await transition.getMatchName(); } catch (_) { /* Host rejected read. */ }
        let durationTicks = null;
        if (tEnd.subtract) durationTicks = String(tEnd.subtract(tStart).ticks);
        matched = {
          trackIndex,
          leftStartTicks: String(left.start.ticks),
          leftEndTicks: String(left.end.ticks),
          rightStartTicks: String(right.start.ticks),
          rightEndTicks: String(right.end.ticks),
          transitionStartTicks: String(tStart.ticks),
          transitionEndTicks: String(tEnd.ticks),
          matchName,
          durationTicks,
        };
        break;
      }
      if (matched) plan.push(matched);
    }
  }
  return plan;
}

async function createTransitionComponent(matchName) {
  const factory = ppro.TransitionFactory;
  if (!factory) return null;
  const name = matchName || DEFAULT_AUDIO_CROSSFADE_MATCH;
  if (typeof factory.createAudioTransition === 'function') return factory.createAudioTransition(name);
  if (typeof factory.createVideoTransition === 'function') return factory.createVideoTransition(name);
  return null;
}

function transitionStartPosition() {
  const transitionPos = ppro.VideoTransition || ppro.AudioTransition;
  return transitionPos?.TRANSITIONPOSITION_START ?? 0;
}

// NOTE: createAddAudioTransitionAction/createAddVideoTransitionAction are
// unconfirmed against Adobe's actual AudioClipTrackItem method surface (see
// stripAudioTransitions' note on the sibling removal methods, which were
// dropped for this reason). This path is only reached from
// reapplyDialogueCrossfades, which already treats every call here as
// best-effort and catches+reports failures per boundary rather than letting
// them interrupt Apply, so a wrong/missing method here degrades to "crossfade
// not restored" instead of breaking anything.
async function addAudioCrossfade(project, clipItem, entry) {
  let cast = clipItem;
  if (ppro.AudioClipTrackItem?.cast) {
    try { cast = ppro.AudioClipTrackItem.cast(clipItem) || clipItem; } catch (_) { /* Host rejected cast. */ }
  }
  const add = cast.createAddAudioTransitionAction || cast.createAddVideoTransitionAction;
  if (typeof add !== 'function') throw new Error('add transition API unavailable');
  const transition = await createTransitionComponent(entry.matchName);
  if (!transition) throw new Error('TransitionFactory unavailable');
  let options = null;
  if (ppro.AddTransitionOptions) {
    options = new ppro.AddTransitionOptions();
    let duration = null;
    if (entry.durationTicks != null && ppro.TickTime?.createWithTicks) {
      // createWithTicks(ticks: string) wants a string, not a number --
      // durationTicks is already stored as one (see its assignment above).
      duration = ppro.TickTime.createWithTicks(entry.durationTicks);
    } else if (entry.transitionStartTicks != null && entry.transitionEndTicks != null && ppro.TickTime?.createWithSeconds) {
      const seconds = Math.max(0.01, (Number(entry.transitionEndTicks) - Number(entry.transitionStartTicks)) / 254016000000);
      duration = ppro.TickTime.createWithSeconds(seconds);
    } else if (ppro.TickTime?.createWithSeconds) {
      duration = ppro.TickTime.createWithSeconds(0.125);
    }
    if (duration && options.setDuration) options.setDuration(duration);
  }
  transaction(project, 'WTV: restore crossfade', compound => {
    compound.addAction(options ? add.call(cast, transition, options) : add.call(cast, transition, transitionStartPosition()));
  });
}

// Best-effort: restore captured crossfades on Clean dialogue stem lanes after Apply.
// Re-fetches the sequence by id at the top of every loop iteration (rather
// than reusing the passed-in handle) since each iteration's addAudioCrossfade
// commits its own transaction, which can invalidate the sequence/track
// handles held from a prior iteration.
async function reapplyDialogueCrossfades(project, sequenceId, context, {insertAt, lanes}) {
  const plan = context.crossfadePlan || [];
  const report = {applied: 0, skipped: 0, total: plan.length, reasons: []};
  if (!plan.length) return report;
  for (const entry of plan) {
    const laneIndex = lanes.indexOf(entry.trackIndex);
    if (laneIndex < 0) { report.skipped++; report.reasons.push(`A${entry.trackIndex + 1} not in batch`); continue; }
    const destTrackIndex = insertAt + laneIndex;
    const sequence = await sequenceById(project, sequenceId);
    const track = await sequence.getAudioTrack(destTrackIndex);
    const items = await clipTrackItems(track, ppro.Constants.TrackItemType.CLIP);
    let rightItem = null;
    for (const item of items) {
      const start = await item.getStartTime();
      if (String(start.ticks) === entry.rightStartTicks) { rightItem = item; break; }
    }
    if (!rightItem) { report.skipped++; report.reasons.push(`missing stem at ${entry.rightStartTicks}`); continue; }
    try {
      await addAudioCrossfade(project, rightItem, entry);
      report.applied++;
    } catch (error) {
      report.skipped++;
      report.reasons.push(error.message);
    }
  }
  return report;
}

// Per-clip export isolates one clip at a time; a transition touching that
// clip's own edges makes that unreliable. Strip only transitions that touch
// a clip actually being processed (`processedClips`), on the pending clone
// only (original sequence untouched) -- a transition sitting entirely
// between two OTHER, unprocessed clips on the same track is left alone: it
// has nothing to do with this batch, and unconditionally removing it was
// both destructive (silently dropping a crossfade the user never asked to
// touch) and a source of "The script object is no longer valid" failures
// unrelated to the actual selection. Takes sequenceId (not a sequence
// handle) because this performs many transactions in a row -- the
// sequence/track/item handles fetched before a transaction can go stale the
// moment that transaction commits (even a transaction on that very object),
// so every handle here is re-fetched fresh immediately before each use,
// never carried across a transaction boundary.
//
// Only uses SequenceEditor.createRemoveItemsAction on the actual TRANSITION
// track items (the same removal pattern already confirmed working for real
// stem placement elsewhere in this file/per-clip.js). An earlier version also
// tried per-clip item.createRemoveAudioTransitionAction()/
// createRemoveVideoTransitionAction() as a first pass -- those method names
// were never confirmed against Adobe's actual AudioClipTrackItem surface
// (see PREMIERE-MUSIC-PASS.md's note that only "plus its create*Action
// methods" was ever verified, not an itemized list), and calling a
// nonexistent/mismatched action creator is a plausible way to get exactly
// Premiere's generic "The script object is no longer valid" failure. Removed
// rather than fixed: the TRANSITION-item removal below is already sufficient
// to satisfy validate()'s "no transitions on this clip" check on its own.
async function stripAudioTransitions(project, sequenceId, trackIndexes, processedClips) {
  const lanes = [...new Set(trackIndexes)];
  const processed = new Set((processedClips || []).map(c => clipTimelineKey(c.trackIndex, c.start, c.end)));
  let removed = 0;
  const mediaType = ppro.Constants?.MediaType?.AUDIO ?? ppro.Constants?.MediaType?.audio;

  for (const trackIndex of lanes) {
    for (let pass = 0; pass < 8; pass++) {
      // Re-fetch every handle each pass: the previous pass's removal
      // transaction may have invalidated the sequence/editor/track from the
      // prior iteration, even though nothing here looks different to us.
      const sequence = await sequenceById(project, sequenceId);
      const editor = ppro.SequenceEditor?.getEditor?.(sequence);
      if (!editor || typeof editor.createRemoveItemsAction !== 'function' || !ppro.TrackItemSelection?.createEmptySelection) break;
      const track = await sequence.getAudioTrack(trackIndex);
      const clipItems = await clipTrackItems(track, ppro.Constants.TrackItemType.CLIP);
      const processedSpans = [];
      for (const item of clipItems) {
        if (await item.isDisabled()) continue;
        const start = await item.getStartTime(), end = await item.getEndTime();
        if (processed.has(clipTimelineKey(trackIndex, start, end))) processedSpans.push({start, end});
      }
      const transitions = await clipTrackItems(track, ppro.Constants.TrackItemType.TRANSITION);
      const toRemove = [];
      for (const t of transitions) {
        let tStart, tEnd;
        try { tStart = await t.getStartTime(); tEnd = await t.getEndTime(); } catch (_) { continue; }
        if (processedSpans.some(c => transitionTouchesSpan(tStart, tEnd, c.start, c.end))) toRemove.push(t);
      }
      if (!toRemove.length) break;
      let selection = null;
      ppro.TrackItemSelection.createEmptySelection(sel => { selection = sel; });
      if (!selection) break;
      for (const t of toRemove) selection.addItem(t);
      transaction(project, 'WTV: remove audio transition items', c => {
        c.addAction(editor.createRemoveItemsAction(selection, false, mediaType, false));
      });
      removed += toRemove.length;
    }
  }
  return removed;
}

// Adobe's UXP scripting bridge never hands back a reference to the object an
// action creates (confirmed elsewhere in this codebase: importFiles() only
// returns a boolean, requiring a separate resolve step) -- so identifying a
// freshly cloned sequence means diffing project.getSequences() before/after
// the clone transaction, not reading a return value that doesn't exist. This
// helper does that diff for both cloneActive() below and per-clip.js's
// ensureRenderSequence(), which used to each hardcode the same pattern.
//
// `before` is the id set the caller captured (via project.getSequences())
// immediately before the clone transaction. `excludeIds` are ids that must
// never be accepted as "the new one" (the original sequence being cloned,
// an already-existing render sequence, ...), even if the diff surfaces them.
// `label` names the caller for the error text.
//
// If the diff doesn't land on exactly one acceptable candidate, this throws
// with the actual candidate count/names instead of a bare "could not
// identify" -- and flags one specific, UNCONFIRMED suspicion: if an excluded
// id was missing from `before` but exists afterward, project.getSequences()
// apparently did not include that sequence in its pre-clone snapshot. That
// is exactly what editing inside a nest (having stepped into a nested-
// sequence clip on another timeline, so the "active sequence" is the nest
// itself) would look like from here, if nested sequences aren't consistently
// returned by getSequences() -- but this has not been verified live, so the
// error only reports the observation, not a diagnosis.
// Walk every bin and collect project-item ids. Used to locate a cloned
// sequence that project.getSequences() never lists and that does not become
// active either -- confirmed live 2026-09-17 while editing inside a multicam
// source sequence ("Bear Multicam Day1"): the clone transaction succeeded, 0
// new sequences were listed, and the source stayed active. The clone still
// exists as a project item, so diff the bins instead and ask the new item
// for its sequence (ClipProjectItem.getSequence()).
const unlistedSequenceItems = new Map(); // sequence guid -> project item id
const unlistedItemHandles = new Map(); // sequence guid -> last known project item handle

async function snapshotProjectItems(project) {
  const seen = new Map();
  let root = null;
  try { root = await project.getRootItem(); } catch (_) { return seen; }
  const queue = [root];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const bin = queue.shift();
    let items = [];
    try { items = await listBinItems(folderItem(bin), bin); } catch (_) { continue; }
    for (const item of items || []) {
      let key = null;
      try { key = typeof item.getId === 'function' ? item.getId() : null; } catch (_) { /* ignore */ }
      if (key == null) continue;
      if (seen.has(key)) continue;
      seen.set(key, item);
      if (folderItem(item) || typeof item.getItems === 'function') queue.push(item);
    }
  }
  return seen;
}

async function sequenceFromProjectItem(item) {
  const candidates = [item];
  try { const cast = clipProjectItem(item); if (cast && cast !== item) candidates.push(cast); } catch (_) { /* ignore */ }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.getSequence !== 'function') continue;
    try {
      const sequence = await candidate.getSequence();
      if (sequence && sequence.guid) return sequence;
    } catch (_) { /* not a sequence item */ }
  }
  return null;
}

async function identifyNewSequence(project, before, excludeIds, label, beforeItems = null) {
  const after = await listSequences(project);
  const created = after.filter(seq => !before.has(id(seq)) && !excludeIds.includes(id(seq)));
  if (created.length === 1) return created[0];
  let itemNote = '';
  if (created.length === 0 && beforeItems) {
    const afterItems = await snapshotProjectItems(project);
    const fresh = [...afterItems.entries()].filter(([key]) => !beforeItems.has(key)).map(([, item]) => item);
    const found = [];
    for (const item of fresh) {
      const sequence = await sequenceFromProjectItem(item);
      if (sequence && !before.has(id(sequence)) && !excludeIds.includes(id(sequence))) found.push({sequence, item});
    }
    if (found.length === 1) {
      // Remember which project item backs this unlisted sequence so
      // findSequence() can re-fetch it by id later (handles go stale after
      // every transaction, and neither getSequences() nor the active
      // sequence will ever return it).
      try { unlistedSequenceItems.set(id(found[0].sequence), found[0].item.getId()); unlistedItemHandles.set(id(found[0].sequence), found[0].item); } catch (_) { /* ignore */ }
      return found[0].sequence;
    }
    itemNote = ` Project items new since the clone: ${fresh.length} (${fresh.map(i => `"${i.name}"`).join(', ') || 'none'}), of which ${found.length} resolved to a sequence.`;
  }
  // Confirmed live 2026-09-17: cloning a nested sequence produced a clone that
  // getSequences() never listed (0 candidates of 31), just as the nest itself
  // isn't listed. When the diff finds nothing, fall back to whatever Premiere
  // made active after the clone transaction -- if that's a sequence we didn't
  // know about beforehand and isn't excluded, it is the clone.
  let activeNote = '';
  if (created.length === 0) {
    const active = await project.getActiveSequence();
    if (active && !before.has(id(active)) && !excludeIds.includes(id(active))) return active;
    activeNote = active ? ` Active sequence after the clone: "${active.name}" (${before.has(id(active)) ? 'already known' : excludeIds.includes(id(active)) ? 'the source itself' : 'unlisted'}).` : ' No active sequence after the clone.';
  }
  const names = created.map(seq => `"${seq.name}"`).join(', ') || 'none';
  const missingFromBefore = excludeIds.some(excluded => excluded && !before.has(excluded) && after.some(seq => id(seq) === excluded));
  const nestHint = missingFromBefore ? ' The active/original sequence itself was missing from the pre-clone sequence list -- if you are editing inside a nested sequence, this may be why (unconfirmed).' : '';
  throw new Error(`Could not identify a unique ${label}; no timeline edits applied (found ${created.length} candidate sequence(s): ${names}, of ${after.length} sequence(s) total).${activeNote}${itemNote}${nestHint}`);
}

async function cloneActive() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first');
  const original = await project.getActiveSequence();
  if (!original) throw new Error('Activate a sequence first');
  const settings = await original.getSettings();
  const rate = Math.round((await settings.getAudioSampleRate()).value);
  const channels = await settings.getAudioChannelCount();
  if (![1, 2].includes(channels) || ![44100, 48000, 96000].includes(rate)) throw new Error('This preview supports mono/stereo sequences at 44.1, 48 or 96 kHz');
  const duration = (await original.getEndTime()).seconds;
  if (!(duration > 0)) throw new Error('Sequence has no duration. Check the active sequence in/out.');
  const before = new Set((await listSequences(project)).map(id));
  const beforeItems = await snapshotProjectItems(project);
  transaction(project, 'WTVAudioWizard: clone sequence', compound => compound.addAction(original.createCloneAction()));
  const createdSequence = await identifyNewSequence(project, before, [id(original)], 'clone', beforeItems);
  const sequenceId = id(createdSequence);
  let sequence = createdSequence;
  const item = await sequence.getProjectItem();
  if (!item || typeof item.createSetNameAction !== 'function') throw new Error('Premiere did not expose the cloned sequence in the project. Try saving the project and prepare again.');
  const baseName = sanitizeSequenceName(original.name);
  const name = `${baseName}_WTVAudioWizard_${Date.now()}`;
  transaction(project, 'WTVAudioWizard: name clone', c => c.addAction(item.createSetNameAction(`${name}_PENDING`)));
  // The naming transaction above may have invalidated `sequence`; re-fetch
  // before returning it for the caller to use.
  sequence = await sequenceById(project, sequenceId);
  return {project, sequence, sequenceId, originalId: id(original), rate, channels, duration, name, baseName, signature: await signature(sequence), applied: false};
}

// "Process in place" counterpart to cloneActive() above: same validation,
// but no clone transaction and no rename -- the panel adds tracks directly
// to the active sequence instead of a safety-copy clone. `originalId: null`
// deliberately reuses resumeAppliedClone()'s existing trick below: every
// downstream check that compares a context's sequence against
// `context.originalId` (assertUnchanged()'s "refusing to edit original
// sequence" guard) exists only to stop the CLONE flow from accidentally
// operating on the real sequence it was supposed to leave alone -- that
// guard has nothing to protect against here, since operating on the real
// sequence is the entire point, and `null` can never equal a real
// sequence's guid so it stays a safe no-op rather than a special case.
// `inPlace: true` is what applyStems() below uses to skip the final
// clone-only rename step, so the active sequence keeps its real name.
async function useActive() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first');
  const settings = await sequence.getSettings();
  const rate = Math.round((await settings.getAudioSampleRate()).value);
  const channels = await settings.getAudioChannelCount();
  if (![1, 2].includes(channels) || ![44100, 48000, 96000].includes(rate)) throw new Error('This preview supports mono/stereo sequences at 44.1, 48 or 96 kHz');
  const duration = (await sequence.getEndTime()).seconds;
  if (!(duration > 0)) throw new Error('Sequence has no duration. Check the active sequence in/out.');
  // Same timestamped label the clone flow uses -- the sequence itself is NOT
  // renamed in place, but `context.name` is also the export folder/file and
  // render-clone name, and it must be unique per run: a plain sequence name
  // collided with the previous run's `<name>-clips` folder on the first live
  // in-place attempt ("A Folder with given name exists", 2026-09-17).
  const baseName = sanitizeSequenceName(sequence.name);
  const name = `${baseName}_WTVAudioWizard_${Date.now()}`;
  return {project, sequence, sequenceId: id(sequence), originalId: null, rate, baseName, channels, duration, name, signature: await signature(sequence), applied: false, inPlace: true};
}

// `context` (holding sequence/rate/channels/dialoguePaths/applied/etc.) is
// purely in-memory panel state -- it does not survive a panel reload or a
// Premiere restart, even though the actual finished clone sequence it
// described is still sitting right there on disk/in the project. Without
// this, reloading the panel after steps 1-3 already succeeded permanently
// loses access to music ducking / fix-a-pop / enhance-low-end (all gated on
// `context.applied`) unless the user reruns steps 1-3 from scratch onto a
// brand new clone, duplicating already-finished work.
//
// Reconstructs a minimal, safe-enough `context` from whatever sequence is
// currently active, IF (and only if) its name matches this plugin's own
// finished-clone naming pattern from cloneActive() above
// (`..._WTVAudioWizard_<timestamp>`, with the `_PENDING` suffix already
// gone, since that suffix is only ever removed by applyStems()'s "finish
// clone" transaction on a successful Add-tracks). Never guesses on an
// ordinary/untouched sequence: returns null unless that pattern matches.
//
// `originalId` is set to null (rather than reconstructed) since the
// original sequence's identity isn't recoverable from the clone alone --
// every check downstream that compares against `originalId` only exists to
// stop this plugin from accidentally editing the wrong sequence, and `null`
// can never equal a real sequence's guid, so that safety check still holds.
//
// `dialoguePaths` is reconstructed on a best-effort basis by reading back
// the media on a track literally named "Clean dialogue" (the label
// applyStems()/per-clip.js's apply() name that track with, best-effort --
// see tryNameTrack()) so the default "Duck against -> Clean dialogue"
// reference still works after resuming, without requiring the user to
// switch to "Choose tracks" and pick manually. Silently empty if that
// track-naming attempt didn't stick on this host; music-pass.js already
// reports a clear, actionable error for that case ("use Choose tracks").
async function resumeAppliedClone() {
  const project = await ppro.Project.getActiveProject();
  if (!project) return null;
  const sequence = await project.getActiveSequence();
  if (!sequence) return null;
  let name = sequence.name;
  const seqItem = await sequence.getProjectItem();
  if (seqItem && typeof seqItem.getName === 'function') {
    try { name = await seqItem.getName(); } catch (_) { /* Fall back to sequence.name. */ }
  }
  if (!/_WTVAudioWizard_\d+$/.test(name)) return null;
  const settings = await sequence.getSettings();
  const rate = Math.round((await settings.getAudioSampleRate()).value);
  const channels = await settings.getAudioChannelCount();
  const duration = (await sequence.getEndTime()).seconds;
  const dialoguePaths = [];
  const count = await sequence.getAudioTrackCount();
  for (let index = 0; index < count; index++) {
    const track = await sequence.getAudioTrack(index);
    if (track.name !== 'Clean dialogue' || await track.isMuted()) continue;
    for (const item of await clipTrackItems(track, ppro.Constants.TrackItemType.CLIP)) {
      if (await item.isDisabled()) continue;
      const source = clipProjectItem(await item.getProjectItem());
      if (!source) continue;
      try { dialoguePaths.push(await source.getMediaFilePath()); } catch (_) { /* Host rejected read. */ }
    }
  }
  return {project, sequence, sequenceId: id(sequence), originalId: null, rate, channels, duration, name,
    signature: await signature(sequence), applied: true, failedApply: false, dialoguePaths, resumed: true};
}

// Premiere UXP sequence/track handles can go stale immediately after any
// transaction touches the project (even a transaction on that same object,
// e.g. renaming it, or removing items on one of its tracks) -- calling a
// method on the old handle afterward throws "The script object is no longer
// valid." Always re-fetch by guid right before using a handle again if any
// transaction happened since it was last fetched.
//
// Confirmed live 2026-09-17: when the active sequence is a nested sequence
// (opened by stepping into a nest clip), project.getSequences() does NOT list
// it. Every by-id lookup therefore also checks project.getActiveSequence(),
// so an in-place session on a nest can be re-fetched like any other sequence.
async function findSequence(project, sequenceId) {
  const listed = (await listSequences(project)).find(s => id(s) === sequenceId);
  if (listed) return listed;
  const active = await project.getActiveSequence();
  if (active && id(active) === sequenceId) return active;
  // Third path: a clone located through its project item (see
  // identifyNewSequence). Re-walk the bins for that item and ask it again.
  const itemKey = unlistedSequenceItems.get(sequenceId);
  if (itemKey == null) return null;
  // Try the last project-item handle first: it usually survives sequence-
  // level transactions, and asking it directly skips walking every bin in
  // the project (which the multicam per-clip export loop hit several times
  // per clip, 2026-09-17). Re-walk only when the handle no longer answers.
  const cached = unlistedItemHandles.get(sequenceId);
  if (cached) {
    try {
      const sequence = await sequenceFromProjectItem(cached);
      if (sequence && id(sequence) === sequenceId) return sequence;
    } catch (_) { /* stale handle */ }
    unlistedItemHandles.delete(sequenceId);
  }
  const item = (await snapshotProjectItems(project)).get(itemKey);
  const sequence = item ? await sequenceFromProjectItem(item) : null;
  if (sequence && id(sequence) === sequenceId) { unlistedItemHandles.set(sequenceId, item); return sequence; }
  return null;
}

async function sequenceById(project, sequenceId) {
  const sequence = await findSequence(project, sequenceId);
  if (!sequence) throw new Error('Could not find the sequence in the project. It may have been closed or deleted.');
  return sequence;
}

async function resolveContextSequence(context) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Return to the project containing the sequence');
  context.project = project;
  const want = context.sequenceId || (context.sequence && id(context.sequence));
  if (!want) throw new Error('Missing sequence identity. Run Batch Process Dialogue again.');
  const sequence = await findSequence(project, want);
  if (!sequence) throw new Error(context.inPlace ? 'Return to the project and reopen the sequence being processed' : 'Return to the project containing the clone');
  context.sequence = sequence;
  return sequence;
}

async function assertUnchanged(context) {
  await resolveContextSequence(context);
  if (id(context.sequence) === context.originalId) throw new Error('Refusing to edit original sequence');
  const active = await ppro.Project.getActiveProject();
  if (!active || !await findSequence(active, id(context.sequence))) throw new Error('Return to the project containing the sequence');
  if (context.signature !== await signature(context.sequence)) throw new Error('Clone timing or tracks changed after export. Run Batch Process Dialogue again for a new clone.');
  if (context.applied) throw new Error('This result was already applied');
}

async function ensureImportBin(project) {
  const root = await project.getRootItem();
  const fallback = () => ({target: root, list: root});
  if (typeof root.createBinAction !== 'function') return fallback();
  async function findBin() {
    for (const item of await root.getItems()) {
      if (item.name !== IMPORT_BIN_NAME) continue;
      const folder = folderItem(item);
      if (folder) return {target: item, list: folder};
      if (typeof item.getItems === 'function') return {target: item, list: item};
    }
    return null;
  }
  let resolved = await findBin();
  if (!resolved) {
    try {
      transaction(project, 'WTV: ensure import bin', compound => {
        compound.addAction(root.createBinAction(IMPORT_BIN_NAME, false));
      });
    } catch (_) {
      return fallback();
    }
    resolved = await findBin();
  }
  return resolved || fallback();
}

async function listBinItems(list, root) {
  if (list && typeof list.getItems === 'function') return list.getItems();
  if (root && typeof root.getItems === 'function') return root.getItems();
  throw new Error('Could not read project bin contents');
}

async function importIntoBin(project, paths, errorMessage = 'WAV import failed') {
  const root = await project.getRootItem();
  const {target, list} = await ensureImportBin(project);
  const byPath = new Map();
  if (!paths.length) return {bin: target, added: [], byPath};
  // Import one file at a time so each path maps to exactly one new bin item.
  // Batch imports on some hosts return fewer ProjectItems than paths, which
  // breaks per-clip Apply when many clip/stem WAVs land in one transaction.
  for (const filePath of paths) {
    const key = normalizePath(filePath);
    if (byPath.has(key)) continue;
    const before = new Set((await listBinItems(list, root)).map(item => item.getId()));
    if (!await project.importFiles([filePath], true, target, false)) throw new Error(errorMessage);
    const newItems = (await listBinItems(list, root)).filter(item => !before.has(item.getId()));
    let match = null;
    for (const item of newItems) {
      const clip = clipProjectItem(item);
      if (!clip) continue;
      if (normalizePath(await clip.getMediaFilePath()) === key) match = {item, imported: clip};
    }
    if (!match && newItems.length === 1) {
      const clip = clipProjectItem(newItems[0]) || newItems[0];
      match = {item: newItems[0], imported: clip};
    }
    if (!match) throw new Error(errorMessage);
    byPath.set(key, match);
  }
  return {bin: target, added: [...byPath.values()].map(entry => entry.item), byPath};
}

async function exportWav(context, preset, path, hooks = {}) {
  await assertUnchanged(context);
  const extension = await ppro.EncoderManager.getExportFileExtension(context.sequence, preset);
  if (typeof extension !== 'string' || extension.replace('.', '').toLowerCase() !== 'wav') throw new Error('Premiere could not use the bundled WAV preset');
  const manager = await ppro.EncoderManager.getManager();
  return exportSequenceWithRenderWait({
    ppro,
    manager,
    sequence: context.sequence,
    exportType: ppro.Constants.ExportType.IMMEDIATELY,
    outputFile: path,
    presetFile: preset,
    exportFull: true,
    outputNativePath: path,
    check: hooks.check,
    sleep: hooks.sleep,
    verifyOutput: hooks.verifyOutput,
    deadlineMs: hooks.deadlineMs || 15 * 60 * 1000,
    rejectedMessage: 'Premiere did not accept the export',
  });
}

async function applyStems(context, paths, labels = ['Clean dialogue', 'Ambience', 'Music']) {
  if (context.failedApply) throw new Error(context.inPlace ? 'Run Batch Process Dialogue again after the failed insertion.' : 'Run Batch Process Dialogue again for a fresh clone after the failed insertion.');
  await assertUnchanged(context);
  const {project, sequence} = context;
  const {byPath} = await importIntoBin(project, paths);
  const imported = paths.map(path => byPath.get(normalizePath(path))?.item);
  if (imported.some(item => !item)) throw new Error('Cannot identify all imported WAVs; no timeline edits applied');
  await assertUnchanged(context);
  const count = await sequence.getAudioTrackCount();
  const oldTracks = [];
  for (let i = 0; i < count; i++) {
    const track = await sequence.getAudioTrack(i);
    oldTracks.push({track, muted: await track.isMuted()});
  }
  const editor = ppro.SequenceEditor.getEditor(sequence);
  context.failedApply = true;
  try {
  transaction(project, 'WTVAudioWizard: add stems', c => {
    imported.forEach((item, index) => c.addAction(editor.createInsertProjectItemAction(item, ppro.TickTime.TIME_ZERO, -1, count + index, true)));
  });
    if (context.signature !== await signature(sequence, count)) throw new Error('Raw audio or video changed unexpectedly');
    for (let i = 0; i < paths.length; i++) {
      const track = await sequence.getAudioTrack(count + i);
      if (!tryNameTrack(project, track, labels[i])) context.defaultTrackNames = true;
    }
    // Main tab's "Auto mute" (2026-10-01): off leaves the raw tracks audible.
    if (context.autoMute !== false) for (const entry of oldTracks) if (!await entry.track.setMute(true)) throw new Error(context.inPlace ? 'Could not mute an original track' : 'Could not mute an original track in clone');
    // In-place mode never renames the active sequence -- it isn't a
    // disposable clone the panel owns, it's the sequence Dan was already
    // editing, and this rename exists only to mark a clone as "finished"
    // (see cloneActive()'s `_PENDING` suffix / resumeAppliedClone()'s name
    // match). context.applied is enough to mark completion in-place.
    if (!context.inPlace) {
      const item = await sequence.getProjectItem();
      transaction(project, 'WTVAudioWizard: finish clone', c => c.addAction(item.createSetNameAction(context.name)));
    }
    context.failedApply = false;
    context.applied = true;
  } catch (error) {
    const recovery = [];
    for (const entry of oldTracks) { try { if (!await entry.track.setMute(entry.muted)) recovery.push('old track'); } catch (_) { recovery.push('old track'); } }
    for (let i = count; i < await sequence.getAudioTrackCount(); i++) { try { if (!await (await sequence.getAudioTrack(i)).setMute(true)) recovery.push('result track'); } catch (_) { recovery.push('result track'); } }
    const retained = context.inPlace ? 'Original sequence retained for inspection; use Undo if unsure.' : 'Clone retained for inspection.';
    throw new Error(`${error.message}. ${retained}${recovery.length ? ' Mute recovery was incomplete; inspect the sequence before playback.' : ' Added stems muted and old mute states restored.'}`);
  }
  await project.openSequence(sequence);
  await project.setActiveSequence(sequence);
}

// Ticks per frame of the sequence's video timebase, or null when the host
// doesn't expose it. Premiere floors a newly placed audio clip's start and
// duration to this grid (confirmed live 2026-09-14 on a 29.97 sequence), so
// per-clip placement needs it to cover raw clips that don't sit on whole
// frames. Sequence.getTimebase() (UXP, since 25.6) returns the value as a
// string -- Adobe's own sample does Number(await sequence.getTimebase()) --
// with SequenceSettings.getVideoFrameRate().ticksPerFrame as the fallback.
// Both are plain getters (no create*Action), probed defensively; a missing or
// implausible answer degrades to the exact-span behaviour, never an error.
async function sequenceFrameTicks(sequence) {
  const plausible = n => Number.isInteger(n) && n >= 254016000000 / 240 && n <= 254016000000;
  try {
    if (typeof sequence.getTimebase === 'function') {
      const n = Number(await sequence.getTimebase());
      if (plausible(n)) return n;
    }
  } catch (_) { /* Fall through to the settings-based probe. */ }
  try {
    const settings = typeof sequence.getSettings === 'function' ? await sequence.getSettings() : null;
    if (settings && typeof settings.getVideoFrameRate === 'function') {
      const rate = await settings.getVideoFrameRate();
      const n = Number(rate?.ticksPerFrame ?? (rate?.value > 0 ? Math.round(254016000000 / rate.value) : NaN));
      if (plausible(n)) return n;
    }
  } catch (_) { /* Host doesn't expose a frame rate; caller uses exact spans. */ }
  return null;
}

async function getProjectFolder(fs) {
  const path = require('path');
  const project = await ppro.Project.getActiveProject();
  const projectPath = project?.path;
  if (!projectPath) return null;
  try {
    const entry = await fs.getEntryWithUrl(path.dirname(projectPath));
    if (entry && entry.isFolder) return entry;
  } catch (_) { /* Host denied or path unavailable. */ }
  return null;
}

// Full path of the active project file, or null when it has never been saved.
async function getProjectPath() {
  const project = await ppro.Project.getActiveProject();
  return project?.path || null;
}

module.exports = {getProjectPath, cloneActive, useActive, findSequence, listSequences, snapshotProjectItems, resumeAppliedClone, exportWav, applyStems, assertUnchanged, resolveContextSequence, transaction, signature, musicPassSignature, tryNameTrack, captureAudioCrossfadePlan, stripAudioTransitions, reapplyDialogueCrossfades, transitionTouchesSpan, ensureImportBin, importIntoBin, clipProjectItem, trackItemSourceKey, trackItemHasLinkedMedia, clipTrackItems, sequenceFrameTicks, normalizePath, getProjectFolder, identifyNewSequence, IMPORT_BIN_NAME, DEFAULT_AUDIO_CROSSFADE_MATCH};
