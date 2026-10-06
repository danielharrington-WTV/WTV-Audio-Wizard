/**
 * Simulates the plugin music-analysis duck pipeline on equal time segments of a WAV.
 * Usage: node research/simulate-music-bed-segments.cjs [path-to-wav] [segmentCount]
 */
const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');
const { analyze } = require('../plugin/music-analysis.js');

const defaultWav =
  'h:\\Dans Stuff\\WildTV\\Prairie Pursuit\\PP9001 Greg SpringBear\\Music\\ANW4290_013_New-Frontier-No-Strings.wav';
const wavPath = process.argv[2] || defaultWav;
const segmentCount = Math.max(2, Number(process.argv[3]) || 10);
const rate = 48000;
const channels = 1;

function decodeToMonoF32(file) {
  const tmp = path.join(process.env.TEMP || '/tmp', `wtv-bed-sim-${Date.now()}.raw`);
  const ff = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-y', '-i', file, '-f', 'f32le', '-ac', String(channels), '-ar', String(rate), tmp],
    { encoding: 'utf8' },
  );
  if (ff.status !== 0) throw new Error(ff.stderr || 'ffmpeg failed');
  const raw = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  return Float64Array.from(f32);
}

function buildSummary(samples, blockSamples) {
  const count = Math.ceil(samples.length / blockSamples);
  const levels = new Float64Array(count);
  const peaks = new Float64Array(count);
  let peak = 0;
  for (let b = 0; b < count; b++) {
    let sum = 0;
    let c = 0;
    let max = 0;
    const start = b * blockSamples;
    const end = Math.min(samples.length, start + blockSamples);
    for (let i = start; i < end; i++) {
      const v = samples[i];
      const a = Math.abs(v);
      if (a > max) max = a;
      if (a > 1e-15) {
        sum += v * v;
        c++;
      }
    }
    levels[b] = c ? Math.sqrt(sum / c) : 0;
    peaks[b] = max;
    if (max > peak) peak = max;
  }
  return { rate, channels, samples: samples.length, peak, levels, peaks };
}

function sliceSummary(full, startBlock, endBlock, blockSamples) {
  const levels = full.levels.subarray(startBlock, endBlock);
  const peaks = full.peaks.subarray(startBlock, endBlock);
  let peak = 0;
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
  return {
    rate: full.rate,
    channels: full.channels,
    samples: (endBlock - startBlock) * blockSamples,
    peak,
    levels,
    peaks,
  };
}

function synthDialogue(music) {
  const dLevels = new Float64Array(music.levels.length);
  const dPeaks = new Float64Array(music.levels.length);
  const level = 0.1;
  const n = music.levels.length;
  const a = Math.floor(n * 0.35);
  const b = Math.ceil(n * 0.65);
  for (let i = a; i < b && i < n; i++) {
    dLevels[i] = level;
    dPeaks[i] = level * 1.2;
  }
  return { rate: music.rate, channels: music.channels, samples: music.samples, peak: level * 1.2, levels: dLevels, peaks: dPeaks };
}

function synthProbe(music) {
  const duration = music.samples / music.rate;
  const probeLevels = new Float64Array(music.levels.length);
  const probePeaks = new Float64Array(music.levels.length);
  for (let i = 0; i < music.levels.length; i++) {
    const expected = -3 - (6 * Math.min((i + 0.5) * 0.02, duration)) / duration;
    const scale = 10 ** (expected / 20);
    probeLevels[i] = music.levels[i] * scale;
    probePeaks[i] = music.peaks[i] * scale;
  }
  let peak = 0;
  for (const p of probePeaks) if (p > peak) peak = p;
  return { rate: music.rate, channels: music.channels, samples: music.samples, peak, levels: probeLevels, peaks: probePeaks };
}

function curveStats(plan, music) {
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-15));
  const points = plan.points;
  const value = (t) => {
    const i = points.findIndex((x) => x[0] >= t);
    if (i <= 0) return points[0][1];
    if (i < 0) return points.at(-1)[1];
    const [a, x] = points[i - 1];
    const [b, y] = points[i];
    return x + (y - x) * ((t - a) / (b - a));
  };
  const duration = plan.duration;
  let sum = 0;
  let n = 0;
  const nBlocks = music.levels.length;
  const speechA = Math.floor(nBlocks * 0.35);
  const speechB = Math.ceil(nBlocks * 0.65);
  for (let i = 0; i < music.levels.length; i++) {
    if (music.levels[i] <= 10 ** (-60 / 20)) continue;
    if (i >= speechA && i < speechB) continue;
    const t = Math.min((i + 0.5) * 0.02, duration);
    const g = value(t);
    const out = music.levels[i] * 10 ** (g / 20);
    sum += out * out;
    n++;
  }
  return {
    between_lines_active_rms_dbfs: n ? db(Math.sqrt(sum / n)) : null,
  };
}

async function runSegment(music, dialogue, probe, bedCompression) {
  return analyze(music, dialogue, probe, {
    target_dbfs: -20,
    target_mode: 'peak',
    duck_db: 10,
    attack_ms: 200,
    release_ms: 1200,
    threshold_dbfs: -40,
    bed_compression: bedCompression,
  });
}

async function main() {
  if (!fs.existsSync(wavPath)) {
    console.error('WAV not found:', wavPath);
    process.exit(1);
  }
  const samples = decodeToMonoF32(wavPath);
  const blockSamples = Math.round(rate * 0.02);
  const full = buildSummary(samples, blockSamples);
  const blocksPerSeg = Math.floor(full.levels.length / segmentCount);
  if (blocksPerSeg < 20) throw new Error('File too short for 0.4s segments at this segment count');
  const segments = [];
  for (let s = 0; s < segmentCount; s++) {
    const startBlock = s * blocksPerSeg;
    const endBlock = s === segmentCount - 1 ? full.levels.length : startBlock + blocksPerSeg;
    const music = sliceSummary(full, startBlock, endBlock, blockSamples);
    if (music.samples / rate < 0.4) continue;
    const dialogue = synthDialogue(music);
    const probe = synthProbe(music);
    const withBed = await runSegment(music, dialogue, probe, true);
    const withoutBed = await runSegment(music, dialogue, probe, false);
    const withStats = curveStats(withBed, music);
    const withoutStats = curveStats(withoutBed, music);
    segments.push({
      index: s + 1,
      time_range_s: [+(startBlock * 0.02).toFixed(2), +(endBlock * 0.02).toFixed(2)],
      duration_s: +(music.samples / rate).toFixed(3),
      measured_peak_dbfs: +withBed.measured_music_peak_dbfs.toFixed(2),
      with_bed: {
        baseline_gain_db: +withBed.baseline_gain_db.toFixed(2),
        predicted_peak_dbfs: +withBed.predicted_sample_peak_dbfs.toFixed(2),
        bed_report: withBed.bed_compression_report,
        ...withStats,
      },
      without_bed: {
        baseline_gain_db: +withoutBed.baseline_gain_db.toFixed(2),
        predicted_peak_dbfs: +withoutBed.predicted_sample_peak_dbfs.toFixed(2),
        ...withoutStats,
      },
      delta_baseline_db: +(withBed.baseline_gain_db - withoutBed.baseline_gain_db).toFixed(2),
      delta_between_lines_rms_db: +(
        withStats.between_lines_active_rms_dbfs - withoutStats.between_lines_active_rms_dbfs
      ).toFixed(2),
    });
  }
  const baselines = segments.map((x) => x.with_bed.baseline_gain_db);
  const rmsOut = segments.map((x) => x.with_bed.between_lines_active_rms_dbfs);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
  };
  const report = {
    file: wavPath,
    segment_count: segments.length,
    settings: { target_dbfs: -20, target_mode: 'peak', duck_db: 10, bed_compression_default: true },
    dialogue_simulation: '35–65% of each segment at −20 dBFS block level',
    consistency: {
      baseline_gain_db: { mean: +mean(baselines).toFixed(2), stdev: +std(baselines).toFixed(2) },
      between_lines_active_rms_dbfs: { mean: +mean(rmsOut).toFixed(2), stdev: +std(rmsOut).toFixed(2) },
    },
    segments,
  };
  const outPath = path.join(__dirname, '../validation/music-bed-anw4290-segments.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log('Wrote', outPath);
  console.log('Baseline gain (with bed): mean', report.consistency.baseline_gain_db.mean, 'stdev', report.consistency.baseline_gain_db.stdev);
  console.log('Between-lines RMS (with bed): mean', report.consistency.between_lines_active_rms_dbfs.mean, 'stdev', report.consistency.between_lines_active_rms_dbfs.stdev);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
