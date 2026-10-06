// Pure logic for the "Click/pop report" panel button. No UXP dependency, so
// this is unit-testable directly (see tests/click-pop-report.test.cjs).
//
// DORMANT: the "Help & repair report" section (and its "Click/pop report"
// button) was removed from plugin/index.html/main.js again. This module is
// no longer wired up from the panel. Left in place, still covered by
// tests/click-pop-report.test.cjs, for a future revival.
//
// Timestamps are seconds-based (mm:ss.mmm), not SMPTE frame-accurate: no code
// path elsewhere in this plugin reads sequence frame rate, only audio sample
// rate/ticks/seconds (see per-clip.js), so that is what can honestly be shown.
function formatTimestamp(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(3);
  return `${String(minutes).padStart(2, '0')}:${remainder.padStart(6, '0')}`;
}

// context/jobResult mirror the panel's module-level state; clickPopEvents is
// clip-batch.js's aggregation helper, passed in to keep this module UXP-free.
function summarize(context, jobResult, clickPopEvents) {
  if (context && context.mode === 'per_clip') {
    if (!context.clips || !context.clips.some(c => c.result)) {
      return {ran: false, anyEnabled: false, total: 0, clips: context.clips ? context.clips.length : 0, events: []};
    }
    const anyEnabled = context.clips.some(c => c.result && c.result.deess_declick);
    const total = context.clips.reduce((sum, c) => sum + (c.result && c.result.deess_declick ? c.result.deess_declick.clicks_repaired : 0), 0);
    return {ran: true, anyEnabled, total, clips: context.clips.length, events: clickPopEvents(context)};
  }
  if (jobResult && jobResult.mode !== 'per_clip') {
    const deess = jobResult.deess_declick;
    const events = deess ? deess.repairs.map(r => ({timeline_seconds: r.start_seconds, clip_name: null, track_index: null})) : [];
    return {ran: true, anyEnabled: Boolean(deess), total: deess ? deess.clicks_repaired : 0, clips: null, events};
  }
  return {ran: false, anyEnabled: false, total: 0, clips: null, events: []};
}

function note(summary) {
  if (!summary.ran || !summary.anyEnabled) return '';
  return ` ${summary.total} click${summary.total === 1 ? '' : 's'}/pop${summary.total === 1 ? '' : 's'} repaired — see Click/pop report.`;
}

function report(summary) {
  if (!summary.ran) return 'No processed batch yet. Run Batch Process Dialogue first.';
  if (!summary.anyEnabled) return 'De-click & de-ess dialogue was off for this batch. No click/pop report available.';
  const header = summary.clips != null
    ? `${summary.total} click${summary.total === 1 ? '' : 's'}/pop${summary.total === 1 ? '' : 's'} repaired across ${summary.clips} clip${summary.clips === 1 ? '' : 's'}.`
    : `${summary.total} click${summary.total === 1 ? '' : 's'}/pop${summary.total === 1 ? '' : 's'} repaired.`;
  const lines = summary.events.map(e => `${formatTimestamp(e.timeline_seconds)}${e.track_index != null ? ` — Track A${e.track_index + 1}` : ''}${e.clip_name ? ` — ${e.clip_name}` : ''}`);
  return [header, ...lines].join('\n');
}

module.exports = {formatTimestamp, summarize, note, report};
