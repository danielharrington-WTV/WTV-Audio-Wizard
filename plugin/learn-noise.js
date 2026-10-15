// Learn noise (2026-10-15): renders the active sequence's In/Out range --
// the audible mix, exactly as the timeline plays it -- uploads it, and asks
// the service for a noise print (POST /v1/noise-profile). The range should
// hold background noise only (room tone, hum, hiss between lines). Nothing on
// the timeline changes. Remove noise (remove-noise.js) uses the print.
const ppro = require('premierepro');
const {getWavPreset} = require('./export-presets.js');
const {exportSequenceWithRenderWait} = require('./export-sync.js');

const MIN_SECONDS = 0.5;
const MAX_SECONDS = 60;
const SILENT_DBFS = -90;

// Check a finished render: rate/channels must match; duration within 0.1 s of
// the In/Out range (Premiere may round the range to a frame or sample).
function wavInfo(buffer, expected) {
  const view = new DataView(buffer);
  const tag = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== buffer.byteLength) return null;
  let format = null, dataBytes = null;
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const size = view.getUint32(offset + 4, true), body = offset + 8;
    if (body + size > buffer.byteLength) return null;
    if (tag(offset) === 'fmt ' && size >= 16) format = {channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), align: view.getUint16(body + 12, true)};
    if (tag(offset) === 'data') dataBytes = size;
    offset = body + size + size % 2;
  }
  if (!format || !dataBytes || !format.align) return null;
  const seconds = dataBytes / format.align / format.rate;
  if (format.rate !== expected.rate || format.channels !== expected.channels) throw new Error('The noise render has a different sample rate or channel count than the sequence.');
  if (Math.abs(seconds - expected.duration) > 0.1) throw new Error(`The noise render is ${seconds.toFixed(2)} s, not the ${expected.duration.toFixed(2)} s In/Out range.`);
  return {seconds};
}

async function range(sequence) {
  const start = await sequence.getInPoint(), end = await sequence.getOutPoint();
  const inSeconds = Number(start?.seconds), outSeconds = Number(end?.seconds);
  if (!Number.isFinite(inSeconds) || !Number.isFinite(outSeconds)) throw new Error('Could not read the sequence In/Out points.');
  const duration = outSeconds - inSeconds;
  if (duration < MIN_SECONDS || duration > MAX_SECONDS) {
    throw new Error(`Mark In and Out on the sequence around ${MIN_SECONDS}–${MAX_SECONDS} seconds of background noise only (no speech, music or effects), then click Learn noise. The current range is ${duration.toFixed(1)} s.`);
  }
  return {inSeconds, outSeconds, duration};
}

async function run({fs, binary, io = require('fs'), request, check = () => {}, say = () => {}, sleep}) {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first.');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('Activate a sequence first.');
  const seqSettings = await sequence.getSettings();
  const rate = Math.round((await seqSettings.getAudioSampleRate()).value);
  const channels = await seqSettings.getAudioChannelCount();
  if (![1, 2].includes(channels) || ![44100, 48000, 96000].includes(rate)) throw new Error('Learn noise supports mono/stereo sequences at 44.1, 48 or 96 kHz.');
  const {inSeconds, outSeconds, duration} = await range(sequence);
  const preset = await getWavPreset(fs, {rate, channels});
  const folder = await fs.getTemporaryFolder();
  const file = await folder.createFile(`WTV-noise-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`, {overwrite: false});
  let bytes = null, ready = false, assetId = null;
  try {
    say(`Learn noise: rendering ${duration.toFixed(1)} s between In and Out…`);
    await exportSequenceWithRenderWait({
      ppro, manager: await ppro.EncoderManager.getManager(), sequence,
      exportType: ppro.Constants.ExportType.IMMEDIATELY,
      outputFile: file.nativePath, presetFile: preset.nativePath, exportFull: false,
      outputNativePath: file.nativePath, check, sleep,
      rejectedMessage: 'Premiere did not accept the noise render.',
      verifyOutput: async ({check: verifyCheck}) => {
        const deadline = Date.now() + 5 * 60 * 1000;
        let last = -1;
        while (Date.now() < deadline) {
          verifyCheck();
          try {
            // Size first (cheap); read the file only once it has stopped growing.
            const size = (await io.lstat(file.nativePath)).size;
            if (size === last) {
              const data = await file.read({format: binary});
              if (wavInfo(data, {rate, channels, duration})) { bytes = data; ready = true; return; }
            }
            last = size;
          } catch (error) { if (/noise render/.test(error.message)) throw error; }
          await sleep(300);
        }
        throw new Error('The noise render timed out; Premiere may still be exporting.');
      },
    });
    check();
    say('Learn noise: measuring the noise print on the service…');
    const asset = await (await request('/v1/assets', {method: 'POST', headers: {'Content-Type': 'audio/wav'}, body: bytes})).json();
    assetId = asset.asset_id;
    const learned = await (await request('/v1/noise-profile', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({asset_id: assetId})})).json();
    if (learned.summary && learned.summary.noise_rms_dbfs < SILENT_DBFS) {
      throw new Error('The In/Out range rendered as silence (a muted track or no clip there). Mark In/Out over audible background noise and try again.');
    }
    return {profileId: learned.profile_id, summary: learned.summary, inSeconds, outSeconds};
  } finally {
    if (assetId) { try { await request(`/v1/assets/${assetId}`, {method: 'DELETE'}); } catch (_) {} }
    // An unconfirmed render (cancelled mid-export) is left: Premiere may still be writing it.
    if (ready) { try { await file.delete(); } catch (_) {} }
  }
}

module.exports = {run, range, wavInfo, MIN_SECONDS, MAX_SECONDS};
