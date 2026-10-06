// Estimates belong to one phase/run. Cached clips never train processing speed.
function createBatchProgress(clips, {now = () => Date.now(), completed = []} = {}) {
  const weights = clips.map(c => Math.max(0.001, Number(c.exportDuration ?? c.duration) || 0.001));
  const done = new Set(completed), total = weights.reduce((a,b)=>a+b,0);
  const started = now(); let active = null, activeAt = started, fraction = 0, measuredTime = 0, measuredAudio = 0, high = 0;
  function snapshot() {
    const time = now(), finished = [...done].reduce((n,i)=>n+weights[i],0);
    const work = finished + (active === null ? 0 : weights[active]*fraction);
    high = Math.max(high, Math.min(done.size === clips.length ? 100 : 99, work/total*100 || 0));
    let remaining = null;
    if (done.size === clips.length) remaining = 0;
    else if (measuredAudio > 0) {
      remaining = (total-finished)*measuredTime/measuredAudio;
      if (active !== null) remaining -= (time-activeAt)/1000;
      // An overrun is unknown, not a misleading zero-second countdown.
      if (remaining <= 0) remaining = null;
    }
    return {percent:high, completed:done.size, total:clips.length, elapsed:Math.max(0,(time-started)/1000), remaining};
  }
  return {
    start(index) {if (!done.has(index) && active !== index) {active=index;activeAt=now();fraction=0;}return snapshot();},
    progress(percent) {fraction=Math.max(fraction,Math.min(0.95,Math.max(0,Number(percent)||0)/100*0.95));return snapshot();},
    complete(index, reused=false) {
      if (!done.has(index)) {
        if (!reused && active===index) {measuredTime+=Math.max(0.001,(now()-activeAt)/1000);measuredAudio+=weights[index];}
        done.add(index);
      }
      if(active===index){active=null;fraction=0;}return snapshot();
    }, snapshot
  };
}
module.exports={createBatchProgress};
