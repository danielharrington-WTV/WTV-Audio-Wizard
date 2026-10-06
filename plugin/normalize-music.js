const ppro=require('premierepro');
const host=require('./premiere.js');
const {inventory}=require('./per-clip.js');
const {describe}=require('./music-pass.js');
const effects=require('./music-effects.js');
// Preserve the original native capture; this workflow bypasses its limiter and removes band makeup gain.
const broadcastPreset=JSON.parse(JSON.stringify(require('./music-broadcast-preset.json')));
broadcastPreset.params.find(param=>param.name==='LMAX: Bypass').value=1;
// Captured Gain 2/3 value 0.5 is native 0 dB; use it for every band.
for(const band of [1,2,3,4]) broadcastPreset.params.find(param=>param.name===`Gain ${band}`).value=0.5;

// "Peak control" stage: the same verified Multiband Compressor component
// (identical match id/105-param layout as the Broadcast preset above), with
// only Threshold 1-4 and Ratio 1-4 overridden to tame anything louder than
// -30 dB at a 3:1 ratio, no extra output gain. Placed AFTER Broadcast in the
// chain (Dan's choice): Broadcast levels the bed first, then this stage
// catches whatever peaks remain above -30 dB.
//
// These normalized values are NOT a fresh dB->normalized formula guessed for
// this feature -- both mappings are read directly off numbers this exact
// component already shipped in the verified Broadcast preset, the same way
// Amplify's -96..+48 dB range was confirmed elsewhere in this codebase
// (never trust a guessed formula; solve it from a real captured value):
//   - Ratio: Broadcast's own Ratio 1 (0.06896551698446274) and Ratio 2/3
//     (0.03448275849223137) decode to 2/29 and 1/29 under
//     normalized=(ratio-1)/29 -- i.e. stock Broadcast already ships 3:1 on
//     bands 1/4 and 2:1 on bands 2/3, which is what confirms the 1:1..30:1
//     range in the first place. Rather than recompute (3-1)/29 in double
//     precision (which lands a few ULPs away from what Premiere actually
//     stores/reports, since (3-1)/29 recomputed is 0.06896551724137931, not
//     bit-identical to the real captured 0.06896551698446274), this reuses
//     Broadcast's own captured Ratio 1 value directly -- already confirmed
//     live to mean exactly 3:1 on this component, byte-for-byte as Premiere
//     itself will read it back.
//   - Threshold: Broadcast's own Threshold 4 (0.5833333134651184) decodes to
//     an exact -25.0 dB under normalized=(db+60)/60 (a -60..0 dB range) --
//     the only one of the four Broadcast thresholds that lands on a round
//     number under any tested range, which is what confirms -60..0 dB.
//     -30 dB => (-30+60)/60 = 0.5 exactly.
//   - Output Gain: Broadcast's own per-band Gain 2/3 default to exactly 0.5
//     at 0 dB, consistent with Output Gain's confirmed -18..+18 dB range
//     ((-12+18)/36 = Broadcast's captured 0.1666666716337204). 0 dB here is
//     also 0.5 -- this stage adds no extra output gain of its own.
// Both stages use zero band makeup gain and bypass the limiter.
// Attack/Release/crossover/band-count fields are left exactly as
// Broadcast's own verified values (untouched, unguessed). Still verified
// like everything else in this file: configure() reads the live default
// back before writing each param, and verify() re-reads every param after
// Apply -- if Premiere's real behavior doesn't match this decode, verify()
// throws and the clip rolls back rather than silently shipping wrong audio.
const peakPreset=(()=>{
  const clone=JSON.parse(JSON.stringify(broadcastPreset));
  clone.name='Peak control (3:1 above -30 dB)';
  clone.output_gain_db=0;
  const param=name=>clone.params.find(p=>p.name===name);
  const ratio3to1=broadcastPreset.params.find(p=>p.name==='Ratio 1').value;
  param('Output Gain').value=0.5;
  for(const band of [1,2,3,4]) {
    param(`Threshold ${band}`).value=0.5;
    param(`Ratio ${band}`).value=ratio3to1;
  }
  return clone;
})();

// Order matters: this is the actual signal-chain order the stages are
// inserted and configured in (Broadcast, then Peak control).
const STAGES=[broadcastPreset,peakPreset];

const scalar=value=>value && typeof value==='object' && 'value' in value ? value.value : value;
const equal=(a,b)=>((typeof a==='number' || typeof a==='boolean') && (typeof b==='number' || typeof b==='boolean')) ? Math.abs(Number(a)-Number(b))<1e-6 : a===b;
// Spectrum and meter controls are UI state, not Broadcast audio settings.
const audioSetting=index=>index<=21 || (index>=25 && index<=32) || (index>=34 && index<=36) || [48,49,51,52,53,58].includes(index);
async function parameters(component, preset=broadcastPreset) {
  if(await component.getMatchName()!==preset.match || await component.getParamCount()!==preset.params.length)
    throw Error(`Multiband Compressor layout differs from the verified ${preset.name} preset. Copy report with your Premiere version.`);
  const result=[];
  for(const setting of preset.params) {
    const param=await component.getParam(setting.index);
    if(param.displayName!==setting.name) throw Error(`Unexpected compressor parameter ${setting.index}: ${param.displayName}`);
    if(audioSetting(setting.index)) result.push({param,setting});
  }
  return result;
}
// Returns which param indexes need to become static and/or get a new value,
// WITHOUT creating any action yet. On Premiere 26.5.1, ComponentParam value
// actions must be created INSIDE the host.transaction that commits them, and
// every ComponentParam/Component handle must be re-fetched after any prior
// commit -- holding one across a transaction throws "The script object is no
// longer valid" (root-caused and fixed the same way in per-clip.js's
// setClipGains; see HANDOFF.md 2026-09-22, "Native Apply gain error
// diagnosed and fixed"). This function only reads state, so it's safe to
// call with handles from just before a transaction; run() re-fetches fresh
// handles by index before building the actual actions.
async function plan(component, preset=broadcastPreset) {
  const toStatic=[], toSet=[];
  for(const {param,setting} of await parameters(component,preset)) {
    const varying=await param.isTimeVarying();
    const value=scalar(await param.getValueAtTime(ppro.TickTime.createWithSeconds(0)));
    if(!varying && equal(value,setting.value)) continue;
    if(varying) toStatic.push(setting.index);
    toSet.push({index:setting.index, value:setting.value});
  }
  return {toStatic, toSet};
}
async function verify(component, preset=broadcastPreset) {
  for(const {param,setting} of await parameters(component,preset)) {
    if(await param.isTimeVarying() || !equal(scalar(await param.getValueAtTime(ppro.TickTime.createWithSeconds(0))),setting.value))
      throw Error(`${preset.name} compressor verification failed: ${setting.name}`);
  }
}
async function run({check=()=>{},say=()=>{}}={}) {
  const project=await ppro.Project.getActiveProject(), sequence=project && await project.getActiveSequence();
  if(!sequence) throw Error('Open a sequence and select music clips.');
  const sequenceId=sequence.guid.toString(),selected=[];
  for(const entry of await inventory(sequence)) if(await entry.item.getIsSelected()) {
    if(!entry.enabled || entry.muted) throw Error('Enable and unmute the selected music clips first.');
    selected.push(await describe(entry));
  }
  if(!selected.length) throw Error('Select the music clips to normalize.');
  const names=await ppro.AudioFilterFactory.getDisplayNames();
  const effectName=names.find(name=>name.toLowerCase()==='multiband compressor');
  if(!effectName) throw Error('Native Multiband Compressor is unavailable in this Premiere language/build.');
  async function fresh(clip) {
    const active=await project.getActiveSequence();
    if(!active || active.guid.toString()!==sequenceId) throw Error('Active sequence changed during music normalization.');
    const entry=(await inventory(active)).find(e=>e.trackIndex===clip.trackIndex && e.index===clip.index && e.sourceId===clip.sourceId);
    if(!entry) throw Error('Selected music clip disappeared.');
    const result=await describe(entry);
    if(result.key!==clip.key) throw Error('Selected music moved or was retrimmed during normalization.');
    return result;
  }
  let completed=0;
  for(const selectedClip of selected) {
    check();
    let clip=await fresh(selectedClip);
    const before=await effects.snapshot(clip.chain),old=[];
    let insertAt=await clip.chain.getComponentCount();
    for(let i=0;i<await clip.chain.getComponentCount();i++) {
      const component=await clip.chain.getComponentAtIndex(i);
      // Both stages share the same match id, so this removes any Multiband
      // Compressor(s) left by a previous run (one stage or two, old builds
      // included) before reinserting a fresh, correctly-ordered pair.
      if(await component.getMatchName()===broadcastPreset.match) {old.push({index:i,component});insertAt=Math.min(insertAt,i);}
      if(await effects.isAmplifyComponent(component)) insertAt=Math.min(insertAt,i);
    }
    const created=[];
    for(let i=0;i<STAGES.length;i++) created.push(await ppro.AudioFilterFactory.createComponentByDisplayName(effectName,clip.item));
    let committed=false;
    try {
      host.transaction(project,'WTV: normalize music levels (compressors)',compound=>{
        for(const item of [...old].reverse()) compound.addAction(clip.chain.createRemoveComponentAction(item.component));
        created.forEach((component,i)=>compound.addAction(clip.chain.createInsertComponentAction(component,insertAt+i)));
      });
      committed=true;
      clip=await fresh(selectedClip);
      const installed=[];
      for(let i=0;i<STAGES.length;i++) installed.push(await clip.chain.getComponentAtIndex(insertAt+i));
      // Plan against these handles (read-only), but never carry a param/
      // component handle across the transactions below -- see plan()'s
      // comment.
      const toStatic=[], toSet=[]; // [{stage, index[, value]}]
      for(let i=0;i<STAGES.length;i++) {
        const {toStatic:ts, toSet:tv} = await plan(installed[i], STAGES[i]);
        for(const index of ts) toStatic.push({stage:i,index});
        for(const {index,value} of tv) toSet.push({stage:i,index,value});
      }
      check();
      if(toStatic.length) {
        const params=[];
        for(const {stage,index} of toStatic) params.push(await (await clip.chain.getComponentAtIndex(insertAt+stage)).getParam(index));
        host.transaction(project,'WTV: prepare static compressor params',compound=>{for(const param of params) compound.addAction(param.createSetTimeVaryingAction(false));});
        clip=await fresh(selectedClip);
      }
      if(toSet.length) {
        const pairs=[];
        for(const {stage,index,value} of toSet) {
          const param=await (await clip.chain.getComponentAtIndex(insertAt+stage)).getParam(index);
          if(await param.isTimeVarying()) throw new Error(`${STAGES[stage].name} parameter did not become static.`);
          pairs.push({param,value});
        }
        try {
          // Fresh handles, value action created synchronously INSIDE the
          // compound callback -- the fix per HANDOFF.md 2026-09-22.
          host.transaction(project,'WTV: Broadcast + Peak control compressors',compound=>{
            for(const {param,value} of pairs) compound.addAction(param.createSetValueAction(param.createKeyframe(value),true));
          });
        } catch(error) {
          throw new Error(`${error.message} [setting ${pairs.length} compressor param(s)]`);
        }
      }
      clip=await fresh(selectedClip);
      for(let i=0;i<STAGES.length;i++) await verify(await clip.chain.getComponentAtIndex(insertAt+i),STAGES[i]);
      const after=JSON.parse(await effects.snapshot(clip.chain));
      const expected=JSON.parse(before);for(const item of [...old].reverse()) expected.splice(item.index,1);
      for(let i=STAGES.length-1;i>=0;i--) after.splice(insertAt+i,1);
      if(JSON.stringify(after)!==JSON.stringify(expected)) throw Error('Other music effects changed during normalization.');
      completed++;
      say(`Normalize music levels: ${completed}/${selected.length} clips complete.`);
    } catch(error) {
      let restored=false;
      if(committed) try {
        clip=await fresh(selectedClip);
        const added=[];
        for(let i=0;i<STAGES.length;i++) {
          const component=await clip.chain.getComponentAtIndex(insertAt+i);
          if(await component.getMatchName()!==broadcastPreset.match) throw Error('Cannot identify added compressor');
          added.push(component);
        }
        host.transaction(project,'WTV: restore compressors after failed normalization',compound=>{
          for(const component of [...added].reverse()) compound.addAction(clip.chain.createRemoveComponentAction(component));
          for(const item of old) compound.addAction(clip.chain.createInsertComponentAction(item.component,item.index));
        });
        clip=await fresh(selectedClip);
        restored=await effects.snapshot(clip.chain)===before;
      } catch(_) { /* Require inspection for uncertain host transactions. */ }
      throw Error(`${error.message || String(error)} ${completed}/${selected.length} clips completed. ${restored?'Failed clip restored.':'Inspect effects and use Undo if needed.'}`);
    }
  }
  return {clips:completed,stages:STAGES.map(preset=>({preset:preset.name,output_gain_db:preset.output_gain_db}))};
}
module.exports={run,plan,verify,broadcastPreset,peakPreset,STAGES};
