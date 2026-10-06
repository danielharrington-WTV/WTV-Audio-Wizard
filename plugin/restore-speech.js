// Rebuild Speech (button renamed from Restore Speech 2026-10-01; code names keep "restore"): Sidon speech restoration (sarulab-speech/sidon-v0.1, MIT)
// on every selected clip, on the connected service's GPU. Sidon regenerates
// the voice without room sound, echo, noise or band-limiting -- chosen over
// Resemble Enhance and GAP-URGENet after the 2026-09-29 Derev-Test listening
// test. It re-synthesizes speech rather than filtering it, so it is its own
// button rather than a Batch Process Dialogue model.
//
// Pipeline: exactly Extract ambience's per-clip render -> upload -> job ->
// place (extract-ambience.js, run with RESTORE_KIND), asking the service for
// its dialogue stem with enhancer 'sidon' and no level/de-ess finishing, so
// the result is Sidon's output as-is (only the mixer's shared -1.2 dBFS peak
// safety applies). Results go on a new "Restored speech" track; overlapping
// selections use extra lanes. Each original whose restored clip was placed
// is then muted the same way Batch Process Dialogue mutes raw clips (-96 dB Amplify
// + " · WTV muted"), so Unmute and Select muted work on it and the two are
// never heard doubled.
const extract = require('./extract-ambience.js');
const perClip = require('./per-clip.js');
const muteTools = require('./mute-tools.js');
const ppro = require('premierepro');

const RESTORE_KIND = {
  action: 'Rebuild Speech', gerund: 'rebuilding speech', process: 'speech rebuild', Process: 'Speech rebuild',
  noun: 'rebuilt speech', result: 'rebuilt speech', resultClip: 'rebuilt speech', title: 'Rebuild', uploadFor: 'speech rebuild',
  track: 'Rebuilt speech', clipSuffix: ' · Rebuilt', renderName: 'WTV_RESTORE_RENDER', filePrefix: 'restored', stem: 'dialogue',
  // A clip Batch Process Dialogue already silenced would render as silence.
  preflight: async entry => {
    if (await muteTools.isMuted(entry)) throw new Error('Clip is muted by WTVAudioWizard; Unmute it first or select the audible clip.');
  },
};

// Job settings from the service defaults: Sidon only, nothing else.
function restoreSettings(factory) {
  if (!factory) throw new Error('Connect to the service first');
  const result = JSON.parse(JSON.stringify(factory));
  Object.assign(result, {
    enhancer: 'sidon', enhancer_wet: 1, separator: 'bandit_v2', ambience_only: false,
    separate_ambience: false, separate_music: false, dialogue_postprocess: false, deess_declick: false,
  });
  if ('level_dialogue' in result) result.level_dialogue = false;
  if ('deess' in result) result.deess = false;
  return result;
}

// Service readiness from /v1/health's model list.
function sidonProblem(models) {
  const sidon = (models || []).find(m => m && m.id === 'sidon');
  if (!sidon) return 'Restart the updated service, then Connect again, to use Rebuild Speech.';
  if (!sidon.available) return 'Sidon is not installed on the service machine. Run setup-sidon.bat there (needs an NVIDIA GPU), restart the service, then Connect again.';
  return null;
}

async function muteOriginals(placed, say) {
  const project = await ppro.Project.getActiveProject();
  const sequence = project && await project.getActiveSequence();
  if (!sequence) throw new Error('Sequence is no longer active.');
  const clips = placed.map(r => ({...r.source}));
  await perClip.silenceRawClips(project, {sequenceId: sequence.guid.toString(), inPlace: true}, clips, {say});
  return clips.length;
}

async function run(hooks) {
  let result, fatal = null;
  try {
    result = await extract.run({...hooks, kind: RESTORE_KIND});
  } catch (error) {
    if (!Array.isArray(error.results)) throw error;
    fatal = error;
    result = {results: error.results};
  }
  const placed = result.results.filter(r => !r.error && r.source);
  let muted = 0, muteError = null;
  // Main tab's "Auto mute" (2026-10-01): off leaves the originals audible.
  const autoMute = hooks.autoMute !== false;
  if (placed.length && autoMute) {
    try { muted = await muteOriginals(placed, hooks.say || (() => {})); }
    catch (error) { muteError = error.message; }
  }
  if (fatal) {
    if (muted) fatal.message += ` The ${muted} original clip(s) rebuilt before the stop were muted.`;
    else if (muteError) fatal.message += ` Could not mute the originals rebuilt before the stop (${muteError}); mute them before playback.`;
    throw fatal;
  }
  return {...result, muted, muteError, autoMute};
}

module.exports = {run, restoreSettings, sidonProblem, RESTORE_KIND};
