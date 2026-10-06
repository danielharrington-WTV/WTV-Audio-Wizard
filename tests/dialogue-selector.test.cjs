const test=require('node:test'), assert=require('node:assert/strict');
const {createDialogueSelector}=require('../plugin/dialogue-selector.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup() {
  function element() {
    return {style:{},children:[],listeners:{},value:'',disabled:false,
      set textContent(value) {this.text=value;this.children=[];},get textContent(){return this.text;},
      appendChild(child){this.children.push(child);},addEventListener(name,fn){this.listeners[name]=fn;}};
  }
  const elements=Object.fromEntries(['duckAgainst','refreshDialogueTracks','dialogueTrackList','musicReference','dialogueReferenceSummary'].map(id=>[id,element()]));
  const document={getElementById:id=>elements[id],createElement:element};
  let context={applied:true,id:'one'};
  const choices=new Map();
  const musicPass={
    loadReference:(storage,ctx)=>structuredClone(choices.get(ctx?.id) || {mode:'clean',trackIds:[]}),
    saveReference:(storage,ctx,value)=>choices.set(ctx.id,structuredClone(value)),
    reference:async(ctx,choice)=>({label:choice.mode==='clean' ? 'Clean dialogue · A4' : 'Chosen tracks',
      tracks:[{id:'100',label:'A1 · Interview',muted:false},{id:'101',label:'A2 · Boom',muted:true}]})};
  const ui=createDialogueSelector({document,musicPass,storage:{},getContext:()=>context,onError:error=>{throw error;}});
  return {ui,e:elements,choices,musicPass,setContext:value=>{context=value;}};
}
test('selector defaults to clean dialogue; choosing tracks reveals checkboxes and saves changes',async()=>{
  const s=setup();await s.ui.refresh();
  assert.equal(s.e.duckAgainst.value,'clean');
  assert.equal(s.e.dialogueTrackList.style.display,'none');
  assert.match(s.e.dialogueReferenceSummary.textContent,/A4/);
  s.e.duckAgainst.value='tracks';s.e.duckAgainst.listeners.change();await flush();
  assert.equal(s.e.dialogueTrackList.children.length,2);
  assert.match(s.e.dialogueTrackList.children[1].children[1].textContent,/Boom.*muted/);
  const rows=[...s.e.dialogueTrackList.children];
  const box=rows[0].children[0];box.checked=true;box.listeners.change();
  assert.equal(s.e.dialogueTrackList.children[0],rows[0]);
  await flush();
  assert.equal(s.e.dialogueTrackList.children[0],rows[0]);
  assert.equal(s.e.dialogueTrackList.children[1],rows[1]);
  assert.deepEqual(s.ui.current(),{mode:'tracks',trackIds:['100']});
  s.e.duckAgainst.value='clean';s.e.duckAgainst.listeners.change();await flush();
  assert.equal(s.e.dialogueTrackList.style.display,'none');
  s.e.duckAgainst.value='tracks';s.e.duckAgainst.listeners.change();await flush();
  assert.equal(s.e.dialogueTrackList.children[0].children[0].checked,true);
});
test('changing sequences uses its own preference and restores the earlier sequence choice',async()=>{
  const s=setup();s.choices.set('one',{mode:'tracks',trackIds:['100']});
  await s.ui.refresh();assert.equal(s.e.duckAgainst.value,'tracks');
  s.setContext({applied:true,id:'two'});await s.ui.refresh();assert.equal(s.e.duckAgainst.value,'clean');
  s.setContext({applied:true,id:'one'});await s.ui.refresh();assert.equal(s.e.duckAgainst.value,'tracks');
});
test('a removed track remains visible and can be unchecked',async()=>{
  const s=setup();s.choices.set('one',{mode:'tracks',trackIds:['999']});await s.ui.refresh();
  const row=s.e.dialogueTrackList.children.at(-1);
  assert.match(row.children[1].textContent,/Unavailable/);
  row.children[0].checked=false;row.children[0].listeners.change();await flush();
  assert.deepEqual(s.ui.current().trackIds,[]);
});
test('pending refresh cannot change controls during processing',async()=>{
  const s=setup();let resolve;
  s.musicPass.reference=()=>new Promise(r=>{resolve=r;});
  const pending=s.ui.refresh();s.ui.setBusy(true);
  resolve({label:'Stale response',tracks:[]});await pending;
  assert.equal(s.e.duckAgainst.disabled,true);
  assert.notEqual(s.e.dialogueReferenceSummary.textContent,'Stale response');
});
