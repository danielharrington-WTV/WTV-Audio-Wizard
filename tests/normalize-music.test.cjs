const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const preset=require('../plugin/music-broadcast-preset.json');
function setup({fail=false,wrongLayout=false}={}) {
  const tick=()=>({ticks:'0'});
  // Regression tracker for the 2026-09-22 "The script object is no longer
  // valid" fix: on real Premiere 26.5.1, ComponentParam.createKeyframe/
  // createSetValueAction must be called synchronously INSIDE the
  // host.transaction build callback, not built into an actions array ahead
  // of time (see per-clip.js's setClipGains and HANDOFF.md's "Native Apply
  // gain error diagnosed and fixed"). This mock can't reproduce the real
  // host's staleness, so it instead records whether each createKeyframe call
  // happened while a transaction's build callback was actively running.
  let inTransaction=false;
  const keyframeCallSites=[];
  function compressor(defaults=false) {
    const params=preset.params.map(s=>({displayName:s.name,value:defaults && s.name==='Output Gain'?.5:s.value,
      isTimeVarying:async()=>false,getValueAtTime(){return {value:this.value};},
      createKeyframe:value=>{keyframeCallSites.push(inTransaction);return {value};},
      createSetValueAction(k){return ()=>{if(!fail)this.value=k.value;};}}));
    if(wrongLayout)params[1].displayName='Unknown Gain';
    return {params,getMatchName:async()=>preset.match,getParamCount:async()=>params.length,getParam:async i=>params[i]};
  }
  const amp={getMatchName:async()=> 'Amplify'},eq={getMatchName:async()=> 'EQ'};
  function clip(selected,parts) {
    const chain={parts,getComponentCount:async()=>parts.length,getComponentAtIndex:async i=>parts[i],
      createInsertComponentAction:(c,i)=>()=>parts.splice(i,0,c),createRemoveComponentAction:c=>()=>{const i=parts.indexOf(c);assert.ok(i>=0);parts.splice(i,1);}};
    return {chain,item:{getIsSelected:async()=>selected},enabled:true,muted:false,trackIndex:selected?0:1,index:0,sourceId:selected?'music':'other',key:selected?'music':'other'};
  }
  const old=compressor(),a=clip(true,[eq,amp,old]),b=clip(false,[compressor()]);
  const seq={guid:{toString:()=> 'seq'}},project={getActiveSequence:async()=>seq};
  const snapshot=async ch=>JSON.stringify(await Promise.all(ch.parts.map(async c=>[await c.getMatchName(),c.params?.map(p=>p.value) || []])));
  const deps={'premierepro':{Project:{getActiveProject:async()=>project},TickTime:{createWithSeconds:tick},AudioFilterFactory:{getDisplayNames:async()=>['Multiband Compressor'],createComponentByDisplayName:async()=>compressor(true)}},
    './premiere.js':{transaction:(p,label,build)=>{
      const actions=[];inTransaction=true;
      try{build({addAction:a=>actions.push(a)});}finally{inTransaction=false;}
      actions.forEach(a=>a());
    }},
    './per-clip.js':{inventory:async()=>[a,b]},'./music-pass.js':{describe:async e=>({...e})},
    './music-effects.js':{snapshot,isAmplifyComponent:async c=>(await c.getMatchName())==='Amplify'},'./music-broadcast-preset.json':preset};
  const box={module:{exports:{}},require:n=>deps[n]};vm.runInNewContext(fs.readFileSync(require.resolve('../plugin/normalize-music.js'),'utf8'),box);
  return {api:box.module.exports,a,b,amp,eq,old,snapshot,keyframeCallSites};
}
test('Broadcast then Peak control are applied in order, only to selected clips, before existing duck Amplify, and reruns do not stack',async()=>{
  const s=setup(),other=await s.snapshot(s.b.chain);
  const result=await s.api.run();
  assert.equal(result.clips,1);
  // result.stages is an Array constructed inside the sandboxed module's own
  // realm; compare its content, not object/array identity across realms.
  assert.equal(JSON.stringify(result.stages.map(x=>x.preset)),JSON.stringify([s.api.broadcastPreset.name,s.api.peakPreset.name]));
  assert.equal(s.a.chain.parts.length,4);
  assert.equal(s.a.chain.parts[0],s.eq);
  assert.equal(s.a.chain.parts[3],s.amp);
  await s.api.verify(s.a.chain.parts[1],s.api.broadcastPreset);
  await s.api.verify(s.a.chain.parts[2],s.api.peakPreset);
  assert.equal(await s.snapshot(s.b.chain),other);
  // Rerun: two prior WTV compressors are replaced, not stacked into four.
  await s.api.run();
  assert.equal(s.a.chain.parts.length,4);
  assert.equal(s.a.chain.parts[3],s.amp);
});
test('Peak control stage is configured for 3:1 above -30 dB, not the Broadcast values',async()=>{
  const s=setup();
  await s.api.run();
  const peak=s.a.chain.parts[2];
  const byName=name=>peak.params.find(p=>p.displayName===name);
  assert.equal(byName('Threshold 1').value,0.5);
  assert.equal(byName('Threshold 2').value,0.5);
  assert.equal(byName('Threshold 3').value,0.5);
  assert.equal(byName('Threshold 4').value,0.5);
  const ratio3to1=preset.params.find(p=>p.name==='Ratio 1').value;
  assert.equal(byName('Ratio 1').value,ratio3to1);
  assert.equal(byName('Ratio 4').value,ratio3to1);
  assert.equal(byName('Output Gain').value,0.5);
  const broadcast=s.a.chain.parts[1];
  assert.equal(broadcast.params.find(p=>p.displayName==='Output Gain').value,preset.params.find(p=>p.name==='Output Gain').value);
});
test('failed gain readback restores the original compressor and effect order',async()=>{
  const s=setup({fail:true}),before=await s.snapshot(s.a.chain);
  await assert.rejects(s.api.run(),/Failed clip restored/);
  assert.equal(await s.snapshot(s.a.chain),before);
  assert.equal(s.a.chain.parts[2],s.old);
});
test('unknown parameter layout rolls back instead of guessing',async()=>{
  const s=setup({wrongLayout:true}),before=await s.snapshot(s.a.chain);
  await assert.rejects(s.api.run(),/Unexpected compressor parameter/);
  assert.equal(await s.snapshot(s.a.chain),before);
});
test('UI and unused native fields do not block audio preset verification',async()=>{
  const s=setup();await s.api.run();
  const c=s.a.chain.parts[1];
  for(const i of [22,23,24,33,37,45,46,47,50,54,104]) c.params[i].value=.731;
  await s.api.verify(c,s.api.broadcastPreset);
});

test('both stages bypass the limiter, retain compression, and verify bypass on reruns',async()=>{
  const s=setup();
  for(let run=0;run<2;run++) {
    await s.api.run();
    for(const component of s.a.chain.parts.slice(1,3)) {
      assert.equal(component.params.find(p=>p.displayName==='LMAX: Bypass').value,1);
      for(const band of [1,2,3,4]) assert.equal(component.params.find(p=>p.displayName===`Gain ${band}`).value,0.5);
      assert.equal(component.params.find(p=>p.displayName==='Bypass').value,false);
    }
  }
  assert.equal(preset.params.find(p=>p.name==='LMAX: Bypass').value,0,'original native capture stays intact');
  s.a.chain.parts[2].params.find(p=>p.displayName==='LMAX: Bypass').value=0;
  await assert.rejects(s.api.verify(s.a.chain.parts[2],s.api.peakPreset),/LMAX: Bypass/);
});

test('regression: every ComponentParam value action is created inside a transaction (2026-09-22 "script object no longer valid" fix)', async () => {
  const s = setup();
  await s.api.run();
  assert.ok(s.keyframeCallSites.length > 0, 'expected at least one param value to be set');
  assert.ok(s.keyframeCallSites.every(Boolean),
    'every createKeyframe() call must happen inside a host.transaction build callback -- ' +
    'building it ahead of time and committing it later is what threw "The script object is ' +
    'no longer valid" on real Premiere 26.5.1 (see per-clip.js\'s setClipGains fix)');
});

test('music Peak control threshold and ratio are adjustable; defaults keep the captured values (2026-10-15)',async()=>{
  const s=setup();
  const def=s.api.makePeakPreset(), p=name=>def.params.find(x=>x.name===name).value;
  const ratio3=preset.params.find(x=>x.name==='Ratio 1').value;
  for(const band of [1,2,3,4]) { assert.equal(p(`Threshold ${band}`),0.5); assert.equal(p(`Ratio ${band}`),ratio3); }
  assert.equal(JSON.stringify(def),JSON.stringify(s.api.peakPreset));
  const custom=s.api.makePeakPreset({thresholdDb:-24,ratio:4}), c=name=>custom.params.find(x=>x.name===name).value;
  for(const band of [1,2,3,4]) { assert.equal(c(`Threshold ${band}`),0.6); assert.ok(Math.abs(c(`Ratio ${band}`)-3/29)<1e-12); }
  assert.equal(custom.name,'Peak control (4:1 above -24 dB)');
  const result=await s.api.run({peak:{thresholdDb:-24,ratio:4}});
  assert.equal(result.stages[1].preset,'Peak control (4:1 above -24 dB)');
  await s.api.verify(s.a.chain.parts[2],custom);
  for(const bad of [{thresholdDb:1,ratio:3},{thresholdDb:-30,ratio:0.5},{thresholdDb:NaN,ratio:3}]) assert.throws(()=>s.api.makePeakPreset(bad),/Music peak control/);
});
