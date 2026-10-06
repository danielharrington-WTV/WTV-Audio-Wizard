// Persist dialogue 20 ms summaries so reruns skip the analysis export.

const CACHE_VERSION = 4;

const INDEX_KEY = 'wtv-music-analysis-cache-index-v1';

const MAX_ENTRIES = 12;



function hashString(text) {

  let h = 5381;

  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);

  return (h >>> 0).toString(16);

}



function analysisSettingsForCache(settings) {

  return Object.fromEntries(Object.entries(settings).filter(([key, value]) => key !== 'strip_clip_volume' && value !== undefined));

}



function buildFingerprint({ passSignature, stripClipVolume, analysisSettings, dialogueReference, rate, channels, duration, presetPath }) {

  const ref = dialogueReference?.trackIds

    ? { mode: dialogueReference.mode, trackIds: [...dialogueReference.trackIds].sort() }

    : dialogueReference?.choice

      ? { mode: dialogueReference.choice.mode, trackIds: [...(dialogueReference.choice.trackIds || [])].sort() }

      : dialogueReference;

  return JSON.stringify({

    v: CACHE_VERSION,

    passSignature,

    stripClipVolume: stripClipVolume === true,

    analysisSettings,

    reference: ref,

    rate,

    channels,

    duration,

    presetPath: presetPath || '',

  });

}



function packFloat64Array(arr) {

  if (!(arr instanceof Float64Array)) arr = Float64Array.from(arr || []); // plain arrays (fixtures, older summaries) pack the same way

  const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

  if (typeof Buffer !== 'undefined') return Buffer.from(view).toString('base64');

  let binary = '';

  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);

  return btoa(binary);

}



function unpackFloat64Array(encoded, count) {

  const byteLength = count * 8;

  if (typeof Buffer !== 'undefined') {

    const bytes = Buffer.from(encoded, 'base64');

    if (bytes.length !== byteLength) throw new Error('Cached analysis summary has invalid length');

    return new Float64Array(bytes.buffer, bytes.byteOffset, count);

  }

  const binary = atob(encoded);

  const buffer = new ArrayBuffer(byteLength);

  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < byteLength; i++) bytes[i] = binary.charCodeAt(i);

  return new Float64Array(buffer, 0, count);

}



function packSummary(summary) {

  return {

    rate: summary.rate,

    channels: summary.channels,

    samples: summary.samples,

    peak: summary.peak,

    levelCount: summary.levels.length,

    levelsB64: packFloat64Array(summary.levels),

    peaksB64: packFloat64Array(summary.peaks),

  };

}



function unpackSummary(packed) {

  return {

    rate: packed.rate,

    channels: packed.channels,

    samples: packed.samples,

    peak: packed.peak,

    levels: unpackFloat64Array(packed.levelsB64, packed.levelCount),

    peaks: unpackFloat64Array(packed.peaksB64, packed.levelCount),

  };

}



function validateSummary(summary, expected) {

  if (!summary || summary.rate !== expected.rate || summary.channels !== expected.channels) return false;

  return Math.abs(summary.samples / summary.rate - expected.duration) <= 1 / expected.rate;

}



let cachedRoot;



async function cacheFolder(fs) {

  if (cachedRoot) return cachedRoot;

  const data = await fs.getDataFolder();

  try {

    cachedRoot = await data.getEntry('music-analysis-cache');

  } catch (_) {

    cachedRoot = await data.createFolder('music-analysis-cache');

  }

  return cachedRoot;

}



function readIndex(storage) {

  if (!storage) return {};

  try { return JSON.parse(storage.getItem(INDEX_KEY)) || {}; } catch (_) { return {}; }

}



function writeIndex(storage, index) {

  if (!storage) return;

  storage.setItem(INDEX_KEY, JSON.stringify(index));

}



function touchIndex(storage, hash, fingerprint) {

  const index = readIndex(storage);

  index[hash] = { fingerprint, usedAt: Date.now() };

  const keys = Object.keys(index);

  if (keys.length > MAX_ENTRIES) {

    keys.sort((a, b) => (index[a].usedAt || 0) - (index[b].usedAt || 0));

    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete index[keys[i]];

  }

  writeIndex(storage, index);

}



async function load(fs, storage, fingerprint, expected) {

  const hash = hashString(fingerprint);

  const folder = await cacheFolder(fs);

  let file;

  try { file = await folder.getEntry(`${hash}.json`); } catch (_) { return null; }

  let parsed;

  try {

    const raw = await file.read();

    const text = typeof raw === 'string' ? raw : (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw) ? raw.toString('utf8') : new TextDecoder().decode(raw));

    parsed = JSON.parse(text);

  } catch (_) { return null; }

  if (!parsed || parsed.fingerprint !== fingerprint || parsed.v !== CACHE_VERSION) return null;

  const dialogue = unpackSummary(parsed.dialogue);

  if (!validateSummary(dialogue, expected)) return null;

  touchIndex(storage, hash, fingerprint);

  return { dialogue, hash };

}



async function save(fs, storage, fingerprint, { dialogue }) {

  const hash = hashString(fingerprint);

  const folder = await cacheFolder(fs);

  const payload = {

    v: CACHE_VERSION,

    fingerprint,

    savedAt: Date.now(),

    dialogue: packSummary(dialogue),

  };

  const file = await folder.createFile(`${hash}.json`, { overwrite: true });

  await file.write(JSON.stringify(payload));

  touchIndex(storage, hash, fingerprint);

  return hash;

}



async function pruneIndex(fs, storage) {

  const index = readIndex(storage);

  const folder = await cacheFolder(fs);

  for (const hash of Object.keys(index)) {

    try { await (await folder.getEntry(`${hash}.json`)).delete(); } catch (_) { /* already gone */ }

  }

  writeIndex(storage, {});

}



module.exports = {

  CACHE_VERSION,

  buildFingerprint,

  analysisSettingsForCache,

  packSummary,

  unpackSummary,

  validateSummary,

  hashString,

  load,

  save,

  pruneIndex,

};


