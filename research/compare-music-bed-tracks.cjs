/**
 * Compare bed-compression simulation on two library masters (10 segments each).
 * Usage: node research/compare-music-bed-tracks.cjs [wavA] [wavB]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { analyze } = require('../plugin/music-analysis.js');

const defaultA =
  'h:\\Dans Stuff\\WildTV\\Prairie Pursuit\\PP9001 Greg SpringBear\\Music\\ANW4290_013_New-Frontier-No-Strings.wav';
const defaultB =
  'h:\\Dans Stuff\\WildTV\\Prairie Pursuit\\PP9001 Greg SpringBear\\Music\\ANW2865_038_Back-From-The-Dead-3.wav';
const wavA = process.argv[2] || defaultA;
const wavB = process.argv[3] || defaultB;
const segmentCount = 10;
const rate = 48000;

function decodeToMonoF32(file) {
  const tmp = path.join(process.env.TEMP || '/tmp', `wtv-bed-cmp-${Date.now()}-${Math.random().toString(16).slice(2)}.raw`);
  const ff = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-y', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(rate), tmp],
    { encoding: 'utf8' },
  );
  if (ff.status !== 0) throw new Error(ff.stderr || `ffmpeg failed: ${file}`);
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
  return { rate, channels: 1, samples: samples.length, peak, levels, peaks, duration: samples.length / rate };
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

function db(x) {
  return 20 * Math.log10(Math.max(x, 1e-15));
}

async function analyzeFile(wavPath) {
  if (!fs.existsSync(wavPath)) throw new Error(`Missing: ${wavPath}`);
  const samples = decodeToMonoF32(wavPath);
  const blockSamples = Math.round(rate * 0.02);
  const full = buildSummary(samples, blockSamples);
  const blocksPerSeg = Math.floor(full.levels.length / segmentCount);
  const settings = {
    target_dbfs: -20,
    target_mode: 'peak',
    duck_db: 10,
    attack_ms: 200,
    release_ms: 1200,
    threshold_dbfs: -40,
  };
  let active = 0;
  let sum = 0;
  for (const v of full.levels) {
    if (v > 10 ** (-70 / 20)) {
      active++;
      sum += v * v;
    }
  }
  const fileSummary = {
    basename: path.basename(wavPath),
    duration_s: +full.duration.toFixed(2),
    sample_peak_dbfs: +db(full.peak).toFixed(2),
    active_rms_20ms_dbfs: +db(Math.sqrt(sum / active)).toFixed(2),
    crest_db: +(db(full.peak) - db(Math.sqrt(sum / active))).toFixed(2),
  };
  const segments = [];
  for (let s = 0; s < segmentCount; s++) {
    const startBlock = s * blocksPerSeg;
    const endBlock = s === segmentCount - 1 ? full.levels.length : startBlock + blocksPerSeg;
    const levels = full.levels.subarray(startBlock, endBlock);
    const peaks = full.peaks.subarray(startBlock, endBlock);
    let peak = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > peak) peak = peaks[i];
    const music = {
      rate: full.rate,
      channels: full.channels,
      samples: (endBlock - startBlock) * blockSamples,
      peak,
      levels,
      peaks,
    };
    if (music.samples / rate < 0.4) continue;
    const dialogue = synthDialogue(music);
    const probe = synthProbe(music);
    const withBed = await analyze(music, dialogue, probe, { ...settings, bed_compression: true });
    const withoutBed = await analyze(music, dialogue, probe, { ...settings, bed_compression: false });
    segments.push({
      index: s + 1,
      time_s: [+(startBlock * 0.02).toFixed(1), +(endBlock * 0.02).toFixed(1)],
      segment_peak_dbfs: +withBed.measured_music_peak_dbfs.toFixed(2),
      with_bed: {
        baseline_gain_db: +withBed.baseline_gain_db.toFixed(2),
        bed_mean_compression_db: +((withBed.bed_compression_report?.mean_compression_db) || 0).toFixed(2),
        blocks_compressed: withBed.bed_compression_report?.blocks_compressed ?? 0,
      },
      without_bed: { baseline_gain_db: +withoutBed.baseline_gain_db.toFixed(2) },
      lift_from_bed_db: +(withBed.baseline_gain_db - withoutBed.baseline_gain_db).toFixed(2),
    });
  }
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr) => {
    const m = mean(arr);
    return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
  };
  const baselinesWith = segments.map((x) => x.with_bed.baseline_gain_db);
  const baselinesWithout = segments.map((x) => x.without_bed.baseline_gain_db);
  const lifts = segments.map((x) => x.lift_from_bed_db);
  return {
    file: wavPath,
    ...fileSummary,
    segments,
    aggregate: {
      baseline_with_bed: { mean: +mean(baselinesWith).toFixed(2), stdev: +std(baselinesWith).toFixed(2) },
      baseline_without_bed: { mean: +mean(baselinesWithout).toFixed(2), stdev: +std(baselinesWithout).toFixed(2) },
      lift_from_bed_db: { mean: +mean(lifts).toFixed(2), stdev: +std(lifts).toFixed(2) },
      mean_blocks_compressed: +mean(segments.map((x) => x.with_bed.blocks_compressed)).toFixed(0),
      mean_bed_compression_db: +mean(segments.map((x) => x.with_bed.bed_mean_compression_db)).toFixed(2),
    },
  };
}

async function main() {
  const a = await analyzeFile(wavA);
  const b = await analyzeFile(wavB);
  const report = {
    settings: { target_dbfs: -20, target_mode: 'peak', duck_db: 10, bed_compression: true },
    dialogue_simulation: '35–65% of each segment at −20 dBFS (same as segment sim)',
    tracks: {
      ANW4290_New_Frontier: a,
      ANW2865_Back_From_The_Dead_3: b,
    },
    comparison: {
      louder_master_peak_dbfs: a.sample_peak_dbfs > b.sample_peak_dbfs ? a.basename : b.basename,
      baseline_with_bed_mean_delta: +(b.aggregate.baseline_with_bed.mean - a.aggregate.baseline_with_bed.mean).toFixed(2),
      lift_from_bed_mean_delta: +(b.aggregate.lift_from_bed_db.mean - a.aggregate.lift_from_bed_db.mean).toFixed(2),
      bed_work_mean_compression_delta: +(b.aggregate.mean_bed_compression_db - a.aggregate.mean_bed_compression_db).toFixed(2),
    },
  };
  const outPath = path.join(__dirname, '../validation/music-bed-track-comparison.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log('Wrote', outPath);
  console.log('');
  console.log('File summary:');
  for (const t of [a, b]) {
    console.log(`  ${t.basename}: ${t.duration_s}s, peak ${t.sample_peak_dbfs} dBFS, RMS ${t.active_rms_20ms_dbfs} dBFS, crest ${t.crest_db} dB`);
  }
  console.log('');
  console.log('With bed compression (10-segment mean):');
  console.log(`  ${path.basename(wavA)}: baseline ${a.aggregate.baseline_with_bed.mean} dB (lift +${a.aggregate.lift_from_bed_db.mean} vs no bed)`);
  console.log(`  ${path.basename(wavB)}: baseline ${b.aggregate.baseline_with_bed.mean} dB (lift +${b.aggregate.lift_from_bed_db.mean} vs no bed)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
