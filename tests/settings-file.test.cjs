const test=require('node:test'),assert=require('node:assert/strict');
const api=require('../plugin/settings-file.js');
function controls(){
 const values={handleSeconds:0.5,peakFlag:-6,peakMerge:2,mode:'per_clip',enhancer:'mossformer2',dialogue:-12,music:-28,effects:-30,duck:10,speechThreshold:-40,attack:200,release:1200,qualityThreshold:1.5,loudnessTarget:-24,loudnessTolerance:1};
 const bools=['handlesEnabled','peakMarkers','processInPlace','selectedDialogue','enableEnhancer','dialoguePostprocess','deess','autoMute','deessDeclick','ambienceStem','musicStem','duckEffects','stripMusicVolume','compressMusicBed'];
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

test('handles persist and older presets default off',()=>{
 const c=controls();c.handleSeconds.value='1.5';
 const data=api.capture(id=>c[id]);assert.equal(api.validate(data).handleSeconds,1.5);
 delete data.values.handlesEnabled;delete data.values.handleSeconds;
 const values=api.validate(data);assert.equal(values.handlesEnabled,false);assert.equal(values.handleSeconds,0.5);
 for(const value of [0,3,NaN]) {data.values.handleSeconds=value;assert.throws(()=>api.validate(data),/handleSeconds/);}
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
