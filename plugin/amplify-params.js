// Which parameters of a native Amplify effect are its per-channel gain
// sliders. Shared by per-clip.js (setClipGains) and mute-tools.js so the two
// can't drift apart again.
//
// Real layout, read live from Premiere 2026-09-25 on a mono clip:
//   Bypass, Channel Count, Link Sliders, Gain, <31 unnamed>, Link Keyframes
// i.e. Amplify now carries 32 channel-slider slots; only the ones in use for
// the clip's channel layout have a display name ("Gain" on mono, "Left" /
// "Right" on stereo -- the stereo names are what the original code matched
// and was confirmed live on 2026-09-22). The unnamed slots are the hidden
// unused channels.
//
// Rule: a gain slider is any NAMED parameter that isn't one of Amplify's
// known controls. That covers mono, stereo and any other named channel
// layout without having to guess the channel names in advance.
const AMPLIFY_CONTROLS = /^(bypass|channel count|link sliders|link keyframes)$/i;

async function amplifyGainParamIndexes(component) {
  const indexes = [], names = [];
  const count = await component.getParamCount();
  for (let i = 0; i < count; i++) {
    const param = await component.getParam(i);
    const name = String(param.displayName || '').trim();
    names.push(name || `param ${i}`);
    if (name && !AMPLIFY_CONTROLS.test(name)) indexes.push(i);
  }
  return {indexes, names};
}

module.exports = {amplifyGainParamIndexes, AMPLIFY_CONTROLS};
