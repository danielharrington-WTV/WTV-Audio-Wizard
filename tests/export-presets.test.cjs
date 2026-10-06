const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {getWavPreset} = require('../plugin/export-presets.js');

const pluginRoot = path.resolve(__dirname, '../plugin');
const storage = {getPluginFolder: async () => ({getEntry: async relativePath => {
  const nativePath = path.join(pluginRoot, relativePath);
  return {nativePath, isFile: fs.statSync(nativePath).isFile()};
}})};

test('every supported sequence selects a bundled audio-only PCM WAV with matching format', async () => {
  const ids = new Set();
  for (const rate of [44100, 48000, 96000]) for (const channels of [1, 2]) {
    const entry = await getWavPreset(storage, {rate, channels});
    const xml = fs.readFileSync(entry.nativePath, 'utf8');
    assert.match(xml, /<DoAudio>true<\/DoAudio>/);
    assert.match(xml, /<DoVideo>false<\/DoVideo>/);
    assert.match(xml, /<ExporterFileType>1463899717<\/ExporterFileType>/);
    const values = {};
    for (const [block] of xml.matchAll(/<ExporterParam\b[^>]*>[\s\S]*?<\/ExporterParam>/g)) {
      const key = block.match(/<ParamIdentifier>([^<]+)<\/ParamIdentifier>/)[1];
      const value = block.match(/<ParamValue>([^<]+)<\/ParamValue>/);
      if (value) values[key] = Number(value[1]);
    }
    assert.equal(values.ADBEAudioRatePerSecond, rate);
    assert.equal(values.ADBEAudioNumChannels, channels);
    assert.equal(values.ADBEAudioCodec, 0);
    assert.equal(values.ADBEAudioSampleType, 1);
    ids.add(xml.match(/<PresetID>([^<]+)<\/PresetID>/)[1]);
  }
  assert.equal(ids.size, 6);
});

test('unsupported formats stop before accessing a preset', async () => {
  for (const context of [{rate: 48000, channels: 6}, {rate: 16000, channels: 1}]) {
    await assert.rejects(getWavPreset({}, context), /supports mono\/stereo/);
  }
});

test('missing packaged preset gives recovery instructions', async () => {
  const missingStorage = {getPluginFolder: async () => ({getEntry: async () => {throw Error('Not found');}})};
  await assert.rejects(getWavPreset(missingStorage, {rate: 48000, channels: 2}), /Restore the complete plugin folder/);
});
