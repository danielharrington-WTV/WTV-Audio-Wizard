// Select music (2026-10-13): which timeline clips count as music for the
// small arrow button beside Level & duck music. Pure helpers, no DOM or UXP.
//
// The filter is a comma-separated list of words, set in Options > Ducking and
// remembered per panel (not per preset). A clip matches when its clip name or
// its audio track's name contains any of the words, ignoring case. Default
// "ANW": the office music library's file names carry that prefix.
const MUSIC_FILTER_KEY = 'wtv-music-select-filter-v1';
const DEFAULT_MUSIC_FILTER = 'ANW';
const MAX_FILTER_LENGTH = 200;

function parseFilter(text) {
  const seen = new Set();
  const terms = [];
  for (const raw of String(text ?? '').slice(0, MAX_FILTER_LENGTH).split(',')) {
    const term = raw.trim().replace(/\s+/g, ' ');
    if (term && !seen.has(term.toLowerCase())) { seen.add(term.toLowerCase()); terms.push(term); }
  }
  return terms;
}

function matchesMusic(entry, terms) {
  const haystacks = [entry?.name, entry?.trackName].filter(v => typeof v === 'string' && v).map(v => v.toLowerCase());
  return terms.some(term => haystacks.some(h => h.includes(term.toLowerCase())));
}

// Saved text, or the default when nothing (or nothing usable) is saved.
function loadFilter(storage) {
  let saved = null;
  try { saved = storage.getItem(MUSIC_FILTER_KEY); } catch (_) { /* Use the default. */ }
  return saved != null && parseFilter(saved).length ? saved : DEFAULT_MUSIC_FILTER;
}

function describeFilter(terms) {
  return terms.map(t => `"${t}"`).join(' or ');
}

module.exports = {MUSIC_FILTER_KEY, DEFAULT_MUSIC_FILTER, MAX_FILTER_LENGTH, parseFilter, matchesMusic, loadFilter, describeFilter};
