# Bundled WAV export presets

The plugin chooses a preset automatically from the sequence's audio settings:
44,100, 48,000 or 96,000 Hz, with one or two channels. All six presets export
audio-only, uncompressed 16-bit PCM WAV. They do not set the dialogue, music or
effects target levels; the local service applies those after separation.

The XML is based on the installed Adobe Media Encoder 2026 system preset
`MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr`.
Only the sample rate, channel count, preset ID, preset name and display folder
were changed. The mono value (1) was checked against Adobe's installed
`Settings/EncoderPresets/RawPCM_mono_16khz_nometadata.epr`.
The known sample-type value (1 = 16-bit) and exporter object structure were
preserved. Installed Adobe files were not modified.

The plugin resolves these files through UXP's read-only plugin folder, so no
machine-specific Adobe installation path or preset file picker is required.
Keep this directory when copying or packaging the plugin.

Preset XML and selection are checked locally. Export acceptance and resulting
WAV format still need an actual Premiere run; step 2 checks the exported WAV's
duration, sample rate and channels before submitting a processing job.
