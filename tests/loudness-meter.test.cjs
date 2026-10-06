const test=require('node:test'),assert=require('node:assert/strict');
const {createMeter}=require('../plugin/loudness-meter.js');
function tone(channels=1,seconds=3,amplitude=.1){
 const m=createMeter(channels);
 for(let i=0;i<48000*seconds;i++)m.push(Array(channels).fill(amplitude*Math.sin(2*Math.PI*1000*i/48000)));
 return m;
}
test('1 kHz -20 dBFS sine agrees with BS.1770 / FFmpeg reference',()=>{
 const r=tone().finish();assert.ok(Math.abs(r.integrated_lufs-(-23.0037))<.02);
 assert.ok(Math.abs(r.sample_peak_dbfs+20)<1e-8);assert.ok(Math.abs(r.rms_dbfs+23.0103)<.001);
});
test('stereo sums channel energy, and silence is gated rather than diluting programme loudness',()=>{
 const mono=tone().finish(),stereo=tone(2).finish();assert.ok(Math.abs(stereo.integrated_lufs-mono.integrated_lufs-3.0103)<.001);
 const m=tone();for(let i=0;i<48000*10;i++)m.push([0]);assert.ok(Math.abs(m.finish().integrated_lufs-mono.integrated_lufs)<.3);
});
test('silence, short audio and invalid samples never produce a false loudness pass',()=>{
 const m=createMeter(1);for(let i=0;i<48000;i++)m.push([0]);assert.equal(m.finish().integrated_lufs,null);
 assert.equal(tone(1,.2).finish().integrated_lufs,null);
 assert.throws(()=>m.push([NaN]),/Non-finite/);assert.throws(()=>createMeter(6),/mono/);
});

test('finds the earliest highest sample, channel and tied occurrences',()=>{
 const m=createMeter(2);for(let i=0;i<48000;i++)m.push([0,0]);
 m.push([.2,1]);m.push([1,0]);
 const r=m.finish();assert.equal(r.sample_peak_position_seconds,1);assert.equal(r.sample_peak_channel,2);assert.equal(r.sample_peak_occurrences,2);
 assert.equal(createMeter(1).finish().sample_peak_position_seconds,null);
});
test('peak location formatter handles millisecond rounding across hour boundary',()=>{
 const {formatPeakPosition}=require('../plugin/loudness-meter.js');
 assert.equal(formatPeakPosition(3599.9999),'01:00:00.000');
 assert.equal(formatPeakPosition(61.123),'00:01:01.123');
});
