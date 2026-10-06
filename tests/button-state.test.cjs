const test = require('node:test'), assert = require('node:assert/strict');
const {computeButtonState, isResumableBatchContext} = require('../plugin/button-state.js');

test('prepare is disabled while a batch is prepared but not yet applied or failed', () => {
  const state = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: false}, busy: false, factory: {}, jobResult: null});
  assert.equal(state.prepare, true);
});

test('prepare re-enables after a batch finishes successfully, so a different clip can be prepared next (regression: 2026-09-14)', () => {
  const state = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: true}, busy: false, factory: {}, jobResult: null});
  assert.equal(state.prepare, false);
  // step 4 / Fix a pop stay usable against the just-finished context too.
  assert.equal(state.musicPass, false);
  assert.equal(state.fixPop, false);
});

test('prepare re-enables after a failed apply, matching the successful-apply case', () => {
  const state = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: false, failedApply: true}, busy: false, factory: {}, jobResult: null});
  assert.equal(state.prepare, false);
  assert.equal(state.musicPass, true);
  // Fix a pop is standalone (any selected clip), so a failed apply doesn't block it.
  assert.equal(state.fixPop, false);
});

test('music is available offline while server features remain disabled', () => {
  const state = computeButtonState({context: null, busy: false, factory: null, jobResult: null});
  assert.equal(state.prepare, true);
  assert.equal(state.musicPass, false);
  // Hint trimmed to just the useful part (2026-09-25).
  assert.match(state.hint, /Connect for dialogue cleanup/);
});

test('enhanceLowEnd runs entirely in-panel now, so it needs neither a connection nor an active context (2026-09-22)', () => {
  const withFactory = computeButtonState({context: null, busy: false, factory: {}, jobResult: null});
  assert.equal(withFactory.enhanceLowEnd, false);
  const withoutFactory = computeButtonState({context: null, busy: false, factory: null, jobResult: null});
  assert.equal(withoutFactory.enhanceLowEnd, false);
});

test('fixPop is enabled by default: no connection or WTV session needed, only disabled while busy (v0.8.1)', () => {
  const applied = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: true}, busy: false, factory: null, jobResult: null});
  assert.equal(applied.fixPop, false);
  const fresh = computeButtonState({context: null, busy: false, factory: null, jobResult: null});
  assert.equal(fresh.fixPop, false);
});

test('everything disables while busy, except cancel', () => {
  const state = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: true}, busy: true, factory: {}, jobResult: null});
  assert.equal(state.prepare, true);
  assert.equal(state.process, true);
  assert.equal(state.apply, true);
  assert.equal(state.musicPass, true);
  assert.equal(state.fixPop, true);
  assert.equal(state.enhanceLowEnd, true);
  assert.equal(state.cancel, false); // cancel is enabled (not disabled) while busy
});

test('isResumableBatchContext: interrupted per-clip batch with partial progress is resumable', () => {
  const context = {mode: 'per_clip', prepared: false, applied: false, failedApply: false,
    clips: [{exportVerified: true}, {exportVerified: true}, {exportVerified: false}]};
  assert.equal(isResumableBatchContext(context), true);
});

test('isResumableBatchContext: no context is not resumable', () => {
  assert.equal(isResumableBatchContext(null), false);
});

test('isResumableBatchContext: full-sequence mode is never resumable', () => {
  const context = {mode: 'full_sequence', clips: [{exportVerified: true}]};
  assert.equal(isResumableBatchContext(context), false);
});

test('isResumableBatchContext: a batch that already finished (prepared) is not resumable', () => {
  const context = {mode: 'per_clip', prepared: true, clips: [{exportVerified: true}]};
  assert.equal(isResumableBatchContext(context), false);
});

test('isResumableBatchContext: an applied or failed-apply context is not resumable', () => {
  assert.equal(isResumableBatchContext({mode: 'per_clip', applied: true, clips: [{exportVerified: true}]}), false);
  assert.equal(isResumableBatchContext({mode: 'per_clip', failedApply: true, clips: [{exportVerified: true}]}), false);
});

test('isResumableBatchContext: a batch with zero progress (nothing exported yet) is not resumable (fresh prepare handles that)', () => {
  const context = {mode: 'per_clip', clips: [{exportVerified: false}, {exportVerified: false}]};
  assert.equal(isResumableBatchContext(context), false);
});

test('runCleanDialogue is enabled for a fresh per-clip session', () => {
  const state = computeButtonState({context: null, busy: false, factory: {}, jobResult: null, mode: 'per_clip'});
  assert.equal(state.runCleanDialogue, false);
});

test('Batch Process Dialogue also works in full sequence mode: it is the only Clean dialogue control since v0.8.1', () => {
  const state = computeButtonState({context: null, busy: false, factory: {}, jobResult: null, mode: 'full_sequence'});
  assert.equal(state.runCleanDialogue, false);
  assert.equal(state.runLabel, 'Batch Process Dialogue');
});

test('Batch Process Dialogue relabels to Resume when an interrupted per-clip export batch has progress', () => {
  const context = {mode: 'per_clip', prepared: false, applied: false, clips: [{exportVerified: true}, {exportVerified: false}]};
  const state = computeButtonState({context, busy: false, factory: {}, jobResult: null, mode: 'per_clip'});
  assert.equal(state.runLabel, 'Resume Batch Process Dialogue');
  assert.match(state.hint, /Resume Batch Process Dialogue/);
});

test('runCleanDialogue re-enables after an applied or failed batch, matching Prepare (2026-09-17)', () => {
  for (const context of [{mode: 'per_clip', prepared: true, applied: true}, {mode: 'per_clip', prepared: true, applied: false, failedApply: true}]) {
    const state = computeButtonState({context, busy: false, factory: {}, jobResult: {mode: 'per_clip'}, mode: 'per_clip'});
    assert.equal(state.prepare, false);
    assert.equal(state.runCleanDialogue, false);
  }
  const busy = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: true}, busy: true, factory: {}, jobResult: null, mode: 'per_clip'});
  assert.equal(busy.runCleanDialogue, true);
});

test('runCleanDialogue stays enabled mid-batch when only process and apply remain', () => {
  const state = computeButtonState({context: {mode: 'per_clip', prepared: true, applied: false}, busy: false, factory: {}, jobResult: null, mode: 'per_clip'});
  assert.equal(state.prepare, true);
  assert.equal(state.process, false);
  assert.equal(state.runCleanDialogue, false);
});

test('restoreSpeech (Sidon on the service GPU) needs a connection, not a WTV session, and is disabled while busy', () => {
  assert.equal(computeButtonState({context: null, busy: false, factory: null, jobResult: null}).restoreSpeech, true);
  assert.equal(computeButtonState({context: null, busy: false, factory: {}, jobResult: null}).restoreSpeech, false);
  assert.equal(computeButtonState({context: {applied: true}, busy: false, factory: {}, jobResult: null}).restoreSpeech, false);
  assert.equal(computeButtonState({context: null, busy: true, factory: {}, jobResult: null}).restoreSpeech, true);
});

test('Batch Process Dialogue is off with every Batch Process Options step unticked, and the hint says why', () => {
  const none = computeButtonState({context: null, busy: false, factory: {}, jobResult: null, stepsSelected: false});
  assert.equal(none.runCleanDialogue, true);
  assert.match(none.hint, /Tick at least one step in Batch Process Options/);
  assert.equal(computeButtonState({context: null, busy: false, factory: {}, jobResult: null, stepsSelected: true}).runCleanDialogue, false);
  assert.equal(computeButtonState({context: null, busy: false, factory: {}, jobResult: null}).runCleanDialogue, false, 'defaults to steps selected');
});
