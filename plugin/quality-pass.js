const ppro=require('premierepro');
const host=require('./premiere.js');
const {inventory,clipKey}=require('./per-clip.js');
const effects=require('./music-effects.js');
const {getWavPreset}=require('./export-presets.js');
const {exportSequenceWithRenderWait}=require('./export-sync.js');
const {waitForStableWavFile}=require('./wav.js');
const PREFIX='WTV quality | ';
const markerOwners=new Map();
function ownership(key) {
 try { const saved=JSON.parse(localStorage.getItem(key));if(saved && typeof saved==='object' && !Array.isArray(saved))return saved; } catch(_) {}
 return markerOwners.get(key)||{};
}
function saveOwnership(key,value) {
 markerOwners.set(key,value);
 try { localStorage.setItem(key,JSON.stringify(value)); } catch(_) {}
}
const markerId=marker=>marker.guid?.toString();
function clipScope(clip) {
 return `clip A${clip.trackIndex+1} ${clip.start.ticks}-${clip.end.ticks}`;
}
function timelineRegions(regions,offset,clip) {
 return regions.map(r=>({...r,start:Math.max(clip.start.seconds,r.start+offset),end:Math.min(clip.end.seconds,r.end+offset)})).filter(r=>r.end>r.start);
}
async function signature(sequence) {
 const rows=[];
 for(const c of await inventory(sequence)) rows.push([clipKey(c),c.enabled,c.muted,await effects.snapshot(await c.item.getComponentChain())]);
 return JSON.stringify([await host.signature(sequence),rows]);
}
function validateReport(report,duration) {
 if(!report.ok) throw Error(report.error || 'Quality analysis failed.');
 if(report.model!=='DNSMOS P.835' || report.provider!=='CPUExecutionProvider' || !Number.isFinite(report.duration) || Math.abs(report.duration-duration)>.01 || !Array.isArray(report.regions) || report.regions.length>500) throw Error('Invalid quality report.');
 let end=-1;
 for(const r of report.regions) {
  if(![r.start,r.end,r.speech,r.background,r.overall].every(Number.isFinite) || r.start<0 || r.start<end || r.end<=r.start || r.end>duration+.001) throw Error('Invalid quality marker range.');
  end=r.end;
 }
 return report;
}
async function placeMarkers(project,sequence,regions,scopeKey) {
 if(!ppro.Markers?.getMarkers || ppro.Constants.MarkerColor?.RED===undefined) throw Error('This Premiere version does not expose red sequence markers.');
 const sequenceId=sequence.guid.toString();
 let markers=await ppro.Markers.getMarkers(sequence);
 const ownerKey=`wtv-quality-markers-v1:${project.path||''}:${sequenceId}`,owners=ownership(ownerKey);
 const stale=[];
 // Replace only this selected clip's review markers.
 const scope=PREFIX+scopeKey+' | ';
 for(const marker of (await markers.getMarkers())||[]) if(String(await marker.getName()).startsWith(scope)||owners[markerId(marker)]===scopeKey) stale.push(marker);
 const run=`${Date.now()}`;
 host.transaction(project,'WTV: dialogue quality review markers',compound=>{
  for(const marker of stale) compound.addAction(markers.createRemoveMarkerAction(marker));
  regions.forEach((r,i)=>compound.addAction(markers.createAddMarkerAction(`${scope}${run}-${i+1}`,'Comment',
   ppro.TickTime.createWithSeconds(r.start),ppro.TickTime.createWithSeconds(r.end-r.start),
   `overall ${r.overall.toFixed(2)}, speech ${r.speech.toFixed(2)}, background ${r.background.toFixed(2)}. (Lower is worse)`)));
 });
 markers=await ppro.Markers.getMarkers(await host.findSequence(project,sequenceId));
 const added=[];
 for(const marker of (await markers.getMarkers())||[]) if(String(await marker.getName()).startsWith(scope+run+'-')) added.push(marker);
 if(added.length!==regions.length) throw Error('Quality markers could not be verified. Inspect the timeline; Undo can remove this marker pass.');
 // Persistent GUID ownership keeps implementation IDs out of visible text.
 for(const marker of stale)delete owners[markerId(marker)];
 for(const marker of added)if(markerId(marker))owners[markerId(marker)]=scopeKey;
 saveOwnership(ownerKey,owners);
 const addedIds=new Set(added.map(markerId).filter(Boolean));
 if(added.length) {
  const titles=[];
  for(const marker of added) {
   const index=Number(String(await marker.getName()).slice((scope+run+'-').length))-1;
   titles.push(regions[index].overall.toFixed(2));
  }
  host.transaction(project,'WTV: colour quality markers red',compound=>{
   added.forEach((marker,i)=>{
    compound.addAction(marker.createSetColorByIndexAction(ppro.Constants.MarkerColor.RED));
    compound.addAction(marker.createSetNameAction(titles[i]));
   });
  });
  // Reacquire after the mutation before verifying.
  markers=await ppro.Markers.getMarkers(await host.findSequence(project,sequenceId));
  for(const marker of (await markers.getMarkers())||[]) if(addedIds.has(markerId(marker)) && await marker.getColorIndex()!==ppro.Constants.MarkerColor.RED) throw Error('Quality markers added, but red colour could not be verified.');
 }
 return {added:added.length,removed:stale.length};
}
async function runClip({fs,request,binary,clip,threshold=1.5,sleep,check=()=>{},say=()=>{},onProgress=()=>{}}) {
 if(!Number.isFinite(threshold)||threshold<1||threshold>5) throw Error('Quality review threshold must be 1 to 5.');
 const health=await (await request('/v1/health')).json();
 if(!health.capabilities?.includes('dnsmos_quality_v1')) throw Error('Restart the updated service to enable dialogue quality analysis.');
 check();
 const project=await ppro.Project.getActiveProject(),sequence=project && await project.getActiveSequence();
 if(!sequence) throw Error('Open a sequence to check dialogue quality.');
 const all=await inventory(sequence),chosen=all.filter(c=>clipKey(c)===clipKey(clip)&&c.enabled);
 if(chosen.length!==1) throw Error('Selected dialogue clip changed. Select it again and retry.');
 const tracks=[clip.trackIndex];
 const channels=await (await sequence.getSettings()).getAudioChannelCount();
 if(![1,2].includes(channels)) throw Error('Quality scans support mono/stereo sequences.');
 const frameTicks=await host.sequenceFrameTicks(sequence);
 const startTicks=Number(clip.start.ticks),endTicks=Number(clip.end.ticks);
 const renderStart=frameTicks?Math.floor(startTicks/frameTicks)*frameTicks:startTicks;
 const renderEnd=frameTicks?Math.ceil(endTicks/frameTicks)*frameTicks:endTicks;
 let offset=renderStart/254016000000,duration=(renderEnd-renderStart)/254016000000;
 const before=await signature(sequence),sequenceId=sequence.guid.toString();
 const job=`wtvq-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
 let scratch=null,ready=false,submitted=null,done=false,file=null,asset=null;
 try {
  const beforeIds=new Set((await host.listSequences(project)).map(s=>s.guid.toString())),beforeItems=await host.snapshotProjectItems(project);
  host.transaction(project,'WTV: dialogue quality analysis copy',c=>c.addAction(sequence.createCloneAction()));
  scratch=await host.identifyNewSequence(project,beforeIds,[sequenceId],'quality analysis',beforeItems);
  await project.setActiveSequence(await host.findSequence(project,sequenceId));
  const copied=await inventory(scratch);
  if(JSON.stringify(copied.map(clipKey))!==JSON.stringify(all.map(clipKey))) throw Error('Quality analysis copy does not match the timeline.');
  for(const index of tracks) {
   const track=await scratch.getAudioTrack(index);
   if(await track.isMuted()) { await track.setMute(false); if(await track.isMuted()) throw Error('Cannot unmute analysis track.'); }
  }
  const item=await scratch.getProjectItem();
  host.transaction(project,'WTV: isolate selected dialogue clip',c=>{
   c.addAction(item.createSetNameAction('WTV_QUALITY_ANALYSIS'));
   c.addAction(scratch.createSetInPointAction(ppro.TickTime.createWithSeconds(offset)));
   c.addAction(scratch.createSetOutPointAction(ppro.TickTime.createWithSeconds(offset+duration)));
   for(const clip of copied) if(clipKey(clip)!==clipKey(chosen[0])) c.addAction(clip.item.createSetDisabledAction(true));
  });
  scratch=await host.findSequence(project,scratch.guid.toString());
  const actualIn=(await scratch.getInPoint()).seconds,actualOut=(await scratch.getOutPoint()).seconds;
  const tolerance=(frameTicks||0)/254016000000+1/48000;
  if(!Number.isFinite(actualIn)||!Number.isFinite(actualOut)||actualIn>clip.start.seconds+1/48000||actualOut<clip.end.seconds-1/48000||clip.start.seconds-actualIn>tolerance||actualOut-clip.end.seconds>tolerance) throw Error('Premiere could not set the selected clip export range.');
  offset=actualIn;duration=actualOut-actualIn;
  const scratchBefore=await signature(scratch);
  file=await (await fs.getTemporaryFolder()).createFile(`${job}.wav`,{overwrite:false});
  const preset=await getWavPreset(fs,{rate:48000,channels});
  say('Quality: rendering selected dialogue clip. Keep the timeline unchanged.');onProgress(1);
  await exportSequenceWithRenderWait({ppro,manager:await ppro.EncoderManager.getManager(),sequence:scratch,
   exportType:ppro.Constants.ExportType.IMMEDIATELY,outputFile:file.nativePath,presetFile:preset.nativePath,exportFull:false,
   outputNativePath:file.nativePath,check,sleep,exportAcceptTimeoutMs:Math.max(360000,duration*3000),
   verifyOutput:async ({check:exportCheck})=>{await waitForStableWavFile(file.nativePath,{rate:48000,channels,duration},{check:exportCheck,sleep,pollIntervalMs:200,deadlineMs:30*60*1000});ready=true;}});
  check();
  scratch=await host.findSequence(project,scratch.guid.toString());
  if(scratchBefore!==await signature(scratch)) throw Error('Analysis timeline changed; rerun quality scan.');
  say('Quality: uploading dialogue to the connected service.');onProgress(8);
  const bytes=await file.read({format:binary});check();
  asset=await (await request('/v1/assets',{method:'POST',headers:{'Content-Type':'audio/wav'},body:bytes})).json();
  check();
  submitted=await (await request('/v1/quality-jobs',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({asset_id:asset.asset_id,threshold,delete_asset_when_done:true})})).json();
  say('Quality: analyzing on the connected service CPU.');
  let result=null;
  const deadline=Date.now()+2*60*60*1000;
  while(Date.now()<deadline) {
   check();
   const status=await (await request(`/v1/quality-jobs/${submitted.job_id}`)).json();
   if(status.status==='done') { result=status.result;break; }
   if(['failed','cancelled'].includes(status.status)) { done=true;throw Error(status.error || 'Quality analysis stopped.'); }
   if(Number.isFinite(status.progress))onProgress(10+.85*Math.max(0,Math.min(100,status.progress)));
   await sleep(500);
  }
  if(!result) throw Error('Quality scan timed out.');
  done=true;check();validateReport(result,duration);
  const active=await project.getActiveSequence();
  if(!active || active.guid.toString()!==sequenceId || before!==await signature(active)) throw Error('Timeline changed; no quality markers added. Rerun the scan.');
  onProgress(100);
  return {...result,regions:timelineRegions(result.regions,offset,clip),scope:clipScope(clip)};
 } finally {
  if(submitted&&!done) { try { await request(`/v1/quality-jobs/${submitted.job_id}`,{method:'DELETE'}); } catch(_) {} }
  if(asset&&!submitted) { try { await request(`/v1/assets/${asset.asset_id}`,{method:'DELETE'}); } catch(_) {} }
  if(ready&&scratch) { try { await project.deleteSequence(await host.findSequence(project,scratch.guid.toString())); } catch(_) { say('Quality analysis copy retained; it can be removed from the project.'); } }
  if(ready&&file) { try { await file.delete(); } catch(_) {} }

 }
}
async function run(options) {
 const {check=()=>{},say=()=>{},onProgress=()=>{}}=options;
 const project=await ppro.Project.getActiveProject(),sequence=project && await project.getActiveSequence();
 if(!sequence)throw Error('Open a sequence and select dialogue clips.');
 const selected=[];
 for(const clip of await inventory(sequence)) if(clip.enabled && await clip.item.getIsSelected())selected.push(clip);
 if(!selected.length)throw Error('Select one or more dialogue audio clips on the timeline first.');
 for(const clip of selected)if(clip.end.seconds-clip.start.seconds<.4||clip.end.seconds-clip.start.seconds>1800)throw Error('Select dialogue clips between 0.4 seconds and 30 minutes long.');
 const sequenceId=sequence.guid.toString(),before=await signature(sequence),reports=[];
 for(let i=0;i<selected.length;i++) {
  check();say(`Quality: selected clip ${i+1}/${selected.length}.`);
  reports.push(await runClip({...options,clip:selected[i],onProgress:p=>onProgress(95*(i+p/100)/selected.length)}));
 }
 check();
 const active=await project.getActiveSequence();
 if(!active||active.guid.toString()!==sequenceId||before!==await signature(active))throw Error('Timeline changed; no quality markers added. Rerun the scan.');
 const markers={added:0,removed:0};
 for(const report of reports) {
  const placed=await placeMarkers(project,await host.findSequence(project,sequenceId),report.regions,report.scope);
  markers.added+=placed.added;markers.removed+=placed.removed;
 }
 onProgress(100);
 return {model:'DNSMOS P.835',clips:selected.length,windows:reports.reduce((n,r)=>n+r.windows,0),truncated:reports.some(r=>r.truncated),markers,reports};
}
module.exports={run,clipScope,timelineRegions,validateReport,placeMarkers};
