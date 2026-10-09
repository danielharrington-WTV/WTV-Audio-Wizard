const uxp = require('uxp');
const host = require('./premiere.js');
const fs = uxp.storage.localFileSystem;
const panelDefaults = require('./defaults.json');
const settingsFile = require('./settings-file.js');
const customPresetStore = require('./custom-presets.js');
const projectFolders = require('./project-folders.js');
const outputFolders = require('./output-folder.js');
const {createBatchProgress} = require('./batch-progress.js');
let settingsLoadedFromFile = false;
// Presets: each keeps its own remembered settings (same schema/keys as
// settingsFile.js) under its own localStorage key, so switching presets
// never loses a preset's own edits. Built-ins start on the factory defaults
// (defaults.json) plus any `defaults` below; user-created presets (Options >
// Save as new preset) are listed after them, see custom-presets.js.
// `defaults` overrides defaults.json for that preset's factory settings
// (what "Reset" restores and what "Changed from defaults" compares against).
// Tuned 2026-10-09 (Dan): the three were identical before. Handles are on for every preset (factory default).
//  Promo/Action: 15% of the raw clip kept under the cleaned voice, hotter dialogue, stronger and faster music ducking.
//  Interview:    fully clean, smoother ducking, lower speech floor so quiet answers still count as speech.
//  Camcorder:    10% raw, De-click, more boost for distant talkers, lowest speech floor.
const PRESETS = [
  {id:'promo',label:'Promo/Action',defaults:{rawBlend:15,dialogue:-10,duck:12,attack:100,release:800}},
  {id:'interview',label:'Interview',defaults:{attack:250,release:1500,speechThreshold:-45}},
  {id:'camcorder',label:'Camcorder',defaults:{rawBlend:10,deessDeclick:true,maxBoost:12,speechThreshold:-48}},
  {id:'natural',label:'Natural (MossFormer)',defaults:{enhancer:'mossformer2'}},
  // Stem separation (2026-10-08): dialogue plus separate music and ambience /
  // sound-effects tracks. Dialogue still comes from neural cleanup of the raw
  // clip; Bandit v2 supplies the music and ambience stems.
  {id:'stems',label:'Stem separation',defaults:{ambienceStem:true,musicStem:true}}];
const DEFAULT_PRESET = 'camcorder';
const ACTIVE_PRESET_KEY = 'wtv-active-preset-v1';
let activePreset = DEFAULT_PRESET;
let customPresets = [];
try { customPresets = customPresetStore.parseCustomPresets(localStorage.getItem(customPresetStore.CUSTOM_PRESETS_KEY)); } catch (_) {}
function saveCustomPresets() { localStorage.setItem(customPresetStore.CUSTOM_PRESETS_KEY, JSON.stringify(customPresets)); }
function allPresets() { return [...PRESETS, ...customPresets]; }
function presetLabel(id) { return (allPresets().find(p => p.id === id) || PRESETS[0]).label; }
function presetOverrides(id) { return (allPresets().find(p => p.id === id) || {}).defaults || {}; }
function presetDefaults() { return {...panelDefaults, ...presetOverrides(activePreset)}; }
function presetSettingsKey(id) { return `wtv-last-settings-v1:${id}`; }
const {normalizeBaseUrl, requestLocal} = require('./local-api.js');
const panelMenu = require('./panel-menu.js');
const {getWavPreset} = require('./export-presets.js');
const musicPass = require('./music-pass.js');
const normalizeMusic = require('./normalize-music.js');
const loudnessPass = require('./loudness-pass.js');
const qualityPass = require('./quality-pass.js');
let lastQualityReport=null;
const {formatPeakPosition}=require('./loudness-meter.js');
let lastLoudnessReport=null;
const {createDialogueSelector} = require('./dialogue-selector.js');
const deplosive = require('./deplosive.js');
// const lowend = require('./lowend.js'); // Enhance low end hidden in v0.8.1
const muteTools = require('./mute-tools.js');
const extractAmbience = require('./extract-ambience.js');
const restoreSpeech = require('./restore-speech.js');
const perClip = require('./per-clip.js');
const {processBatch, saveManifest, validateOutputs} = require('./clip-batch.js');
const {createPrefetch} = require('./prefetch.js');
const {waitForStableWav, waitForStableWavFile, wavSilence} = require('./wav.js');
const {computeButtonState, isResumableBatchContext} = require('./button-state.js');
const $ = id => document.getElementById(id);
// All clickable actions in this panel are `<div role="button">`, not real
// `<button>` elements. A recent UXP/host regression paints native button
// chrome (a grey rounded pill) over custom `background`/`border` CSS on
// real `<button>`/form controls despite `appearance:none !important` --
// see forums.creativeclouddeveloper.com's 2026-08 "DroverUXP" thread and
// developer.adobe.com/premiere-pro/uxp/uxp-api/known-issues's long-standing
// "certain style properties... cannot be changed on button elements" note.
// Adobe's own forum participants recommend plain styleable elements (div/
// span with role="button") specifically to escape this, at the cost of
// reimplementing keyboard activation, focus and `.disabled` ourselves --
// this makeButtonDiv() call (run once per element, below) is that
// reimplementation. It preserves the existing `$(id).disabled = value`
// call sites everywhere else in this file unchanged (`disabled` becomes a
// real accessor property on the element, not a no-op), and guarantees a
// disabled div still visually looks disabled and can't be activated by
// mouse or keyboard, matching native `<button disabled>` behavior.
function makeButtonDiv(el) {
  let disabled = el.getAttribute('aria-disabled') === 'true';
  Object.defineProperty(el, 'disabled', {
    get() { return disabled; },
    set(value) {
      disabled = Boolean(value);
      el.setAttribute('aria-disabled', String(disabled));
      el.classList.toggle('is-disabled', disabled);
      el.tabIndex = disabled ? -1 : 0;
    },
  });
  el.tabIndex = disabled ? -1 : 0;
  el.classList.toggle('is-disabled', disabled);
  // Registered before any other click listener this file adds to the same
  // element (this function runs at module top-level, before any `action()`
  // or direct `addEventListener('click', ...)` call below) -- same-element
  // listeners run in registration order regardless of capture, so this
  // always sees the click first and can stop it going any further.
  el.addEventListener('click', event => { if (disabled) { event.preventDefault(); event.stopImmediatePropagation(); } });
  el.addEventListener('keydown', event => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); el.click(); }
  });
}
for (const id of ['toggleConnection', 'connect', 'runCleanDialogue', 'musicPass', 'fixPop',
  'checkQuality', 'toggleQuality', 'verifyLoudness', 'saveSettings', 'loadSettings', 'refreshDialogueTracks', 'tabMainBtn', 'tabOptionsBtn', 'reset', 'resetAllOptions', 'copyReport', 'cancel',
  'createPreset', 'deletePreset',
  'extractAmbience', 'restoreSpeech', 'unmuteClips', 'selectMuted',
  'toggleProcessing', 'toggleCleanDialogue', 'toggleLevelsStems', 'toggleDucking', 'toggleLoudness', 'toggleChangedSettings', 'togglePresets', 'openDestinationFolder', 'changeFolder']) makeButtonDiv($(id));
let musicContextRevision=0;
let context, musicContext, activeAction, jobId, jobResult, busy = false, factory, availableModels = [];
let clientBase, clientToken;
let cancelled = false;
let lastError = null;
let lastMusicReport = null;
let lastMusicTiming = null;
let lastExportWaitTally = {events: 0, poll: 0};
function noteExportWait(signal) {
  if (!signal) return;
  if (signal.mode === 'events') lastExportWaitTally.events++;
  else lastExportWaitTally.poll++;
}
function resetExportWaitTally() {
  lastExportWaitTally = {events: 0, poll: 0};
}
let lastPopFixReport = null;
let lastLowEndReport = null;
let lastAmbienceReport = null;
let lastRestoreReport = null;
let lastUnmuteReport = null;
let lastSelectMutedReport = null;
let lastCleanDialogueTiming = null;
// Project export folder, resolved once per panel session and shared by
// Prepare exports, Fix a pop, and Enhance low end.
let workFolder = null;
// Export folder memory (2026-10-05). workFolder belongs to one project
// (workFolderKey; null = unsaved project, undefined = not looked up yet).
// A folder the user chose (workFolderChosen) is remembered per project with a
// UXP persistent token; the automatic project folder is not stored.
let workFolderKey;
let workFolderChosen = false;
let folderChangedSinceContext = false;
let folderSync = Promise.resolve();
function storedFolders() { try { return localStorage.getItem(projectFolders.STORAGE_KEY); } catch (_) { return null; } }
function storeFolders(raw) { try { localStorage.setItem(projectFolders.STORAGE_KEY, raw); } catch (_) { /* Remembering is optional. */ } }
async function rememberFolder(entry) {
  if (!workFolderKey) return false;
  try {
    const token = await fs.createPersistentToken(entry);
    if (!token) return false;
    storeFolders(projectFolders.remember(storedFolders(), workFolderKey, token));
    return true;
  } catch (_) { return false; }
}
async function syncWorkFolderNow() {
  let key = null;
  try { key = projectFolders.projectKey(await host.getProjectPath()); } catch (_) { key = null; }
  if (key === workFolderKey) return;
  // An unsaved project that has just been saved keeps the folder chosen for it.
  const carry = workFolderKey === null && workFolderChosen && workFolder && key;
  workFolderKey = key;
  if (carry) { await rememberFolder(workFolder); return; }
  // A different project: drop the previous project's folder and load this one's.
  workFolder = null; workFolderChosen = false;
  const token = projectFolders.tokenFor(storedFolders(), key);
  if (!token) return;
  try {
    const entry = await fs.getEntryForPersistentToken(token);
    if (entry && entry.isFolder) { workFolder = entry; workFolderChosen = true; return; }
  } catch (_) { /* Folder moved, deleted or drive missing. */ }
  storeFolders(projectFolders.forget(storedFolders(), key));
}
// Serialized: updateActions() calls this often and overlapping lookups must not interleave.
function syncWorkFolder() { folderSync = folderSync.then(syncWorkFolderNow, syncWorkFolderNow); return folderSync; }
async function setChosenFolder(entry) {
  await syncWorkFolder();
  workFolder = entry; workFolderChosen = true; folderChangedSinceContext = true;
  return rememberFolder(entry);
}
const recentStatus = [];
const dialogueSelector = createDialogueSelector({document, musicPass, storage:localStorage, getContext:()=>musicContext || context,
  onError:error=>reportError(error,'dialogue reference')});
function checkCancelled() { if (cancelled) throw new Error('Batch stopped. The original sequence is intact. Click Batch Process Dialogue to continue; completed exports are reused.'); }
const say = message => {
  $('status').textContent = message;
  recentStatus.push(`${new Date().toISOString()} ${message}`);
  if (recentStatus.length > 20) recentStatus.shift();
  $('copyFeedback').textContent = '';
};
function setCleanProgress(visible, percent = 0) {
  const wrap = $('progressWrap');
  if (!wrap) return;
  wrap.hidden = !visible;
  if (!visible) return;
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  $('progressBar').style.width = `${value}%`;
  $('progressBar').setAttribute('aria-valuenow', String(value));
}
let batchTicker = null;
function beginBatchProgress(label, clips, completed = []) {
  if (batchTicker !== null) clearInterval(batchTicker);
  const tracker = createBatchProgress(clips, {completed});
  const draw = () => {
    const p = tracker.snapshot();
    setCleanProgress(true, p.percent);
    $('batchEstimate').hidden = false;
    $('batchEstimate').textContent = `${label}: ${p.completed}/${p.total} clips done | ${Math.floor(p.percent)}% | ${formatDuration(p.elapsed)} elapsed | ${p.remaining === null ? 'Estimating time remaining...' : '~' + formatDuration(p.remaining) + ' remaining'}`;
  };
  draw(); batchTicker = setInterval(draw, 1000);
  return {event(e) {
    if (e.done) tracker.complete(e.clipIndex, e.reused);
    else {tracker.start(e.clipIndex); if(e.jobProgress !== undefined) tracker.progress(e.jobProgress);}
    draw();
  }, stop() {
    if (batchTicker !== null) clearInterval(batchTicker);
    batchTicker = null;
    $('batchEstimate').hidden = true;
    setCleanProgress(false);
  }};
}
function setMusicProgress(visible, stage, percent) {
  setCleanProgress(visible, percent);
  if (visible && stage) $('status').textContent = `${stage} \u00b7 ${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '\u2014';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}
function summarizeServiceTimings(context) {
  if (!context || context.mode !== 'per_clip' || !context.clips?.length) return null;
  const totals = {};
  let clipCount = 0;
  for (const clip of context.clips) {
    const timings = clip.result?.timings;
    if (!timings) continue;
    clipCount++;
    for (const [key, value] of Object.entries(timings)) {
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
    }
  }
  return clipCount ? {clipCount, totals} : null;
}
function formatMusicPassTimingReport(timing) {
  return musicPass.formatMusicPassTimingReport(timing);
}
function formatCleanDialogueTimingReport(timing) {
  if (!timing) return '';
  const parts = [`wall ${formatDuration(timing.wall_seconds)}`];
  for (const name of ['prepare', 'process', 'apply']) {
    if (Number.isFinite(timing.phases?.[name])) parts.push(`${name} ${formatDuration(timing.phases[name])}`);
  }
  const service = timing.service;
  if (service?.totals?.total_seconds) {
    parts.push(`service ${formatDuration(service.totals.total_seconds)} (${service.clipCount} clip${service.clipCount === 1 ? '' : 's'})`);
  }
  return parts.join(' \u00b7 ');
}
function batchProgressPercent(clipIndex, clipCount, jobProgress) {
  const slice = 1 / clipCount;
  const within = Number.isFinite(jobProgress) ? jobProgress / 100 : 0.05;
  return (clipIndex + within) / clipCount * 100;
}
function reportError(error, actionName) {
  lastError = {action: actionName, message: error.message || String(error), stack: error.stack || ''};
  say(lastError.message);
}
function diagnosticReport() {
  const report = ['WTVAudioWizard panel v0.8.2', `Panel menu: ${panelMenuState.installed ? 'installed' : 'not installed (' + panelMenuState.error + ')'} \u00b7 compact ${document.body.classList.contains('compact') ? 'on' : 'off'}`, `Mode: ${$('mode').value}`,
    `Dialogue: ${$('enableEnhancer').checked ? $('enhancer').value : 'raw (no model)'} \u00b7 level ${$('dialoguePostprocess').checked ? 'on' : 'off'} \u00b7 de-ess ${$('deess').checked ? 'on' : 'off'}`,
    `De-click: ${$('deessDeclick').checked}`,
    `Handles: ${$('handlesEnabled').checked ? $('handleSeconds').value + ' s per side (per clip only)' : 'off'}`,
    `Preset: ${presetLabel(activePreset)} \u00b7 Keep raw mix ${$('rawBlend').value}% \u00b7 Max level boost ${$('maxBoost').value} dB \u00b7 Don't use cached files ${noCache ? 'on' : 'off'}`,
    `Handle results: ${JSON.stringify(context?.clips?.filter(c=>c.handles).map(c=>({clip:c.name,...c.handles})) || [])}`,
    `Optional stems: ambience=${$('ambienceStem').checked}, music=${$('musicStem').checked}`,
    `Job: ${jobId || 'none'}`, `Applied: ${Boolean(context && context.applied)}`,
    `Apply failed: ${Boolean(context && context.failedApply)}`,
    `Duck against: ${JSON.stringify(dialogueSelector.current())}`,
    `Status: ${$('status').textContent || ''}`,
    lastLoudnessReport ? `Loudness verification: ${JSON.stringify(lastLoudnessReport)}` : '',
    lastQualityReport ? `Dialogue quality: ${JSON.stringify(lastQualityReport)}` : '',
    lastMusicReport ? `Music analysis: ${JSON.stringify(lastMusicReport)}` : '',
    lastMusicTiming ? `Music timing: ${formatMusicPassTimingReport(lastMusicTiming)}` : '',
    lastMusicTiming?.renders ? `Music render breakdown: ${JSON.stringify(lastMusicTiming.renders)}` : '',
    lastMusicTiming?.exportWait ? `Music export wait: ${JSON.stringify(lastMusicTiming.exportWait)}` : '',
    lastMusicTiming?.analysis_cache ? `Music analysis cache: ${lastMusicTiming.analysis_cache}` : '',
    (lastExportWaitTally.events || lastExportWaitTally.poll) ? `Export wait: ${JSON.stringify(lastExportWaitTally)}` : '',
    lastPopFixReport ? `Pop fix: ${JSON.stringify(lastPopFixReport)}` : '',
    lastLowEndReport ? `Enhance low end: ${JSON.stringify(lastLowEndReport)}` : '',
    lastAmbienceReport ? `Extract ambience: ${JSON.stringify(lastAmbienceReport)}` : '',
    lastRestoreReport ? `Rebuild Speech: ${JSON.stringify(lastRestoreReport)}` : '',
    lastUnmuteReport ? `Unmute: ${JSON.stringify(lastUnmuteReport)}` : '',
    lastSelectMutedReport ? `Select muted: ${JSON.stringify(lastSelectMutedReport)}` : '',
    lastCleanDialogueTiming ? `Clean dialogue timing: ${formatCleanDialogueTimingReport(lastCleanDialogueTiming)}` : '',
    lastCleanDialogueTiming?.service?.totals ? `Clean dialogue service phases: ${JSON.stringify(lastCleanDialogueTiming.service.totals)}` : '',
    lastError ? `Last error (${lastError.action}): ${lastError.message}\n${lastError.stack}` : '',
    'Recent status:', ...recentStatus].filter(Boolean).join('\n');
  let sanitized = report.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  for (const token of [clientToken, $('token').value.trim()]) {
    if (token) sanitized = sanitized.split(token).join('[redacted]');
  }
  return sanitized;
}
$('copyReport').addEventListener('click', async () => {
  const report = diagnosticReport();
  try {
    await navigator.clipboard.writeText(report);
    $('copyFeedback').textContent = 'Report copied.';
    $('reportText').style.display = 'none';
  } catch (_) {
    $('reportText').value = report;
    $('reportText').style.display = 'block';
    $('copyFeedback').textContent = 'Clipboard unavailable. Select the report below and press Ctrl+C.';
  }
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// "Don't use cached files" (panel menu, global, 2026-10-09): every run exports,
// analyses and processes again. Jobs carry fresh:true so the service neither
// reuses an earlier job nor its stage cache (it still stores the new results).
const NO_CACHE_KEY = 'wtv-no-cache-v1';
let noCache = false;
try { noCache = localStorage.getItem(NO_CACHE_KEY) === '1'; } catch (_) {}
function setNoCache(on) {
  noCache = Boolean(on);
  try { localStorage.setItem(NO_CACHE_KEY, noCache ? '1' : '0'); } catch (_) {}
  say(noCache ? "Don't use cached files is on: every run exports and processes again." : "Don't use cached files is off: earlier exports and results are reused when they match.");
}
let serviceCapabilities = [];
function freshJobBody(options) {
  if (!noCache || options.method !== 'POST' || typeof options.body !== 'string') return options;
  if (!serviceCapabilities.includes('fresh_jobs_v1')) throw new Error("Restart the updated service to use Don't use cached files.");
  return {...options, body: JSON.stringify({...JSON.parse(options.body), fresh: true})};
}
async function request(path, options = {}) {
  if (path === '/v1/jobs') options = freshJobBody(options);
  return requestLocal(clientBase, clientToken, path, options);
}
// Batch Process Dialogue's Processing menu (Main tab): the step checkboxes, in the
// order the service runs them. Locked while anything is running.
const PROCESSING_STEP_IDS = ['enableEnhancer', 'dialoguePostprocess', 'deess', 'deessDeclick', 'ambienceStem', 'musicStem'];
function processingStepsSelected() {
  return PROCESSING_STEP_IDS.some(id => $(id).checked);
}
function processingSummaryText() {
  const parts = [];
  if ($('enableEnhancer').checked) parts.push(($('enhancer').value === 'mossformer2' ? 'MossFormer2' : 'GAP-URGENet') + (Number($('rawBlend').value) > 0 ? ` + ${Number($('rawBlend').value)}% raw` : ''));
  if ($('dialoguePostprocess').checked) parts.push('Level');
  if ($('deess').checked) parts.push('De-ess');
  if ($('deessDeclick').checked) parts.push('De-click');
  if ($('ambienceStem').checked) parts.push('Ambience');
  if ($('musicStem').checked) parts.push('Music');
  return parts.length ? parts.join(' \u00b7 ') : 'Nothing selected \u2014 open Batch Process Options and tick a step.';
}
function syncCleanupControls() {
  $('handlesEnabled').disabled = $('mode').value !== 'per_clip';
  $('handleSeconds').disabled = $('mode').value !== 'per_clip' || !$('handlesEnabled').checked;
  for (const id of [...PROCESSING_STEP_IDS, 'autoMute']) $(id).disabled = busy;
  $('enhancer').disabled = busy || !$('enableEnhancer').checked;
  $('rawBlend').disabled = busy || !$('enableEnhancer').checked;
  $('maxBoost').disabled = busy || !$('dialoguePostprocess').checked;
  $('processingSummary').textContent = processingSummaryText();
  $('processingWarning').style.display = processingStepsSelected() ? 'none' : 'block';
  $('repairHelp').style.display = $('deessDeclick').checked ? 'block' : 'none';
}
function settings() {
  if (!factory) throw new Error('Connect to the service first');
  const result = JSON.parse(JSON.stringify(factory));
  result.enhancer = $('enableEnhancer').checked ? $('enhancer').value : 'none';
  if ($('enableEnhancer').checked && !availableModels.some(m => m.id === result.enhancer && m.available)) {
    throw new Error('Selected dialogue model is unavailable. Check its runtime and reconnect.');
  }
  // Keep raw mix: the service blends this share of the raw clip back in before leveling
  // (Settings.enhancer_wet = model share). Only meaningful with a model.
  const rawShare = $('enableEnhancer').checked ? Number($('rawBlend').value) / 100 : 0;
  if (!Number.isFinite(rawShare) || rawShare < 0 || rawShare > 0.5) throw new Error('Keep raw mix must be 0 to 50 %.');
  if ('enhancer_wet' in factory) result.enhancer_wet = Math.round((1 - rawShare) * 1000) / 1000;
  else if (rawShare > 0) throw new Error('Restart the updated service to use Keep raw mix.');
  const boost = Number($('maxBoost').value);
  if (!Number.isFinite(boost) || boost < 0 || boost > 24) throw new Error('Max level boost must be 0 to 24 dB.');
  if ('max_boost_db' in factory) result.max_boost_db = boost;
  result.dialogue_postprocess = $('dialoguePostprocess').checked;
  if ('deess' in factory) result.deess = $('deess').checked;
  else if ($('deess').checked !== result.dialogue_postprocess) throw new Error('Restart the updated service to switch Level and De-ess separately.');
  result.separate_ambience = $('ambienceStem').checked;
  result.separate_music = $('musicStem').checked;
  result.deess_declick = $('deessDeclick').checked;
  result.separator = 'bandit_v2';
  result.stems.forEach(stem => { stem.target = Number($(stem.name).value); stem.duck = stem.name === 'music' || (stem.name === 'effects' && $('duckEffects').checked); });
  result.duck_db = Number($('duck').value);
  result.attack_ms = Number($('attack').value);
  result.release_ms = Number($('release').value);
  result.threshold_dbfs = Number($('speechThreshold').value);
  result.output_rate = context.rate;
  if (result.stems.some(s => !Number.isFinite(s.target))) throw new Error('Enter numeric levels');
  if (!processingStepsSelected()) {
    throw new Error('Tick at least one step in Batch Process Options.');
  }
  return result;
}
// Standalone Extract ambience: same separator/background-level settings as
// the Clean dialogue pipeline's own Ambience stem checkbox, but forced to
// ambience-only -- no neural dialogue model, no dialogue post-process, no
// de-click, no music stem. Doesn't touch context.rate (no big session here);
// extract-ambience.js fills in output_rate itself from the active sequence.
function ambienceSettings() {
  if (!factory) throw new Error('Connect to the service first');
  if(!('ambience_only' in factory))throw Error('Restart the updated service before extracting ambience.');
  const result = JSON.parse(JSON.stringify(factory));
  result.ambience_only = true;
  result.enhancer = 'none';
  result.dialogue_postprocess = false;
  if ('deess' in result) result.deess = false;
  result.deess_declick = false;
  result.separate_ambience = true;
  result.separate_music = false;
  result.separator = 'bandit_v2';
  result.stems.forEach(stem => { stem.target = Number($(stem.name).value); stem.duck = false; });
  result.duck_db = Number($('duck').value);
  result.attack_ms = Number($('attack').value);
  result.release_ms = Number($('release').value);
  result.threshold_dbfs = Number($('speechThreshold').value);
  if (result.stems.some(s => !Number.isFinite(s.target))) throw new Error('Enter numeric levels');
  return result;
}
function showSettings(s) {
  $('enableEnhancer').checked = s.enhancer !== 'none';
  $('dialoguePostprocess').checked = s.dialogue_postprocess !== false;
  // Unset de-ess follows Level, as it did before the two were split.
  $('deess').checked = typeof s.deess === 'boolean' ? s.deess : s.dialogue_postprocess !== false;
  $('deessDeclick').checked = s.deess_declick === true;
  $('repairHelp').style.display = $('deessDeclick').checked ? 'block' : 'none';
  $('ambienceStem').checked = s.separate_ambience === true;
  $('musicStem').checked = s.separate_music === true;
  $('enhancer').value = s.enhancer === 'mossformer2' ? 'mossformer2' : 'gap_urgenet';
  s.stems.forEach(stem => { $(stem.name).value = String(stem.target); });
  $('duck').value = String(s.duck_db); $('attack').value = String(s.attack_ms); $('release').value = String(s.release_ms);
  $('speechThreshold').value = String(s.threshold_dbfs ?? -40);
  $('duckEffects').checked = s.stems.find(s => s.name === 'effects').duck;
  syncCleanupControls();
  updateLevelHelp();
}
// Mirrors what resetActivePresetToDefaults() below (and defaults.json, for
// the core cleanup fields) sets every field to. Keep the two in sync --
// this is only used to compute the "Changed from defaults" diagnostic list,
// so a mismatch here just makes that list wrong, not the actual reset.
const FACTORY_DEFAULT_VALUES = {
  mode:'per_clip', enhancer:'gap_urgenet', handlesEnabled:true, handleSeconds:0.5, rawBlend:0, maxBoost:8, selectedDialogue:true, processInPlace:true,
  enableEnhancer:true, dialoguePostprocess:true, deess:true, autoMute:true, deessDeclick:false, ambienceStem:false, musicStem:false, duckEffects:false,
  stripMusicVolume:true, compressMusicBed:true, dialogue:-12, music:-28, effects:-18, duck:10, speechThreshold:-40,
  attack:200, release:1200, loudnessTarget:-24, loudnessTolerance:1, peakFlag:-6, peakMerge:2, peakMarkers:true, qualityThreshold:1.5,
};
const CHANGED_SETTINGS_LABELS = {
  mode:'Source mode', enhancer:'Dialogue model', handlesEnabled:'Add clip handles', handleSeconds:'Handle length (s)', rawBlend:'Keep raw mix (%)', maxBoost:'Max level boost (dB)',
  selectedDialogue:'Use selected clip only', processInPlace:'Process in place', enableEnhancer:'Neural dialogue cleanup',
  dialoguePostprocess:'Level & compress', deess:'De-ess', autoMute:'Mute raw when done', deessDeclick:'De-click', ambienceStem:'Extract ambience stem',
  musicStem:'Extract music stem', duckEffects:'Also duck ambience', stripMusicVolume:'Remove clip Volume before ducking',
  compressMusicBed:'Compress music bed', dialogue:'Dialogue target (dBFS)', music:'Music target (dBFS)', effects:'Ambience target (dBFS)',
  duck:'Duck amount (dB)', speechThreshold:'Speech floor (dBFS)', attack:'Attack (ms)', release:'Release (ms)',
  loudnessTarget:'Loudness target (LUFS)', loudnessTolerance:'Loudness tolerance (LU)', peakFlag:'Flag peaks over (dBFS)',
  peakMerge:'Merge within (s)', peakMarkers:'Add peak markers', qualityThreshold:'Dialogue quality flag below',
};
function formatChangedSettingsValue(id, value) {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (id === 'mode') return value === 'per_clip' ? 'Per clip' : 'Full sequence';
  if (id === 'enhancer') return value === 'mossformer2' ? 'MossFormer2' : 'GAP URGENet';
  return String(value);
}
// Diffs the live panel against FACTORY_DEFAULT_VALUES and lists what's
// changed on the *current* preset -- purely a read, never writes settings.
function updateChangedSettingsList() {
  const el = $('changedSettingsList');
  if (!el) return;
  let current;
  try { current = settingsFile.capture($).values; }
  catch (_) { el.textContent = 'Fix the invalid field above to see what changed.'; return; }
  const factoryDefaults = {...FACTORY_DEFAULT_VALUES, ...presetOverrides(activePreset)};
  const changed = settingsFile.fieldIds.filter(id => id in factoryDefaults && current[id] !== factoryDefaults[id]);
  el.textContent = changed.length
    ? changed.map(id => `${CHANGED_SETTINGS_LABELS[id] || id}: ${formatChangedSettingsValue(id, current[id])} (default ${formatChangedSettingsValue(id, factoryDefaults[id])})`).join('; ') + '.'
    : 'No changes from factory defaults.';
}
function resetActivePresetToDefaults() {
  settingsLoadedFromFile = false;
  showSettings(presetDefaults());
  localStorage.removeItem('wtv-settings-v1');
  settingsFile.apply($, {...FACTORY_DEFAULT_VALUES, ...presetOverrides(activePreset)});
  localStorage.removeItem('wtv-quality-threshold'); // Retired global preference; now part of each preset.
  updateWorkflow(); syncCleanupControls();
  $('settingsSource').textContent = `${presetLabel(activePreset)} \u00b7 Factory defaults`;
  const activeTab = $('tabOptions').hidden ? 'main' : 'options';
  localStorage.setItem(OPTIONS_UI_KEY, JSON.stringify({
    activeTab,
    mainScrollTop: 0,
    optionsScrollTop: 0,
    cleanDialogue: false,
    levelsStems: false,
    ducking: false,
    // Presets area and Main's Processing menu aren't preset settings: keep their state.
    presets: $('togglePresets').getAttribute('aria-expanded') === 'true',
    processing: $('toggleProcessing').getAttribute('aria-expanded') === 'true',
    stripMusicVolume: true,
    compressMusicBed: true,
  }));
  setCleanDialogueOpen(false);
  setLevelsStemsOpen(false);
  setDuckingOpen(false);
  setLoudnessOpen(false);
  setQualityOpen(false);
  mainScrollTop = 0;
  optionsScrollTop = 0;
  updateChangedSettingsList();
  $('panelScroll').scrollTop = 0;
  updateScrollIndicators();
}
function updateLevelHelp() {
  for (const [name, label] of [['dialogue', 'Dialogue'], ['music', 'Music baseline'], ['effects', 'Ambience']]) {
    $(`${name}Label`).textContent = `${label} \u00b7 dBFS`;
  }
  $('levelHelp').textContent = 'Absolute RMS targets over active audio. Music target is before ducking.';
  const baseline = Number($('duck').value);
  $('duckHelp').textContent = $('duck').value.trim() && Number.isFinite(baseline)
    ? `Pulls music down by ${baseline} dB while dialogue is above Speech floor (relative to current level).`
    : 'Ducking reduces music while dialogue is present; music level is unchanged between lines.';
}
// Declared before section()/popover toggles so their initial set() calls can
// safely refresh scroll cues. Gradient overlays sit above the scroll pane
// with pointer-events:none so they show cutoff without blocking clicks.
function updateScrollIndicators() {
  const el = $('panelScroll');
  if (!el) return;
  const atTop = el.scrollTop <= 1;
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
  $('scrollArea').classList.toggle('more-above', !atTop);
  $('scrollArea').classList.toggle('more-below', !atBottom);
}
function section(name, title, expanded, onSet) {
  const button = $(`toggle${name}`);
  const content = $(`${name.charAt(0).toLowerCase()}${name.slice(1)}Section`);
  function set(open) {
    button.setAttribute('aria-expanded', String(open));
    button.textContent = `${open ? '\u2212' : '+'} ${title}`;
    content.style.display = open ? 'block' : 'none';
    updateScrollIndicators();
    if (onSet) onSet(open);
  }
  set(expanded);
  button.addEventListener('click', () => set(button.getAttribute('aria-expanded') !== 'true'));
  return set;
}
const OPTIONS_UI_KEY = 'wtv-options-ui-v1';
function loadOptionsUi() {
  try { return JSON.parse(localStorage.getItem(OPTIONS_UI_KEY)) || {}; }
  catch (_) { return {}; }
}
function saveOptionsUi(patch) {
  localStorage.setItem(OPTIONS_UI_KEY, JSON.stringify({...loadOptionsUi(), ...patch}));
}
const optionsUi = loadOptionsUi();
const setConnectionOpen = section('Connection', 'Connection', true);
// Compact layout (2026-10-06), switched only from the panel menu: hides Copy
// report, Change, an idle Cancel, and the Connection row while connected.
// Each hidden control stays reachable from the menu (see panel-menu.js).
function setCompact(on) {
  document.body.classList.toggle('compact', Boolean(on));
  saveOptionsUi({compact: Boolean(on)});
  updateScrollIndicators();
}
document.body.classList.toggle('compact', optionsUi.compact === true);
const panelMenuState = panelMenu.createMenu({
  entrypoints: uxp.entrypoints, panelId: 'wtvAudioWizard', version: '0.8.2',
  hooks: {
    click: id => $(id).click(),
    getCompact: () => document.body.classList.contains('compact'),
    setCompact,
    getNoCache: () => noCache,
    setNoCache,
    // Shows the Connection block (hidden in compact layout while connected) and
    // opens it; choosing it again puts it away.
    toggleConnection: () => {
      const show = !document.body.classList.contains('show-connection');
      document.body.classList.toggle('show-connection', show);
      if (show) { $('tabMainBtn').click(); setConnectionOpen(true); }
      updateScrollIndicators();
    },
  },
});
// Batch Process Dialogue's Processing menu on Main: collapsed by default, remembered.
// The one-line summary shows only while it is collapsed.
const setProcessingOpen = section('Processing', 'Batch Process Options', optionsUi.processing === true,
  open => { saveOptionsUi({processing: open}); $('processingSummary').style.display = open ? 'none' : 'block'; });
const setCleanDialogueOpen = section('CleanDialogue', 'Clean dialogue', optionsUi.cleanDialogue === true,
  open => saveOptionsUi({cleanDialogue: open}));
const setLevelsStemsOpen = section('LevelsStems', 'Levels & stems', optionsUi.levelsStems === true,
  open => saveOptionsUi({levelsStems: open}));
const setDuckingOpen = section('Ducking', 'Ducking', optionsUi.ducking === true,
  open => saveOptionsUi({ducking: open}));
const setLoudnessOpen = section('Loudness', 'Loudness verification', false);
const setQualityOpen = section('Quality', 'Dialogue quality', false);
const setChangedSettingsOpen = section('ChangedSettings', 'Changed from defaults', optionsUi.changedSettings === true,
  open => saveOptionsUi({changedSettings: open}));
// Create/delete custom presets: collapsed by default, remembered like the others.
const setPresetsOpen = section('Presets', 'Presets', optionsUi.presets === true,
  open => saveOptionsUi({presets: open}));
let mainScrollTop = Number(optionsUi.mainScrollTop ?? optionsUi.workflowScrollTop) || 0;
let optionsScrollTop = Number(optionsUi.optionsScrollTop) || 0;
function setActiveTab(name) {
  const onOptions = !$('tabOptions').hidden;
  if (onOptions) optionsScrollTop = $('panelScroll').scrollTop;
  else mainScrollTop = $('panelScroll').scrollTop;
  const main = name === 'main';
  $('tabMainBtn').classList.toggle('active', main);
  $('tabOptionsBtn').classList.toggle('active', !main);
  $('tabMainBtn').setAttribute('aria-selected', String(main));
  $('tabOptionsBtn').setAttribute('aria-selected', String(!main));
  $('tabMain').hidden = !main;
  $('tabOptions').hidden = main;
  $('panelScroll').scrollTop = main ? mainScrollTop : optionsScrollTop;
  saveOptionsUi({activeTab: name, mainScrollTop, optionsScrollTop});
  updateScrollIndicators();
}
$('tabMainBtn').addEventListener('click', () => setActiveTab('main'));
$('tabOptionsBtn').addEventListener('click', () => setActiveTab('options'));
setActiveTab(optionsUi.activeTab === 'options' ? 'options' : 'main');
// Explicit DOM assignment also initializes native UXP number fields on first load.
showSettings(panelDefaults);
$('loudnessTarget').value='-24'; $('loudnessTolerance').value='1';
$('peakFlag').value='-6'; $('peakMerge').value='2'; $('peakMarkers').checked=true;
$('handleSeconds').value='0.5';
$('stripMusicVolume').checked = optionsUi.stripMusicVolume !== false;
$('compressMusicBed').checked = optionsUi.compressMusicBed !== false;
$('mode').value = 'per_clip';
function updateWorkflow() {
  const clips = $('mode').value === 'per_clip';
  const inPlace = $('processInPlace').checked;
  $('selectionRow').style.display = clips ? 'block' : 'none';
  $('modeHelp').textContent = clips
    ? ''
    : 'Use dialogue-only input. Adds continuous clean tracks.';
}
updateWorkflow();
function rememberSettings() {
  try { localStorage.setItem(presetSettingsKey(activePreset),JSON.stringify(settingsFile.capture($))); settingsLoadedFromFile=true; }
  catch (_) { /* Keep the last valid settings while a field is being edited. */ }
  updateChangedSettingsList();
}
// Switches the active preset (or loads the initial one at startup): applies
// that preset's own last-used settings if it has any, otherwise factory
// defaults. Never touches another preset's saved settings.
// Rebuilds the preset dropdown: built-ins (from index.html's markup order)
// followed by the user's own presets.
function renderPresetOptions() {
  const select = $('presetSelect');
  while (select.firstChild) select.removeChild(select.firstChild);
  for (const preset of allPresets()) {
    const option = document.createElement('option');
    option.value = preset.id; option.textContent = preset.label;
    select.appendChild(option);
  }
  select.value = activePreset;
}
let deletePresetArmed = null;
function updatePresetButtons() {
  const custom = customPresetStore.isCustomPresetId(activePreset);
  if (deletePresetArmed && deletePresetArmed !== activePreset) deletePresetArmed = null;
  $('deletePreset').disabled = busy || !custom;
  $('deletePreset').textContent = deletePresetArmed ? 'Click again to delete' : 'Delete this preset';
  $('deletePreset').title = custom ? `Delete the "${presetLabel(activePreset)}" preset and its saved settings. Click twice to confirm.` : 'Only presets you created can be deleted.';
  $('createPreset').disabled = busy;
}
function loadPreset(id) {
  activePreset = allPresets().some(p => p.id === id) ? id : DEFAULT_PRESET;
  deletePresetArmed = null;
  if (typeof updatePresetButtons === 'function' && $('deletePreset')) updatePresetButtons();
  try { localStorage.setItem(ACTIVE_PRESET_KEY, activePreset); } catch (_) {}
  $('presetSelect').value = activePreset;
  let saved = null;
  try { saved = localStorage.getItem(presetSettingsKey(activePreset)); } catch (_) { $('settingsSource').textContent = 'Saved settings unavailable; using defaults'; }
  if (saved) {
    try {
      settingsFile.apply($, settingsFile.validate(JSON.parse(saved)));
      settingsLoadedFromFile = true;
      updateWorkflow(); syncCleanupControls(); updateLevelHelp();
      $('repairHelp').style.display = $('deessDeclick').checked ? 'block' : 'none';
      $('settingsSource').textContent = `${presetLabel(activePreset)} \u00b7 Last-used settings`;
      updateChangedSettingsList();
      return;
    } catch (_) { /* Corrupt saved data for this preset; fall through to factory defaults. */ }
  }
  resetActivePresetToDefaults();
}
// Preset defaults revision 2 (2026-10-09): Promo/Action, Interview and Camcorder
// were retuned and clip handles turned on for every preset. Once per panel: the
// three retuned presets drop their last-used settings so they start from the new
// defaults; every other saved preset keeps its settings but gets handles on at 0.5 s.
const PRESET_DEFAULTS_REVISION_KEY = 'wtv-preset-defaults-revision';
const RETUNED_PRESETS = ['promo', 'interview', 'camcorder'];
function migratePresetDefaults(store = localStorage) {
  let revision = 0;
  try { revision = Number(store.getItem(PRESET_DEFAULTS_REVISION_KEY)) || 0; } catch (_) { return; }
  if (revision >= 2) return;
  for (const preset of allPresets()) {
    const key = presetSettingsKey(preset.id);
    try {
      if (RETUNED_PRESETS.includes(preset.id)) { store.removeItem(key); continue; }
      const data = JSON.parse(store.getItem(key) || 'null');
      if (data && data.values) { data.values.handlesEnabled = true; data.values.handleSeconds = 0.5; store.setItem(key, JSON.stringify(data)); }
    } catch (_) { /* Leave unreadable saved settings to loadPreset's fallback. */ }
  }
  try { store.setItem(PRESET_DEFAULTS_REVISION_KEY, '2'); } catch (_) {}
}
migratePresetDefaults();
renderPresetOptions();
try { loadPreset(localStorage.getItem(ACTIVE_PRESET_KEY) || DEFAULT_PRESET); }
catch (_) { loadPreset(DEFAULT_PRESET); }
$('presetSelect').addEventListener('change', () => loadPreset($('presetSelect').value));
for(const id of settingsFile.fieldIds) $(id).addEventListener('change',rememberSettings);
$('mode').addEventListener('change', () => { context = null; jobId = null; jobResult = null; $('musicPass').disabled = true; updateWorkflow(); updateActions(); });
$('processInPlace').addEventListener('change', updateWorkflow);
$('handlesEnabled').addEventListener('change', syncCleanupControls);
for (const name of ['dialogue', 'music', 'effects', 'duck', 'attack', 'release', 'speechThreshold', 'duckEffects', 'enhancer', 'enableEnhancer', 'dialoguePostprocess', 'deess', 'ambienceStem', 'musicStem', 'deessDeclick', 'rawBlend', 'maxBoost']) {
  $(name).addEventListener('change', () => {
    syncCleanupControls();
    $('settingsSource').textContent = 'Custom settings';
    $('repairHelp').style.display = $('deessDeclick').checked ? 'block' : 'none';
    updateLevelHelp();
    if (!busy && PROCESSING_STEP_IDS.includes(name)) updateActions();
  });
  if (name !== 'duckEffects') $(name).addEventListener('input', updateLevelHelp);
}
// Panel-only preference (not part of the job Settings schema, so it is
// persisted separately and survives independently of "Reset defaults").
$('stripMusicVolume').addEventListener('change', () => { saveOptionsUi({stripMusicVolume: $('stripMusicVolume').checked}); });
$('compressMusicBed').addEventListener('change', () => { saveOptionsUi({compressMusicBed: $('compressMusicBed').checked}); });
function action(id, fn) {
  $(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true; cancelled = false; activeAction=id;
    dialogueSelector.setBusy(true);
    $('mode').disabled = true; $('cancel').disabled = false;
    for (const id of [...PROCESSING_STEP_IDS, 'enhancer', 'autoMute']) $(id).disabled = true;
    for (const name of ['changeFolder', 'connect', 'runCleanDialogue', 'musicPass', 'fixPop', 'reset', 'extractAmbience', 'restoreSpeech', 'unmuteClips', 'selectMuted', 'saveSettings', 'loadSettings', 'verifyLoudness', 'checkQuality', 'createPreset', 'deletePreset']) $(name).disabled = true;
    try { await fn(); } catch (error) { reportError(error, id); }
    finally {
      if (id === 'process' || id === 'musicPass' || id === 'runCleanDialogue' || id === 'verifyLoudness' || id === 'checkQuality') {
        setCleanProgress(false);
      }
      if (id === 'process' || id === 'runCleanDialogue') {
        try { await request('/v1/workers/release', {method: 'POST'}); } catch (_) {}
      }
      busy = false; activeAction=null; updateActions();
    }
  });
}
function updateConnectionStatus(state) {
  // `factory` (populated only by a successful connect, reset to null at the
  // start of every attempt -- see action('connect')) is the only signal we
  // have of connection state; there's no live heartbeat, so this reflects
  // "last connect attempt succeeded", not a continuously-verified socket.
  const connected = state === 'connecting' ? false : Boolean(factory);
  $('connectionStatus').classList.toggle('connected', connected);
  $('connectionStatus').classList.toggle('connecting', state === 'connecting');
  $('connectionStatusText').textContent = state === 'connecting' ? 'Connecting\u2026' : connected ? 'Connected' : 'Not connected';
  document.body.classList.toggle('is-connected', connected);
}
function destinationFolderEntry() {
  // A folder changed after the last batch started shows the new choice, not that batch's clips folder.
  return (folderChangedSinceContext ? null : context?.folder) || workFolder || null;
}
function updateDestinationFolder() {
  renderDestinationFolder();
  void syncWorkFolder().then(renderDestinationFolder);
}
function renderDestinationFolder() {
  $('changeFolder').disabled = busy;
  const btn = $('openDestinationFolder');
  // Text goes in the name span so the folder icon beside it survives.
  const label = $('destinationFolderName');
  const folder = destinationFolderEntry();
  if (folder) {
    label.textContent = folder.name;
    btn.disabled = busy;
    btn.title = `Open export folder in File Explorer\n${folder.nativePath}${folder === workFolder && workFolderChosen ? (workFolderKey ? '\nChosen for this project' : '\nChosen for this session; save the project to have it remembered') : ''}`;
    return;
  }
  // No folder yet: the button is a chooser (2026-10-05). Clicking it opens the
  // folder picker; the choice is remembered for this project.
  label.textContent = 'No folder';
  btn.disabled = busy;
  btn.title = 'Click to choose an export folder. A saved project\u2019s own folder is used automatically.';
  void host.getProjectFolder(fs).then(projectFolder => {
    if (destinationFolderEntry()) return;
    if (!projectFolder) return;
    label.textContent = projectFolder.name;
    btn.disabled = busy;
    btn.title = `${projectFolder.nativePath}\nProject folder \u00b7 opens after Batch Process Dialogue runs`;
  });
}
function updateActions() {
  syncCleanupControls();
  dialogueSelector.setBusy(busy);
  void dialogueSelector.refresh();
  updateConnectionStatus();
  updateDestinationFolder();
  $('connect').disabled = busy;
  $('reset').disabled = busy;
  $('resetAllOptions').disabled = busy;
  $('mode').disabled = busy;
  updatePresetButtons();
  const state = computeButtonState({context, busy, factory, jobResult, mode: $('mode').value, stepsSelected: processingStepsSelected()});
  $('runCleanDialogue').disabled = state.runCleanDialogue;
  $('runCleanDialogue').textContent = state.runLabel;
  $('musicPass').disabled = state.musicPass;
  $('verifyLoudness').disabled = busy;
  $('checkQuality').disabled = busy || !factory;
  $('saveSettings').disabled = busy;
  $('loadSettings').disabled = busy;
  $('fixPop').disabled = state.fixPop;
  $('extractAmbience').disabled = state.extractAmbience;
  $('restoreSpeech').disabled = state.restoreSpeech;
  $('unmuteClips').disabled = state.unmuteClips;
  $('selectMuted').disabled = state.selectMuted;
  $('cancel').disabled = state.cancel;
  $('mainHint').textContent = state.hint;
  updateScrollIndicators();
}
updateActions();

action('openDestinationFolder', async () => { await openDestinationFolder(); });
action('changeFolder', async () => { await chooseExportFolder(); });
action('connect', async () => {
  factory = null;
  updateConnectionStatus('connecting');
  clientBase = normalizeBaseUrl($('baseUrl').value); clientToken = $('token').value.trim();
  const health = await (await request('/v1/health')).json();
  if (health.service_version !== '0.7.1') throw new Error('Restart the updated v0.7.1 local service.');
  availableModels = health.models;
  serviceCapabilities = Array.isArray(health.capabilities) ? health.capabilities : [];
  factory = await (await request('/v1/defaults')).json();
  await uxp.storage.secureStorage.setItem('wtv-token', clientToken);
  setConnectionOpen(false);
  document.body.classList.remove('show-connection');
  // `context` is in-memory only and does not survive a panel reload/Premiere
  // restart. If the active sequence is already one of this plugin's own
  // finished clones (steps 1-3 already completed, possibly in an earlier
  // session), resume it so music ducking / fix-a-pop / enhance-low-end don't
  // require redoing steps 1-3 onto a brand new clone just to unlock them
  // again. Never overwrites an existing in-session context.
  let resumed = null;
  if (!context) { try { resumed = await host.resumeAppliedClone(); } catch (_) { /* Best-effort; fall through to normal message. */ } }
  if (resumed) {
    context = resumed;
    say(resumed.dialoguePaths.length
      ? 'Connected \u00b7 Resumed the active WTV clone \u2014 ready to duck music or fix a pop.'
      : 'Connected \u00b7 Resumed the active WTV clone \u2014 ready to duck music (use "Choose tracks" under Duck against) or fix a pop.');
  } else {
    say('Connected \u00b7 Ready for dialogue.');
  }
});
action('reset', async () => {
  settingsLoadedFromFile = false;
  showSettings(presetDefaults());
  $('settingsSource').textContent = `${presetLabel(activePreset)} \u00b7 Factory defaults`;
  rememberSettings();
  say('Targets restored: dialogue \u221212, music \u221228, effects / ambience \u221218 dBFS.');
});
action('checkQuality', async () => {
  if(!factory)throw Error('Connect to the service before checking dialogue quality.');
  lastQualityReport=null;
  $('qualityResult').style.display='';  // Hidden until the first quality check.
  $('qualityResult').textContent='Quality scan running; previous reading cleared.';
  setCleanProgress(true,0);
  try {
    const result=await qualityPass.run({fs,request,binary:uxp.storage.formats.binary,sleep,say,
      threshold:Number($('qualityThreshold').value),onProgress:p=>setCleanProgress(true,p),
      check:()=>{if(cancelled)throw Error('Quality scan cancelled; an active export may still finish.');}});
    lastQualityReport=result;
    const text=`DNSMOS: ${result.markers.added} red review region(s) across ${result.clips} selected clip(s); ${result.windows} windows assessed.${result.truncated?' Marker limit reached.':''}${!result.windows?' No audio above the silence floor was assessed. Check the selected clips and mixer solos.':' Listen to flagged sections before editing.'}`;
    $('qualityResult').textContent=text;say(text);
  } catch(error) { $('qualityResult').textContent='Quality scan did not complete. See status for details.';throw error; }
});
action('verifyLoudness', async () => {
  const target=Number($('loudnessTarget').value.trim() || NaN),tolerance=Number($('loudnessTolerance').value.trim() || NaN);
  if(!Number.isFinite(target)||target < -70 || target>0 || !Number.isFinite(tolerance)||tolerance<0||tolerance>10)throw Error('Enter a valid LUFS target and tolerance in Options.');
  const peakFlagDbfs=Number($('peakFlag').value.trim() || NaN),mergeSeconds=Number($('peakMerge').value.trim() || NaN);
  if(!Number.isFinite(peakFlagDbfs)||peakFlagDbfs<-40||peakFlagDbfs>0||!Number.isFinite(mergeSeconds)||mergeSeconds<0||mergeSeconds>30)throw Error('Enter a valid peak flag level (-40..0 dBFS) and merge window (0..30 s) in Options.');
  lastLoudnessReport=null;
  $('loudnessResult').style.display='';  // Hidden until the first Verify loudness run.
  $('loudnessResult').textContent='Verification running; previous reading cleared.';
  setCleanProgress(true,0);
  const result=await loudnessPass.run({fs,sleep,say,peakFlagDbfs,mergeSeconds,addMarkers:$('peakMarkers').checked,formatPosition:formatPeakPosition,onProgress:p=>setCleanProgress(true,p),
    check:()=>{if(cancelled)throw Error('Loudness check cancelled; any export already started may still finish.');}});
  const delta=result.integrated_lufs===null?null:result.integrated_lufs-target;
  lastLoudnessReport={...result,target_lufs:target,tolerance_lu:tolerance,delta_lu:delta,within_loudness_target:delta===null?null:Math.abs(delta)<=tolerance};
  const number=value=>value===null?'not measurable':value.toFixed(1);
  const peakLocation=result.sample_peak_position_seconds===null?'':` First peak at ${formatPeakPosition(result.sample_peak_position_seconds)} from sequence start, channel ${result.sample_peak_channel}.`;
  const events=result.over_threshold_events||[];
  const list=events.slice(0,5).map(e=>`${formatPeakPosition(e.position_seconds)} (${e.peak_dbfs.toFixed(1)} dBFS)`).join(', ');
  const flagged=events.length
    ? ` ${events.length}${result.over_threshold_truncated?'+':''} peak event${events.length===1?'':'s'} over ${peakFlagDbfs} dBFS: ${list}${events.length>5?', …':''}.`
    : ` No peaks over ${peakFlagDbfs} dBFS.`;
  const markerNote=!result.markers?'':result.markers.error?` Markers not added: ${result.markers.error}.`:result.markers.added?` ${result.markers.added} marker${result.markers.added===1?'':'s'} added${result.markers.removed?` (${result.markers.removed} old replaced)`:''}.`:'';
  const renderNote='';
  const summary=`Loudness: ${number(result.integrated_lufs)} LUFS; sample peak ${result.sample_peak_dbfs===null?'not measurable':result.sample_peak_dbfs.toFixed(3)} dBFS.${peakLocation}${flagged}${markerNote} ${delta===null?'No gated audio to compare.':`${Math.abs(delta)<=tolerance?'Within':'Outside'} ${target} LUFS +/- ${tolerance} LU target.`} Full audible sequence; true peak not measured.${renderNote}`;
  $('loudnessResult').textContent=summary;
  say(summary);
});
action('saveSettings', async () => {
  const data=settingsFile.capture($);
  const file=await fs.getFileForSaving('WTVAudioWizard-settings.json',{types:['json']});
  if(!file) return;
  await file.write(JSON.stringify(data,null,2));
  say('Settings saved.');
});
action('loadSettings', async () => {
  const file=await fs.getFileForOpening({types:['json'],allowMultiple:false});
  if(!file) return;
  const text=await file.read();
  if(text.length>100000) throw Error('Settings file is too large.');
  const values=settingsFile.validate(JSON.parse(text));
  if(context && values.mode!==$('mode').value) throw Error('Finish the current workflow before loading settings with a different source mode.');
  settingsFile.apply($,values);
  settingsLoadedFromFile=true;
  saveOptionsUi({stripMusicVolume:values.stripMusicVolume,compressMusicBed:values.compressMusicBed});
  syncCleanupControls();updateWorkflow();updateLevelHelp();
  $('repairHelp').style.display=values.deessDeclick?'block':'none';
  rememberSettings();
  $('settingsSource').textContent='Loaded settings';
  say('Settings loaded. Ready to use.');
});
// Save as new preset: copies the CURRENT settings into a new, user-named
// preset and switches to it. Its Reset target inherits the source preset's
// `defaults` (e.g. MossFormer2 when made from Natural).
action('createPreset', async () => {
  const name = customPresetStore.validateNewName($('newPresetName').value, allPresets().map(p => p.label));
  let snapshot;
  try { snapshot = settingsFile.capture($); }
  catch (_) { throw new Error('Fix the invalid setting first; a new preset copies the current settings.'); }
  const preset = {id: customPresetStore.makePresetId(), label: name, defaults: {...presetOverrides(activePreset)}};
  customPresets = [...customPresets, preset];
  saveCustomPresets();
  localStorage.setItem(presetSettingsKey(preset.id), JSON.stringify(snapshot));
  renderPresetOptions();
  loadPreset(preset.id);
  $('newPresetName').value = '';
  say(`Created preset "${name}" from the current settings. It's selected now; edits are remembered on it.`);
});
// Custom presets only. No confirm() in UXP, so the first click arms the
// button ("Click again to delete") for 4 s and the second click deletes.
action('deletePreset', async () => {
  const preset = customPresets.find(p => p.id === activePreset);
  if (!preset) throw new Error('Only presets you created can be deleted.');
  if (deletePresetArmed !== preset.id) {
    deletePresetArmed = preset.id;
    setTimeout(() => { if (deletePresetArmed === preset.id) { deletePresetArmed = null; updatePresetButtons(); } }, 4000);
    say(`Click the button again within 4 seconds to delete "${preset.label}".`);
    return;
  }
  deletePresetArmed = null;
  customPresets = customPresets.filter(p => p.id !== preset.id);
  saveCustomPresets();
  try { localStorage.removeItem(presetSettingsKey(preset.id)); } catch (_) {}
  renderPresetOptions();
  loadPreset(DEFAULT_PRESET);
  say(`Deleted preset "${preset.label}". Switched to ${presetLabel(DEFAULT_PRESET)}.`);
});
action('resetAllOptions', async () => {
  resetActivePresetToDefaults();
  rememberSettings();
  say(`All ${presetLabel(activePreset)} preset settings restored to factory defaults. Other presets are unaffected.`);
});
// The picker opens in `initial` when given, otherwise in the folder the project is saved in.
async function pickFolder(initial = null) {
  const initialLocation = initial || await host.getProjectFolder(fs);
  return initialLocation ? fs.getFolder({initialLocation}) : fs.getFolder();
}
async function openDestinationFolder() {
  await syncWorkFolder();
  const folder = destinationFolderEntry() || await host.getProjectFolder(fs);
  if (!folder) { await chooseExportFolder(); return; }  // "No folder": choose one instead of failing.
  const result = await uxp.shell.openPath(folder.nativePath, 'Open the WTV export folder in Finder or File Explorer.');
  if (result) throw new Error(result);
}
// Folder picker for the export folder. Starts in the folder already chosen for
// this project, or the project's own folder when none has been chosen yet.
async function chooseExportFolder() {
  await syncWorkFolder();
  const chosen = await pickFolder(workFolderChosen ? workFolder : null);
  if (!chosen) { say('Export folder unchanged.'); return null; }
  const remembered = await setChosenFolder(chosen);
  say(`Export folder set \u00b7 ${chosen.nativePath}${remembered ? ' \u00b7 remembered for this project' : workFolderKey ? '' : ' \u00b7 save the project to have it remembered'}`);
  return chosen;
}
async function resolveWorkFolder(context) {
  await syncWorkFolder();
  if (workFolder) return workFolder;
  let folder = await host.getProjectFolder(fs);
  if (folder) say(`Using project folder \u00b7 ${folder.nativePath}`);
  else {
    const project = context?.project;
    if (project?.path) say('Could not access project folder \u00b7 choose an export location.');
    else say('Save the project to use its folder automatically, or choose a location.');
    folder = await pickFolder();
  }
  if (folder) workFolder = folder;
  return folder || null;
}
// Everything the plugin keeps goes in a WTVAudioWizard folder inside the
// export folder (output-folder.js), not loose among the project's files.
// Returns {root, output}, or null when no folder is available. If the export
// folder cannot be written to, asks for another one.
async function resolveOutputFolder(context) {
  let root = await resolveWorkFolder(context);
  if (!root) return null;
  try { return {root, output: await outputFolders.outputFolder(root)}; }
  catch (_) {
    say('Could not write to that folder \u00b7 choose an export location.');
    root = await pickFolder();
    if (!root) return null;
    await setChosenFolder(root);
    return {root, output: await outputFolders.outputFolder(root)};
  }
}
// Reuse an existing `<name>-clips` folder instead of failing on it: per-clip
// exports use {overwrite: true} per file anyway, and a leftover folder from an
// interrupted run is not a reason to prompt for a different location.
// Stable per-sequence folder name (no timestamp): the same sequence's clips
// land in the same folder run after run, so exports and processed stems from
// an earlier selection can be reused (see exportPerClipBatch / processBatch).
function clipsFolder(target, context) {
  return outputFolders.clipsFolder(target.output, target.root, context.baseName || context.name);
}
async function createExportTarget(target, context, perClipMode) {
  const make = async t => perClipMode
    ? {folder: await clipsFolder(t, context)}
    : {file: await t.output.createFile(`${context.name}-input.wav`, {overwrite: false})};
  try { return await make(target); }
  catch (_) {
    say('Could not write to that folder \u00b7 choose an export location.');
    const chosen = await pickFolder();
    if (!chosen) return null;
    await setChosenFolder(chosen);
    return make({root: chosen, output: await outputFolders.outputFolder(chosen)});
  }
}
// Exports every clip in context.clips that isn't already verified, so this
// can run either fresh (nothing verified yet) or resume a batch interrupted
// partway through (e.g. by "Export timed out" on a large batch) without
// re-exporting clips that already succeeded. {overwrite: true} because a
// resumed clip's own file may already exist as a partial/failed write from
// the interrupted attempt.
// mm:ss or h:mm:ss timeline position, so when the same source file (e.g.
// "C0036.MP4") appears many times across a batch, status/log lines can tell
// exactly which occurrence is running -- useful for isolating a specific
// stall (e.g. a repeated "Export timed out") to one particular clip instance
// rather than the source file in general.
function formatTimelinePosition(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
function clipLocation(clip) {
  return `A${clip.trackIndex + 1} @ ${formatTimelinePosition(clip.start.seconds)}`;
}
// Interleaved batch (2026-10-07): set by Batch Process Dialogue for the length
// of one run. Each finished export is handed to it so the service starts on
// that clip while Premiere exports the next (see prefetch.js).
let batchPrefetch = null, batchPrefetchWanted = false;
async function exportPerClipBatch(context, preset) {
  // Created here, not earlier: the job settings include the sequence's sample
  // rate, which is only known once this run's context exists.
  if (batchPrefetchWanted && !batchPrefetch) batchPrefetch = newBatchPrefetch();
  const pending = context.clips.filter(c => !c.exportVerified);
  // A resumed batch: clips exported before the interruption can start now.
  for (const clip of context.clips) if (clip.exportVerified) batchPrefetch?.exported(context, clip);
  // Batch-wide efficiency (see per-clip.js exportClip): fingerprint the full
  // sequence at most every 15 s, fingerprint the render once at the end.
  context.lastAssertMs = 0;
  context.deferRenderSignature = true;
  let reusedExports = 0;
  const silentClips = [];
  const progress = beginBatchProgress('Exporting', context.clips, context.clips.map((c,i)=>c.exportVerified ? i : -1).filter(i=>i>=0));
  try {
  for (const clip of pending) {
    checkCancelled();
    const index = context.clips.indexOf(clip);
    progress.event({clipIndex:index});
    // Reuse an existing export from a previous run in this folder when it
    // already validates (same clip id = same source, lane, in/out ticks;
    // same rate/channels/export length). Nothing else about the clip can
    // change without changing that id.
    const previous = context.reuse?.clips?.[clip.id];
    const canReuse = !noCache && (!clip.handles || previous?.export_identity === clip.exportIdentity);
    const expectedLayout = {rate: context.rate, channels: context.channels, duration: clip.exportDuration ?? clip.duration};
    let existing = canReuse && await existingWav(context.folder, `${clip.id}-input.wav`, expectedLayout);
    // A silent leftover (e.g. exported while its track was muted) is never reused.
    if (existing && await silentExport(existing.nativePath, expectedLayout)) {
      say(`Export ${index + 1}/${context.clips.length} \u00b7 ${clip.name} \u00b7 earlier export is silent; exporting again`);
      existing = null;
    }
    if (existing) {
      clip.inputFile = existing; clip.exportVerified = true; reusedExports++;
      batchPrefetch?.exported(context, clip);
      progress.event({clipIndex:index,done:true,reused:true});
      say(`Export ${index + 1}/${context.clips.length} \u00b7 ${clip.name} \u00b7 reused existing file`);
      continue;
    }
    clip.inputFile = await context.folder.createFile(`${clip.id}-input.wav`, {overwrite: true});
    say(`Export ${index + 1}/${context.clips.length} \u00b7 ${clip.name} \u00b7 ${clipLocation(clip)}`);
    try {
      const renderWait = await perClip.exportClip(context, clip, preset.nativePath, clip.inputFile.nativePath,
        {check: checkCancelled, sleep, verifyOutput: async ({check}) => {
          say(`Waiting for export ${index + 1}/${context.clips.length} \u00b7 ${clip.name} \u00b7 ${clipLocation(clip)}`);
          await waitForStableWavFile(clip.inputFile.nativePath,
            {rate: context.rate, channels: context.channels, duration: clip.exportDuration ?? clip.duration},
            {check, sleep, pollIntervalMs: 200});
        }});
      noteExportWait(renderWait);
      // Digital silence: don't keep it and don't send it to the service.
      if (await silentExport(clip.inputFile.nativePath, expectedLayout)) {
        try { await clip.inputFile.delete(); } catch (_) { /* Overwritten on the next export. */ }
        clip.inputFile = null;
        silentClips.push(clip);
        say(`Export ${index + 1}/${context.clips.length} \u00b7 ${clip.name} \u00b7 ${clipLocation(clip)} is silent; not kept and not sent to the service`);
        progress.event({clipIndex:index,done:true});
        continue;
      }
    } catch (err) {
      // Identify exactly which timeline occurrence stalled -- the same
      // source file (e.g. "C0036.MP4") can appear dozens of times in a
      // batch, so the bare filename alone isn't enough to test the right
      // one independently.
      err.message = `${err.message} (clip ${index + 1}/${context.clips.length} \u00b7 ${clip.name} \u00b7 ${clipLocation(clip)})`;
      throw err;
    }
    clip.exportVerified = true;
    // New audio: an earlier processed result for this clip id must not be reused (clip-batch.js).
    clip.freshExport = true;
    batchPrefetch?.exported(context, clip);
    progress.event({clipIndex:index,done:true});
  }
  if (silentClips.length) {
    const names = silentClips.map(c => `${c.name} (${clipLocation(c)})`).join(', ');
    const one = silentClips.length === 1;
    throw new Error(`Silent export${one ? '' : 's'}: ${names}. ${one ? 'It was' : 'They were'} not kept and nothing was sent to the service. `
      + 'Check that the track is not muted, the clip is enabled, its volume is not -\u221e and it has no "WTV muted" Amplify (select it and use Unmute), '
      + 'then click Batch Process Dialogue again. The other exports are kept and reused.');
  }
  } finally {
    progress.stop();
    context.deferRenderSignature = false;
    context.reusedExports = reusedExports;
    try { await perClip.sealRender(context); } catch (_) { /* Clean's assertExportsUnchanged will report an unsealed render. */ }
  }
}
// True only when the WAV is digital silence (wav.js wavSilence). A file the check
// cannot read is treated as sound, so the check never blocks a working batch.
async function silentExport(nativePath, expected) {
  try { return (await wavSilence(nativePath, expected, {check: checkCancelled})).silent; }
  catch (error) { if (cancelled) throw error; return false; }
}
// An existing, complete WAV in the export folder that matches `expected`, or null.
async function existingWav(folder, name, expected) {
  let entry = null;
  try { entry = await folder.getEntry(name); } catch (_) { return null; }
  if (!entry || !entry.isFile || !entry.nativePath) return null;
  const io = require('fs');
  const {header} = require('./music-wav.js');
  let fd;
  try {
    const stat = await io.lstat(entry.nativePath);
    fd = await io.open(entry.nativePath, 'r');
    await header(io, fd, stat.size, expected);
    return entry;
  } catch (_) { return null; }
  finally { if (fd !== undefined) { try { await io.close(fd); } catch (_) {} } }
}
// Previous run's manifest in the export folder, keyed by clip id, so Clean
// audio can reuse processed stems whose settings match.
async function loadPreviousManifest(folder) {
  try {
    const entry = await folder.getEntry('clip-batch.json');
    const data = JSON.parse(await entry.read());
    if (!data || data.mode !== 'per_clip' || !Array.isArray(data.clips)) return null;
    const clips = {};
    for (const c of data.clips) if (c && c.id) clips[c.id] = c;
    return {settings: data.settings ? JSON.stringify(data.settings) : null, clips};
  } catch (_) { return null; }
}
// True if `context` is a per-clip batch that was interrupted mid-export (not
// yet `prepared`, not `applied`/`failedApply`) with at least one clip already
// verified, on a pending clone that's still intact -- i.e. worth resuming
// instead of discarding and re-exporting everything from scratch.
async function resumableBatch() {
  if (!isResumableBatchContext(context)) return false;
  try { await host.assertUnchanged(context); return true; } catch (_) { return false; }
}
async function doPrepare() {
  if (!factory) throw new Error('Connect first');
  resetExportWaitTally();
  const perClipMode = $('mode').value === 'per_clip';
  const inPlace = $('processInPlace').checked;
  if (perClipMode && await resumableBatch()) {
    const done = context.clips.filter(c => c.exportVerified).length;
    const keepMsg = context.inPlace ? 'Keep the sequence unchanged.' : 'Keep the pending clone unchanged.';
    say(`Resuming batch: ${done}/${context.clips.length} clips already exported. ${keepMsg}`);
    const preset = await getWavPreset(fs, context);
    await saveManifest(context, 'exporting');
    await exportPerClipBatch(context, preset);
    checkCancelled();
    context.prepared = true;
    await perClip.releaseRender(context);
    await saveManifest(context, 'exports_requested');
    say(`${context.clips.length} clip export${context.clips.length === 1 ? '' : 's'} ready. ${keepMsg}`);
    return;
  }
  context = null; jobId = null; jobResult = null;
  context = perClipMode
    ? await perClip.prepare($('selectedDialogue').checked, {inPlace, handlesEnabled: $('handlesEnabled').checked, handleSeconds: Number($('handleSeconds').value)})
    : inPlace ? await host.useActive() : await host.cloneActive();
  const exportFolder = await resolveOutputFolder(context);
  if (!exportFolder) return;
  const target = await createExportTarget(exportFolder, context, perClipMode);
  if (!target) return;
  if (perClipMode) {
    context.folder = target.folder;
    folderChangedSinceContext = false;
    for (const clip of context.clips) if (clip.handles) {
      const h = clip.handles;
      say(`${clip.name}: handles ${h.head.toFixed(3)} s before / ${h.tail.toFixed(3)} s after${h.reason ? ' - '+h.reason : ''}.`);
    }
    context.reuse = noCache ? null : await loadPreviousManifest(target.folder);
    if (noCache) say("Don't use cached files is on: exporting and processing every clip again.");
    const preset = await getWavPreset(fs, context);
    await saveManifest(context, 'exporting');
    await exportPerClipBatch(context, preset);
    checkCancelled();
    context.prepared = true;
    await perClip.releaseRender(context);
    await saveManifest(context, 'exports_requested');
    const reused = context.reusedExports ? ` (${context.reusedExports} reused from the folder)` : '';
    say(`${context.clips.length} clip export${context.clips.length === 1 ? '' : 's'} ready${reused}. ${context.inPlace ? 'Keep the sequence unchanged.' : 'Keep the pending clone unchanged.'}`);
    return;
  }
  const preset = await getWavPreset(fs, context);
  context.exportPath = target.file.nativePath;
  say(`Exporting WAV \u00b7 ${context.rate / 1000} kHz \u00b7 ${context.channels === 1 ? 'mono' : 'stereo'}\u2026`);
  const renderWait = await host.exportWav(context, preset.nativePath, target.file.nativePath,
    {check: checkCancelled, sleep, verifyOutput: async ({check}) => {
      say('Waiting for Premiere to finish writing the export WAV\u2026');
      await waitForStableWav(target.file,
        {rate: context.rate, channels: context.channels, duration: context.duration},
        {binary: uxp.storage.formats.binary, check, sleep, pollIntervalMs: 200});
    }});
  noteExportWait(renderWait);
  if (await silentExport(target.file.nativePath, {rate: context.rate, channels: context.channels, duration: context.duration})) {
    try { await target.file.delete(); } catch (_) {}
    throw new Error('The sequence export is silent, so it was not kept. Check for muted tracks, disabled clips or volume at -\u221e, then click Batch Process Dialogue again.');
  }
  say(`Export ready. Choose that WAV when asked. ${context.inPlace ? 'Keep the sequence unchanged.' : 'Keep the clone unchanged.'}`);
}
async function doProcess() {
  if (!context) throw new Error('Run Batch Process Dialogue first');
  await host.assertUnchanged(context);
  for (const name of ['dialogue', 'music', 'effects', 'duck', 'attack', 'release']) if ($(name).value.trim() === '') throw new Error('Enter all target and timing values');
  const chosen = settings();
  context.outputStems = ['dialogue'].concat(chosen.separate_ambience ? ['effects'] : [], chosen.separate_music ? ['music'] : []);
  if (context.mode === 'per_clip') {
    if (!context.prepared) throw new Error('Export preparation was interrupted. Click Batch Process Dialogue to resume exporting the remaining clips.');
    if (context.failedApply) throw new Error(context.inPlace ? 'Inspect the sequence and prepare a new batch after the track insertion failure.' : 'Inspect the pending clone and prepare a new batch after the track insertion failure.');
    await perClip.assertExportsUnchanged(context);
    jobResult = null;
    localStorage.setItem('wtv-settings-v1', JSON.stringify(chosen));
    let progress = beginBatchProgress('Cleaning', context.clips);
    let processingPhase = null;
    // Stop starting jobs early; from here processBatch collects them. If the
    // settings somehow differ from the ones the early jobs used, drop them.
    let prefetch = null;
    if (batchPrefetch) {
      if (batchPrefetch.matches(chosen)) {
        const early = await batchPrefetch.stop();
        prefetch = batchPrefetch;
        context.earlyStarted = early.started;
        if (early.started) say(`${early.started} of ${context.clips.length} clips were sent for processing during export.`);
        // Not an error: the batch continues the old way. Kept for Copy report.
        if (early.disabled) { recentStatus.push(`${new Date().toISOString()} Early processing stopped: ${early.disabled}`); if (recentStatus.length > 20) recentStatus.shift(); }
      } else { await batchPrefetch.abort(); batchPrefetch = null; }
    }
    try {
      setCleanProgress(true, 0);
      await processBatch(context, chosen, {prefetch, request, binary: uxp.storage.formats.binary, check: checkCancelled, onJob: value => { jobId = value; },
        onProgress: e => {
          if(e.phase && e.phase!==processingPhase){progress.stop();processingPhase=e.phase;progress=beginBatchProgress(e.phase==='dialogue'?'1/2 Dialogue cleanup':'2/2 Stems and finishing',context.clips);}
          progress.event(e);
        },
        say, sleep});
      await host.assertUnchanged(context);
      jobResult = {mode: 'per_clip'};
      say(`${context.clips.length} processed clips are ready${context.reusedResults ? ` (${context.reusedResults} reused from the folder)` : ''}. Adding clean tracks next.`);
    } catch (error) { await saveManifest(context, 'interrupted'); throw error; }
    finally { progress.stop(); }
    return;
  }
  const file = await fs.getFileForOpening({types: ['wav']}); if (!file) return;
  if (file.nativePath.replace(/\\/g, '/').toLowerCase() !== context.exportPath.replace(/\\/g, '/').toLowerCase()) throw new Error('Choose the WAV that Batch Process Dialogue just exported.');
  localStorage.setItem('wtv-settings-v1', JSON.stringify(chosen));
  jobResult = null;
  setCleanProgress(true, 0);
  say('Uploading WAV\u2026');
  const data = await file.read({format: uxp.storage.formats.binary});
  if (data.byteLength > 1536 * 1024 * 1024) throw new Error('WAV exceeds 1536 MiB upload limit');
  const asset = await (await request('/v1/assets', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: data})).json();
  if (Math.abs(asset.samples / asset.sample_rate - context.duration) > 1 / asset.sample_rate) throw new Error('WAV duration differs from full sequence duration. Export the entire sequence.');
  if (asset.channels !== context.channels) throw new Error('WAV channel count differs from the sequence');
  if (asset.sample_rate !== context.rate) throw new Error('WAV sample rate differs from the sequence. Run Batch Process Dialogue again.');
  const submitted = await (await request('/v1/jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tracks: [{asset_id: asset.asset_id, role: 'mixture'}], settings: chosen})})).json();
  if (submitted.reused) { try { await request(`/v1/assets/${asset.asset_id}`, {method: 'DELETE'}); } catch (_) {} }
  jobId = submitted.job_id;
  setCleanProgress(true, 0);
  while (true) {
    const job = await (await request(`/v1/jobs/${jobId}`)).json();
    setCleanProgress(true, job.progress ?? 0);
    say(`${job.stage} \u00b7 ${job.progress}%`);
    if (job.status === 'done') { jobResult = job.result; break; }
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error ? job.error.message : 'Job cancelled');
    await sleep(1000);
  }
  say(`Stems are ready. They will be saved in the export folder and added to ${context.inPlace ? 'the sequence' : 'the clone'}.`);
}
async function doApply() {
  if (!jobResult || !context) throw new Error('Run Batch Process Dialogue first');
  await host.assertUnchanged(context);
  if (context.mode === 'per_clip') {
    await validateOutputs(context, uxp.storage.formats.binary, {io: require('fs'), say});
    await saveManifest(context, 'applying');
    context.autoMute = $('autoMute').checked;
    try { await perClip.apply(context, {say}); }
    catch (error) { await saveManifest(context, 'insertion_failed'); throw error; }
    await saveManifest(context, 'applied');
    let crossfadeNote = '';
    const report = context.crossfadeReport;
    if (report?.total) {
      crossfadeNote = ` Crossfades on Clean dialogue: ${report.applied}/${report.total} restored`;
      if (report.skipped) crossfadeNote += ` (${report.skipped} skipped).`;
      else crossfadeNote += '.';
    }
    say(`Done. Clean tracks added; ${context.autoMute ? 'raw lanes muted' : 'raw audio left audible (Mute raw when done is off)'}. Media is in the ${host.IMPORT_BIN_NAME} bin.` + crossfadeNote + (context.defaultTrackNames ? ' Default track names kept.' : ''));
    return;
  }
  if (jobResult.sample_rate !== context.rate || Math.abs(jobResult.samples / context.rate - context.duration) > 1 / context.rate) throw new Error('Result duration/rate mismatch');
  // Full sequence results go to the export folder like everything else; no
  // folder prompt (2026-10-05).
  const resultTarget = await resolveOutputFolder(context); if (!resultTarget) return;
  const folder = resultTarget.output;
  const paths = [];
  for (const stem of context.outputStems) {
    const bytes = await (await request(`/v1/jobs/${jobId}/result/${stem}`)).arrayBuffer();
    const file = await folder.createFile(`${jobId}-${stem}.wav`, {overwrite: false});
    await file.write(bytes, {format: uxp.storage.formats.binary}); paths.push(file.nativePath);
  }
  context.autoMute = $('autoMute').checked;
  await host.applyStems(context, paths, context.outputStems.map(name => ({dialogue:'Clean dialogue',effects:'Ambience',music:'Music'})[name]));
  context.dialoguePaths = [paths[context.outputStems.indexOf('dialogue')]];
  say(`Done. Clean tracks added below ${context.autoMute ? 'muted' : 'audible (Mute raw when done is off)'} raw audio. Media is in the ${host.IMPORT_BIN_NAME} bin.` + (context.defaultTrackNames ? ' Default track names kept.' : ''));
}
function workflowButtonState() {
  return computeButtonState({context, busy: false, factory, jobResult, mode: $('mode').value});
}
// The early-start helper for one per-clip run, or null when it cannot apply
// (full sequence mode, not connected, or settings that doProcess would refuse).
function newBatchPrefetch() {
  if ($('mode').value !== 'per_clip' || !factory || !context) return null;
  for (const name of ['dialogue', 'music', 'effects', 'duck', 'attack', 'release']) if ($(name).value.trim() === '') return null;
  try {
    return createPrefetch({settings: settings(), request, binary: uxp.storage.formats.binary, sleep, isCancelled: () => cancelled});
  } catch (_) { return null; }
}
action('runCleanDialogue', async () => {
  const wallStart = performance.now();
  const phases = {};
  let stepState = workflowButtonState();
  batchPrefetch = null; batchPrefetchWanted = true;
  try {
  if (!stepState.prepare) {
    const t0 = performance.now();
    await doPrepare();
    // Per-clip marks `prepared`; full sequence records `exportPath` instead.
    if (!context?.prepared && !context?.exportPath) return;
    phases.prepare = (performance.now() - t0) / 1000;
  }
  stepState = workflowButtonState();
  if (!stepState.process) {
    const t0 = performance.now();
    await doProcess();
    if (!jobResult) return;
    phases.process = (performance.now() - t0) / 1000;
  }
  } finally {
    batchPrefetchWanted = false;
    // Anything started early and not collected (stopped, failed or cancelled
    // run) is cancelled on the service. After a completed run this is a no-op.
    if (batchPrefetch) { const pending = batchPrefetch; batchPrefetch = null; try { await pending.abort(); } catch (_) {} }
  }
  stepState = workflowButtonState();
  if (!stepState.apply) {
    const t0 = performance.now();
    await doApply();
    if (!context?.applied) return;
    phases.apply = (performance.now() - t0) / 1000;
  }
  lastCleanDialogueTiming = {
    wall_seconds: (performance.now() - wallStart) / 1000,
    phases,
    service: summarizeServiceTimings(context),
    clip_count: context?.clips?.length ?? 0,
    finished_at: new Date().toISOString(),
  };
  const timingLine = formatCleanDialogueTimingReport(lastCleanDialogueTiming);
  say(`${$('status').textContent} Timing: ${timingLine}.`);
  recentStatus.push(`${new Date().toISOString()} Clean dialogue timing: ${timingLine}`);
  if (recentStatus.length > 20) recentStatus.shift();
});
$('cancel').addEventListener('click', async () => {
  if (busy) { cancelled = true; say('Stopping after the current operation. Any Premiere export already started may still finish.'); }
  if (['musicPass','normalizeMusic','saveSettings','loadSettings','verifyLoudness','checkQuality'].includes(activeAction) || !jobId) return;
  try { await request(`/v1/jobs/${jobId}`, {method: 'DELETE'}); say('Cancellation requested\u2026'); } catch (error) { reportError(error, 'cancel'); }
});
action('musicPass', async () => {
  await refreshMusicContext();
  for (const field of ['duck','attack','release','speechThreshold']) if (!$(field).value.trim() || !Number.isFinite(Number($(field).value))) throw Error('Enter numeric ducking settings.');
  const chosen={duck_db:Number($('duck').value),attack_ms:Number($('attack').value),release_ms:Number($('release').value),threshold_dbfs:Number($('speechThreshold').value),strip_clip_volume:$('stripMusicVolume').checked};
  lastMusicReport={settings:chosen,applied:false};
  setMusicProgress(true, 'Music pass starting', 0);
  let lastMusicProgressStage = '';
  try {
  const result = await musicPass.run(musicContext, chosen,
    {fs,binary:uxp.storage.formats.binary,check:()=>{if(cancelled) throw Error('Music ducking cancelled. Any export already started may still finish.');},say,sleep,storage:localStorage,noCache,
    dialogueReference:dialogueSelector.current(),onReference:reference=>{lastMusicReport={...lastMusicReport,reference};},onPlan:plan=>{
      const {points,...analysis}=plan;
      lastMusicReport={...lastMusicReport,settings:chosen,applied:false,analysis,curve_points:points.length};
    },onProgress:({stage, percent}) => {
      setMusicProgress(true, stage, percent);
      if (stage && stage !== lastMusicProgressStage) {
        lastMusicProgressStage = stage;
        say(`${stage} \u00b7 ${Math.round(percent)}%`);
        recentStatus.push(`${new Date().toISOString()} ${stage} \u00b7 ${Math.round(percent)}%`);
        if (recentStatus.length > 20) recentStatus.shift();
      }
    }});
  lastMusicReport={...lastMusicReport,applied:true,clips:result.clips,clips_updated:result.clips_updated,clips_fresh:result.clips_fresh,clips_unchanged:result.clips_unchanged,keyframes:result.keyframes,keyframe_optimization:result.keyframe_optimization,partial_update:result.partial_update,timing:result.timing};
  lastMusicTiming=result.timing || null;
  if (result.timing?.exportWait) {
    lastExportWaitTally.events += result.timing.exportWait.events || 0;
    lastExportWaitTally.poll += result.timing.exportWait.poll || 0;
  }
  const detection=Number.isFinite(result.duck_active_percent) ? ` Ducking active on ${Math.round(result.duck_active_percent)}% of the sequence.` : '';
  const timingLine=lastMusicTiming ? ` ${formatMusicPassTimingReport(lastMusicTiming)}.` : '';
  const duckLine=`Ducked ${result.clips} clips, ${result.keyframes} gain points.${result.partial_update && result.clips_unchanged ? ` ${result.clips_unchanged} other ducked clip(s) left unchanged.` : ''}${result.volume_clips_stripped ? ` Removed clip Volume on ${result.volume_clips_stripped} clip(s).` : ''} Relative duck ${result.duck_db ?? $('duck').value} dB.${detection}${timingLine} ${(result.warnings || []).join(' ')} Native Amplify keyframes are editable in Effect Controls.`;
  // Conform & duck music = ducking, then level normalization on the same
  // selection (v0.8.1: the separate "5. Normalize music levels" button was
  // folded in here). Normalize runs second because it places its compressors
  // before the earliest Amplify and preserves the duck keyframes just written.
  // Ducking is already applied (and Undo-able) if normalizing fails.
  setMusicProgress(true, 'Normalizing music levels', 100);
  say(`${duckLine} Normalizing music levels\u2026`);
  let norm;
  try {
    norm=await normalizeMusic.run({say,check:()=>{
      if(cancelled) throw Error('Music normalization cancelled; ducking and any completed clips remain applied.');
    }});
  } catch(error) {
    lastMusicReport={...lastMusicReport,normalized:false,normalize_error:error.message};
    throw new Error(`Ducking was applied, but normalizing music levels failed: ${error.message}`);
  }
  lastMusicReport={...lastMusicReport,normalized:true,normalized_clips:norm.clips};
  say(`${duckLine} Levels normalized on ${norm.clips} clip(s): Broadcast multiband compressor at -12 dB output gain, then a 3:1 peak-control compressor above -30 dB (limiters bypassed); duck keyframes preserved.`);
  } finally {
    setCleanProgress(false);
  }
});
action('fixPop', async () => {
  const folder = (await resolveOutputFolder(context))?.output;
  if (!folder) return;
  const result = await deplosive.run(context, {fs, binary: uxp.storage.formats.binary, request, check: checkCancelled, say, sleep, outputFolder: folder});
  lastPopFixReport = result;
  say(`Pop fixed at ${result.seed_seconds.toFixed(3)}s: attenuated ${result.start_seconds.toFixed(3)}-${result.end_seconds.toFixed(3)}s (${Math.round(result.duration_seconds * 1000)}ms, up to ${result.max_reduction_db} dB). Audition the result; Undo reverts just this fix. Media updated in the ${host.IMPORT_BIN_NAME} bin.`);
});
// Enhance low end: button removed from the panel for now (v0.8.1). lowend.js
// and its tests are kept; restore the markup, this handler, and the three
// 'enhanceLowEnd' entries above to bring it back.
action('extractAmbience', async () => {
  if (!factory) throw Error('Connect first');
  const chosen = ambienceSettings();
  const folder = (await resolveOutputFolder(context))?.output;
  if (!folder) return;
  const result = await extractAmbience.run({fs, binary: uxp.storage.formats.binary, request, check: checkCancelled, say, sleep, outputFolder: folder, settings: chosen});
  lastAmbienceReport = result;
  const failed = result.results.filter(r => r.error);
  const failureText = failed.length ? ` Failed: ${failed.map(r => `"${r.name}" (${r.error})`).join('; ')}` : '';
  say(`Extracted ambience for ${result.succeeded}/${result.clips} selected clip${result.clips === 1 ? '' : 's'}${result.trackAdded ? ' on a new Ambience track' : ''}. Originals untouched. Media is in the ${host.IMPORT_BIN_NAME} bin.${failureText}`);
});
action('restoreSpeech', async () => {
  if (!factory) throw Error('Connect first');
  const problem = restoreSpeech.sidonProblem(availableModels);
  if (problem) throw Error(problem);
  const chosen = restoreSpeech.restoreSettings(factory);
  const folder = (await resolveOutputFolder(context))?.output;
  if (!folder) return;
  lastRestoreReport = null;
  const check = () => { if (cancelled) throw new Error('Rebuild Speech stopped. Clips already rebuilt stay on the Rebuilt speech track.'); };
  const result = await restoreSpeech.run({autoMute: $('autoMute').checked, fs, binary: uxp.storage.formats.binary, request, check, say, sleep, outputFolder: folder, settings: chosen});
  lastRestoreReport = result;
  const failed = result.results.filter(r => r.error);
  const failureText = failed.length ? ` Failed: ${failed.map(r => `"${r.name}" (${r.error})`).join('; ')}` : '';
  const muteText = result.muteError ? ` Could not mute the originals (${result.muteError}); mute them before playback.`
    : result.muted ? ` ${result.muted} original${result.muted === 1 ? '' : 's'} muted; Unmute reverts.`
    : result.autoMute === false && result.succeeded ? ' Originals left audible (Mute raw when done is off).' : '';
  say(`Rebuilt speech for ${result.succeeded}/${result.clips} selected clip${result.clips === 1 ? '' : 's'}${result.trackAdded ? ' on a new Rebuilt speech track' : ''}.${muteText} Audition before delivery. Media is in the ${host.IMPORT_BIN_NAME} bin.${failureText}`);
});
action('unmuteClips', async () => {
  const result = await muteTools.unmute({say});
  lastUnmuteReport = result;
  say(`Unmuted ${result.clips} clip${result.clips === 1 ? '' : 's'}: ${result.names.join(', ')}. Undo reverts it.`);
});
action('selectMuted', async () => {
  const result = await muteTools.selectMuted({say});
  lastSelectMutedReport = result;
  say(`Selected ${result.clips} muted clip${result.clips === 1 ? '' : 's'} on the timeline.`);
});
function rememberScrollPosition() {
  if (!$('tabOptions').hidden) {
    optionsScrollTop = $('panelScroll').scrollTop;
    saveOptionsUi({optionsScrollTop});
  } else {
    mainScrollTop = $('panelScroll').scrollTop;
    saveOptionsUi({mainScrollTop});
  }
}
$('panelScroll').addEventListener('scroll', () => { updateScrollIndicators(); rememberScrollPosition(); });
window.addEventListener('resize', updateScrollIndicators);
updateScrollIndicators();
uxp.storage.secureStorage.getItem('wtv-token').then(bytes => {
  $('token').value = String.fromCharCode(...new Uint8Array(bytes));
}).catch(() => {});


async function refreshMusicContext() {
  const ticket=++musicContextRevision;
  try {
    const candidate=await musicPass.resolveMusicContext(context || musicContext);
    if(ticket===musicContextRevision) musicContext=candidate;
  } catch(error) {
    if(ticket===musicContextRevision) {
      musicContext=null;
      $('dialogueReferenceSummary').textContent=error.message;
    }
    throw error;
  }
}
function refreshOfflineMusic() {
  if(busy) return;
  void refreshMusicContext().then(()=>{if(!busy) updateActions();}).catch(()=>{});
}
$('toggleDucking').addEventListener('click',refreshOfflineMusic);
$('tabOptionsBtn').addEventListener('click',refreshOfflineMusic);
$('refreshDialogueTracks').addEventListener('click',refreshOfflineMusic);
refreshOfflineMusic();
