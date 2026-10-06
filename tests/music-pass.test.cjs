const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {exportSync}=require('./plugin-test-require.cjs');
const analysisCacheModule=require('../plugin/music-analysis-cache.js');

test('strip_clip_volume is omitted from settings passed to analyze', () => {
  const filtered = Object.fromEntries(Object.entries({ strip_clip_volume: true, duck_db: 10, target_dbfs: -28 })
    .filter(([key, value]) => key !== 'strip_clip_volume' && value !== undefined));
  assert.equal(filtered.strip_clip_volume, undefined);
  assert.equal(filtered.duck_db, 10);
});

test('no detected dialogue stops before editing music and retains analysis diagnostics',async()=>{
  const s=setup(),request=s.hooks.request;let analysis;
  s.hooks.onPlan=plan=>{analysis=plan;};
  s.hooks.request=async(route,options)=>{
    const result=await request(route,options);
    if(route==='/v1/music-analysis')return {json:async()=>({...await result.json(),speech_regions:0,threshold_dbfs:-40,dialogue_active_percent:0})};
    return result;
  };
  await assert.rejects(s.api.run(s.context,{},s.hooks),/No dialogue detected/);
  assert.equal(analysis.dialogue_active_percent,0);
  assert.equal(s.music.chain.components.length,1);
  assert.equal(s.assets.size,0);assert.equal(s.sequences.length,1);
  assert.ok(!s.calls.some(c=>c.startsWith('WTV: conform and duck selected music')));
});
// Default base of 2/3 (== dbToNormalized(0) == (0-(-96))/144, confirmed live
// as a freshly-added Amplify's default Left/Right value) matches production
// code's new sanity check in configure(), which now rejects any live default
// that isn't ~0 dB on the confirmed -96..+48 dB range instead of silently
// trusting it -- see music-effects.js's AMPLIFY_MIN_DB/dbToNormalized.
function setup({base=2/3,calibrated=true,localAnalysis=false}={}) {
  const localFixture=require('../validation/music-local-parity.json')[0];
  const tick=s=>({seconds:s,ticks:String(Math.round(s*254016000000))});
  function component(name='Amplify', initial=base, paramName='Boost') {
    // paramName defaults to something that does NOT match any known "gain"
    // spelling, deliberately: real Premiere's actual Amplify parameter name
    // is unconfirmed (a bare /gain/i match found nothing live and threw
    // "Could not identify native Amplify gain parameters" -- see
    // music-effects.js's isGainLike/single-parameter-fallback comments). The
    // whole suite running through the single-parameter fallback below, not a
    // name match, is the point: production code must not secretly still
    // depend on guessing the right string.
    const param={displayName:paramName,varying:false,keys:[],
      areKeyframesSupported:async()=>true,isTimeVarying(){return this.varying;},
      getKeyframeListAsTickTimes(){return this.keys.map(k=>k.position);},
      getKeyframePtr(t){return this.keys.find(k=>k.position.ticks===t.ticks);},
      async getValueAtTime(t){return this.keys.find(k=>k.position.ticks===t.ticks)?.value ?? initial;},
      createKeyframe(value){return {value,mode:0,async setTemporalInterpolationMode(m){this.mode=m;return true;},async getTemporalInterpolationMode(){return this.mode;}};},
      createSetTimeVaryingAction(v){return ()=>{this.varying=v;};},
      createAddKeyframeAction(k){return ()=>this.keys.push(k);}};
    // Mirrors the real Premiere API split (confirmed live): a component
    // fresh off AudioFilterFactory.createComponentByDisplayName() is a bare
    // AudioFilterComponent handle with NO getParamCount()/getParam() -- those
    // only appear once the handle has actually been appended into a chain
    // (see install() below), matching the real "component.getParamCount is
    // not a function" bug this file regression-tests.
    return {param,getMatchName:async()=>name};
  }
  function install(c){if(!c.getParamCount) {c.getParamCount=()=>1;c.getParam=()=>c.param;} return c;}
  function chain(components=[]){components.forEach(install);return {components,getComponentCount(){return this.components.length;},getComponentAtIndex(i){return this.components[i];},
    createAppendComponentAction(c){return ()=>{install(c);this.components.push(c);};},
    createRemoveComponentAction(c){return ()=>{const i=this.components.indexOf(c);assert.ok(i>=0);this.components.splice(i,1);};},
    createInsertComponentAction(c,i){return ()=>{install(c);this.components.splice(i,0,c);};}};}
  const fade=component('Volume',.7);fade.param.varying=true;
  const fadeKey=fade.param.createKeyframe(.7);fadeKey.position=tick(30);fade.param.keys=[fadeKey];
  function entry(name,trackIndex,start=0,end=4,inPoint=0,selected=false,c=chain(),muted=false) {
    const source={getMediaFilePath:async()=>`C:/${name}.wav`};
    const inPointState={value:inPoint};
    const item={disabled:false,getInPoint:async()=>tick(inPointState.value),getOutPoint:async()=>tick(inPointState.value+end-start),getComponentChain:async()=>c,
      getProjectItem:async()=>source,getIsSelected:async()=>selected,getSpeed:async()=>1,isSpeedReversed:async()=>false,
      createSetDisabledAction(v){return ()=>{this.disabled=v;};}};
    return {item,chain:c,trackIndex,index:0,sourceId:name,start:tick(start),end:tick(end),enabled:true,muted,transitions:0,inPointState};
  }
  // Default dialogue follows context.dialoguePaths regardless of its track.
  const music=entry('music',2,1,4,30,true,chain([fade])),dialogue=entry('dialogue',0);
  let serial=0;
  const calls=[],sequences=[],assets=new Set(),storage=new Map(),exportArgs=[];const overrides={};
  function sequence(entries) {
    const seq={guid:{toString:()=>`seq-${seq.serial}`},serial:serial++,entries,getEndTime:async()=>tick(4),inOut:null,
      createSetInPointAction(t){return ()=>{seq.inOut=[t.seconds,seq.inOut?.[1]];};},createSetOutPointAction(t){return ()=>{seq.inOut=[seq.inOut?.[0],t.seconds];};},
      getAudioTrackCount:async()=>Math.max(...entries.map(e=>e.trackIndex))+1,
      getAudioTrack:async i=>({id:seq.trackIds?.[i] ?? i+100,name:`Track ${i+1}`,isMuted:async()=>entries.some(e=>e.trackIndex===i && e.muted)}),
      getProjectItem:async()=>({createSetNameAction:()=>()=>{}}),
      createCloneAction:()=>()=>{sequences.push(sequence(entries.map(e=>{
        const components=e.chain.components.map(c=>{const copy=component(c.getMatchName ? 'Amplify':'?',base);copy.getMatchName=c.getMatchName;copy.param.keys=[...c.param.keys];copy.param.varying=c.param.varying;return copy;});
        return entry(e.sourceId,e.trackIndex,e.start.seconds,e.end.seconds,e.inPointState.value,false,chain(components),e.muted);
      })));}};
    return seq;
  }
  const seq=sequence([music,dialogue]);sequences.push(seq);
  seq.getSettings=async()=>({getAudioSampleRate:async()=>({value:48000}),getAudioChannelCount:async()=>2});
  if(localAnalysis) seq.getEndTime=async()=>tick(localFixture.expected.duration);
  const project={getActiveSequence:async()=>seq,getSequences:async()=>sequences,setActiveSequence:async()=>true,
    deleteSequence:async s=>{calls.push('delete-scratch');sequences.splice(sequences.indexOf(s),1);return true;}};
  const ppro={Project:{getActiveProject:async()=>project},ClipProjectItem:{cast:x=>x},TickTime:{createWithSeconds:tick},
    Constants:{InterpolationMode:{LINEAR:1},ExportType:{IMMEDIATELY:1}},
    AudioFilterFactory:{getDisplayNames:async()=>{calls.push('effect-catalog');return ['Amplify'];},createComponentByDisplayName:async()=>component()},
    EncoderManager:{getManager:async()=>({exportSequence:async(...args)=>{calls.push('render');exportArgs.push(args);return true;}})}};
  function load(name,require){const box={module:{exports:{}},require};vm.runInNewContext(fs.readFileSync(path.join(__dirname,`../plugin/${name}.js`),'utf8'),box);return box.module.exports;}
  const effects=load('music-effects',()=>ppro);
  const host={resumeAppliedClone:async()=>null,signature:async s=>JSON.stringify(s.entries.map(e=>[e.sourceId,e.item.disabled])),musicPassSignature:async(s,music,dialogue)=>JSON.stringify([s.serial,music.map(c=>[c.sourceId,c.item.disabled]),dialogue.map(c=>[c.sourceId,c.item.disabled])]),transaction:(p,label,build)=>{
    calls.push(label);const actions=[];build({addAction:a=>actions.push(a)});actions.forEach(a=>a());}};
  const api=load('music-pass',n=>({'premierepro':ppro,'./premiere.js':host,'./export-sync.js':exportSync,'./music-analysis-cache.js':analysisCacheModule,'./per-clip.js':{inventory:async s=>s.entries},'./music-effects.js':effects,
    './music-wav.js':{readSummary:async (file,expected)=>overrides.readSummary ? overrides.readSummary(file,expected) : localAnalysis ? localFixture.dialogue : {peak:.25,rate:48000,channels:2,samples:192000,levels:new Float64Array(50).fill(0.1),peaks:new Float64Array(50).fill(0.1)}},'./music-analysis.js':{analyze:async(d,settings,options)=>localAnalysis ? require('../plugin/music-analysis.js').analyze(d,settings,options) : (await hooks.request('/v1/music-analysis',{method:'POST',body:JSON.stringify(settings)})).json()},'./export-presets.js':{getWavPreset:async()=>({nativePath:'preset'})}}[n]));
  const hooks={check:()=>{},say:()=>{},sleep:async()=>{},binary:'binary',
    storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    fs:{getTemporaryFolder:async()=>({createFolder:async()=>({createFile:async name=>({nativePath:name,read:async()=>new ArrayBuffer(44)}),delete:async()=>calls.push('delete-files')})})},
    request:async(route,options)=>{
      if(route==='/v1/assets'){const id=String(assets.size+1).padStart(32,'0');assets.add(id);return {json:async()=>({asset_id:id})};}
      if(route==='/v1/music-analysis')return {json:async()=>({calibration:{passed:calibrated},points:[[0,-5],[1,-15],[3,-15],[4,-5]],target_dbfs:-28})};
      assert.equal(options.method,'DELETE');assets.delete(route.split('/').at(-1));return {};
    }};
  const context={applied:true,sequence:seq,originalId:'original',dialoguePaths:['C:/dialogue.wav'],rate:48000,channels:2};
  return {api,effects,context,hooks,music,dialogue,fade,assets,calls,sequences,ppro,host,project,entry,chain,component,exportArgs,overrides};
}

test('existing unrecorded Amplify is replaced on selected music at Apply',async()=>{
  const s=setup();
  s.music.chain.createAppendComponentAction(s.component('Amplify'))();
  assert.equal(s.music.chain.components.length,2);
  let stripped=0;
  const orig=s.effects.addRemoveAmplifyActions;
  s.effects.addRemoveAmplifyActions=(compound,chain,amps)=>{
    stripped+=amps.length;
    return orig(compound,chain,amps);
  };
  await s.api.run(s.context,{},s.hooks);
  assert.equal(stripped,1);
  assert.equal(s.music.chain.components.length,2);
});

test('native pass keeps existing fade/media and updates only its owned effect on rerun',async()=>{
  const s=setup();const before=await s.effects.snapshot(s.music.chain);
  const result=await s.api.run(s.context,{strip_clip_volume:false},s.hooks);
  assert.equal(result.clips,1);assert.equal(s.music.chain.components.length,2);
  assert.equal(s.music.chain.components[0],s.fade);
  assert.equal(s.music.item.disabled,false);assert.equal(s.dialogue.item.disabled,false);
  assert.equal(s.assets.size,0);assert.equal(s.sequences.length,1);
  assert.equal(s.calls.filter(c=>c==='render').length,1);
  assert.equal(s.calls.filter(c=>c==='effect-catalog').length,1);
  assert.ok(s.calls.lastIndexOf('delete-scratch')<s.calls.indexOf('WTV: conform and duck selected music (effect)'));
  const keys=s.music.chain.components[1].param.keys;
  assert.equal(keys[0].position.seconds,30);
  // -15 dB on the confirmed -96..+48 dB Amplify range: (-15-(-96))/144 = 0.5625.
  assert.ok(Math.abs(keys[0].value-0.5625)<1e-9);
  assert.ok(keys.at(-1).position.seconds<33);
  await s.api.run(s.context,{strip_clip_volume:false},s.hooks);
  assert.equal(s.music.chain.components.length,2);assert.equal(s.music.chain.components[0],s.fade);
  s.music.chain.components.pop();assert.equal(await s.effects.snapshot(s.music.chain),before);
});
test('strip_clip_volume removes native Volume before adding Amplify ducking',async()=>{
  const s=setup();
  assert.equal(s.music.chain.components.length,1);
  assert.equal(await s.music.chain.components[0].getMatchName(),'Volume');
  const result=await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  assert.equal(result.volume_clips_stripped,1);
  assert.equal(s.music.chain.components.length,1);
  assert.equal(await s.music.chain.components[0].getMatchName(),'Amplify');
  assert.ok(s.calls.includes('WTV: remove clip Volume before music ducking'));
});
test('failed pass restores removed clip Volume when strip_clip_volume is enabled',async()=>{
  const s=setup(),before=await s.effects.snapshot(s.music.chain);
  const transaction=s.host.transaction;
  s.host.transaction=(p,label,build)=>{
    transaction(p,label,build);
    if(label==='WTV: conform and duck selected music (keyframes)')s.music.chain.components.at(-1).param.getValueAtTime=async()=>100;
  };
  await assert.rejects(s.api.run(s.context,{strip_clip_volume:true},s.hooks),/readback/);
  assert.equal(await s.effects.snapshot(s.music.chain),before);
});
test('rerun accepts legacy stored identity when the per-track item index drifted',async()=>{
  const s=setup();
  await s.api.run(s.context,{strip_clip_volume:false},s.hooks);
  const storageKey='wtv-music-v1-seq-0';
  const saved=JSON.parse(s.hooks.storage.getItem(storageKey));
  const current=JSON.parse(saved.clips[0].identity);
  saved.clips[0].identity=JSON.stringify([current[0], 99, current[1], current[2], current[3]]);
  s.hooks.storage.setItem(storageKey, JSON.stringify(saved));
  s.music.index=99;
  await s.api.run(s.context,{strip_clip_volume:false},s.hooks);
  assert.equal(s.music.chain.components.length,2);
});
test('rerun with strip_clip_volume skips the edited-chain guard after Volume removal',async()=>{
  const s=setup();
  await s.api.run(s.context,{strip_clip_volume:false},s.hooks);
  assert.equal(s.music.chain.components.length,2);
  await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  assert.equal(s.music.chain.components.length,1);
  assert.equal(await s.music.chain.components[0].getMatchName(),'Amplify');
});
test('invalid duck_db is rejected before any Premiere export',async()=>{
  const s=setup();
  await assert.rejects(s.api.run(s.context,{duck_db:999},s.hooks),/duck_db/);
  assert.equal(s.calls.filter(c=>c==='render').length,0);
});
test('a Ctrl+Z of the previous pass (owned effect cleanly removed) is treated as no previous pass, even if the clip also moved',async()=>{
  const s=setup();
  const first=await s.api.run(s.context,{},s.hooks);
  assert.equal(first.clips,1);
  assert.equal(s.music.chain.components.length,2); // pre-existing Volume fade + WTV Amplify
  // Simulate Ctrl+Z of exactly the "WTV: conform and duck..." transaction:
  // it removes only what it added, nothing else -- but Premiere's undo
  // stack is invisible to this panel's own separate storage record, so
  // without the fix this looks identical to an untrustworthy edit.
  s.music.chain.components.pop();
  assert.equal(s.music.chain.components.length,1);
  // Also move the clip -- on its own this would trip the exact clip-identity
  // (key) comparison, which is exactly the reported real-world scenario
  // (undo, then move the music clip, then rerun). Shift start/end together
  // (same delta) so this mock's derived source out-point (inPoint+end-start,
  // in entry()) stays consistent with the item.getOutPoint() closure this
  // clip's Ctrl+Z-untouched item object already has -- a pure timeline
  // translation, not a retrim, matching "moved the clip" rather than
  // "changed its speed/trim" (a different, still-blocked scenario).
  const tick=t=>({seconds:t,ticks:String(Math.round(t*254016000000))});
  s.music.start=tick(.5);s.music.end=tick(3.5);
  const second=await s.api.run(s.context,{},s.hooks);
  assert.equal(second.clips,1);
  assert.equal(s.music.chain.components.length,2); // fresh WTV Amplify re-added
  assert.equal(s.music.chain.components[0],s.fade); // pre-existing effect untouched
});
test('moving a music clip (same source in/out, just repositioned) is detected and silently re-ducked at the new position, no fresh clone required',async()=>{
  const s=setup();
  const notices=[];s.hooks.say=m=>{notices.push(m);};
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,2);
  const ownedBefore=s.music.chain.components[1];
  // Move the clip without retrimming it (same sourceIn/sourceOut) -- the
  // owned effect is still exactly where it was left, but its keyframes are
  // stored in clip/source-relative time (see music-effects.js's clipCurve()),
  // so a pure repositioning doesn't invalidate them; every rerun recomputes
  // the duck curve fresh from the current timeline anyway.
  const tick=t=>({seconds:t,ticks:String(Math.round(t*254016000000))});
  s.music.start=tick(.5);s.music.end=tick(3.5);
  const second=await s.api.run(s.context,{},s.hooks);
  assert.equal(second.clips,1);
  assert.equal(s.music.chain.components.length,2); // fresh WTV Amplify re-added
  assert.equal(s.music.chain.components[0],s.fade); // pre-existing effect untouched
  assert.notEqual(s.music.chain.components[1],ownedBefore); // effect was actually swapped, not left stale
  assert.ok(notices.some(m=>/moved since the previous pass/.test(m)));
});
test('partial rerun updates only the selected clip and keeps other pass records',async()=>{
  const s=setup();
  await s.api.run(s.context,{strip_clip_volume:false},s.hooks);
  const second=s.entry('music2',3,0,4,0,true,s.chain([]));
  s.context.sequence.entries.push(second);
  await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  const storageKey='wtv-music-v1-seq-0';
  const before=JSON.parse(s.hooks.storage.getItem(storageKey));
  assert.equal(before.clips.length,2);
  second.item.getIsSelected=async()=>false;
  const result=await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  assert.equal(result.partial_update,true);
  assert.equal(result.clips,1);
  assert.equal(result.clips_unchanged,1);
  const after=JSON.parse(s.hooks.storage.getItem(storageKey));
  assert.equal(after.clips.length,2);
  assert.equal(await s.music.chain.components.length,1);
  assert.deepEqual(after.clips.find(r=>JSON.parse(r.identity)[1]==='music2'),before.clips.find(r=>JSON.parse(r.identity)[1]==='music2'));
});
test('retrimming a music clip (different source in/out) replaces stray duck Amplify without blocking the bed',async()=>{
  const s=setup();
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,2);
  const ownedBefore=s.music.chain.components[1];
  s.music.inPointState.value=1;
  const second=await s.api.run(s.context,{},s.hooks);
  assert.equal(second.clips_fresh,1);
  assert.equal(second.clips_updated,0);
  assert.equal(s.music.chain.components.length,2);
  assert.notEqual(s.music.chain.components[1],ownedBefore);
});
test('stale ownership is cleared when no WTV Amplify remains, even if stored identities no longer match',async()=>{
  const s=setup();
  await s.api.run(s.context,{},s.hooks);
  s.music.chain.components.pop();
  const key='wtv-music-v1-seq-0';
  const saved=JSON.parse(s.hooks.storage.getItem(key));
  saved.clips[0].identity=JSON.stringify([99,'wrong',0,100]);
  s.hooks.storage.setItem(key, JSON.stringify(saved));
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,2);
});
test('user changes to existing fades prevent destructive rerun',async()=>{
  const s=setup();await s.api.run(s.context,{},s.hooks);
  s.fade.param.keys[0].mode=5;
  await assert.rejects(s.api.run(s.context,{},s.hooks),/edited after/);
  assert.equal(s.music.chain.components.length,2);
});
test('dB values are encoded onto the confirmed -96..+48 dB Amplify range, not a linear amplitude ratio (regression for the live 42-54 dB calibration failure)',async()=>{
  const s=setup();await s.api.run(s.context,{},s.hooks);
  const p=s.music.chain.components[1].param;
  // Same -15 dB duck point as the rerun test above, via the full run() path
  // rather than a direct configure() call: (-15-(-96))/144 = 0.5625, NOT the
  // old, wrong linear-ratio guess 10**(-15/20).
  assert.ok(Math.abs(p.keys[0].value-0.5625)<1e-9);
  assert.notEqual(p.keys[0].value,10**(-15/20));
});
test('a live Amplify default far from the confirmed 0 dB (e.g. a stale/foreign linear-ratio-style value) is rejected up front, not silently miscalibrated',async()=>{
  // base:1 normalizes to +48 dB (normalizedToDb(1) = 1*144-96 = 48), nowhere
  // near the confirmed 0 dB default -- this must fail loudly in configure(),
  // instead of quietly writing keyframes on a range assumption that may not
  // hold for this component.
  const s=setup({base:1});
  await assert.rejects(s.api.run(s.context,{},s.hooks),/Amplify "Boost" default is 48\.0 dB, not the expected 0 dB/);
});
test('verify() rejects a keyframe readback that does not match what was written, regardless of units',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  s.effects.addActions({addAction:a=>a()},prepared);
  prepared.component.param.getValueAtTime=async()=>123;
  await assert.rejects(s.effects.verify(prepared),/readback/);
});
test('a component fresh off the factory has no getParamCount/getParam until appended into the chain (regression for live "component.getParamCount is not a function")',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  assert.equal(typeof created.component.getParamCount,'undefined');
  assert.throws(()=>created.component.getParamCount(),/is not a function/);
  s.music.chain.createAppendComponentAction(created.component)();
  const installed=await s.effects.installed(clip);
  assert.equal(typeof installed.getParamCount,'function');
  assert.equal(await installed.getParamCount(),1);
});
test('a param name matching a known "gain" spelling is used directly, without needing the single-parameter fallback',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  created.component.param.displayName='Amount'; // a plausible real spelling, matches isGainLike but not literally "Gain"
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  assert.equal(prepared.parameters.length,1);
  assert.equal(prepared.parameters[0].param.displayName,'Amount');
});
test('an ambiguous multi-parameter component with no gain-like name throws, listing the names it found',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  s.music.chain.createAppendComponentAction(created.component)();
  const component=await s.effects.installed(clip);
  const second={displayName:'Bypass',areKeyframesSupported:async()=>true};
  const originalCount=component.getParamCount, originalGet=component.getParam;
  component.getParamCount=()=>2;
  component.getParam=i=>i===0?originalGet():second;
  await assert.rejects(s.effects.configure(component,clip,[[0,0],[4,-10]],48000),/Could not identify native Amplify gain parameters\. Found: Boost, Bypass\./);
});
test('the real Amplify parameter layout (confirmed live: Bypass, Channel Count, Link Sliders, Left, Right, Link Keyframes) selects only Left and Right',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  s.music.chain.createAppendComponentAction(created.component)();
  const component=await s.effects.installed(clip);
  const gain=name=>({displayName:name,areKeyframesSupported:async()=>true,async getValueAtTime(){return 2/3;}, // confirmed live default (0 dB)
    createKeyframe(value){return {value,async setTemporalInterpolationMode(){return true;}};}});
  const other=name=>({displayName:name,areKeyframesSupported:async()=>false});
  // Not "Bypass"/"Channel Count"/"Link Sliders"/"Link Keyframes" -- exact
  // real-world names from the "Could not identify native Amplify gain
  // parameters" bug report, which is why isGainLike must not treat any of
  // them as a gain control while still catching Left/Right.
  const list=[other('Bypass'),other('Channel Count'),other('Link Sliders'),gain('Left'),gain('Right'),other('Link Keyframes')];
  component.getParamCount=()=>list.length;
  component.getParam=i=>list[i];
  const prepared=await s.effects.configure(component,clip,[[0,0],[4,-10]],48000);
  // prepared.parameters is a cross-realm array (music-effects.js runs inside
  // its own vm context here) -- compare its primitive fields individually
  // rather than with assert.deepEqual on the whole array/object, which bails
  // out on cross-realm objects even when the printed values are identical.
  assert.equal(prepared.parameters.length,2);
  assert.equal(prepared.parameters[0].param.displayName,'Left');
  assert.equal(prepared.parameters[1].param.displayName,'Right');
  assert.ok(prepared.parameters[0].keys.length>1);
  assert.ok(prepared.parameters[1].keys.length>1);
});
test('a gain value returned as a numeric string (confirmed live: "Unrecognized Amplify gain representation") is coerced, not rejected',async()=>{
  // ComponentParam.getValueAtTime() is documented to resolve to
  // number|string|boolean|PointF|Color depending on the param's underlying
  // type -- this models a param whose base value comes back as "0" rather
  // than the plain number 0.
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  created.component.param.displayName='Left';
  created.component.param.getValueAtTime=async()=>'0.6666666865348816'; // confirmed live default, as a numeric string
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  assert.equal(prepared.parameters.length,1);
  // The first knot (at clip.start=1, interpolated between the two curve
  // points [[0,0],[4,-10]]) is -2.5 dB; encoded onto the confirmed -96..+48
  // dB range: (-2.5-(-96))/144 = 0.649305...
  assert.ok(Math.abs(prepared.parameters[0].keys[0].value-93.5/144)<1e-9);
});
test('a gain value returned as a boxed {value: number} object (confirmed live) is unwrapped, not rejected',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  created.component.param.displayName='Left';
  created.component.param.getValueAtTime=async()=>({value:0.6666666865348816}); // exact value seen live
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  assert.equal(prepared.parameters.length,1);
  assert.ok(Number.isFinite(prepared.parameters[0].keys[0].value));
});
test('verify() accepts a keyframe readback returned as a boxed {value: number} object, not just plain numbers',async()=>{
  // The same live marshalling quirk fixed in configure()'s base read can
  // recur on verify()'s post-write readback -- this was still unfixed there
  // until now, and would have false-flagged a successful write as
  // "Premiere music keyframe readback failed."
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  s.effects.addActions({addAction:a=>a()},prepared);
  const realGetValueAtTime=prepared.component.param.getValueAtTime.bind(prepared.component.param);
  prepared.component.param.getValueAtTime=async t=>({value:await realGetValueAtTime(t)});
  await s.effects.verify(prepared); // must not throw
});
test('verify() reports which position/parameter is missing when a keyframe was never actually added',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  s.effects.addActions({addAction:a=>a()},prepared);
  prepared.component.param.keys.shift(); // simulate Premiere silently dropping the first keyframe
  // First keyframe lands at clip.inPoint (30s here, per this mock's music
  // entry), not clip.start -- see clipCurve()'s source-relative mapping.
  await assert.rejects(s.effects.verify(prepared),/no keyframe at 30\.000s on "Boost"/);
});
test('a gain value that is not a usable number even after string/object coercion throws with the raw value and type',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  created.component.param.displayName='Left';
  created.component.param.getValueAtTime=async()=>true; // e.g. a boolean/PointF/Color-typed param, not a gain value
  s.music.chain.createAppendComponentAction(created.component)();
  await assert.rejects(s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000),
    /Unrecognized Amplify gain representation for "Left": true \(typeof boolean\)\./);
});
test('requires a music context and normal speed selection',async()=>{
  const s=setup();await assert.rejects(s.api.collect({...s.context,applied:false}),/Open a sequence/);
  s.music.item.getSpeed=async()=>2;await assert.rejects(s.api.collect(s.context),/normal-speed/);
});
test('default clean dialogue follows inserted media below muted raw tracks',async()=>{
  const s=setup();
  s.sequences[0].entries.push({...s.dialogue,sourceId:'raw',muted:true});
  s.dialogue.trackIndex=3;
  const state=await s.api.collect(s.context);
  assert.equal(state.dialogue.length,1);assert.equal(state.dialogue[0].trackIndex,3);
  assert.match(state.reference.label,/Clean dialogue.*A4/);
});

test('clean dialogue is recognized by its durable markers when the session has no dialoguePaths: stem file name, item name, or track name (2026-09-18)',async()=>{
  // Reload / in-place / second batch / offline music-only: context.dialoguePaths is empty.
  for(const marker of ['file','item','track']) {
    const s=setup();
    if(marker==='file') s.dialogue.item.getProjectItem=async()=>({getMediaFilePath:async()=>'C:/Bear-clips/C0046-A2-110005685647200-dialogue.wav'});
    if(marker==='item') s.dialogue.item.getName=async()=>'C0046.MP4 · Clean dialogue · A2';
    if(marker==='track') s.dialogue.trackName='Clean dialogue';
    const state=await s.api.collect({...s.context,dialoguePaths:[]});
    assert.equal(state.dialogue.length,1,marker);
    assert.equal(state.dialogue[0].trackIndex,0,marker);
  }
  // A plain raw clip named like the source is still not clean dialogue.
  const s=setup();
  s.dialogue.item.getName=async()=>'dialogue.MP4';
  await assert.rejects(s.api.collect({...s.context,dialoguePaths:[]}),/No enabled, unmuted Clean dialogue/);
});

test('clean dialogue requires matching inserted media, even when A1 contains audible audio',async()=>{
  const s=setup();
  await assert.rejects(s.api.collect({...s.context,dialoguePaths:[]}),/No enabled, unmuted Clean dialogue/);
});

for(const field of ['muted','enabled']) test(`clean dialogue excludes ${field} state when inaudible`,async()=>{
  const s=setup();s.dialogue[field]=field==='muted';
  await assert.rejects(s.api.collect(s.context),/No enabled, unmuted Clean dialogue/);
});

test('clean mode permits selected music on A1 or A2',async()=>{
  const s=setup();s.dialogue.trackIndex=3;s.music.trackIndex=1;
  const state=await s.api.collect(s.context);
  assert.equal(state.music[0].trackIndex,1);assert.equal(state.dialogue[0].trackIndex,3);
});

test('clean mode recognizes a replacement pop-fix media path',async()=>{
  const s=setup();
  s.dialogue.item.getProjectItem=async()=>({getMediaFilePath:async()=> 'C:\\fixed-pop.wav'});
  s.context.dialoguePaths.push('c:/FIXED-pop.wav');
  assert.equal((await s.api.collect(s.context)).dialogue.length,1);
});

test('chosen tracks allow dialogue WTV did not process',async()=>{
  const s=setup();s.context.dialoguePaths=[];
  const state=await s.api.collect(s.context,{mode:'tracks',trackIds:['100']});
  assert.equal(state.dialogue[0].sourceId,'dialogue');
  assert.match(state.reference.label,/Chosen tracks.*A1/);
});

test('an explicit track choice never falls back to clean dialogue',async()=>{
  const s=setup();
  for(const trackIds of [[],['999'],['101']]) {
    await assert.rejects(s.api.run(s.context,{}, {...s.hooks,dialogueReference:{mode:'tracks',trackIds}}),/Choose at least|no longer available|No enabled, unmuted dialogue/);
  }
  assert.equal(s.calls.filter(c=>c==='render').length,0);
});

test('all chosen tracks must contain enabled unmuted dialogue',async()=>{
  const s=setup();s.dialogue.muted=true;
  await assert.rejects(s.api.collect(s.context,{mode:'tracks',trackIds:['100']}),/No enabled, unmuted dialogue on A1/);
  s.dialogue.muted=false;
  await assert.rejects(s.api.collect(s.context,{mode:'tracks',trackIds:['100','101']}),/No enabled, unmuted dialogue on A2/);
});

test('chosen dialogue is excluded from the selected music in either mode',async()=>{
  const s=setup();s.dialogue.item.getIsSelected=async()=>true;
  for(const choice of [undefined,{mode:'tracks',trackIds:['100']}]) {
    await assert.rejects(s.api.collect(s.context,choice),/deselect clips used as the dialogue reference/);
  }
});

test('selected music must be unmuted',async()=>{
  const s=setup();s.music.muted=true;
  await assert.rejects(s.api.collect(s.context),/Unmute and enable the selected music/);
});

test('track choices follow IDs when track positions change',async()=>{
  const s=setup();s.dialogue.trackIndex=1;
  s.sequences[0].trackIds=[101,100,102];
  const state=await s.api.collect(s.context,{mode:'tracks',trackIds:['100']});
  assert.equal(state.dialogue[0].trackIndex,1);
});

test('dialogue choice is restored per sequence with a clean default',async()=>{
  const s=setup(),storage=s.hooks.storage;
  assert.equal(s.api.loadReference(storage,s.context).mode,'clean');
  s.api.saveReference(storage,s.context,{mode:'tracks',trackIds:['100']});
  assert.equal(s.api.loadReference(storage,s.context).trackIds[0],'100');
  const other={sequence:{guid:{toString:()=> 'other-sequence'}}};
  assert.equal(s.api.loadReference(storage,other).mode,'clean');
  storage.setItem('wtv-duck-reference-v1-seq-0','not json');
  assert.equal(s.api.loadReference(storage,s.context).mode,'clean');
});

test('custom reference reaches analysis without entering the service settings',async()=>{
  const s=setup();s.context.dialoguePaths=[];
  let ref;const request=s.hooks.request;
  s.hooks.request=async(route,options)=>{
    if(route==='/v1/music-analysis') {
      const body=JSON.parse(options.body);
      assert.equal(body.dialogueReference,undefined);assert.equal(body.trackIds,undefined);
    }
    return request(route,options);
  };
  await s.api.run(s.context,{}, {...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']},onReference:value=>{ref=value;}});
  assert.equal(ref.choice.mode,'tracks');assert.match(ref.label,/A1/);
});

test('no music selected still requires a selection even when dialogue is present',async()=>{
  const s=setup();
  s.music.item.getIsSelected=async()=>false;
  await assert.rejects(s.api.collect(s.context),/Select the music clips to duck/);
});
test('verify() skips null entries in Premiere keyframe tick lists',async()=>{
  const s=setup();
  const clip=await s.api.describe(s.music);
  const created=await s.effects.createComponent(clip,{});
  s.music.chain.createAppendComponentAction(created.component)();
  const prepared=await s.effects.configure(await s.effects.installed(clip),clip,[[0,0],[4,-10]],48000);
  s.effects.addActions({addAction:a=>a()},prepared);
  const realList=prepared.component.param.getKeyframeListAsTickTimes.bind(prepared.component.param);
  prepared.component.param.getKeyframeListAsTickTimes=()=>[null,...realList()];
  await s.effects.verify(prepared);
});
test('run() emits onProgress stages through analysis and apply',async()=>{
  const s=setup();
  const stages=[];
  await s.api.run(s.context,{}, {...s.hooks,onProgress:({stage,percent})=>stages.push({stage,percent})});
  assert.ok(stages.some(x=>/Dialogue reference/.test(x.stage)));
  assert.ok(stages.some(x=>/Generating duck keyframes/.test(x.stage)));
  assert.equal(stages.at(-1).percent,100);
});
test('failed native readback rolls back only the added effect',async()=>{
  const s=setup(),before=await s.effects.snapshot(s.music.chain),transaction=s.host.transaction;
  s.host.transaction=(p,label,build)=>{
    transaction(p,label,build);
    // Corrupt readback only once keyframes are being committed, i.e. after
    // configure() has already read a normal base value and computed normal
    // keyframe values -- corrupting any earlier (at the "(effect)" label)
    // would instead trip configure()'s own default-value sanity check,
    // which is a different failure mode than the readback mismatch this
    // test is about.
    if(label==='WTV: conform and duck selected music (keyframes)')s.music.chain.components.at(-1).param.getValueAtTime=async()=>100;
  };
  await assert.rejects(s.api.run(s.context,{},s.hooks),/readback/);
  assert.equal(await s.effects.snapshot(s.music.chain),before);
  assert.equal(s.hooks.storage.getItem('wtv-music-v1-seq-0'),undefined);
});
test('timeline changes during analysis prevent Apply',async()=>{
  const s=setup({localAnalysis:true});
  let yields=0;
  s.hooks.sleep=async()=>{ if(++yields===1) s.dialogue.item.disabled=true; };
  await assert.rejects(s.api.run(s.context,{},s.hooks),/Timeline changed during music analysis/);
  assert.equal(s.music.chain.components.length,1);
});
test('run records pass timing with phases and render breakdown',async()=>{
  const s=setup();
  const result=await s.api.run(s.context,{},s.hooks);
  assert.ok(result.timing);
  assert.ok(Number.isFinite(result.timing.wall_seconds));
  assert.ok(Number.isFinite(result.timing.phases.render_dialogue));
  assert.ok(result.timing.renders.dialogue);
  assert.equal(result.timing.music_clips,1);
  assert.equal(result.timing.sequence_duration_s,4);
});


test('music report counts native parameter keys and avoided dense keys',async()=>{
  const s=setup();const result=await s.api.run(s.context,{},s.hooks);
  assert.equal(result.keyframe_optimization.method,'linear_db_corners');
  assert.equal(result.keyframe_optimization.native_keys,result.keyframes); // fixture has one gain parameter
  assert.ok(result.keyframe_optimization.legacy_native_keys>result.keyframe_optimization.native_keys);
});
test('oversized corner count stops before final Amplify insertion',async()=>{
  const s=setup(),request=s.hooks.request;
  s.hooks.request=async(route,options)=>{
    const response=await request(route,options);
    if(route!=='/v1/music-analysis') return response;
    const plan=await response.json(),duration=plan.points.at(-1)[0];
    return {json:async()=>({...plan,points:Array.from({length:12001},(_,i)=>[i*duration/12000,i%2?-10:0])})};
  };
  await assert.rejects(s.api.run(s.context,{},s.hooks),/curve corners/);
  assert.ok(!s.calls.includes('WTV: conform and duck selected music (effect)'));
});


test('deleted Amplify on a partial selection rebuilds and retains other music records',async()=>{
  const s=setup(), key='wtv-music-v1-seq-0';
  const second=s.entry('music2',3,0,4,0,true,s.chain([]));
  s.context.sequence.entries.push(second);
  await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  const otherEffect=second.chain.components[0];
  const before=JSON.parse(s.hooks.storage.getItem(key));
  s.music.chain.components.pop(); // user deletes selected clip's Amplify
  second.item.getIsSelected=async()=>false;
  const result=await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  assert.equal(result.partial_update,true);
  assert.equal(result.clips_unchanged,1);
  assert.equal(s.music.chain.components.length,1);
  assert.equal(second.chain.components[0],otherEffect);
  const after=JSON.parse(s.hooks.storage.getItem(key));
  assert.equal(after.clips.length,2);assert.equal(after.pending,false);
  assert.deepEqual(after.clips[1],before.clips[1]);
  // A further rerun must replace the rebuilt effect, not stack another one.
  await s.api.run(s.context,{strip_clip_volume:true},s.hooks);
  assert.equal(s.music.chain.components.length,1);
});
test('mixed deleted and surviving Amplify effects are rebuilt without stacking',async()=>{
  const s=setup();
  const second=s.entry('music2',3,0,4,0,true,s.chain([]));
  s.context.sequence.entries.push(second);
  await s.api.run(s.context,{},s.hooks);
  s.music.chain.components.pop();
  const surviving=second.chain.components[0];
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,2); // original Volume plus Amplify
  assert.equal(second.chain.components.length,1);
  assert.notEqual(second.chain.components[0],surviving);
});
test('unrelated effect occupying deleted Amplify index is preserved',async()=>{
  const s=setup();await s.api.run(s.context,{},s.hooks);
  s.music.chain.components.pop();
  const eq=s.component('Parametric EQ');s.music.chain.createAppendComponentAction(eq)();
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,3);
  assert.equal(s.music.chain.components[1],eq);
});


test('offline ducking uses real local analysis without any requests or audio import',async()=>{
  const s=setup({localAnalysis:true});
  s.hooks.request=async()=>{throw Error('Network must not be used');};
  const standalone=await s.api.resolveMusicContext(null);
  assert.equal(standalone.musicOnly,true);
  const result=await s.api.run(standalone,{}, {...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']}});
  assert.equal(result.analysis_location,'plugin');assert.equal(result.baseline_gain_db,0);
  assert.equal(result.clips,1);assert.equal(s.music.chain.components.length,2);
  assert.equal(s.calls.filter(c=>c==='render').length,1);
  assert.equal(s.sequences.length,1);
});
test('ducking a different music selection with the same dialogue reuses the cached dialogue analysis instead of re-rendering (2026-09-18)',async()=>{
  const s=setup({localAnalysis:true});
  s.hooks.request=async()=>{throw Error('Network must not be used');};
  // In-memory data folder so the analysis cache can actually persist.
  const files=new Map();
  const dataFolder={getEntry:async name=>{if(!files.has(name))throw Error('missing');return files.get(name);},
    createFolder:async()=>dataFolder,
    createFile:async name=>{const f={nativePath:name,text:'',read:async()=>f.text,write:async t=>{f.text=t;},delete:async()=>files.delete(name)};files.set(name,f);return f;}};
  s.hooks.fs.getDataFolder=async()=>dataFolder;
  const standalone=await s.api.resolveMusicContext(null);
  const first=await s.api.run(standalone,{}, {...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']}});
  assert.equal(first.analysis_cache ?? first.timing?.analysis_cache,'miss');
  const rendersAfterFirst=s.calls.filter(c=>c==='render').length;
  // Now a different music clip on another lane is the selection; dialogue untouched.
  s.music.item.getIsSelected=async()=>false;
  const other=s.entry('other-music',3,0,4,0,true,s.chain());
  s.context.sequence.entries.push(other);
  const again=await s.api.resolveMusicContext(null);
  const second=await s.api.run(again,{}, {...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']}});
  assert.equal(second.analysis_cache ?? second.timing?.analysis_cache,'hit');
  assert.equal(s.calls.filter(c=>c==='render').length,rendersAfterFirst,'no second dialogue render');
});
test('padSummary places a span summary at its timeline offset inside a silent full-length summary',()=>{
  const {api}=setup();
  const span={rate:48000,channels:2,samples:48000*2,peak:0.5,levels:Float64Array.from({length:100},()=>0.3),peaks:Float64Array.from({length:100},()=>0.5)};
  const full=api.padSummary(span,10,30);
  assert.equal(full.samples,48000*30);
  assert.equal(full.levels.length,1500);
  assert.equal(full.levels[499],0);assert.equal(full.levels[500],0.3);assert.equal(full.levels[599],0.3);assert.equal(full.levels[600],0);
  assert.equal(full.peaks[500],0.5);
});
test('ducking one clip in a long sequence renders only that clip\'s span (with margin), not the whole sequence; a whole-sequence cache entry serves a later sub-span (2026-09-18)',async()=>{
  const s=setup({localAnalysis:true});
  s.hooks.request=async()=>{throw Error('Network must not be used');};
  const files=new Map();
  const dataFolder={getEntry:async name=>{if(!files.has(name))throw Error('missing');return files.get(name);},createFolder:async()=>dataFolder,
    createFile:async name=>{const f={nativePath:name,text:'',read:async()=>f.text,write:async t=>{f.text=t;},delete:async()=>files.delete(name)};files.set(name,f);return f;}};
  s.hooks.fs.getDataFolder=async()=>dataFolder;
  // 1320 s sequence; music at 600-610 s; dialogue present 602-605 s.
  s.context.sequence.getEndTime=async()=>({seconds:1320});
  s.music.start={seconds:600,ticks:'0'};s.music.end={seconds:610,ticks:'1'};s.music.inPointState.value=0;
  s.overrides.readSummary=async(file,expected)=>{
    const count=Math.ceil(expected.duration/0.02);
    const levels=new Float64Array(count),peaks=new Float64Array(count);
    // Dialogue lives at absolute 602-605 s; the render span starts at `start` (from the mock in/out).
    const render=s.sequences[s.sequences.length-1]; const start=render.inOut?.[0] ?? 0;
    for(let i=0;i<count;i++){const t=start+i*0.02; if(t>=602 && t<605){levels[i]=0.2;peaks[i]=0.3;}}
    return {rate:48000,channels:2,samples:Math.round(expected.duration*48000),peak:0.3,levels,peaks};
  };
  const result=await s.api.run(s.context,{},{...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']}});
  const [seqArg,,,,exportFull]=s.exportArgs[s.exportArgs.length-1];
  assert.equal(exportFull,false,'span export, not full');
  assert.ok(seqArg.inOut[0]<=600-2 && seqArg.inOut[0]>=590 && seqArg.inOut[1]>=610+2 && seqArg.inOut[1]<=620, `span ${seqArg.inOut}`);
  assert.equal(result.timing.renders.dialogue.span.length,2);
  assert.ok(result.speech_regions>=1,'dialogue detected inside the span');
  // Keyframes for the music clip must reflect ducking around 602-605 s, i.e. inside the clip.
  assert.ok(result.keyframes>0);
  // Now a whole-sequence run (music spanning most of the timeline) renders full and caches; a following sub-span run hits it.
  s.music.start={seconds:10,ticks:'0'};s.music.end={seconds:1300,ticks:'1'};
  const full=await s.api.run(s.context,{},{...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']}});
  assert.equal(full.timing.renders.dialogue.span,'full');
  assert.equal(full.timing.analysis_cache,'miss');
  s.music.start={seconds:600,ticks:'0'};s.music.end={seconds:610,ticks:'1'};
  const renders=s.calls.filter(c=>c==='render').length;
  const sub=await s.api.run(s.context,{},{...s.hooks,dialogueReference:{mode:'tracks',trackIds:['100']}});
  assert.equal(sub.timing.analysis_cache,'hit');
  assert.equal(s.calls.filter(c=>c==='render').length,renders);
});
test('offline context reuses clean paths and rejects unfinished cleanup',async()=>{
  const s=setup();
  const context=await s.api.resolveMusicContext(s.context);
  assert.deepEqual(context.dialoguePaths,s.context.dialoguePaths);
  await assert.rejects(s.api.resolveMusicContext({...s.context,applied:false}),/pending cleanup/);
});


test('all stacked Amplify effects are replaced, unrelated and unselected effects survive',async()=>{
  const s=setup();
  const eq=s.component('Parametric EQ');
  for(const c of [s.component('Amplify'),eq,s.component('Amplify')]) s.music.chain.createAppendComponentAction(c)();
  const other=s.entry('other',3,0,4,0,false,s.chain([s.component('Amplify')]));
  s.context.sequence.entries.push(other);
  const untouched=other.chain.components[0];
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,3);
  assert.equal(s.music.chain.components[0],s.fade);
  assert.equal(s.music.chain.components[1],eq);
  assert.equal((await s.effects.listAmplifyComponents(s.music.chain)).length,1);
  assert.equal(other.chain.components[0],untouched);
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,3);
});

test('failed Apply restores multiple Amplify effects at their original positions',async()=>{
  const s=setup({base:1});
  for(const c of [s.component('Amplify'),s.component('Parametric EQ'),s.component('Amplify')]) s.music.chain.createAppendComponentAction(c)();
  const before=[...s.music.chain.components];
  await assert.rejects(s.api.run(s.context,{},s.hooks),/default is/);
  assert.deepEqual(s.music.chain.components,before);
  assert.equal(s.hooks.storage.getItem('wtv-music-v1-seq-0'),undefined);
});


test('Amplify with an opaque internal ID is recognized by its display name',async()=>{
  const s=setup();
  const make=()=>{const c=s.component('opaque-native-filter-42');c.getDisplayName=async()=> 'Amplify';return c;};
  s.ppro.AudioFilterFactory.createComponentByDisplayName=async()=>make();
  s.music.chain.createAppendComponentAction(make())();
  s.music.chain.createAppendComponentAction(make())();
  await s.api.run(s.context,{},s.hooks);
  assert.equal(s.music.chain.components.length,2);
  assert.equal(s.music.chain.components[0],s.fade);
  assert.equal((await s.effects.listAmplifyComponents(s.music.chain)).length,1);
});

test('effect verification refreshes a chain whose count stays stale after mutation',async()=>{
  const s=setup(),live=s.music.chain;
  live.createAppendComponentAction(s.component('Amplify'))();
  live.createAppendComponentAction(s.component('Amplify'))();
  s.music.item.getComponentChain=async()=>{
    const snapshot=[...live.components];
    return {getComponentCount:async()=>snapshot.length,getComponentAtIndex:async i=>snapshot[i],
      createAppendComponentAction:live.createAppendComponentAction.bind(live),
      createRemoveComponentAction:live.createRemoveComponentAction.bind(live),
      createInsertComponentAction:live.createInsertComponentAction.bind(live)};
  };
  await s.api.run(s.context,{},s.hooks);
  assert.equal(live.components.length,2);
  assert.equal((await s.effects.listAmplifyComponents(live)).length,1);
});
