const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const settings=require('../plugin/settings-file.js');
const source=fs.readFileSync(require.resolve('../plugin/main.js'),'utf8');
const defaultsSource=source.slice(source.indexOf('const FACTORY_DEFAULT_VALUES ='),source.indexOf('const CHANGED_SETTINGS_LABELS'));
const resetSource=source.slice(source.indexOf('function resetActivePresetToDefaults()'),source.indexOf('function updateLevelHelp()'));
function reset(overrides={}) {
 const controls={},stored=new Map([['wtv-quality-threshold','4']]),collapsed=[];
 const $=id=>controls[id]||(controls[id]={value:'999',checked:false,style:{},hidden:false,getAttribute:()=> 'false'});
 const noop=()=>{};
 const box={$: $,settingsFile:settings,settingsLoadedFromFile:true,activePreset:'test',localStorage:{removeItem:key=>stored.delete(key),setItem:(key,value)=>stored.set(key,value)},OPTIONS_UI_KEY:'ui',showSettings:noop,presetDefaults:()=>({}),presetOverrides:()=>overrides,presetLabel:()=> 'Test',updateWorkflow:noop,syncCleanupControls:noop,updateChangedSettingsList:noop,updateScrollIndicators:noop};
 for(const name of ['CleanDialogue','LevelsStems','Ducking','Loudness','Quality'])box['set'+name+'Open']=value=>collapsed.push([name,value]);
 vm.runInNewContext(defaultsSource+resetSource+'\nresetActivePresetToDefaults();globalThis.defaults=FACTORY_DEFAULT_VALUES;',box);
 return {controls,stored,collapsed,values:settings.capture($).values,defaults:box.defaults};
}
test('reset covers every portable preset field, including dialogue quality',()=>{
 const r=reset();assert.deepEqual(Object.keys(r.defaults).sort(),settings.fieldIds.slice().sort());
 for(const id of settings.fieldIds)assert.equal(r.values[id],r.defaults[id],id);
 assert.equal(r.values.qualityThreshold,1.5);assert.equal(r.stored.has('wtv-quality-threshold'),false);
 assert.ok(r.collapsed.some(([name,value])=>name==='Quality'&&value===false));
});
test('reset respects Natural preset model while resetting every other field',()=>{
 const r=reset({enhancer:'mossformer2'});assert.equal(r.values.enhancer,'mossformer2');
 for(const id of settings.fieldIds)if(id!=='enhancer')assert.equal(r.values[id],r.defaults[id],id);
});
test('all editable panel preferences have reset coverage except deliberate context fields',()=>{
 const html=fs.readFileSync(require.resolve('../plugin/index.html'),'utf8');
 const excluded=['presetSelect','baseUrl','token','newPresetName','duckAgainst'];
 for(const match of html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g))assert.ok(settings.fieldIds.includes(match[1])||excluded.includes(match[1]),`Missing reset coverage: ${match[1]}`);
});
