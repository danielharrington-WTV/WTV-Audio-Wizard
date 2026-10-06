const test=require('node:test'),assert=require('node:assert/strict');
const {analyze}=require('../plugin/music-analysis.js');

function dialogueSummary({duration=4,rate=48000,channels=2,pulseStart=1,pulseEnd=2,level=0.1}={}) {
  const blockSec=0.02;
  const count=Math.ceil(duration/blockSec);
  const samples=Math.round(duration*rate);
  const levels=new Float64Array(count);
  const peaks=new Float64Array(count);
  for(let i=0;i<count;i++) {
    const t=(i+.5)*blockSec;
    const hot=t>=pulseStart && t<pulseEnd;
    levels[i]=hot?level:1e-8;
    peaks[i]=levels[i];
  }
  return {rate,channels,samples,peak:level,levels,peaks};
}

test('relative duck applies negative gain during dialogue',async()=>{
  const dialogue=dialogueSummary({duration:4,pulseStart:1,pulseEnd:2});
  const plan=await analyze(dialogue,{duck_db:10,attack_ms:200,release_ms:1200,threshold_dbfs:-40});
  assert.equal(plan.baseline_gain_db,0);
  assert.ok(plan.points.some(([,g])=>g<=-9.5));
  assert.ok(plan.points.some(([,g])=>Math.abs(g)<0.05));
  assert.equal(plan.speech_regions,1);
});

test('missing dialogue summaries are rejected',async()=>{
  await assert.rejects(analyze({samples:48000,rate:48000,channels:2,levels:new Float64Array(0),peaks:new Float64Array(0)}),/missing level/);
});

test('local analysis yields and cancellation interrupts it',async()=>{
  const dialogue=dialogueSummary();let cancelled=false;
  await assert.rejects(analyze(dialogue,{duck_db:10},{check:()=>{if(cancelled)throw Error('Cancelled');},yieldUI:async()=>{cancelled=true;}}),/Cancelled/);
});
