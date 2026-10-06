// Runs main.js's real export-folder memory code (not a copy) against fake
// UXP storage, since main.js itself cannot load outside Premiere.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const main=fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8');
const projectFolders=require('../plugin/project-folders.js');
const block=main.slice(main.indexOf('let workFolder = null;'));
const code=block.slice(0,block.indexOf('\n}',block.indexOf('async function setChosenFolder'))+2);
function panel(store=new Map()){
 const state={path:null,tokens:new Map(),failTokens:false};
 const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,v)};
 const fsApi={createPersistentToken:async e=>{if(state.failTokens)throw Error('no tokens');const t='tok:'+e.nativePath;state.tokens.set(t,e);return t;},
  getEntryForPersistentToken:async t=>{const e=state.tokens.get(t);if(!e||e.gone)throw Error('missing');return e;}};
 const host={getProjectPath:async()=>state.path};
 const api=new Function('projectFolders','localStorage','fs','host',code+'\nreturn {sync:syncWorkFolder,choose:setChosenFolder,get folder(){return workFolder},get chosen(){return workFolderChosen},setAuto:e=>{workFolder=e;}};')(projectFolders,localStorage,fsApi,host);
 return {api,state,store};
}
const folder=p=>({nativePath:p,name:p.split('/').pop(),isFolder:true});
test('a chosen folder is remembered per project and restored after a panel reload',async()=>{
 const first=panel();first.state.path='C:/Edits/A.prproj';
 assert.equal(await first.api.choose(folder('D:/exports/a')),true);
 const reloaded=panel(first.store);reloaded.state.path='C:\\Edits\\a.prproj';reloaded.state.tokens=first.state.tokens;
 await reloaded.api.sync();
 assert.equal(reloaded.api.folder.nativePath,'D:/exports/a');assert.equal(reloaded.api.chosen,true);
});
test('switching projects swaps folders; a project with no choice starts with none',async()=>{
 const p=panel();p.state.path='C:/A.prproj';await p.api.choose(folder('D:/a'));
 p.state.path='C:/B.prproj';await p.api.sync();assert.equal(p.api.folder,null);
 await p.api.choose(folder('D:/b'));
 p.state.path='C:/A.prproj';await p.api.sync();assert.equal(p.api.folder.nativePath,'D:/a');
 p.state.path='C:/B.prproj';await p.api.sync();assert.equal(p.api.folder.nativePath,'D:/b');
});
test('the automatic project folder is not carried to another project and is never stored',async()=>{
 const p=panel();p.state.path='C:/A.prproj';await p.api.sync();p.api.setAuto(folder('C:/A'));
 p.state.path='C:/B.prproj';await p.api.sync();assert.equal(p.api.folder,null);
 assert.deepEqual(projectFolders.parse(p.store.get(projectFolders.STORAGE_KEY)||null).projects,{});
});
test('a remembered folder that has gone missing is forgotten and the panel falls back to none',async()=>{
 const p=panel();p.state.path='C:/A.prproj';const f=folder('E:/usb');await p.api.choose(f);
 const again=panel(p.store);again.state.path='C:/A.prproj';again.state.tokens=p.state.tokens;f.gone=true;
 await again.api.sync();assert.equal(again.api.folder,null);
 assert.equal(projectFolders.tokenFor(again.store.get(projectFolders.STORAGE_KEY),projectFolders.projectKey('C:/A.prproj')),null);
});
test('an unsaved project keeps its choice for the session and it is remembered once the project is saved',async()=>{
 const p=panel();p.state.path=null;
 assert.equal(await p.api.choose(folder('D:/scratch')),false);
 await p.api.sync();assert.equal(p.api.folder.nativePath,'D:/scratch');
 p.state.path='C:/New.prproj';await p.api.sync();
 assert.equal(p.api.folder.nativePath,'D:/scratch');
 assert.ok(projectFolders.tokenFor(p.store.get(projectFolders.STORAGE_KEY),projectFolders.projectKey('C:/New.prproj')));
});
test('if the host cannot issue a token the folder still works for the session',async()=>{
 const p=panel();p.state.path='C:/A.prproj';p.state.failTokens=true;
 assert.equal(await p.api.choose(folder('D:/a')),false);assert.equal(p.api.folder.nativePath,'D:/a');
});
