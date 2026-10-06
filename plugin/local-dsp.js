// Plugin-side (no network) ports of service/deplosive.py (Fix a pop) and
// service/lowend.py (Enhance low end). Both are documented in service/app.py
// as synchronous, uncached, pure-CPU-DSP endpoints -- no model, no GPU -- so
// they're ported here to run entirely inside the UXP panel and avoid a round
// trip to the local/remote service. See research/REMOTE-SERVICE-READINESS-
// 2026-09-22.md for why these two (and only these two) were picked.
//
// Deliberately NOT built on the Web Audio API (OfflineAudioContext /
// BiquadFilterNode / decodeAudioData), even though a UXP webview may expose
// it: this environment can't confirm what Web Audio surface Premiere's UXP
// host actually provides, and this project's convention (see
// research/UXP-QUIRKS.md) is to never ship code that assumes unverified host
// behavior. A pure-JS implementation with zero host-API dependency works
// regardless of that answer. If Dan confirms Web Audio is available and
// stable there, that's a reasonable follow-up, not a blocker to this.
//
// enhanceLowEnd is NOT a bit-identical port of service/lowend.py: the Python
// version filters with a true 2nd-order Butterworth bandpass (scipy
// butter(...) + sosfiltfilt). Re-deriving an exact Butterworth SOS bandpass
// by hand (analog lowpass prototype -> lp2bp -> bilinear transform -> SOS)
// is easy to get subtly wrong with no scipy reference available here to
// check against. Instead this uses the RBJ Audio EQ Cookbook's bandpass
// biquad (constant skirt gain, peak gain = Q), applied zero-phase via a
// hand-written mirror-padded filtfilt. Same band, same intent, NOT
// guaranteed sample-identical output -- an A/B listening check against the
// old server-side output is recommended before treating this as a drop-in
// replacement. attenuatePop, by contrast, is a direct line-by-line port of
// pure RMS/envelope math with no library dependency, so it carries no such
// caveat.

// ---------------------------------------------------------------------------
// WAV codec
// ---------------------------------------------------------------------------

// Decode a RIFF/WAVE ArrayBuffer to {sampleRate, channels: Float32Array[]}.
// Supports format code 1 (integer PCM, 8/16/24/32-bit) and 3 (IEEE float,
// 32/64-bit), including WAVE_FORMAT_EXTENSIBLE (code 65534) resolving its
// real subformat from the extension block, same as plugin/wav.js's
// inspectWav. The export preset's exact bit depth couldn't be confirmed by
// inspecting plugin/presets/wav-48000-2ch.epr, so all of these are handled
// rather than assuming one.
function readWavFloat(buffer) {
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a valid WAV file.');
  let format, dataOffset, dataBytes;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const size = view.getUint32(offset + 4, true), body = offset + 8;
    if (body + size > buffer.byteLength) throw new Error('Incomplete WAV chunk.');
    if (tag(offset) === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format chunk.');
      let code = view.getUint16(body, true);
      if (code === 65534 && size >= 40) code = view.getUint16(body + 24, true);
      format = {code, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true),
        align: view.getUint16(body + 12, true), bits: view.getUint16(body + 14, true)};
    }
    if (tag(offset) === 'data') {
      if (dataBytes !== undefined) throw new Error('Multiple WAV data chunks are unsupported.');
      dataOffset = body;
      dataBytes = size;
    }
    offset = body + size + size % 2;
  }
  if (!format || !dataBytes || !format.align || format.align !== format.channels * format.bits / 8 || dataBytes % format.align) {
    throw new Error('Invalid or incomplete PCM WAV.');
  }
  const frames = dataBytes / format.align;
  const channels = [];
  for (let c = 0; c < format.channels; c++) channels.push(new Float32Array(frames));
  const bytesPerSample = format.bits / 8;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < format.channels; c++) {
      const at = dataOffset + i * format.align + c * bytesPerSample;
      let v;
      if (format.code === 3) {
        v = format.bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
      } else if (format.code === 1) {
        if (format.bits === 8) {
          v = (view.getUint8(at) - 128) / 128;
        } else if (format.bits === 16) {
          v = view.getInt16(at, true) / 32768;
        } else if (format.bits === 24) {
          const b0 = view.getUint8(at), b1 = view.getUint8(at + 1), b2 = view.getUint8(at + 2);
          let raw = b0 | (b1 << 8) | (b2 << 16);
          if (raw & 0x800000) raw -= 0x1000000;
          v = raw / 8388608;
        } else if (format.bits === 32) {
          v = view.getInt32(at, true) / 2147483648;
        } else {
          throw new Error(`Unsupported PCM bit depth: ${format.bits}`);
        }
      } else {
        throw new Error(`Unsupported WAV format code: ${format.code}`);
      }
      channels[c][i] = v;
    }
  }
  return {sampleRate: format.rate, channels};
}

// Encode {sampleRate, channels: Float32Array[]} as a 32-bit IEEE-float WAV
// ArrayBuffer -- the simplest lossless-for-our-purposes format to write, and
// waitForStableWav/inspectWav (plugin/wav.js) already accept format code 3.
function writeWavFloat(sampleRate, channelArrays) {
  const numChannels = channelArrays.length;
  const frames = channelArrays[0] ? channelArrays[0].length : 0;
  const bytesPerSample = 4;
  const blockAlign = numChannels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeTag = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 32, true);
  writeTag(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      view.setFloat32(offset, channelArrays[c][i], true);
      offset += 4;
    }
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Fix a pop -- direct port of service/deplosive.py
// ---------------------------------------------------------------------------

const POP_SEARCH_MS = 400.0;
const POP_BASELINE_WINDOW_S = 0.4;
const POP_BASELINE_GAP_S = 0.05;
const POP_BLOCK_MS = 10.0;
const POP_RETURN_RATIO = 1.5;
const POP_MISS_TOLERANCE_BLOCKS = 2;
const POP_MAX_REDUCTION_DB = 16.0;
const POP_ATTACK_MS = 2.0;
const POP_RELEASE_MS = 40.0;

function rmsRange(x, lo, hi) {
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (hi - lo));
}

// Port of _walk: walk outward from `seed` in steps of `block` samples
// (direction -1 backward, +1 forward), tracking the furthest boundary
// reached while blocks stay above `threshold`, tolerating up to
// POP_MISS_TOLERANCE_BLOCKS consecutive misses before stopping.
function popWalk(x, seed, block, threshold, direction, limit) {
  let pos = seed;
  let lastGood = seed;
  let misses = 0;
  while (pos >= 0 && pos <= x.length && Math.abs(pos - seed) < limit) {
    let lo, hi;
    if (direction > 0) { lo = pos; hi = pos + block; } else { lo = pos - block; hi = pos; }
    lo = Math.max(0, lo); hi = Math.min(x.length, hi);
    if (hi <= lo) break;
    const level = rmsRange(x, lo, hi);
    pos += direction * block;
    if (level > threshold) {
      misses = 0;
      lastGood = pos;
    } else {
      misses += 1;
      if (misses > POP_MISS_TOLERANCE_BLOCKS) break;
    }
  }
  return lastGood;
}

// Port of _channel_window.
function popChannelWindow(x, rate, seed) {
  const block = Math.max(1, Math.round(rate * POP_BLOCK_MS / 1000));
  const baselineSamples = Math.round(POP_BASELINE_WINDOW_S * rate);
  const gapSamples = Math.round(POP_BASELINE_GAP_S * rate);
  const preLo = Math.max(0, seed - baselineSamples);
  const preHi = Math.max(0, seed - gapSamples);
  const preLen = Math.max(0, preHi - preLo);
  const baseline = Math.max(preLen ? rmsRange(x, preLo, preHi) : 1e-6, 1e-6);
  const threshold = baseline * POP_RETURN_RATIO;
  const searchSamples = Math.round(POP_SEARCH_MS * rate / 1000);

  let start = popWalk(x, seed, block, threshold, -1, searchSamples);
  let end = popWalk(x, seed, block, threshold, +1, searchSamples);
  start = Math.max(0, Math.min(start, seed));
  end = Math.min(x.length, Math.max(end, seed));
  return {start, end, baseline};
}

// Port of _attenuation_envelope.
function popAttenuationEnvelope(length, rate) {
  const depth = Math.pow(10, -POP_MAX_REDUCTION_DB / 20);
  const attackN = Math.min(Math.max(1, Math.round(rate * POP_ATTACK_MS / 1000)), length);
  const releaseN = Math.min(Math.max(1, Math.round(rate * POP_RELEASE_MS / 1000)), length - attackN);
  const env = new Float64Array(length).fill(depth);
  for (let i = 0; i < attackN; i++) env[i] = 1.0 + (depth - 1.0) * (attackN === 1 ? 1 : i / (attackN - 1));
  if (releaseN > 0) {
    const base = length - releaseN;
    for (let i = 0; i < releaseN; i++) env[base + i] = depth + (1.0 - depth) * (releaseN === 1 ? 1 : i / (releaseN - 1));
  }
  return env;
}

// Port of attenuate_pop. `channels` is Float32Array[]; `rate` in Hz;
// `seedSeconds` a human-identified approximate timestamp within the signal.
// Returns {output: Float32Array[], report} with the same report shape the
// Python service returned, so callers that shift report fields to
// timeline-relative time (deplosive.js's toTimeline) need no changes.
function attenuatePop(channels, rate, seedSeconds) {
  const length = channels[0] ? channels[0].length : 0;
  if (!(seedSeconds >= 0 && seedSeconds <= length / rate)) {
    throw new Error(`seed_seconds ${seedSeconds} is outside the ${(length / rate).toFixed(3)}s signal`);
  }
  const seed = Math.round(seedSeconds * rate);
  const output = channels.map(c => c.slice());
  const windows = [];
  for (let c = 0; c < channels.length; c++) {
    const {start, end, baseline} = popChannelWindow(channels[c], rate, seed);
    windows.push({start, end, baseline});
    const winLength = end - start;
    if (winLength <= 0) continue;
    const env = popAttenuationEnvelope(winLength, rate);
    const src = channels[c], dst = output[c];
    for (let i = 0; i < winLength; i++) dst[start + i] = src[start + i] * env[i];
  }
  const overallStart = Math.min(...windows.map(w => w.start));
  const overallEnd = Math.max(...windows.map(w => w.end));
  const report = {
    seed_seconds: seedSeconds,
    start_seconds: overallStart / rate,
    end_seconds: overallEnd / rate,
    duration_seconds: (overallEnd - overallStart) / rate,
    max_reduction_db: POP_MAX_REDUCTION_DB,
    channels: windows.map(w => ({start_seconds: w.start / rate, end_seconds: w.end / rate, baseline_rms: w.baseline})),
  };
  return {output, report};
}

// ---------------------------------------------------------------------------
// Enhance low end -- RBJ-cookbook port of service/lowend.py (see file-level
// comment for why this isn't a bit-identical Butterworth match)
// ---------------------------------------------------------------------------

const LOWEND_BAND_LO_HZ = 150;
const LOWEND_BAND_HI_HZ = 500;

// RBJ Audio EQ Cookbook bandpass (constant 0 dB skirt gain, peak gain = Q),
// centered at f0 with bandwidth expressed via Q, at sample rate fs. Returns
// normalized {b, a} biquad coefficients (a[0] === 1).
function rbjBandpassCoeffs(f0, q, fs) {
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw0 = Math.cos(w0);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * cosw0, a2 = 1 - alpha;
  return {b: [b0 / a0, b1 / a0, b2 / a0], a: [1, a1 / a0, a2 / a0]};
}

// Direct-form II transposed biquad, one pass, in place over a copy.
function applyBiquad(x, b, a) {
  const y = new Float64Array(x.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b[0] * xi + z1;
    z1 = b[1] * xi - a[1] * yi + z2;
    z2 = b[2] * xi - a[2] * yi;
    y[i] = yi;
  }
  return y;
}

// Zero-phase filtering: mirror-pad, forward pass, reverse, forward pass
// again, reverse, then trim the padding -- approximates scipy's sosfiltfilt
// (which mirror-pads by default too) closely enough for this band without
// replicating its exact edge-transient handling.
function filtfiltBiquad(x, b, a) {
  const padLen = Math.min(x.length - 1, Math.max(3 * Math.max(a.length, b.length), 15));
  if (x.length <= padLen || padLen < 1) {
    // Too short to pad meaningfully; match service/lowend.py's own
    // len(x) <= 27 bypass by leaving tiny clips unfiltered.
    return new Float64Array(x.length);
  }
  const n = x.length;
  const padded = new Float64Array(n + 2 * padLen);
  for (let i = 0; i < padLen; i++) padded[i] = 2 * x[0] - x[padLen - i];
  for (let i = 0; i < n; i++) padded[padLen + i] = x[i];
  for (let i = 0; i < padLen; i++) padded[padLen + n + i] = 2 * x[n - 1] - x[n - 2 - i];

  let y = applyBiquad(padded, b, a);
  y.reverse();
  y = applyBiquad(y, b, a);
  y.reverse();
  return y.slice(padLen, padLen + n);
}

// Naive linear-interpolation 4x oversample true-peak estimate, matching the
// intent of service/lowend.py's peak4() (resample_poly-based) closely enough
// for a safety ceiling, without depending on any resampling library.
function estimateTruePeak4x(channels) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i];
      peak = Math.max(peak, Math.abs(a));
      if (i + 1 < ch.length) {
        const b = ch[i + 1];
        for (let k = 1; k < 4; k++) {
          const interp = a + (b - a) * (k / 4);
          peak = Math.max(peak, Math.abs(interp));
        }
      }
    }
  }
  return peak;
}

// Port of enhance_low_end. `channels` is Float32Array[]; `rate` in Hz;
// `intensity` in [0.2, 3.0]. Returns {output: Float32Array[], report}.
function enhanceLowEnd(channels, rate, intensity = 1.0) {
  if (!Number.isFinite(intensity) || intensity < 0.2 || intensity > 3) throw new Error('Low-end intensity must be between 0.2 and 3.0');
  if (!channels.length || ![1, 2].includes(channels.length) || !channels[0].length || rate < 8000 || rate > 96000) {
    throw new Error('Expected finite mono/stereo audio at 8-96 kHz');
  }
  const length = channels[0].length;
  const centerHz = Math.sqrt(LOWEND_BAND_LO_HZ * LOWEND_BAND_HI_HZ);
  const q = centerHz / (LOWEND_BAND_HI_HZ - LOWEND_BAND_LO_HZ);
  const {b, a} = rbjBandpassCoeffs(centerHz, q, rate);

  const output = [];
  let anyApplied = false;
  const channelApplied = [];
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    let body = new Float64Array(length);
    if (length > 27) body = filtfiltBiquad(x, b, a);
    const out = new Float64Array(length);
    let changed = false;
    for (let i = 0; i < length; i++) {
      const v = x[i] + intensity * body[i];
      out[i] = v;
      if (Math.abs(v - x[i]) > 1e-8) changed = true;
    }
    channelApplied.push(changed);
    if (changed) anyApplied = true;
    output.push(out);
  }

  const measured = estimateTruePeak4x(output);
  const ceiling = Math.pow(10, -1 / 20);
  const safety = Math.min(1.0, ceiling / Math.max(measured, 1e-15));
  const finalOutput = output.map(ch => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * safety;
    return out;
  });

  const report = {
    algorithm: 'whisper-body-v1-js',
    intensity,
    body_band_hz: [LOWEND_BAND_LO_HZ, LOWEND_BAND_HI_HZ],
    nominal_center_boost_db: 20 * Math.log10(1 + intensity),
    safety_gain_db: 20 * Math.log10(safety),
    output_peak_dbfs: 20 * Math.log10(Math.max(measured * safety, 1e-15)),
    peak_method: '4x linear-interpolation oversampled estimate; linked global attenuation to -1 dBFS',
    applied: anyApplied,
    channels: channelApplied.map(applied => ({applied})),
  };
  return {output: finalOutput, report};
}

module.exports = {readWavFloat, writeWavFloat, attenuatePop, enhanceLowEnd};
