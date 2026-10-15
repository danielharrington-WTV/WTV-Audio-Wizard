// Delivery targets for Verify loudness (2026-10-15). Pure helpers, no DOM.
//
// Choosing a delivery fills in Target, Tolerance and Flag peaks over; editing
// any of those by hand makes the choice read "Custom".
//
// YouTube: YouTube does not publish a loudness spec. Its player normalizes to
// about -14 LUFS integrated (visible in "Stats for nerds"): louder uploads are
// turned down, quieter ones are not turned up. Common practice is -14 LUFS with
// true peaks at or below -1 dBTP. Verify loudness measures SAMPLE peaks, and
// inter-sample (true) peaks run about 1-1.5 dB higher on dialogue, so the
// sample-peak flag sits at -2 dBFS to leave that margin under -1 dBTP.
// Broadcast keeps the panel's previous defaults.
const DELIVERIES = {
  broadcast: {label: 'Broadcast (-24 LUFS)', loudnessTarget: -24, loudnessTolerance: 1, peakFlag: -6},
  youtube: {label: 'YouTube (-14 LUFS)', loudnessTarget: -14, loudnessTolerance: 1, peakFlag: -2},
};
const DELIVERY_FIELDS = ['loudnessTarget', 'loudnessTolerance', 'peakFlag'];

// Which delivery the three values match, or 'custom'.
function detectDelivery(values) {
  for (const [id, d] of Object.entries(DELIVERIES)) {
    if (DELIVERY_FIELDS.every(f => Number(values[f]) === d[f])) return id;
  }
  return 'custom';
}

function deliveryValues(id) {
  const d = DELIVERIES[id];
  return d ? Object.fromEntries(DELIVERY_FIELDS.map(f => [f, d[f]])) : null;
}

module.exports = {DELIVERIES, DELIVERY_FIELDS, detectDelivery, deliveryValues};
