const test=require('node:test'),assert=require('node:assert/strict');
const {outputFolder,clipsFolder,OUTPUT_FOLDER_NAME}=require('../plugin/output-folder.js');
function dir(name,parent=null){
 const d={name,isFolder:true,children:new Map(),created:[],nativePath:(parent?parent.nativePath+'/':'')+name,
  getEntry:async n=>{if(!d.children.has(n))throw Error('missing');return d.children.get(n);},
  createFolder:async n=>{if(d.children.has(n))throw Error('exists');const c=dir(n,d);d.children.set(n,c);d.created.push(n);return c;}};
 return d;
}
test('kept files go in a WTVAudioWizard folder inside the export folder, created once',async()=>{
 const root=dir('MyProject');const a=await outputFolder(root);const b=await outputFolder(root);
 assert.equal(a.name,OUTPUT_FOLDER_NAME);assert.equal(a,b);assert.deepEqual(root.created,[OUTPUT_FOLDER_NAME]);
});
test('an export folder already named WTVAudioWizard is used as it is, not nested',async()=>{
 const root=dir('wtvaudiowizard');assert.equal(await outputFolder(root),root);assert.deepEqual(root.created,[]);
});
test('a file (not a folder) with that name is not mistaken for the output folder',async()=>{
 const root=dir('P');root.children.set(OUTPUT_FOLDER_NAME,{name:OUTPUT_FOLDER_NAME,isFolder:false});
 await assert.rejects(outputFolder(root),/exists/);
});
test('new sequences get their clips folder inside WTVAudioWizard and reuse it next time',async()=>{
 const root=dir('P'),out=await outputFolder(root);
 const first=await clipsFolder(out,root,'Ep1');assert.equal(first.nativePath,'P/WTVAudioWizard/Ep1-clips');
 assert.equal(await clipsFolder(out,root,'Ep1'),first);assert.equal(root.children.has('Ep1-clips'),false);
});
test('a clips folder from before this layout is still reused in place',async()=>{
 const root=dir('P');const legacy=await root.createFolder('Ep1-clips');const out=await outputFolder(root);
 assert.equal(await clipsFolder(out,root,'Ep1'),legacy);assert.equal(out.children.size,0);
 const other=await clipsFolder(out,root,'Ep2');assert.equal(other.nativePath,'P/WTVAudioWizard/Ep2-clips');
});
test('once both exist the new location wins',async()=>{
 const root=dir('P');await root.createFolder('Ep1-clips');const out=await outputFolder(root);const fresh=await out.createFolder('Ep1-clips');
 assert.equal(await clipsFolder(out,root,'Ep1'),fresh);
});
