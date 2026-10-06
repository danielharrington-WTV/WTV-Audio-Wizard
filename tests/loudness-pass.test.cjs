const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup({cancel=false,changed=false}={}) {
 const samples=48000,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(3276*Math.sin(2*Math.PI*1000*i/48000)),44+i*2);
 let deleted=false,closed=0,signatureCalls=0,exports=0;
 const seq={guid:{toString:()=> 'sequence'},getSettings:async()=>({getAudioChannelCount:async()=>1}),getEndTime:async()=>({seconds:1})};
 const file={nativePath:'test.wav',delete:async()=>{deleted=true;}};
 const deps={premierepro:{Project:{getActiveProject:async()=>({getActiveSequence:async()=>seq})},EncoderManager:{getManager:async()=>({})},Constants:{ExportType:{IMMEDIATELY:1}}},
 './premiere.js':{signature:async()=>changed && signatureCalls++?'changed':'same'},'./per-clip.js':{inventory:async()=>[]},'./music-effects.js':{},
 './export-presets.js':{getWavPreset:async()=>({nativePath:'preset'})},'./export-sync.js':{exportSequenceWithRenderWait:async options=>{exports++;assert.equal(options.exportFull,true);await options.verifyOutput({check:()=>{if(cancel)throw Error('cancelled');}});}},
 './music-wav.js':require('../plugin/music-wav.js'),'./loudness-meter.js':require('../plugin/loudness-meter.js')};
 const box={module:{exports:{}},require:n=>deps[n],Date};vm.runInNewContext(fs.readFileSync(require.resolve('../plugin/loudness-pass.js'),'utf8'),box);
 const io={lstat:async()=>({size:bytes.length}),open:async()=>1,close:async()=>closed++,read:async(fd,buffer,offset,length,position)=>{new Uint8Array(buffer,offset,length).set(bytes.subarray(position,position+length));return {bytesRead:length};}};
 return {run:()=>box.module.exports.run({fs:{getTemporaryFolder:async()=>({createFile:async()=>file})},io,sleep:async()=>{}}),state:()=>({deleted,closed,exports})};
}
// v0.8.1: no render cache any more (solo/mixer state can't be fingerprinted),
// so a successful pass deletes its render once measured.
test('full mix export is verified, metered, closed and removed without timeline actions',async()=>{const s=setup(),r=await s.run();assert.ok(Math.abs(r.integrated_lufs+23)<.1);assert.equal(s.state().deleted,true);assert.equal(s.state().exports,1);});
test('unconfirmed cancelled render is not deleted',async()=>{const s=setup({cancel:true});await assert.rejects(s.run(),/cancelled/);assert.equal(s.state().deleted,false);});
test('changed timeline rejects report and removes completed analysis file',async()=>{const s=setup({changed:true});await assert.rejects(s.run(),/Timeline changed/);assert.equal(s.state().deleted,true);});
