// Pure computation of the main panel's step 1-4 button-enabled/disabled state
// and main hint text, factored out of `main.js`'s `updateActions()` so it can
// be unit tested without a DOM or the real `uxp` module -- `main.js` requires
// both at module scope and isn't practical to load under plain Node, so this
// is the testable seam for that logic instead of a full DOM-harness test file.
//
// Takes plain data, returns plain data; callers assign the results to
// `$(id).disabled` / `$('mainHint').textContent` themselves.
function computeButtonState({context, busy, factory, jobResult, mode = 'per_clip', stepsSelected = true}) {
  // Resumable is a stronger, more specific case of "not yet prepared" -- an
  // interrupted per-clip batch with real partial progress worth continuing,
  // as opposed to a context that's simply never been prepared at all. Used
  // only to relabel the button/hint; the host-side validity check
  // (assertUnchanged) that full resumableBatch() in main.js also requires
  // isn't available here, so this can occasionally offer to "Resume" a batch
  // that main.js's stricter check then falls back to a fresh Prepare for
  // anyway -- harmless, since the fallback behaves identically either way.
  const resumable = isResumableBatchContext(context);
  // Only block re-running Prepare while a batch is actually in flight (prepared/exported
  // but not yet applied or failed). Once a batch finishes -- successfully (`applied`) or
  // not (`failedApply`) -- Prepare re-enables so a different clip/selection can be run
  // through steps 1-3 without reconnecting; the finished clone stays intact either way,
  // and step 4/Fix a pop/Enhance low end keep working against it until Prepare is clicked.
  const prepareDone = Boolean(context && !context.failedApply && !context.applied && (context.prepared || context.exportPath));
  const processDone = Boolean(jobResult);
  const applyDone = Boolean(context?.applied);
  const failedApply = Boolean(context?.failedApply);
  const prepareDisabled = busy || !factory || prepareDone;
  const processDisabled = busy || !factory || !context || applyDone || failedApply || (context?.mode === 'per_clip' && !context.prepared) || processDone;
  const applyDisabled = busy || !jobResult || !context || applyDone || failedApply;
  return {
    prepare: prepareDisabled,
    process: processDisabled,
    apply: applyDisabled,
    // Enabled whenever any of steps 1-3 is: main.js's handler simply runs
    // each step that's currently enabled, in order. After a finished
    // (applied) or failed batch, Prepare is enabled again for a new batch,
    // so Run must be too -- it used to stay greyed out in exactly those
    // states (2026-09-17), leaving Dan to click Prepare/Clean/Add by hand.
    // The only Clean dialogue control since v0.8.1 (steps 1-3 buttons are
    // gone): runs whichever of prepare/process/apply are due, in both modes.
    // Also off when every step in the Processing menu is unticked (2026-09-29).
    runCleanDialogue: busy || !factory || !stepsSelected
      || (prepareDisabled && processDisabled && applyDisabled),
    musicPass: busy || failedApply || Boolean(context && !context.applied),
    // Fix a pop runs entirely in-panel (local-dsp.js) and works on whatever
    // single clip is selected, with or without a WTV session: deplosive.js
    // derives the render settings from the active sequence when there's no
    // applied context. So, like Enhance low end, only `busy` disables it
    // (v0.8.1, Dan: "so it isn't greyed out by default").
    fixPop: busy,
    // Standalone, unlike every other step/utility above -- works on whatever is
    // selected on the timeline regardless of WTV session state, and no longer
    // needs the service either.
    enhanceLowEnd: busy,
    // Extract ambience still goes through the service (model-based, not pure
    // CPU DSP), so it still needs a live connection.
    extractAmbience: busy || !factory,
    // Restore Speech (Sidon) runs on the service's GPU, so like Extract
    // ambience it needs a live connection. Whether Sidon is installed there
    // is checked on click, with setup instructions if it isn't.
    restoreSpeech: busy || !factory,
    // Unmute/Select muted are pure client-side Amplify-effect bookkeeping --
    // no service connection or WTV session needed, like Enhance low end.
    unmuteClips: busy,
    selectMuted: busy,
    cancel: !busy,
    runLabel: resumable ? 'Resume Batch Process Dialogue' : 'Batch Process Dialogue',
    hint: !factory ? 'Connect for dialogue cleanup.'
      : !stepsSelected ? 'Tick at least one step in Batch Process Options.'
      : !context ? 'Select dialogue; leave music unselected.'
      : resumable ? `Export was interrupted (${context.clips.filter(c => c.exportVerified).length}/${context.clips.length} clips already done). Click Resume Batch Process Dialogue to continue.`
      : failedApply ? (context.inPlace ? 'Inspect the sequence before starting again.' : 'Inspect the pending clone before starting again.')
      : context.applied ? 'Dialogue added. Select music and click Level & duck music, or select other clips and click Batch Process Dialogue again.'
      : jobResult ? 'Cleaned audio is ready. Click Batch Process Dialogue to add the tracks.'
      : context.prepared ? 'Exports are ready. Click Batch Process Dialogue to continue.'
      : 'Click Batch Process Dialogue to continue.'
  };
}
// Pure part of deciding whether an in-memory per-clip `context` is worth
// resuming (continuing the SAME export batch where it left off) rather than
// discarding and starting a brand-new one from scratch. Split out from
// main.js's resumableBatch() -- which also needs an async host call
// (assertUnchanged, confirming the pending clone is still intact) that this
// deliberately leaves out, so this half stays plain-data testable.
function isResumableBatchContext(context) {
  if (!context || context.mode !== 'per_clip' || context.prepared || context.applied || context.failedApply) return false;
  return Boolean(context.clips?.some(c => c.exportVerified));
}
module.exports = {computeButtonState, isResumableBatchContext};
