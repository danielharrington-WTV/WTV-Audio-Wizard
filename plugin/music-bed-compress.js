// Per 20 ms block peak compression for cresty library music beds. Gain reductions
// are merged into the Amplify duck envelope (no separate Premiere effect).
const db = (x) => 20 * Math.log10(Math.max(x, 1e-15));

/**
 * @param {Float64Array} peaks block peaks (linear)
 * @param {number} targetDbfs music baseline target (same units as analyze)
 * @param {{ ratio?: number, kneeOffsetDb?: number, maxReductionDb?: number, smoothRadius?: number }} opts
 * @returns {Float64Array} comp_db[i] <= 0
 */
function bedCompressionDb(peaks, targetDbfs, opts = {}) {
  const ratio = opts.ratio ?? 3;
  const kneeOffsetDb = opts.kneeOffsetDb ?? 10;
  const maxReductionDb = opts.maxReductionDb ?? 12;
  const smoothRadius = opts.smoothRadius ?? 2;
  const knee = targetDbfs - kneeOffsetDb;
  const raw = new Float64Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const pDb = db(peaks[i]);
    if (pDb <= knee) {
      raw[i] = 0;
      continue;
    }
    const over = pDb - knee;
    raw[i] = -Math.min(maxReductionDb, over * (1 - 1 / ratio));
  }
  if (smoothRadius <= 0 || peaks.length < 3) return raw;
  const out = new Float64Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - smoothRadius); j <= Math.min(peaks.length - 1, i + smoothRadius); j++) {
      sum += raw[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

function effectivePeakAfterComp(peaks, compDb) {
  let max = 0;
  for (let i = 0; i < peaks.length; i++) {
    max = Math.max(max, peaks[i] * 10 ** (compDb[i] / 20));
  }
  return max;
}

function effectiveActiveRms(levels, compDb) {
  let active = 0;
  let sum = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] <= 10 ** (-70 / 20)) continue;
    active++;
    const v = levels[i] * 10 ** (compDb[i] / 20);
    sum += v * v;
  }
  return active ? Math.sqrt(sum / active) : 0;
}

function maxLinear(peaks) {
  let max = 0;
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
  return max;
}

function summarizeBedCompression(peaks, levels, compDb) {
  const rawPeak = peaks.length ? maxLinear(peaks) : 0;
  const effPeak = effectivePeakAfterComp(peaks, compDb);
  let active = 0;
  let sum = 0;
  for (const v of levels) {
    if (v > 10 ** (-70 / 20)) {
      active++;
      sum += v * v;
    }
  }
  const rawRms = active ? Math.sqrt(sum / active) : rawPeak;
  const effRms = effectiveActiveRms(levels, compDb);
  let compSum = 0;
  let compN = 0;
  for (const c of compDb) {
    if (c < -0.05) {
      compSum += c;
      compN++;
    }
  }
  return {
    crest_db_before: db(rawPeak) - db(rawRms),
    crest_db_after: db(effPeak) - db(effRms),
    blocks_compressed: compN,
    mean_compression_db: compN ? compSum / compN : 0,
  };
}

function compEnvelopeCorners(compDb, duration, opts = {}) {
  const blockSec = opts.blockSec ?? 0.02;
  const quantDb = opts.quantDb ?? 0.25;
  const maxCorners = opts.maxCorners ?? 1200;
  if (!compDb.length) return [[0, 0], [duration, 0]];
  const q = (v) => Math.round(v / quantDb) * quantDb;
  const points = [[0, q(compDb[0])]];
  let last = points[0][1];
  for (let i = 1; i < compDb.length && points.length < maxCorners; i++) {
    const v = q(compDb[i]);
    if (Math.abs(v - last) >= quantDb * 0.5) {
      points.push([Math.min(i * blockSec, duration), v]);
      last = v;
    }
  }
  const endT = duration;
  if (points[points.length - 1][0] < endT - 1e-9) points.push([endT, last]);
  return points;
}

function valueAtPoints(points, t) {
  if (!points.length) return 0;
  if (t <= points[0][0]) return points[0][1];
  if (t >= points[points.length - 1][0]) return points[points.length - 1][1];
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [a, x] = points[lo];
  const [b, y] = points[hi];
  return x + (y - x) * ((t - a) / (b - a));
}

module.exports = {
  bedCompressionDb,
  effectivePeakAfterComp,
  effectiveActiveRms,
  summarizeBedCompression,
  compEnvelopeCorners,
  valueAtPoints,
};
