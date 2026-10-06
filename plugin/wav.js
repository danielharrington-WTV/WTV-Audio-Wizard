// Inspect actual file bytes before upload or timeline replacement. Export
// acceptance alone does not establish that Premiere finished writing a WAV.
function inspectWav(buffer, expected) {
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV is not complete. Wait for Premiere to finish all exports, then click Batch Process Dialogue again.');
  if (view.getUint32(4, true) + 8 !== buffer.byteLength) throw new Error('WAV is still being written or has an invalid length. Wait for export completion.');
  let format, dataBytes;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const size = view.getUint32(offset + 4, true), body = offset + 8;
    if (body + size > buffer.byteLength) throw new Error('Incomplete WAV chunk. Wait for export completion.');
    if (tag(offset) === 'fmt ') {
      if (size < 16) throw new Error('Invalid WAV format.');
      let code = view.getUint16(body, true);
      if (code === 65534 && size >= 40) code = view.getUint16(body + 24, true);
      format = {code, channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), align: view.getUint16(body + 12, true), bits: view.getUint16(body + 14, true)};
    }
    if (tag(offset) === 'data') {
      if (dataBytes !== undefined) throw new Error('Multiple WAV data chunks are unsupported.');
      dataBytes = size;
    }
    offset = body + size + size % 2;
  }
  if (!format || ![1, 3].includes(format.code) || !dataBytes || !format.align || format.align !== format.channels * format.bits / 8 || dataBytes % format.align) throw new Error('Invalid or incomplete PCM WAV.');
  const samples = dataBytes / format.align;
  if (format.rate !== expected.rate || format.channels !== expected.channels || Math.abs(samples / format.rate - expected.duration) > 1 / format.rate) throw new Error('Export duration, sample rate or channels do not match this clip. Keep the pending clone unchanged and prepare again.');
  return {samples, sample_rate: format.rate, channels: format.channels};
}

function peakDbfsFromWav(buffer) {
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('WAV is not complete.');
  let format, dataOffset, dataBytes;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const size = view.getUint32(offset + 4, true), body = offset + 8;
    if (body + size > buffer.byteLength) throw new Error('Incomplete WAV chunk.');
    if (tag(offset) === 'fmt ') {
      let code = view.getUint16(body, true);
      if (code === 65534 && size >= 40) code = view.getUint16(body + 24, true);
      format = {code, channels: view.getUint16(body + 2, true), align: view.getUint16(body + 12, true), bits: view.getUint16(body + 14, true)};
    }
    if (tag(offset) === 'data') {
      dataOffset = body;
      dataBytes = size;
    }
    offset = body + size + size % 2;
  }
  if (!format || !dataBytes || !format.align) throw new Error('Invalid PCM WAV.');
  let peak = 0;
  const end = dataOffset + dataBytes;
  if (format.code === 3) {
    for (let i = dataOffset; i + 4 <= end; i += 4) peak = Math.max(peak, Math.abs(view.getFloat32(i, true)));
  } else if (format.code === 1 && format.bits === 16) {
    for (let i = dataOffset; i + 2 <= end; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true) / 32768));
  } else {
    throw new Error('Unsupported WAV sample format for peak measurement.');
  }
  return peak ? 20 * Math.log10(peak) : -120;
}

// Premiere may return from exportSequence before the WAV is fully flushed.
// Poll until inspectWav passes twice at the same byte length (see deplosive.js).
async function waitForStableWav(file, expected, {binary, check = () => {}, sleep, deadlineMs = 5 * 60 * 1000, renderWaitMode, pollIntervalMs}) {
  const pollMs = pollIntervalMs ?? (renderWaitMode === 'events' ? 200 : 1000);
  let stable = 0, lastSize = 0;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    check();
    try {
      const bytes = await file.read({format: binary});
      inspectWav(bytes, expected);
      stable = bytes.byteLength === lastSize ? stable + 1 : 1;
      lastSize = bytes.byteLength;
      if (stable >= 2) return {bytes, exportWait: renderWaitMode || 'poll'};
    } catch (_) { stable = 0; }
    await sleep(pollMs);
  }
  throw new Error('Export timed out. Wait for Premiere to finish all exports, then click Batch Process Dialogue again.');
}

// Same contract as waitForStableWav, without reading the whole file on every
// poll: stats the size and parses only the chunk headers (music-wav.js's
// bounded header()) until the size is stable across two polls and the header
// validates against `expected`. A 30-minute clip's WAV is hundreds of MB, and
// the old loop pulled all of it into memory every 200 ms (2026-09-17).
// Returns {size, format, exportWait}; callers that need the bytes read them once.
async function waitForStableWavFile(nativePath, expected, {io, check = () => {}, sleep, deadlineMs = 5 * 60 * 1000, renderWaitMode, pollIntervalMs}) {
  io = io || require('fs');
  const {header} = require('./music-wav.js');
  const pollMs = pollIntervalMs ?? (renderWaitMode === 'events' ? 200 : 1000);
  let stable = 0, lastSize = -1, format = null;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    check();
    let fd;
    try {
      const stat = await io.lstat(nativePath);
      fd = await io.open(nativePath, 'r');
      format = await header(io, fd, stat.size, expected);
      stable = stat.size === lastSize ? stable + 1 : 1;
      lastSize = stat.size;
      if (stable >= 2) return {size: stat.size, format, exportWait: renderWaitMode || 'poll'};
    } catch (_) { stable = 0; }
    finally { if (fd !== undefined) { try { await io.close(fd); } catch (_) {} } }
    await sleep(pollMs);
  }
  throw new Error('Export timed out. Wait for Premiere to finish all exports, then click Batch Process Dialogue again.');
}

module.exports = {inspectWav, peakDbfsFromWav, waitForStableWav, waitForStableWavFile};
