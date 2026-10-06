// ITU-R BS.1770-5 Annex 1, 48 kHz mono/stereo, equal channel weights.
// Sample peak only: this is NOT a true-peak delivery compliance meter.
function filter(b,a) {
 let x1=0,x2=0,y1=0,y2=0;
 return x=>{const y=b[0]*x+b[1]*x1+b[2]*x2-a[0]*y1-a[1]*y2;x2=x1;x1=x;y2=y1;y1=y;return y;};
}
const loud=z=>z>0?-0.691+10*Math.log10(z):null;
// Over-threshold peak events: every sample above `peakFlagDbfs` (default
// -6 dBFS) is recorded, not just the single loudest one. Hits closer than
// `mergeSeconds` (default 2 s) to the previous event's last hit are folded
// into that event (its peak/channel track the loudest sample seen), so a
// sustained hot passage or a burst of clipped samples reads as one flag at
// its first sample, not hundreds. Capped at MAX_EVENTS to bound memory and
// marker count; `over_threshold_truncated` says when the cap was hit.
const MAX_EVENTS=500;
function createMeter(channels,{peakFlagDbfs=-6,mergeSeconds=2}={}) {
 if(![1,2].includes(channels)) throw Error('Loudness supports mono/stereo only.');
 const flagLinear=Math.pow(10,peakFlagDbfs/20),mergeFrames=Math.round(mergeSeconds*48000);
 const events=[];let current=null,truncated=false;
 const filters=Array.from({length:channels},()=>[
  filter([1.53512485958697,-2.69169618940638,1.19839281085285],[-1.69065929318241,.73248077421585]),
  filter([1,-2,1],[-1.99004745483398,.99007225036621])]);
 const blocks=[],ring=[];let frames=0,sum=0,raw=0,peak=0,peakFrame=null,peakChannel=null,peakCount=0;
 return {
  push(values) {
   let power=0;
   for(let c=0;c<channels;c++) {
    const x=values[c];if(!Number.isFinite(x)) throw Error('Non-finite audio sample.');
    const magnitude=Math.abs(x);
    if(magnitude>peak) {peak=magnitude;peakFrame=frames;peakChannel=c+1;peakCount=1;}
    else if(magnitude===peak && peak>0) peakCount++;
    if(magnitude>flagLinear) {
     if(current && frames-current.lastFrame<=mergeFrames) {
      current.lastFrame=frames;current.hits++;
      if(magnitude>current.peak){current.peak=magnitude;current.peakFrame=frames;current.channel=c+1;}
     } else if(events.length<MAX_EVENTS) {
      current={startFrame:frames,lastFrame:frames,peakFrame:frames,peak:magnitude,channel:c+1,hits:1};events.push(current);
     } else truncated=true;
    }
    raw+=x*x;
    const y=filters[c][1](filters[c][0](x));power+=y*y;
   }
   sum+=power;frames++;
   if(frames%4800===0) {
    ring.push(sum/4800);sum=0;if(ring.length>4)ring.shift();
    if(ring.length===4)blocks.push(ring.reduce((a,b)=>a+b,0)/4);
   }
  },
  finish() {
   const absolute=blocks.filter(z=>loud(z)!==null && loud(z)>-70);
   const mean=a=>a.reduce((s,z)=>s+z,0)/a.length;
   const relative=absolute.length?loud(mean(absolute))-10:-70;
   const gated=absolute.filter(z=>loud(z)>relative);
   const over_threshold_events=events.map(e=>({position_seconds:e.startFrame/48000,end_seconds:e.lastFrame/48000,
    peak_dbfs:20*Math.log10(e.peak),peak_position_seconds:e.peakFrame/48000,channel:e.channel,samples_over:e.hits}));
   return {integrated_lufs:gated.length?loud(mean(gated)):null,sample_peak_dbfs:peak?20*Math.log10(peak):null,
    over_threshold_dbfs:peakFlagDbfs,over_threshold_merge_seconds:mergeSeconds,over_threshold_events,over_threshold_count:events.length,over_threshold_truncated:truncated,
    sample_peak_position_seconds:peakFrame===null?null:peakFrame/48000,sample_peak_channel:peakChannel,
    sample_peak_occurrences:peakCount,
    rms_dbfs:raw?10*Math.log10(raw/(frames*channels)):null,duration_seconds:frames/48000,
    channels,rate:48000,gated_blocks:gated.length,method:'BS.1770 K-weighted, 400 ms / 75% overlap, -70 LUFS and -10 LU relative gates',
    limitation:'Sample peak only; true peak and delivery compliance are not verified.'};
  }
 };
}
function formatPeakPosition(seconds) {
 if(seconds===null || !Number.isFinite(seconds))return 'not available';
 const ms=Math.round(seconds*1000),hours=Math.floor(ms/3600000),minutes=Math.floor(ms/60000)%60;
 return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}
module.exports={createMeter,formatPeakPosition};
