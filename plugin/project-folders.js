// Remembers the export folder chosen for each Premiere project (2026-10-05).
// Pure bookkeeping only: main.js supplies the UXP persistent token (what lets
// the panel reopen a user-chosen folder after a restart) and the project path.
// Stored in localStorage as {projects: {<project key>: {token, at}}}; keeps the
// 40 most recently used so the list cannot grow without bound.
const STORAGE_KEY = 'wtv-project-folders-v1';
const MAX_PROJECTS = 40;

// Same project file -> same key, regardless of slash direction or case
// (Windows paths are case-insensitive; treating macOS the same only risks two
// same-named-but-differently-cased projects sharing a folder choice).
function projectKey(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function parse(raw) {
  try {
    const data = JSON.parse(raw);
    const projects = {};
    if (data && typeof data.projects === 'object' && data.projects) {
      for (const [key, value] of Object.entries(data.projects)) {
        if (value && typeof value.token === 'string' && value.token) projects[key] = {token: value.token, at: Number(value.at) || 0};
      }
    }
    return {projects};
  } catch (_) { return {projects: {}}; }
}

function tokenFor(raw, key) {
  if (!key) return null;
  return parse(raw).projects[key]?.token || null;
}

function remember(raw, key, token, now = Date.now()) {
  const data = parse(raw);
  if (!key || typeof token !== 'string' || !token) return JSON.stringify(data);
  data.projects[key] = {token, at: now};
  const keep = Object.entries(data.projects).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PROJECTS);
  return JSON.stringify({projects: Object.fromEntries(keep)});
}

function forget(raw, key) {
  const data = parse(raw);
  if (key) delete data.projects[key];
  return JSON.stringify(data);
}

module.exports = {STORAGE_KEY, MAX_PROJECTS, projectKey, parse, tokenFor, remember, forget};
