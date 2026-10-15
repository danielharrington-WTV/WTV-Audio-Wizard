// Noise prints remembered per Premiere project (2026-10-15). Learn noise
// stores the service's profile id for the project that is open; Remove noise
// uses that project's print. Pure bookkeeping, no DOM or UXP, like
// project-folders.js (same project keys). Stored in localStorage as
// {projects: {<project key>: {profileId, serviceUrl, summary, at}}}; keeps the
// 40 most recently learned. An unsaved project has no key: main.js keeps its
// print in memory until the panel reloads.
const STORAGE_KEY = 'wtv-noise-prints-v1';
const MAX_PROJECTS = 40;
const ID = /^[0-9a-f]{32}$/;

function clean(value) {
  if (!value || typeof value !== 'object' || !ID.test(String(value.profileId))) return null;
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : {};
  return {
    profileId: value.profileId,
    serviceUrl: typeof value.serviceUrl === 'string' ? value.serviceUrl : '',
    summary: {seconds: Number(summary.seconds) || 0, noise_rms_dbfs: typeof summary.noise_rms_dbfs === 'number' && Number.isFinite(summary.noise_rms_dbfs) ? summary.noise_rms_dbfs : null,
      sample_rate: Number(summary.sample_rate) || 0, channels: Number(summary.channels) || 0},
    at: Number(value.at) || 0,
  };
}

function parse(raw) {
  try {
    const data = JSON.parse(raw);
    const projects = {};
    if (data && typeof data.projects === 'object' && data.projects) {
      for (const [key, value] of Object.entries(data.projects)) {
        const entry = clean(value);
        if (entry) projects[key] = entry;
      }
    }
    return {projects};
  } catch (_) { return {projects: {}}; }
}

function printFor(raw, key) {
  if (!key) return null;
  return parse(raw).projects[key] || null;
}

function remember(raw, key, print, now = Date.now()) {
  const data = parse(raw);
  const entry = clean({...print, at: now});
  if (!key || !entry) return JSON.stringify(data);
  data.projects[key] = entry;
  const keep = Object.entries(data.projects).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PROJECTS);
  return JSON.stringify({projects: Object.fromEntries(keep)});
}

function forget(raw, key) {
  const data = parse(raw);
  if (key) delete data.projects[key];
  return JSON.stringify(data);
}

// One line for the panel: "Noise print: 2.0 s, -52 dBFS, learned 15 Oct 14:02".
function describe(print, formatDate = at => new Date(at).toLocaleString()) {
  if (!print) return 'No noise print for this project. Mark In/Out around noise only, then click Learn noise.';
  const level = print.summary.noise_rms_dbfs === null ? '' : `, ${Math.round(print.summary.noise_rms_dbfs)} dBFS`;
  return `Noise print: ${print.summary.seconds.toFixed(1)} s${level}, learned ${formatDate(print.at)}.`;
}

module.exports = {STORAGE_KEY, MAX_PROJECTS, parse, printFor, remember, forget, describe};
