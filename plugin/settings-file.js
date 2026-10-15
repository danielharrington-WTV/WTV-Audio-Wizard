// Portable panel preferences only: never credentials, paths, jobs or track IDs.
const fields={
 mode:['per_clip','full_sequence'],enhancer:['gap_urgenet','mossformer2'],
 handlesEnabled:'boolean',handleFrames:[1,300],selectedDialogue:'boolean',processInPlace:'boolean',enableEnhancer:'boolean',dialoguePostprocess:'boolean',deess:'boolean',autoMute:'boolean',deessDeclick:'boolean',
 ambienceStem:'boolean',musicStem:'boolean',duckEffects:'boolean',stripMusicVolume:'boolean',compressMusicBed:'boolean',
 rawBlend:[0,50],maxBoost:[0,24],speechLevel:[-40,-12],levelSpeech:'boolean',compAttack:[0.5,50],compRelease:[10,1000],compKnee:[0,24],compMaxReduction:[0,40],musicPeakThreshold:[-60,0],musicPeakRatio:[1,30],noiseReduction:[0,40],noiseThreshold:[-6,24],dialogue:[-70,-3],music:[-70,-3],effects:[-70,-3],duck:[0,30],speechThreshold:[-60,-15],attack:[10,1000],release:[50,3000],loudnessTarget:[-70,0],loudnessTolerance:[0,10],peakFlag:[-40,0],peakMerge:[0,30],peakMarkers:'boolean',qualityThreshold:[1,5],
 loudnessDelivery:['broadcast','youtube','custom']
};
const {detectDelivery}=require('./delivery.js');
const INTEGER_FIELDS=['handleFrames'];
function validate(data, operation='load') {
 if(!data || data.format!=='WTVAudioWizard settings' || data.schema!==1 || !data.values || typeof data.values!=='object') throw Error('Choose a WTVAudioWizard settings file (schema 1).');
 const values={};
 for(const [id,rule] of Object.entries(fields)) {
  // De-ess was part of dialoguePostprocess until 2026-09-29: older files follow it.
  const fallback=id==='deess'&&typeof data.values.dialoguePostprocess==='boolean'?data.values.dialoguePostprocess:undefined;
  const value=data.values[id] ?? fallback ?? (id==='loudnessDelivery'?detectDelivery(values):undefined) ?? ({autoMute:true,handlesEnabled:false,handleFrames:30,processInPlace:true,loudnessTarget:-24,loudnessTolerance:1,peakFlag:-6,peakMerge:2,peakMarkers:true,qualityThreshold:1.5,rawBlend:0,maxBoost:8,speechLevel:-23,levelSpeech:true,compAttack:3,compRelease:60,compKnee:12,compMaxReduction:24,musicPeakThreshold:-30,musicPeakRatio:3,noiseReduction:12,noiseThreshold:6})[id];
  // Older files carry handleSeconds instead; it is ignored and handleFrames uses its default.
  const valid=rule==='boolean'?typeof value==='boolean':typeof rule[0]==='number'?typeof value==='number' && Number.isFinite(value) && value>=rule[0] && value<=rule[1] && (!INTEGER_FIELDS.includes(id) || Number.isInteger(value)):rule.includes(value);
  if(!valid) throw Error(`Invalid or missing setting: ${id}. Settings ${operation==='save'?'were not saved':'were not loaded'}.`);
  values[id]=value;
 }
 return values;
}
function capture(get) {
 const values={};
 for(const [id,rule] of Object.entries(fields)) values[id]=rule==='boolean'?get(id).checked:typeof rule[0]==='number'?Number(String(get(id).value ?? '').trim() || NaN):get(id).value;
 const data={format:'WTVAudioWizard settings',schema:1,plugin_version:'0.8.7',values};
 validate(data,'save');return data;
}
function apply(get,values) {
 for(const [id,rule] of Object.entries(fields)) if(rule==='boolean') get(id).checked=values[id];else get(id).value=String(values[id]);
}
module.exports={validate,capture,apply,fieldIds:Object.keys(fields)};
