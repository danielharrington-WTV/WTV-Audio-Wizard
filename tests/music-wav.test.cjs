const test=require('node:test'),assert=require('node:assert/strict');
const {readSummary}=require('../plugin/music-wav.js');
function wav(bits=32,code=3) {
  const rate=48000,frames=rate*3+10,channels=2,align=channels*bits/8;
  const buffer=new ArrayBuffer(44+frames*align),v=new DataView(buffer);
  const tag=(i,s)=>[...s].forEach((c,j)=>v.setUint8(i+j,c.charCodeAt(0)));
  tag(0,'RIFF');v.setUint32(4,buffer.byteLength-8,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);
  v.setUint16(20,code,true);v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*align,true);v.setUint16(32,align,true);v.setUint16(34,bits,true);tag(36,'data');v.setUint32(40,frames*align,true);
  for(let i=44;i<buffer.byteLength;i+=bits/8) {
    if(code===3) (bits===32?v.setFloat32.bind(v):v.setFloat64.bind(v))(i,.25,true);
    else if(bits===16) v.setInt16(i,8192,true);
    else if(bits===24) {v.setUint8(i,0);v.setUint8(i+1,0);v.setUint8(i+2,32);}
    else if(bits===32) v.setInt32(i,536870912,true);
    else v.setUint8(i,160);
  }
  let closed=0,maxRead=0;
  const io={open:async()=>1,close:async()=>{closed++;},lstat:async()=>({size:buffer.byteLength}),read:async(fd,out,offset,length,position)=>{
    // Deliberate short reads exercise fs.read's partial-read contract.
    const n=Math.min(length,131071,buffer.byteLength-position);maxRead=Math.max(maxRead,length);
    new Uint8Array(out,offset,n).set(new Uint8Array(buffer,position,n));return {bytesRead:n,buffer:out};
  }};
  return {buffer,io,expected:{rate,channels,duration:frames/rate},closed:()=>closed,maxRead:()=>maxRead};
}
for(const [bits,code] of [[8,1],[16,1],[24,1],[32,1],[32,3],[64,3]]) test(`bounded WAV reading: ${bits}-bit format ${code}`,async()=>{
  const f=wav(bits,code);const s=await readSummary({nativePath:'test'},f.expected,{io:f.io,sleep:async()=>{}});
  assert.equal(s.peak,.25);assert.equal(s.levels[0],.25);
  assert.ok(Math.abs(s.levels.at(-1)-.25*Math.sqrt(10/960))<1e-12);
  assert.ok(f.maxRead()<=128*960*2*bits/8);assert.ok(f.closed()>0);
});
test('nonfinite audio closes the descriptor and rejects',async()=>{
  const f=wav();new DataView(f.buffer).setFloat32(44,NaN,true);
  await assert.rejects(readSummary({nativePath:'test'},f.expected,{io:f.io,sleep:async()=>{}}),/non-finite/);
  assert.ok(f.closed()>0);
});
test('cancel while reading closes descriptor',async()=>{
  const f=wav();let cancelled=false;
  await assert.rejects(readSummary({nativePath:'test'},f.expected,{io:f.io,sleep:async()=>{},onRead:()=>{cancelled=true;},check:()=>{if(cancelled)throw Error('cancel');}}),/cancel/);
  assert.ok(f.closed()>0);
});
