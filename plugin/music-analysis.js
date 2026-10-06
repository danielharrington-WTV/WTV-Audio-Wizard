// Local CPU analysis of dialogue 20 ms summaries. Relative duck only (0 dB baseline).
const MAX_ENVELOPE_CORNERS=8000;
const defaults={duck_db:10,attack_ms:200,release_ms:1200,threshold_dbfs:-40};
const db=x=>20*Math.log10(Math.max(x,1e-15));
const round=x=>x%1===.5 ? 2*Math.round(x/2) : Math.round(x);
async function simplify(t,y,check,yieldUI,{maxKeep=MAX_ENVELOPE_CORNERS,tolerance=0.05}={}) {
  const keep=new Set([0,t.length-1]),pending=[[0,t.length-1]];
  let work=0;
  while(pending.length) {
    const [a,b]=pending.pop();if(b<=a+1) continue;
    let max=0,index=a+1;
    for(let i=a+1;i<b;i++) {
      const e=Math.abs(y[i]-(y[a]+(y[b]-y[a])*(t[i]-t[a])/(t[b]-t[a])));
      if(e>max) {max=e;index=i;}
      if(++work%100000===0) {check();await yieldUI();}
    }
    if(max>tolerance) {keep.add(index);pending.push([a,index],[index,b]);}
    if(keep.size>maxKeep) throw Error(`Too many activity changes (${keep.size} corners, limit ${maxKeep}). Shorten the sequence or reduce dialogue-driven ducking.`);
  }
  return [...keep].sort((a,b)=>a-b).map(i=>[t[i],y[i]]);
}
async function analyze(dialogue,settings={}, {check=()=>{},yieldUI=async()=>{}}={}) {
  const s={...defaults,...settings};
  for(const [name,min,max] of [['duck_db',0,30],['attack_ms',10,1000],['release_ms',50,3000],['threshold_dbfs',-60,-15]]) {
    if(!Number.isFinite(s[name])||s[name]<min||s[name]>max) throw Error(`Invalid ${name}`);
  }
  if(!dialogue?.levels?.length) throw Error('Dialogue analysis render is missing level summaries');
  const duration=dialogue.samples/dialogue.rate,d=dialogue.levels;
  if(duration<.4) throw Error('Analysis needs at least 0.4 seconds of audio');
  check();await yieldUI();
  const threshold=10**(s.threshold_dbfs/20),regions=[];
  let start=null,presentCount=0,dialoguePeak=0;
  for(let i=0;i<=d.length;i++) {
    const present=i<d.length && d[i]>threshold;
    if(i<d.length) dialoguePeak=Math.max(dialoguePeak,d[i]);
    if(present) {presentCount++;if(start===null) start=i;}
    else if(start!==null) {regions.push([start,i]);start=null;}
  }
  const duck=new Float64Array(d.length+1),attack=Math.max(1,round(s.attack_ms/20)),release=Math.max(1,round(s.release_ms/20));
  for(let n=0;n<regions.length;n++) {
    const [start,rawEnd]=regions[n],end=Math.min(duck.length-1,rawEnd+10);
    for(let i=Math.max(0,start-attack);i<start;i++) duck[i]=Math.max(duck[i],s.duck_db*(i-(start-attack))/attack);
    for(let i=start;i<=end;i++) duck[i]=s.duck_db;
    for(let i=end;i<Math.min(duck.length,end+release+1);i++) duck[i]=Math.max(duck[i],s.duck_db*(1-(i-end)/release));
    if(n%128===0) {check();await yieldUI();}
  }
  const times=Array.from(duck,(_,i)=>Math.min(i*.02,duration));
  const ys=Array.from(duck,(_,i)=>-duck[i]);
  const points=await simplify(times,ys,check,yieldUI,{maxKeep:MAX_ENVELOPE_CORNERS,tolerance:duration>600?0.1:0.05});
  let duckedBlocks=0,maxReduction=0;
  for(let i=0;i<d.length;i++) {
    if(duck[i]>.1) {duckedBlocks++;maxReduction=Math.max(maxReduction,duck[i]);}
    if(i%4096===0) {check();await yieldUI();}
  }
  const duckActivePercent=d.length?duckedBlocks/d.length*100:0,warnings=[];
  if(s.duck_db>0) {
    if(!presentCount) warnings.push('No dialogue detected above the speech threshold; no ducking was generated.');
    else if(!duckedBlocks) warnings.push('Detected dialogue did not produce a duck envelope (check duck amount and timing).');
    else if(duckActivePercent>=95) warnings.push('Music ducking is active for nearly the entire sequence. Check continuous speech, residual noise and the speech threshold.');
  }
  return {duration,baseline_gain_db:0,duck_db:s.duck_db,points,speech_regions:regions.length,
    threshold_dbfs:s.threshold_dbfs,dialogue_active_percent:presentCount/d.length*100,
    duck_active_percent:duckActivePercent,music_ducked_percent:duckActivePercent,max_music_duck_db:maxReduction,
    dialogue_peak_rms_dbfs:db(dialoguePeak),warnings,
    analysis_location:'plugin',method:'relative dialogue duck (0 dB baseline); 200 ms hold, look-ahead attack and linear release; native Amplify keyframes'};
}
module.exports={analyze};
