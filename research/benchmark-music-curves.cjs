// Synthetic 22-minute, 21-clip comparison; no native Premiere timing claims.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const box={module:{exports:{}},require:()=>({})};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../plugin/music-effects.js'),'utf8'),box);
const fx=box.module.exports,rate=48000,duration=1320;
const points=[[0,-12]];
for(let i=0;i<426;i++) {
  const t=.2+i*3;
  points.push([t,-12],[t+.2,-22],[t+1.4,-22],[t+2.4,-12]);
}
points.push([1319,-12],[duration,-12]);
function legacy(points,clip) {
  const end=Math.max(clip.start,clip.end-1/rate);
  const knots=[[clip.start,fx.valueAt(points,clip.start)],...points.filter(([t])=>t>clip.start&&t<end),[end,fx.valueAt(points,end)]];
  const dense=[];
  for(let i=0;i<knots.length-1;i++) {
    const [a,x]=knots[i],[b,y]=knots[i+1],steps=Math.max(1,Math.ceil(Math.abs(y-x)/.25));
    for(let j=0;j<steps;j++) dense.push([clip.inPoint+a-clip.start+(b-a)*j/steps,x+(y-x)*j/steps]);
  }
  dense.push([clip.inPoint+end-clip.start,knots.at(-1)[1]]);
  return dense.filter((p,i)=>!i||p[0]>dense[i-1][0]);
}
const results=[];
for(const layout of ['21 consecutive clips','21 overlapping full-length clips']) {
  let before=0,after=0,maxError=0;
  for(let i=0;i<21;i++) {
    const clip=layout.startsWith('21 consecutive')?{start:i*duration/21,end:(i+1)*duration/21,inPoint:30+i}:{start:0,end:duration,inPoint:30+i};
    const old=legacy(points,clip),fitted=fx.fitClipCurve(points,clip,rate,8000),curve=fitted.curve;
    if(old.length!==fitted.legacyKeyCount) throw Error('Legacy count mismatch');
    before+=old.length*2;after+=curve.length*2;
    // Compare the implied native normalized-value interpolation to the old
    // dense dB envelope, including every old corner and segment midpoint.
    const encoded=curve.map(([t,db])=>[t,(db+96)/144]);
    for(let j=0;j<old.length;j++) for(const t of [old[j][0],j?(old[j-1][0]+old[j][0])/2:old[j][0]]) {
      maxError=Math.max(maxError,Math.abs(fx.valueAt(encoded,t)*144-96-fx.valueAt(old,t)));
    }
  }
  results.push({layout,legacy_native_keys:before,sparse_native_keys:after,reduction_percent:100*(1-after/before),max_curve_error_db:maxError});
}
const report={fixture:'synthetic; not Dan\'s project',duration_seconds:duration,service_corners:points.length,channels:2,results,native_premiere_timing:'not measured'};
if(results.some(r=>r.max_curve_error_db>1e-8)) throw Error('Curve changed');
fs.writeFileSync(path.join(__dirname,'../validation/music-curve-optimization.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
