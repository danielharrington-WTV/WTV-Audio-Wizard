const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../plugin/settings-file.js');
function controls(){
 const values={handleFrames:30,peakFlag:-6,peakMerge:2,mode:'per_clip',enhancer:'mossformer2',dialogue:-12,music:-28,effects:-30,duck:10,speechThreshold:-40,attack:200,release:1200,qualityThreshold:1.5,rawBlend:15,maxBoost:12,speechLevel:-23,loudnessTarget:-24,loudnessTolerance:1,loudnessDelivery:'broadcast',compAttack:3,compRelease:60,compKnee:12,compMaxReduction:24,musicPeakThreshold:-30,musicPeakRatio:3,noiseReduction:12,noiseThreshold:6};
 const bools=['levelSpeech','handlesEnabled','peakMarkers','processInPlace','selectedDialogue','enableEnhancer','dialoguePostprocess','deess','autoMute','deessDeclick','ambienceStem','musicStem','duckEffects','stripMusicVolume','compressMusicBed'];
 const result=Object.fromEntries(Object.entries(values).map(([id,v])=>[id,{value:String(v)}]));
 for(const id of bools) result[id]={checked:true};
 result.token={value:'secret'};return result;
}
test('portable settings round trip includes panel choices and excludes credentials',()=>{
 const source=controls(),data=api.capture(id=>source[id]);
 assert.ok(!JSON.stringify(data).includes('secret'));
 const target=controls();target.duck.value='2';target.enhancer.value='gap_urgenet';
 api.apply(id=>target[id],api.validate(JSON.parse(JSON.stringify(data))));
 assert.equal(target.duck.value,'10');assert.equal(target.enhancer.value,'mossformer2');assert.equal(target.deessDeclick.checked,true);
});
test('invalid ranges, types, missing values and schemas are rejected before applying',()=>{
 for(const [key,value] of [['duck',31],['attack','200'],['enhancer','unknown'],['deessDeclick',1],['release',null]]) {
  const data=api.capture(id=>controls()[id]);data.values[key]=value;assert.throws(()=>api.validate(data),/Invalid/);
 }
 const data=api.capture(id=>controls()[id]);data.schema=2;assert.throws(()=>api.validate(data),/schema/);
});
test('empty numbers cannot silently become zero',()=>{
 const c=controls();c.duck.value='';assert.throws(()=>api.capture(id=>c[id]),/Invalid/);
});

test('the separator is no longer a setting; old files that contain it still load',()=>{
 const data=api.capture(id=>controls()[id]);
 assert.ok(!('separator' in data.values));
 data.values.separator='av_cass';
 assert.ok(!('separator' in api.validate(data)));
});

test('handles persist in whole frames; older presets default off at 30 frames (frames since 2026-10-14)',()=>{
 const c=controls();c.handleFrames.value='45';
 const data=api.capture(id=>c[id]);assert.equal(api.validate(data).handleFrames,45);
 delete data.values.handlesEnabled;delete data.values.handleFrames;data.values.handleSeconds=0.5;
 const values=api.validate(data);assert.equal(values.handlesEnabled,false);assert.equal(values.handleFrames,30);assert.ok(!('handleSeconds' in values),'old seconds value is ignored');
 for(const value of [0,301,12.5,NaN,'30']) {data.values.handleFrames=value;assert.throws(()=>api.validate(data),/handleFrames/);}
});

test('dialogue quality persists, validates, and older settings default to 1.5',()=>{
 const c=controls();c.qualityThreshold.value='2.2';const data=api.capture(id=>c[id]);assert.equal(api.validate(data).qualityThreshold,2.2);
 const target=controls();api.apply(id=>target[id],api.validate(data));assert.equal(target.qualityThreshold.value,'2.2');
 delete data.values.qualityThreshold;assert.equal(api.validate(data).qualityThreshold,1.5);
 for(const value of [0,6,NaN,'1.5']){data.values.qualityThreshold=value;assert.throws(()=>api.validate(data),/qualityThreshold/);}
});

test('de-ess is its own setting; files from before the split follow Level & compress',()=>{
 const data=api.capture(id=>controls()[id]);assert.equal(data.values.deess,true);
 for(const level of [true,false]){const old=JSON.parse(JSON.stringify(data));delete old.values.deess;old.values.dialoguePostprocess=level;assert.equal(api.validate(old).deess,level);}
 const split=JSON.parse(JSON.stringify(data));split.values.dialoguePostprocess=false;split.values.deess=true;
 const v=api.validate(split);assert.equal(v.dialoguePostprocess,false);assert.equal(v.deess,true);
});

test('Auto mute is a portable setting and older files default it on (2026-10-01)', () => {
 const data=api.capture(id=>controls()[id]);assert.equal(data.values.autoMute,true);
 const old=JSON.parse(JSON.stringify(data));delete old.values.autoMute;assert.equal(api.validate(old).autoMute,true);
 const off=JSON.parse(JSON.stringify(data));off.values.autoMute=false;assert.equal(api.validate(off).autoMute,false);
});

test('Keep raw mix and Max level boost persist, validate, and older files default to 0 % and 8 dB (2026-10-09)',()=>{
 const data=api.capture(id=>controls()[id]);
 assert.equal(api.validate(data).rawBlend,15);assert.equal(api.validate(data).maxBoost,12);
 for(const [key,value] of [['rawBlend',51],['rawBlend',-1],['maxBoost',25]]) {const d=JSON.parse(JSON.stringify(data));d.values[key]=value;assert.throws(()=>api.validate(d),new RegExp(key));}
 delete data.values.rawBlend;delete data.values.maxBoost;
 const values=api.validate(data);assert.equal(values.rawBlend,0);assert.equal(values.maxBoost,8);
});

test('Speech level and Delivery persist; older files fall back to -23 dBFS and a Delivery matching their loudness fields (2026-10-15)',()=>{
 const c=controls();c.speechLevel.value='-16';c.loudnessDelivery.value='youtube';c.loudnessTarget.value='-14';c.peakFlag.value='-2';
 const data=api.capture(id=>c[id]);const v=api.validate(data);
 assert.equal(v.speechLevel,-16);assert.equal(v.loudnessDelivery,'youtube');
 delete data.values.speechLevel;delete data.values.loudnessDelivery;
 const old=api.validate(data);assert.equal(old.speechLevel,-23);assert.equal(old.loudnessDelivery,'youtube','derived from -14 / 1 / -2');
 data.values.loudnessTarget=-24;data.values.peakFlag=-6;assert.equal(api.validate(data).loudnessDelivery,'broadcast');
 data.values.loudnessTarget=-23;assert.equal(api.validate(data).loudnessDelivery,'custom');
 for(const value of [-41,-11,'x']){data.values.speechLevel=value;assert.throws(()=>api.validate(data),/speechLevel/);}
 data.values.speechLevel=-23;data.values.dialogue=-3;assert.equal(api.validate(data).dialogue,-3);data.values.dialogue=-2;assert.throws(()=>api.validate(data),/dialogue/);
});

test('compressor settings persist, validate, and older files get the long-standing defaults (2026-10-15)',()=>{
 const c=controls();c.compAttack.value='10';c.compRelease.value='200';c.compKnee.value='6';c.compMaxReduction.value='12';c.musicPeakThreshold.value='-24';c.musicPeakRatio.value='4';c.levelSpeech.checked=false;
 const data=api.capture(id=>c[id]);const v=api.validate(data);
 assert.deepEqual([v.compAttack,v.compRelease,v.compKnee,v.compMaxReduction,v.musicPeakThreshold,v.musicPeakRatio,v.levelSpeech],[10,200,6,12,-24,4,false]);
 for(const id of ['compAttack','compRelease','compKnee','compMaxReduction','musicPeakThreshold','musicPeakRatio','levelSpeech']) delete data.values[id];
 const old=api.validate(data);
 assert.deepEqual([old.compAttack,old.compRelease,old.compKnee,old.compMaxReduction,old.musicPeakThreshold,old.musicPeakRatio,old.levelSpeech],[3,60,12,24,-30,3,true]);
 for(const [id,value] of [['compAttack',0.2],['compRelease',2000],['compKnee',25],['compMaxReduction',41],['musicPeakThreshold',1],['musicPeakRatio',0.5]]){const d=JSON.parse(JSON.stringify(data));d.values[id]=value;assert.throws(()=>api.validate(d),new RegExp(id));}
});
