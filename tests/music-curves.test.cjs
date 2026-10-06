const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),vm=require('node:vm');
const box={module:{exports:{}},require:()=>({})};
vm.runInNewContext(fs.readFileSync(require.resolve('../plugin/music-effects.js'),'utf8'),box);
const fx=box.module.exports;
const encode=db=>(db+96)/144,decode=v=>v*144-96;

test('30 dB ramp uses two endpoints and matches encoded dense interpolation',()=>{
  const curve=fx.clipCurve([[0,0],[10,-30]],{start:0,end:10,inPoint:20},48000);
  assert.equal(curve.length,2);
  for(let i=0;i<1000;i++) {
    const t=i/100, expected=-3*t;
    const encoded=curve.map(([t,db])=>[t,encode(db)]);
    assert.ok(Math.abs(decode(fx.valueAt(encoded,t+20))-expected)<1e-10);
  }
});
test('preserves every corner, source trims, clipped ramps and final sample',()=>{
  const points=[[0,0],[1,-10],[2,-10],[3,0],[4,0]];
  const clip={start:.5,end:3.5,inPoint:30};
  const curve=fx.clipCurve(points,clip,48000);
  assert.deepEqual(Array.from(curve[0]),[30,-5]);
  assert.equal(curve.length,5);
  assert.equal(curve.at(-1)[0],33-1/48000);
  for(let i=0;i<3000;i++) {
    const t=.5+i/1000;
    assert.ok(Math.abs(fx.valueAt(points,t)-fx.valueAt(curve,30+t-.5))<1e-10);
  }
});
test('constant, out-of-curve and sub-sample clips have finite ordered keys',()=>{
  for(const clip of [{start:8,end:10,inPoint:0},{start:0,end:2,inPoint:5},{start:2,end:2.000001,inPoint:1}]) {
    const curve=fx.clipCurve([[1,-8],[4,-8]],clip,48000);
    assert.ok(curve.length<=3);
    curve.forEach(([t,g],i)=>{assert.ok(Number.isFinite(t));assert.equal(g,-8);if(i)assert.ok(t>curve[i-1][0]);});
  }
});
test('budget counts corners without discarding them; reports old dense count',()=>{
  const points=[[0,0],[1,-30],[2,0]],clip={start:0,end:3,inPoint:0};
  const fitted=fx.fitClipCurve(points,clip,48000,4);
  assert.equal(fitted.curve.length,4);
  assert.equal(fitted.legacyKeyCount,242);
  assert.throws(()=>fx.fitClipCurve(points,clip,48000,3),/corners/);
});
