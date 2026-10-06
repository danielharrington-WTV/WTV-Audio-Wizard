const ppro=require('premierepro');
const host=require('./premiere.js');
const {inventory}=require('./per-clip.js');
const effects=require('./music-effects.js');
async function effectSignature(sequence) {
 const parts=[];
 for(const entry of await inventory(sequence)) parts.push(await effects.snapshot(await entry.item.getComponentChain()));
 return JSON.stringify(parts);
}
const {getWavPreset}=require('./export-presets.js');
const {exportSequenceWithRenderWait}=require('./export-sync.js');
const {header,exact,sample}=require('./music-wav.js');
const {createMeter}=require('./loudness-meter.js');
const MARKER_PREFIX='WTV peak';
// Sequence markers for over-threshold events (Markers API, Premiere 25.6+).
// Previous WTV peak markers are removed first so a rerun never duplicates.
// Returns {added, removed}, or null when this host has no Markers API.
async function placePeakMarkers(project,sequence,events,thresholdDb,{formatPosition=s=>`${s.toFixed(3)} s`}={}) {
 if(!ppro.Markers || typeof ppro.Markers.getMarkers!=='function') return null;
 const markers=await ppro.Markers.getMarkers(sequence);
 if(!markers || typeof markers.createAddMarkerAction!=='function') return null;
 const stale=[];
 for(const marker of (await markers.getMarkers())||[]) {
  try { if(String(await marker.getName()).startsWith(MARKER_PREFIX)) stale.push(marker); } catch(_) {}
 }
 const zero=ppro.TickTime.TIME_ZERO ?? ppro.TickTime.createWithSeconds(0);
 host.transaction(project,'WTV: peak markers',compound=>{
  for(const marker of stale) compound.addAction(markers.createRemoveMarkerAction(marker));
  for(const e of events) {
   const name=`${MARKER_PREFIX} ${e.peak_dbfs.toFixed(1)} dBFS`;
   const comments=`Over ${thresholdDb} dBFS from ${formatPosition(e.position_seconds)} to ${formatPosition(e.end_seconds)}; loudest ${e.peak_dbfs.toFixed(2)} dBFS at ${formatPosition(e.peak_position_seconds)}, channel ${e.channel}, ${e.samples_over} sample(s) over. WTVAudioWizard Verify loudness.`;
   compound.addAction(markers.createAddMarkerAction(name,'Comment',ppro.TickTime.createWithSeconds(e.position_seconds),zero,comments));
  }
 });
 return {added:events.length,removed:stale.length};
}
// Lenient WAV header for a file Premiere is still writing: finds the fmt
// chunk and the data chunk's start without trusting the RIFF/data sizes,
// which most writers (Premiere included) only patch in when the export
// finishes. Returns null until both are visible.
async function streamingHeader(io,fd,size) {
 if(size<12) return null;
 const head=await exact(io,fd,0,12);
 if(tagOf(head,0)!=='RIFF'||tagOf(head,8)!=='WAVE') return null;
 let format=null;
 for(let offset=12;offset+8<=size;) {
  const chunk=await exact(io,fd,offset,8),bytes=chunk.getUint32(4,true),body=offset+8,id=tagOf(chunk,0);
  if(id==='fmt ') {
   if(bytes<16 || body+Math.min(bytes,40)>size) return null;
   const v=await exact(io,fd,body,Math.min(bytes,40));
   let code=v.getUint16(0,true);
   if(code===65534) { if(bytes<40 || v.getUint16(16,true)<22) return null; code=v.getUint16(24,true); }
   format={code,channels:v.getUint16(2,true),rate:v.getUint32(4,true),align:v.getUint16(12,true),bits:v.getUint16(14,true)};
  }
  if(id==='data') return format ? {...format,dataOffset:body} : null;
  offset=body+bytes+bytes%2;
 }
 return null;
}
const tagOf=(view,offset)=>String.fromCharCode(...new Uint8Array(view.buffer,offset,4));

// Every run renders afresh (v0.8.1). An earlier render cache reused the last
// WAV when the timeline fingerprint was unchanged, but that fingerprint can't
// see mixer state: Premiere's UXP AudioTrack exposes mute only -- no solo,
// track volume/pan or track effects. Live 2026-09-25: Dan verified with two
// tracks soloed, un-soloed, and the rerun silently reused the soloed render.
// Streaming analysis keeps a fresh run close to Premiere's render time.
const STREAM_MARGIN_FRAMES=48000*2;

async function run(options) {
 const state={file:null,ready:false};
 try { return await runInner(options,state); }
 finally {
  // A finished render is only needed for its measurement, so remove it
  // whether the run succeeded or failed. An unconfirmed render (cancelled
  // or timed out mid-export) is left alone: Premiere may still be writing it.
  if(state.file && state.ready) { try { await state.file.delete(); } catch(_) {} }
 }
}
async function runInner({fs,io=require('fs'),sleep,check=()=>{},say=()=>{},onProgress=null,peakFlagDbfs=-6,mergeSeconds=2,addMarkers=true,formatPosition},state) {
 const project=await ppro.Project.getActiveProject(),sequence=project && await project.getActiveSequence();
 if(!sequence)throw Error('Open the sequence to verify.');
 const settings=await sequence.getSettings(),channels=await settings.getAudioChannelCount();
 if(![1,2].includes(channels))throw Error('Loudness verification supports mono/stereo sequences only.');
 const duration=(await sequence.getEndTime()).seconds;
 if(duration<.4)throw Error('At least 0.4 seconds of sequence audio is needed.');
 const sequenceId=sequence.guid.toString(),before=await host.signature(sequence),beforeEffects=await effectSignature(sequence);
 const expected={rate:48000,channels,duration};
 const values=new Array(channels);
 // Progress goes to the bar (onProgress) rather than rewriting the status
 // line: text-length changes reflowed the footer and made the panel bounce
 // while the percentage climbed (2026-09-17). Whole percents, never backwards.
 let shown=-1;
 const report=(done,total)=>{const percent=Math.min(100,Math.floor(100*done/total));if(percent>shown){shown=percent;if(onProgress)onProgress(percent);}};
 // Feed `count` frames starting at `startFrame` into the meter.
 async function feed(meter,fd,format,startFrame,count) {
  const view=await exact(io,fd,format.dataOffset+startFrame*format.align,count*format.align);
  for(let frame=0;frame<count;frame++) {
   for(let c=0;c<channels;c++)values[c]=sample(view,frame*format.align+c*format.bits/8,format.code,format.bits);
   meter.push(values);
  }
 }
 async function analyzeWhole(path,format) {
  const meter=createMeter(channels,{peakFlagDbfs,mergeSeconds});
  const fd=await io.open(path,'r');
  try {
   for(let start=0;start<format.samples;start+=48000) {
    check();const count=Math.min(48000,format.samples-start);
    await feed(meter,fd,format,start,count);
    report(start+count,format.samples);await sleep(0);
   }
  } finally { await io.close(fd); }
  return meter;
 }

 let meter,format,size,file=null,ready=false,streamed=false,streamFallback=null;
 {
  const folder=await fs.getTemporaryFolder();
  file=await folder.createFile(`WTV-loudness-${Date.now()}.wav`,{overwrite:false});state.file=file;
  const preset=await getWavPreset(fs,{rate:48000,channels});
  // Streaming analysis: follow the WAV as Premiere writes it, feeding whole
  // frames past the data chunk start as they appear, so the meter is nearly
  // done when the render is. Once the file stops growing and the strict
  // header validates, anything still unread is fed and we finish. If the
  // lenient parse turns out to have misjudged the data chunk (a trailing
  // chunk after `data`, a different layout), the streamed meter is thrown
  // away and the finished file is analyzed from scratch -- correctness
  // never depends on the overlap.
  let live=null,consumed=0,streamFd,streamOk=true;
  async function verify({check:checkExport}) {
   let previous=-1;const deadline=Date.now()+30*60*1000;
   try {
    while(Date.now()<deadline) {
     checkExport();
     let stat=null;
     try { stat=await io.lstat(file.nativePath); } catch(_) { stat=null; }
     if(stat) {
      // Open per poll (never hold a handle across polls): if the writer
      // replaces the file by rename, a held handle would keep reading the
      // old inode while stat reports the new one.
      if(streamOk && stat.size>0) {
       try {
        streamFd=await io.open(file.nativePath,'r');
        if(!live) live=await streamingHeader(io,streamFd,stat.size);
        if(live && (live.channels!==channels || live.rate!==48000 || live.align!==live.channels*live.bits/8)) streamOk=false;
        if(live && streamOk) {
         if(!meter) meter=createMeter(channels,{peakFlagDbfs,mergeSeconds});
         // Hold back the last STREAM_MARGIN_FRAMES of what's on disk: a writer
         // may append a trailing chunk (bext/LIST/padding) after the samples,
         // and anything fed past the real data end can't be un-fed -- that
         // forced a full re-analysis (a second progress bar) on the first
         // live run (2026-09-17). The held-back tail is fed after the strict
         // header says exactly where the data ends.
         const available=Math.max(0,Math.floor((stat.size-live.dataOffset)/live.align)-STREAM_MARGIN_FRAMES);
         const totalFrames=Math.round(duration*48000);
         while(consumed<available) {
          try { checkExport(); } catch(error) { error.fromCheck=true; throw error; }
          const count=Math.min(48000,available-consumed);
          await feed(meter,streamFd,live,consumed,count);
          consumed+=count;report(consumed,totalFrames);await sleep(0);
         }
        }
       } catch(error) { if(error && error.fromCheck) throw error; /* short read while writing: retry next poll; nothing was pushed */ }
       finally { if(streamFd!==undefined) { try { await io.close(streamFd); } catch(_) {} streamFd=undefined; } }
      }
      // Completion: size stable across two polls and the strict header agrees.
      if(previous===stat.size) {
       let handle;
       try {
        handle=await io.open(file.nativePath,'r');
        format=await header(io,handle,stat.size,expected);
        size=stat.size;ready=true;state.ready=true;return;
       } catch(_) {} finally { if(handle!==undefined) await io.close(handle); }
      }
      previous=stat.size;
     } else previous=-1;
     await sleep(200);
    }
   } finally { if(streamFd!==undefined) { try { await io.close(streamFd); } catch(_) {} streamFd=undefined; } }
   throw Error('Loudness render timed out; Premiere may still be exporting.');
  }
  say('Loudness: rendering and analyzing the full audible sequence. Keep the timeline unchanged.');
  await exportSequenceWithRenderWait({ppro,manager:await ppro.EncoderManager.getManager(),sequence,
   exportType:ppro.Constants.ExportType.IMMEDIATELY,outputFile:file.nativePath,presetFile:preset.nativePath,exportFull:true,
   outputNativePath:file.nativePath,check,sleep,verifyOutput:verify,exportAcceptTimeoutMs:Math.max(360000,duration*3000)});
  check();
  const usable=meter && streamOk && live && live.dataOffset===format.dataOffset && consumed<=format.samples;
  if(!usable) streamFallback=!meter?'no samples streamed before the render finished':!streamOk?'stream format mismatch':!live?'header not visible during render':live.dataOffset!==format.dataOffset?`data offset ${live.dataOffset} vs final ${format.dataOffset}`:`streamed ${consumed} frames past the final data length ${format.samples}`;
  if(usable) {
   streamed=true;
   if(consumed<format.samples) {
    const fd=await io.open(file.nativePath,'r');
    try { for(let start=consumed;start<format.samples;start+=48000){check();const count=Math.min(48000,format.samples-start);await feed(meter,fd,format,start,count);report(start+count,format.samples);await sleep(0);} }
    finally { await io.close(fd); }
   }
  } else {
   shown=-1;say('Loudness: render layout differed from the stream; analyzing the finished file from the start\u2026');
   meter=await analyzeWhole(file.nativePath,format);
  }
 }
 if((await io.lstat(file.nativePath)).size!==size)throw Error('Loudness WAV changed during analysis.');
 const active=await project.getActiveSequence();
 if(!active || active.guid.toString()!==sequenceId || before!==await host.signature(sequence) || beforeEffects!==await effectSignature(sequence)) throw Error('Timeline changed; rerun loudness verification.');
 const result=meter.finish();
 let markers=null;
 if(addMarkers) {
  try { markers=await placePeakMarkers(project,active,result.over_threshold_events,peakFlagDbfs,{formatPosition}); }
  catch(error) { markers={error:error.message}; }
 }
 return {...result,markers,render:streamed?'streamed':'rendered',stream_fallback_reason:streamFallback,sequence_id:sequenceId,measured_at:new Date().toISOString(),scope:'Full audible sequence including current effects, mute/solo and master processing'};
}
module.exports={run,placePeakMarkers,streamingHeader,MARKER_PREFIX};
