const test=require('node:test'),assert=require('node:assert/strict');
const pf=require('../plugin/project-folders.js');
test('the same project file gives the same key whatever the slashes or case; unsaved projects have none',()=>{
 assert.equal(pf.projectKey('C:\\Edits\\Show\\Ep1.prproj'),pf.projectKey('c:/edits/show/ep1.prproj'));
 assert.notEqual(pf.projectKey('C:/Edits/Show/Ep1.prproj'),pf.projectKey('C:/Edits/Show/Ep2.prproj'));
 for(const none of [null,undefined,'','   ',42])assert.equal(pf.projectKey(none),null);
});
test('each project remembers its own folder token; changing one leaves the other',()=>{
 const a=pf.projectKey('C:/a.prproj'),b=pf.projectKey('C:/b.prproj');
 let raw=pf.remember(null,a,'token-a',1);raw=pf.remember(raw,b,'token-b',2);
 assert.equal(pf.tokenFor(raw,a),'token-a');assert.equal(pf.tokenFor(raw,b),'token-b');
 raw=pf.remember(raw,a,'token-a2',3);
 assert.equal(pf.tokenFor(raw,a),'token-a2');assert.equal(pf.tokenFor(raw,b),'token-b');
 raw=pf.forget(raw,a);assert.equal(pf.tokenFor(raw,a),null);assert.equal(pf.tokenFor(raw,b),'token-b');
});
test('nothing is stored for an unsaved project or an empty token',()=>{
 assert.deepEqual(pf.parse(pf.remember(null,null,'t')).projects,{});
 assert.deepEqual(pf.parse(pf.remember(null,'k','')).projects,{});
 assert.equal(pf.tokenFor(pf.remember(null,'k','t'),null),null);
});
test('corrupt or foreign stored data reads as empty instead of throwing',()=>{
 for(const raw of [null,'','not json','[]','{"projects":7}','{"projects":{"k":{"token":5}}}'])assert.deepEqual(pf.parse(raw).projects,{});
});
test('only the most recently used projects are kept',()=>{
 let raw=null;for(let i=0;i<pf.MAX_PROJECTS+5;i++)raw=pf.remember(raw,'p'+i,'t'+i,i);
 const kept=Object.keys(pf.parse(raw).projects);
 assert.equal(kept.length,pf.MAX_PROJECTS);assert.ok(!kept.includes('p0'));assert.ok(kept.includes('p'+(pf.MAX_PROJECTS+4)));
});
