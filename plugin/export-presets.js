async function getWavPreset(fs, {rate, channels}) {
  if (![44100, 48000, 96000].includes(rate) || ![1, 2].includes(channels)) {
    throw new Error('WAV export supports mono/stereo sequences at 44.1, 48 or 96 kHz');
  }
  const pluginFolder = await fs.getPluginFolder();
  let entry;
  try {
    entry = await pluginFolder.getEntry(`presets/wav-${rate}-${channels}ch.epr`);
  } catch (_) {
    throw new Error('The bundled WAV preset is missing. Restore the complete plugin folder and reload the plugin.');
  }
  if (!entry.isFile || !entry.nativePath) throw new Error('The bundled WAV preset is not accessible. Reload the complete plugin folder.');
  return entry;
}

module.exports = {getWavPreset};
