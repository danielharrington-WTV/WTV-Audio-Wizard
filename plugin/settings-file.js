// Portable panel preferences only: never credentials, paths, jobs or track IDs.
const fields={
 mode:['per_clip','full_sequence'],enhancer:['gap_urgenet','mossformer2'],
 handlesEnabled:'boolean',handleSeconds:[0.01,2],selectedDialogue:'boolean',processInPlace:'boolean',enableEnhancer:'boolean',dialoguePostprocess:'boolean',deess:'boolean',autoMute:'boolean',deessDeclick:'boolean',
 ambienceStem:'boolean',musicStem:'boolean',duckEffects:'boolean',stripMusicVolume:'boolean',compressMusicBed:'boolean',
 rawBlend:[0,50],maxBoost:[0,24],dialogue:[-70,-6],music:[-70,-6],effects:[-70,-6],duck:[0,30],speechThreshold:[-60,-15],attack:[10,1000],release:[50,3000],loudnessTarget:[-70,0],loudnessTolerance:[0,10],peakFlag:[-40,0],peakMerge:[0,30],peakMarkers:'boolean',qualityThreshold:[1,5]
};
function validate(data, operation='load') {
 if(!data || data.format!=='WTVAudioWizard settings' || data.schema!==1 || !data.values || typeof data.values!=='object') throw Error('Choose a WTVAudioWizard settings file (schema 1).');
 const values={};
 for(const [id,rule] of Object.entries(fields)) {
  // De-ess was part of dialoguePostprocess until 2026-09-29: older files follow it.
  const fallback=id==='deess'&&typeof data.values.dialoguePostprocess==='boolean'?data.values.dialoguePostprocess:undefined;
  const value=data.values[id] ?? fallback ?? ({autoMute:true,handlesEnabled:false,handleSeconds:0.5,processInPlace:true,loudnessTarget:-24,loudnessTolerance:1,peakFlag:-6,peakMerge:2,peakMarkers:true,qualityThreshold:1.5,rawBlend:0,maxBoost:8})[id];
  const valid=rule==='boolean'?typeof value==='boolean':typeof rule[0]==='number'?typeof value==='number' && Number.isFinite(value) && value>=rule[0] && value<=rule[1]:rule.includes(value);
  if(!valid) throw Error(`Invalid or missing setting: ${id}. Settings ${operation==='save'?'were not saved':'were not loaded'}.`);
  values[id]=value;
 }
 return values;
}
function capture(get) {
 const values={};
 for(const [id,rule] of Object.entries(fields)) values[id]=rule==='boolean'?get(id).checked:typeof rule[0]==='number'?Number(String(get(id).value ?? '').trim() || NaN):get(id).value;
 const data={format:'WTVAudioWizard settings',schema:1,plugin_version:'0.8.4',values};
 validate(data,'save');return data;
}
function apply(get,values) {
 for(const [id,rule] of Object.entries(fields)) if(rule==='boolean') get(id).checked=values[id];else get(id).value=String(values[id]);
}
module.exports={validate,capture,apply,fieldIds:Object.keys(fields)};
