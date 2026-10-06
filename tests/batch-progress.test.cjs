const test=require('node:test'),assert=require('node:assert/strict');
const {createBatchProgress}=require('../plugin/batch-progress.js');
test('duration weighted progress and ETA from measured clips',()=>{
 let time=0;const t=createBatchProgress([{duration:10},{duration:90}],{now:()=>time});
 t.start(0);assert.equal(t.snapshot().remaining,null);time=5000;t.complete(0);
 assert.equal(t.snapshot().percent,10);assert.equal(t.snapshot().remaining,45);
 t.start(1);time=15000;t.progress(50);assert.equal(t.snapshot().remaining,35);
 const p=t.snapshot().percent;t.progress(2);assert.equal(t.snapshot().percent,p);
 t.progress(100);assert.ok(t.snapshot().percent<100);t.complete(1);assert.equal(t.snapshot().percent,100);assert.equal(t.snapshot().remaining,0);
});
test('cached and resumed work counts but never trains speed; phase restart is independent',()=>{
 let time=0;const clips=[{duration:10},{duration:10},{duration:10}];
 const t=createBatchProgress(clips,{now:()=>time,completed:[0]});t.start(1);time=1;t.complete(1,true);
 assert.equal(t.snapshot().completed,2);assert.equal(t.snapshot().remaining,null);
 assert.equal(createBatchProgress(clips).snapshot().completed,0);
});
test('overrun reports unknown instead of a false zero countdown',()=>{
 let time=0;const t=createBatchProgress([{duration:1},{duration:1}],{now:()=>time});
 t.start(0);time=1000;t.complete(0);t.start(1);time=4000;
 assert.equal(t.snapshot().remaining,null);assert.equal(t.snapshot().completed,1);
});
