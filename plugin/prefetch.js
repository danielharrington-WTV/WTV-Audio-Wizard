// Interleaved batch (2026-10-07). While Premiere exports the next clip, the
// clips already exported are uploaded and their service jobs started, so the
// GPU works during the export phase instead of after it.
//
// This only starts work early. clip-batch.js still validates every export,
// applies its reuse rules and collects every result, and it picks up what was
// started here (take()). Rules:
// - Nothing here may fail the batch: any problem turns prefetching off and
//   the batch continues the old way (export everything, then process).
// - The service runs one job at a time and refuses more than 8 waiting or
//   running, so at most `maxActive` prefetched jobs are unfinished at once.
// - A stopped batch cancels the jobs it started (abort()).
// Pure: no DOM, no UXP require.

// Same test clip-batch.js uses to choose its two-pass mode.
function isGrouped(settings) {
  return ['gap_urgenet', 'mossformer2'].includes(settings.enhancer) && Boolean(settings.separate_ambience || settings.separate_music);
}
// The job each clip needs first. Mixed batches cache the dialogue stage first;
// everything else submits the final job directly.
function firstJobBody(assetId, settings) {
  const tracks = [{asset_id: assetId, role: 'mixture'}];
  return isGrouped(settings)
    ? {stage_mode: 'dialogue_cache', tracks, settings: {...settings, separate_ambience: false, separate_music: false}}
    : {tracks, settings};
}
// A clip the previous run in this folder already processed with these settings
// is reused from disk by clip-batch.js; uploading it again would be wasted.
function reusedFromFolder(context, clip, settingsKey) {
  const previous = context.reuse && context.reuse.settings === settingsKey && context.reuse.clips && context.reuse.clips[clip.id];
  return Boolean(previous && previous.result && previous.outputs && (!clip.handles || previous.export_identity === clip.exportIdentity));
}

function createPrefetch({settings, request, binary, sleep, isCancelled = () => false, maxActive = 4, pollMs = 500}) {
  const settingsKey = JSON.stringify(settings);
  const kind = isGrouped(settings) ? 'dialogue' : 'final';
  const queue = [], entries = new Map();
  let stopped = false, disabled = null, runner = null, started = 0;

  async function unfinished() {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.finished) continue;
      try {
        const job = await (await request(`/v1/jobs/${entry.jobId}`)).json();
        if (['done', 'failed', 'cancelled'].includes(job.status)) entry.finished = true;
      } catch (_) { entry.finished = true; }  // Unknown now; clip-batch.js will sort it out.
      if (!entry.finished) count++;
    }
    return count;
  }
  async function submit(context, clip) {
    const bytes = await clip.inputFile.read({format: binary});
    const asset = await (await request('/v1/assets', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: bytes})).json();
    const duration = clip.exportDuration ?? clip.duration;
    // A mismatch is reported properly by clip-batch.js; just don't start a job on it.
    if (asset.sample_rate !== context.rate || asset.channels !== context.channels || Math.abs(asset.samples / asset.sample_rate - duration) > 1 / context.rate) return;
    if (stopped || isCancelled()) { entries.set(clip.id, {asset, jobId: null, kind, finished: true}); return; }
    const submitted = await (await request('/v1/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(firstJobBody(asset.asset_id, settings))})).json();
    entries.set(clip.id, {asset, jobId: submitted.job_id, kind, finished: false});
    started++;
  }
  async function run() {
    while (!stopped && !disabled && queue.length) {
      if (isCancelled()) break;
      try {
        if (await unfinished() >= maxActive) { await sleep(pollMs); continue; }
        if (stopped || !queue.length) break;  // stop() may have emptied the queue meanwhile.
        const {context, clip} = queue.shift();
        await submit(context, clip);
      } catch (error) {
        // Includes a full service queue (429). Leave the rest to the normal pass.
        disabled = error && error.message ? error.message : String(error);
      }
    }
    runner = null;
  }

  return {
    kind, settingsKey,
    matches: chosen => JSON.stringify(chosen) === settingsKey,
    // Called by the export loop for each clip whose export is complete on disk.
    exported(context, clip) {
      if (stopped || disabled || entries.has(clip.id) || queue.some(q => q.clip === clip)) return;
      if (!clip.inputFile || reusedFromFolder(context, clip, settingsKey)) return;
      queue.push({context, clip});
      if (!runner) runner = run();
    },
    // No further submissions; waits for the one in flight. Then clip-batch.js takes over.
    async stop() {
      stopped = true; queue.length = 0;
      if (runner) { try { await runner; } catch (_) {} }
      return {started, disabled};
    },
    // The asset and job started for a clip, once. Null when nothing was started.
    take(clipId) {
      const entry = entries.get(clipId);
      if (!entry) return null;
      entries.delete(clipId);
      return entry;
    },
    // The batch stopped: cancel what was started and not yet collected.
    async abort() {
      await this.stop();
      for (const entry of entries.values()) {
        if (!entry.jobId || entry.finished) continue;
        try { await request(`/v1/jobs/${entry.jobId}`, {method: 'DELETE'}); } catch (_) {}
      }
      entries.clear();
    },
  };
}

module.exports = {createPrefetch, isGrouped, firstJobBody, reusedFromFolder};
