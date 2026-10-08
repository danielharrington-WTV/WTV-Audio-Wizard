// Interleaved batch (2026-10-07): jobs start during export; clip-batch collects them.
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPrefetch, firstJobBody, isGrouped, reusedFromFolder} = require('../plugin/prefetch.js');
const {processBatch} = require('../plugin/clip-batch.js');

function wav(samples = 48000, rate = 48000, channels = 2) {
  const b = new ArrayBuffer(44 + samples * channels * 2), v = new DataView(b);
  const tag = (offset, text) => [...text].forEach((c,i) => v.setUint8(offset+i,c.charCodeAt(0)));
  tag(0,'RIFF'); v.setUint32(4,b.byteLength-8,true); tag(8,'WAVE'); tag(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,channels,true);
  v.setUint32(24,rate,true); v.setUint32(28,rate*channels*2,true); v.setUint16(32,channels*2,true); v.setUint16(34,16,true);
  tag(36,'data'); v.setUint32(40,b.byteLength-44,true); return b;
}
// A small stand-in for the service: assets, a job table and content-matched reuse of final jobs.
function service({clips = 3, finish = () => true, failJobs = false} = {}) {
  const requests = [], jobs = new Map(), files = new Map();
  let assetCount = 0, jobCount = 0;
  const context = {name:'Test', originalId:'original', rate:48000, channels:2,
    folder:{createFile:async name => { const file={nativePath:`C:/batch/${name}`,write:async value=>{file.bytes=value;},read:async()=>file.bytes}; files.set(name,file); return file; }},
    clips:Array.from({length:clips},(_, i) => ({id:`clip-${i+1}`, name:`Clip ${i+1}`, duration:1, trackIndex:0,
      start:{ticks:String(i*100)}, end:{ticks:String(i*100+100)}, inputFile:{nativePath:`C:/batch/input-${i+1}.wav`, read:async()=>wav()}}))};
  const request = async (route, options = {}) => {
    const method = options.method || 'GET';
    requests.push([route, method, options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null]);
    if (route === '/v1/health') return {json:async()=>({capabilities:['grouped_model_batch_v1']})};
    if (route === '/v1/assets') return {json:async()=>({asset_id:String(++assetCount).padStart(32,'a'),samples:48000,sample_rate:48000,channels:2})};
    if (route === '/v1/jobs') {
      if (failJobs) throw new Error('Service 429: Queue is full');
      const body = JSON.parse(options.body), key = JSON.stringify(body);
      if (body.stage_mode !== 'dialogue_cache') for (const job of jobs.values()) if (job.key === key && job.status !== 'failed') return {json:async()=>({job_id:job.id,reused:true})};
      const id = String(++jobCount).padStart(32,'0');
      jobs.set(id, {id, key, body, status:'queued'});
      return {json:async()=>({job_id:id,reused:false})};
    }
    if (route.includes('/result/')) return {arrayBuffer:async()=>wav()};
    if (route.startsWith('/v1/assets/')) return {json:async()=>({deleted:true})};
    const job = jobs.get(route.split('/').pop());
    if (method === 'DELETE') { job.status = 'cancelled'; return {json:async()=>({})}; }
    if (job.status === 'queued' && finish(job)) job.status = 'done';
    return {json:async()=>({status:job.status,stage:'complete',progress:100,result:{samples:48000,sample_rate:48000,channels:2}})};
  };
  const hooks = {request, binary:'binary', check:()=>{}, onJob:()=>{}, say:()=>{}, sleep:async()=>{}};
  return {context, request, requests, jobs, hooks, count: (route, method = 'POST') => requests.filter(r => r[0] === route && r[1] === method).length};
}
const SETTINGS = {enhancer:'gap_urgenet', separate_ambience:false, separate_music:false};
const MIXED = {enhancer:'gap_urgenet', separate_ambience:true, separate_music:false};
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('each exported clip is uploaded and its job started without waiting for the rest of the export', async () => {
  const s = service();
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', sleep:async()=>{}});
  prefetch.exported(s.context, s.context.clips[0]);
  await settle();
  assert.equal(s.count('/v1/assets'), 1); assert.equal(s.count('/v1/jobs'), 1);   // Clip 2 is still "exporting".
  prefetch.exported(s.context, s.context.clips[1]);
  prefetch.exported(s.context, s.context.clips[1]);                               // Reported twice: started once.
  await settle();
  const summary = await prefetch.stop();
  assert.deepEqual(summary, {started:2, disabled:null});
  const entry = prefetch.take('clip-1');
  assert.equal(entry.kind, 'final'); assert.match(entry.jobId, /^0{31}1$/); assert.equal(entry.asset.samples, 48000);
  assert.equal(prefetch.take('clip-1'), null);
  assert.equal(prefetch.take('clip-3'), null);
});

test('no more than maxActive early jobs are unfinished at once, and stop() leaves the rest to the normal pass', async () => {
  const s = service({clips:5, finish:()=>false});
  let sleeps = 0;
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', maxActive:2,
    sleep:async()=>{ sleeps++; await new Promise(resolve => setImmediate(resolve)); }});
  for (const clip of s.context.clips) prefetch.exported(s.context, clip);
  await settle();
  assert.equal(s.count('/v1/jobs'), 2); assert.ok(sleeps > 0);
  assert.deepEqual(await prefetch.stop(), {started:2, disabled:null});
  assert.equal(s.count('/v1/assets'), 2);
});

test('stopping while an upload is in flight is safe', async () => {
  const s = service();
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', sleep:async()=>{}});
  for (const clip of s.context.clips) prefetch.exported(s.context, clip);
  const summary = await prefetch.stop();          // No settle: the first upload has only just begun.
  assert.equal(summary.disabled, null); assert.ok(summary.started <= 1);
  await processBatch(s.context, SETTINGS, {...s.hooks, prefetch});
  assert.equal(s.count('/v1/assets'), 3); assert.equal(s.jobs.size, 3);
});

test('a service problem turns early starts off and never throws into the batch', async () => {
  const s = service({failJobs:true});
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', sleep:async()=>{}});
  for (const clip of s.context.clips) prefetch.exported(s.context, clip);
  await settle();
  const summary = await prefetch.stop();
  assert.equal(summary.started, 0); assert.match(summary.disabled, /Queue is full/);
  assert.equal(s.count('/v1/assets'), 1);
  prefetch.exported(s.context, s.context.clips[2]);
  assert.equal(s.count('/v1/assets'), 1);
});

test('abort cancels early jobs that are unfinished and not yet collected, and nothing else', async () => {
  const s = service({finish:job => job.id.endsWith('1')});
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', sleep:async()=>{}});
  for (const clip of s.context.clips) prefetch.exported(s.context, clip);
  await settle(); await prefetch.stop();
  prefetch.take('clip-3');                    // Collected by the batch: its own business now.
  await prefetch.abort();
  const cancelled = s.requests.filter(r => r[1] === 'DELETE').map(r => r[0]);
  assert.deepEqual(cancelled, [`/v1/jobs/${'0'.repeat(31)}2`]);
});

test('clips the folder already holds results for, with the same settings, are not sent early', () => {
  const clip = {id:'clip-1'}, key = JSON.stringify(SETTINGS);
  const context = {reuse:{settings:key, clips:{'clip-1':{result:{}, outputs:{dialogue:'x'}}}}};
  assert.equal(reusedFromFolder(context, clip, key), true);
  assert.equal(reusedFromFolder(context, clip, JSON.stringify(MIXED)), false);
  assert.equal(reusedFromFolder({}, clip, key), false);
  assert.equal(reusedFromFolder(context, {id:'clip-1', handles:{}, exportIdentity:'new'}, key), false);
});

test('a mixed batch starts the dialogue-cache job early, exactly as the first pass would submit it', () => {
  assert.equal(isGrouped(MIXED), true); assert.equal(isGrouped(SETTINGS), false);
  assert.equal(isGrouped({enhancer:'none', separate_music:true}), false);
  assert.deepEqual(firstJobBody('a', MIXED), {stage_mode:'dialogue_cache', tracks:[{asset_id:'a',role:'mixture'}], settings:{...MIXED, separate_ambience:false, separate_music:false}});
  assert.deepEqual(firstJobBody('a', SETTINGS), {tracks:[{asset_id:'a',role:'mixture'}], settings:SETTINGS});
});

test('the batch collects early jobs: no second upload, no second job, and the job input is not deleted', async () => {
  const s = service();
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', sleep:async()=>{}});
  prefetch.exported(s.context, s.context.clips[0]);
  prefetch.exported(s.context, s.context.clips[1]);
  await settle(); await prefetch.stop();                                      // Clip 3 was never started early.
  const events = [];
  await processBatch(s.context, SETTINGS, {...s.hooks, prefetch, onProgress:e => events.push(e)});
  assert.equal(s.count('/v1/assets'), 3, 'one upload per clip');
  assert.equal(s.jobs.size, 3, 'one job per clip');
  assert.equal(s.requests.filter(r => r[1] === 'DELETE').length, 0);
  assert.deepEqual(s.context.clips.map(c => c.jobId), [...s.jobs.keys()]);
  assert.ok(s.context.clips.every(c => c.outputs.dialogue.path.endsWith(`${c.id}-dialogue.wav`)));
  assert.deepEqual(events.filter(e => e.done).map(e => e.reused), [true, true, false]);
});

test('without early starts the batch behaves exactly as before', async () => {
  const s = service();
  await processBatch(s.context, SETTINGS, s.hooks);
  assert.equal(s.count('/v1/assets'), 3); assert.equal(s.jobs.size, 3);
});

test('a mixed batch reuses the early dialogue job and upload for both passes', async () => {
  const s = service({clips:2});
  const prefetch = createPrefetch({settings:MIXED, request:s.request, binary:'binary', sleep:async()=>{}});
  for (const clip of s.context.clips) prefetch.exported(s.context, clip);
  await settle(); await prefetch.stop();
  await processBatch(s.context, MIXED, {...s.hooks, prefetch});
  assert.equal(s.count('/v1/assets'), 2, 'one upload per clip serves both passes');
  const stage = [...s.jobs.values()].filter(j => j.body.stage_mode === 'dialogue_cache');
  const final = [...s.jobs.values()].filter(j => j.body.require_dialogue_cache);
  assert.equal(stage.length, 2); assert.equal(final.length, 2);
  assert.deepEqual(s.context.clips.map(c => c.dialogueStage.job_id), stage.map(j => j.id));
  assert.deepEqual(final.map(j => j.body.tracks[0].asset_id), stage.map(j => j.body.tracks[0].asset_id));
});

test('an early dialogue job that failed or vanished is replaced once and the batch carries on', async () => {
  const s = service({clips:1});
  const prefetch = createPrefetch({settings:MIXED, request:s.request, binary:'binary', sleep:async()=>{}});
  prefetch.exported(s.context, s.context.clips[0]);
  await settle(); await prefetch.stop();
  s.jobs.get('0'.repeat(31) + '1').status = 'failed';
  await processBatch(s.context, MIXED, {...s.hooks, prefetch});
  assert.equal([...s.jobs.values()].filter(j => j.body.stage_mode === 'dialogue_cache').length, 2);
  assert.equal(s.context.clips[0].dialogueStage.state, 'cached');
  assert.equal(s.count('/v1/assets'), 1);
});

test('an early final job that failed is simply submitted again with the same upload', async () => {
  const s = service({clips:1});
  const prefetch = createPrefetch({settings:SETTINGS, request:s.request, binary:'binary', sleep:async()=>{}});
  prefetch.exported(s.context, s.context.clips[0]);
  await settle(); await prefetch.stop();
  s.jobs.get('0'.repeat(31) + '1').status = 'failed';
  await processBatch(s.context, SETTINGS, {...s.hooks, prefetch});
  assert.equal(s.jobs.size, 2); assert.equal(s.count('/v1/assets'), 1);
  assert.equal(s.context.clips[0].jobId, '0'.repeat(31) + '2');
});

test('main.js hands each finished export to the helper, stops it before processing and cancels leftovers', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'plugin', 'main.js'), 'utf8');
  assert.equal((main.match(/batchPrefetch\?\.exported\(context, clip\)/g) || []).length, 3, 'resumed, reused and fresh exports');
  assert.ok(main.indexOf('await batchPrefetch.stop()') < main.indexOf('await processBatch(context, chosen, {prefetch,'));
  assert.match(main, /finally \{\s*batchPrefetchWanted = false;[\s\S]{0,300}await pending\.abort\(\)/);
});
