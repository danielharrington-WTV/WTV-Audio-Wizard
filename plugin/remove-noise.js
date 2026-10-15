// Remove noise (2026-10-15): turns the project's learned noise print (Learn
// noise, learn-noise.js) down on every selected clip, on the connected
// service (spectral gating, service/denoise.py; CPU DSP, no model needed).
//
// Pipeline: exactly Extract ambience's per-clip render -> upload -> job ->
// place (extract-ambience.js, run with NOISE_KIND), asking the service for its
// dialogue stem with no neural cleanup and no level/de-ess finishing, so the
// result is the clip with the noise turned down and nothing else changed (only
// the mixer's shared -1.2 dBFS peak safety applies). Results go on a new
// "Noise removed" track; the originals are muted like Rebuild Speech's when
// "Mute raw when done" is on (Unmute reverts).
const extract = require('./extract-ambience.js');
const restore = require('./restore-speech.js');
const muteTools = require('./mute-tools.js');

const NOISE_KIND = {
  action: 'Remove noise', gerund: 'removing noise', process: 'noise removal', Process: 'Noise removal',
  noun: 'denoised audio', result: 'denoised audio', resultClip: 'denoised clip', title: 'Remove noise', uploadFor: 'noise removal',
  track: 'Noise removed', clipSuffix: ' · Denoised', renderName: 'WTV_DENOISE_RENDER', filePrefix: 'denoised', stem: 'dialogue',
  preflight: async entry => {
    if (await muteTools.isMuted(entry)) throw new Error('Clip is muted by WTVAudioWizard; Unmute it first or select the audible clip.');
  },
};

const DEFAULTS = {reduction: 12, threshold: 6};
const LIMITS = {reduction: [0, 40], threshold: [-6, 24]};

function checked(value, [low, high], label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < low || n > high) throw new Error(`${label} must be ${low} to ${high} dB.`);
  return n;
}

// Job settings from the service defaults: the noise print only, nothing else.
function noiseSettings(factory, profileId, {reduction = DEFAULTS.reduction, threshold = DEFAULTS.threshold} = {}) {
  if (!factory) throw new Error('Connect to the service first');
  if (!('denoise_profile_id' in factory)) throw new Error('This service has no Remove noise. Update it (git pull) and restart it, then Connect again.');
  if (!/^[0-9a-f]{32}$/.test(String(profileId))) throw new Error('No noise print for this project. Mark In/Out around noise only, then click Learn noise.');
  const result = JSON.parse(JSON.stringify(factory));
  Object.assign(result, {
    enhancer: 'none', enhancer_wet: 1, separator: 'bandit_v2', ambience_only: false,
    separate_ambience: false, separate_music: false, dialogue_postprocess: false, deess_declick: false,
    denoise_profile_id: profileId,
    denoise_reduction_db: checked(reduction, LIMITS.reduction, 'Noise reduction'),
    denoise_threshold_db: checked(threshold, LIMITS.threshold, 'Noise threshold'),
  });
  if ('level_dialogue' in result) result.level_dialogue = false;
  if ('deess' in result) result.deess = false;
  return result;
}

async function run(hooks) {
  let result, fatal = null;
  try {
    result = await extract.run({...hooks, kind: NOISE_KIND});
  } catch (error) {
    if (!Array.isArray(error.results)) throw error;
    fatal = error;
    result = {results: error.results};
  }
  const placed = result.results.filter(r => !r.error && r.source);
  let muted = 0, muteError = null;
  const autoMute = hooks.autoMute !== false;
  if (placed.length && autoMute) {
    try { muted = await restore.muteOriginals(placed, hooks.say || (() => {})); }
    catch (error) { muteError = error.message; }
  }
  if (fatal) {
    if (muted) fatal.message += ` The ${muted} original clip(s) denoised before the stop were muted.`;
    else if (muteError) fatal.message += ` Could not mute the originals denoised before the stop (${muteError}); mute them before playback.`;
    throw fatal;
  }
  return {...result, muted, muteError, autoMute};
}

module.exports = {run, noiseSettings, NOISE_KIND, DEFAULTS, LIMITS};
