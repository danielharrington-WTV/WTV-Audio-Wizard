const test = require('node:test');
const assert = require('node:assert/strict');
const {processBatch, validateOutputs, clickPopEvents} = require('../plugin/clip-batch.js');
const {inspectWav, waitForStableWav} = require('../plugin/wav.js');

function wav(samples = 48000, rate = 48000, channels = 2) {
  const b = new ArrayBuffer(44 + samples * channels * 2), v = new DataView(b);
  const tag = (offset, text) => [...text].forEach((c,i) => v.setUint8(offset+i,c.charCodeAt(0)));
  tag(0,'RIFF'); v.setUint32(4,b.byteLength-8,true); tag(8,'WAVE'); tag(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,channels,true);
  v.setUint32(24,rate,true); v.setUint32(28,rate*channels*2,true); v.setUint16(32,channels*2,true); v.setUint16(34,16,true);
  tag(36,'data'); v.setUint32(40,b.byteLength-44,true); return b;
}
function setup() {
  const files = new Map(), requests = [];
  const context = {name:'Test', originalId:'original', rate:48000, channels:2,
    folder:{createFile:async name => {
      const file = {nativePath:`C:/batch/${name}`, write:async value => {file.bytes=value;}, read:async()=>file.bytes};
      files.set(name,file); return file;
    }},
    clips:[1,2].map(i => ({id:`clip-${i}`, name:`Clip ${i}`, duration:1, trackIndex:i-1,
      start:{ticks:String(i*100)}, end:{ticks:String(i*100+100)},
      inputFile:{nativePath:`C:/batch/input-${i}.wav`, read:async()=>wav()}}))};
  let submitted = 0;
  const hooks = {binary:'binary',check:()=>{},onJob:()=>{},say:()=>{},sleep:async()=>{},
    request:async (route, options={}) => {
      requests.push([route,options.method]);
      if (route === '/v1/assets') return {json:async()=>({asset_id:'a'.repeat(32),samples:48000,sample_rate:48000,channels:2})};
      if (route === '/v1/jobs') return {json:async()=>({job_id:String(++submitted).padStart(32,'0')})};
      if (route.includes('/result/')) return {arrayBuffer:async()=>wav()};
      return {json:async()=>({status:'done',stage:'complete',progress:100,result:{samples:48000,sample_rate:48000,channels:2}})};
    }};
  return {context,hooks,requests,files};
}

test('batch processes every clip sequentially, saves separate cleaned stems and records timeline mapping',async()=>{
  const {context,hooks,requests,files} = setup();
  await processBatch(context,{separate_music:true,separate_ambience:true},hooks);
  assert.equal(requests.filter(([p])=>p==='/v1/jobs').length,2);
  assert.equal(context.clips[0].outputs.dialogue.path,'C:/batch/clip-1-dialogue.wav');
  assert.equal(context.clips[1].outputs.effects.path,'C:/batch/clip-2-effects.wav');
  const manifest=JSON.parse(files.get('clip-batch.json').bytes);
  assert.equal(manifest.state,'ready'); assert.equal(manifest.clips[1].track_index,1);
  assert.equal(manifest.clips[1].start_ticks,'200');
  await validateOutputs(context,'binary');
  context.clips[1].outputs.effects.file.bytes=wav(24000);
  await assert.rejects(validateOutputs(context,'binary'),/do not match/);
});

test('a truncated export anywhere in batch blocks all uploads',async()=>{
  const {context,hooks,requests}=setup();
  context.clips[1].inputFile.read=async()=>wav().slice(0,100);
  await assert.rejects(processBatch(context,{},hooks),/invalid length/);
  assert.equal(requests.length,0);
});

test('whole-job reuse deletes only the new unused upload',async()=>{
  const {context,hooks,requests}=setup(), request=hooks.request;
  hooks.request=async(route,options)=>{
    const result=await request(route,options);
    if(route==='/v1/jobs') {const body=await result.json();return {json:async()=>({...body,reused:true})};}
    return result;
  };
  await processBatch(context,{},hooks);
  assert.equal(requests.filter(([path,method])=>path==='/v1/assets/'+'a'.repeat(32) && method==='DELETE').length,2);
  assert.equal(requests.filter(([path,method])=>path.startsWith('/v1/jobs/') && method==='DELETE').length,0);
  await validateOutputs(context,'binary');
});

for (const [ambience, music] of [[false,false],[true,false],[false,true],[true,true]]) {
  test(`downloads only checked stems: ambience=${ambience}, music=${music}`, async () => {
    const {context,hooks,requests} = setup();
    await processBatch(context,{separate_ambience:ambience,separate_music:music},hooks);
    const expected = ['dialogue', ...(ambience ? ['effects'] : []), ...(music ? ['music'] : [])];
    assert.deepEqual(Object.keys(context.clips[0].outputs), expected);
    assert.deepEqual(requests.filter(([p]) => p.includes('/result/')).map(([p]) => p.split('/').at(-1)), [...expected,...expected]);
    await validateOutputs(context,'binary');
  });
}

test('cancellation during submission cancels that job and does not start the next clip',async()=>{
  const {context,hooks,requests}=setup();
  let cancelled=false;
  hooks.onJob=id=>{if(id)cancelled=true;};
  hooks.check=()=>{if(cancelled)throw Error('cancelled');};
  await assert.rejects(processBatch(context,{},hooks),/cancelled/);
  assert.equal(requests.filter(([p])=>p==='/v1/jobs').length,1);
  assert.equal(requests.at(-1)[1],'DELETE');
  assert.ok(context.clips.every(c=>!c.outputs));
});

test('WAV verification rejects wrong layout and duration; accepts normal PCM',()=>{
  const expected={rate:48000,channels:2,duration:1};
  assert.equal(inspectWav(wav(),expected).samples,48000);
  assert.throws(()=>inspectWav(wav(48000,48000,1),expected),/do not match/);
  assert.throws(()=>inspectWav(wav(24000),expected),/do not match/);
});

test('waitForStableWav requires two stable complete reads', async()=>{
  const expected={rate:48000,channels:2,duration:1};
  let reads=0;
  const file={read:async()=>{reads++; return reads>=2 ? wav() : wav().slice(0,100);}};
  await waitForStableWav(file, expected, {binary:'binary', sleep:async()=>{}});
  assert.ok(reads>=2);
});
test('waitForStableWav uses faster polling after event render wait', async()=>{
  const expected={rate:48000,channels:2,duration:1};
  let sleeps=[];
  const file={read:async()=>wav()};
  await waitForStableWav(file, expected, {binary:'binary', sleep:async ms=>{sleeps.push(ms);}, renderWaitMode:'events'});
  assert.ok(sleeps.includes(200));
});
test('clickPopEvents maps clip-local repairs to absolute timeline seconds, sorted',()=>{
  // Each clip's rendered WAV starts at local time 0 == clip.start on the
  // timeline (media in-point is zero), so timeline position = clip.start.seconds + repair.start_seconds.
  const context={clips:[
    {name:'Clip 1',trackIndex:0,start:{seconds:10},result:{deess_declick:{repairs:[
      {start_seconds:.5,duration_seconds:.001,channels:[0,1]}]}}},
    {name:'Clip 2',trackIndex:1,start:{seconds:0},result:{deess_declick:{repairs:[
      {start_seconds:2,duration_seconds:.002,channels:[0]}]}}},
    {name:'Clip 3',trackIndex:0,start:{seconds:20},result:{}}, // no deess_declick: ignored, not an error
  ]};
  const events=clickPopEvents(context);
  assert.deepEqual(events.map(e=>e.timeline_seconds),[2,10.5]);
  assert.deepEqual(events.map(e=>e.clip_name),['Clip 2','Clip 1']);
  assert.equal(events[0].track_index,1); assert.equal(events[1].track_index,0);
  assert.deepEqual(events[0].channels,[0]);
});

test('a stem file locked by Premiere (already on the timeline) is written under a suffixed name instead of failing',async()=>{
  const {context,hooks}=setup();
  const create=context.folder.createFile;
  context.folder.createFile=async(name,opts)=>{
    const file=await create(name,opts);
    if(name==='clip-1-dialogue.wav') file.write=async()=>{throw new Error('resource busy or locked');};
    return file;
  };
  await processBatch(context,{},hooks);
  assert.match(context.clips[0].outputs.dialogue.path,/^C:\/batch\/clip-1-dialogue-[a-z0-9]+\.wav$/);
  assert.equal(context.clips[1].outputs.dialogue.path,'C:/batch/clip-2-dialogue.wav');
  await validateOutputs(context,'binary');
});

test('an unrelated write error is not swallowed by the locked-file fallback',async()=>{
  const {context,hooks}=setup();
  const create=context.folder.createFile;
  context.folder.createFile=async(name,opts)=>{
    const file=await create(name,opts);
    file.write=async()=>{throw new Error('disk exploded');};
    return file;
  };
  await assert.rejects(processBatch(context,{},hooks),/disk exploded/);
});


test('handled results reuse only the matching export identity and persist trim metadata',async()=>{
 const {context,hooks,requests,files}=setup();context.folder.getEntry=async name=>{if(!files.has(name))throw Error('missing');return files.get(name);};
 const settings={};
 for(const c of context.clips){c.handles={version:1,head:0.5,tail:0.5};c.mediaInTicks='127008000000';c.exportIdentity='geometry-A';}
 await processBatch(context,settings,hooks);
 const manifest=JSON.parse(files.get('clip-batch.json').bytes);
 assert.equal(manifest.clips[0].media_in_ticks,'127008000000');assert.equal(manifest.clips[0].handles.head,0.5);
 context.reuse={settings:JSON.stringify(settings),clips:Object.fromEntries(manifest.clips.map(c=>[c.id,c]))};
 requests.length=0;await processBatch(context,settings,hooks);assert.equal(requests.length,0);
 context.clips[0].exportIdentity='geometry-B';
 await processBatch(context,settings,hooks);assert.equal(requests.filter(([p])=>p==='/v1/jobs').length,1);
});

test('batch progress completes only after outputs and manifest are saved',async()=>{
 const {context,hooks,files}=setup(),events=[];
 hooks.onProgress=e=>{events.push(e);if(e.done){assert.ok(context.clips[e.clipIndex].outputs.dialogue);assert.equal(JSON.parse(files.get('clip-batch.json').bytes).state,'processing');}};
 await processBatch(context,{},hooks);
 assert.deepEqual(events.filter(e=>e.done).map(e=>e.clipIndex),[0,1]);
});


test('mixed batches schedule all dialogue cache jobs before final jobs, with the same raw assets',async()=>{
 const {context,hooks,requests}=setup(),request=hooks.request,jobs=[],uploads=[],events=[];
 hooks.onProgress=e=>events.push(e);
 hooks.request=async(route,opts={})=>{
  if(route==='/v1/health')return {json:async()=>({capabilities:['grouped_model_batch_v1']})};
  if(route==='/v1/assets' && opts.method==='POST')uploads.push(opts.body);
  if(route==='/v1/jobs')jobs.push(JSON.parse(opts.body));
  return request(route,opts);
 };
 await processBatch(context,{enhancer:'gap_urgenet',separate_ambience:true},hooks);
 assert.equal(uploads.length,2);
 assert.deepEqual(jobs.map(j=>j.stage_mode||'complete'),['dialogue_cache','dialogue_cache','complete','complete']);
 assert.ok(jobs.slice(0,2).every(j=>j.settings.separate_ambience===false));
 assert.ok(jobs.slice(2).every(j=>j.require_dialogue_cache && j.settings.separate_ambience));
 assert.deepEqual(jobs[0].tracks,jobs[2].tracks);
 assert.deepEqual(events.filter(e=>e.done).map(e=>e.phase),['dialogue','dialogue','stems','stems']);
});

test('mixed batch refuses older service before uploads',async()=>{
 const {context,hooks,requests}=setup();hooks.request=async()=>({json:async()=>({})});
 await assert.rejects(processBatch(context,{enhancer:'gap_urgenet',separate_music:true},hooks),/Restart/);
 assert.equal(requests.length,0);
});

test('cancellation after dialogue submission cancels that job and never starts Bandit',async()=>{
 const {context,hooks,requests}=setup(),request=hooks.request;let cancelled=false;
 hooks.check=()=>{if(cancelled)throw Error('cancelled');};
 hooks.request=async(route,opts={})=>{
  if(route==='/v1/health')return {json:async()=>({capabilities:['grouped_model_batch_v1']})};
  const result=await request(route,opts);if(route==='/v1/jobs' && opts.method==='POST')cancelled=true;return result;
 };
 await assert.rejects(processBatch(context,{enhancer:'mossformer2',separate_music:true},hooks),/cancelled/);
 assert.equal(requests.filter(([p])=>p==='/v1/jobs').length,1);
 assert.equal(requests.filter(([p,m])=>p.startsWith('/v1/jobs/') && m==='DELETE').length,1);
});
