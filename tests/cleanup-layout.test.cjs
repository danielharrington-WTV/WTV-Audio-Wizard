const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../plugin',name),'utf8');
test('cleanup checkboxes use UXP-compatible flex rows, never grid',()=>{
 const css=read('style.css'),html=read('index.html');
 const container=css.match(/\.check-grid\s*\{([^}]+)\}/)[1];
 assert.match(container,/display:flex/);assert.doesNotMatch(container,/display:grid/);
 assert.match(css,/\.check-row\s*\{[^}]*display:flex/);
 const section=html.split('id="cleanDialogueSection"')[1].split('id="toggleLevelsStems"')[0];
 for(const id of ['mode','selectedDialogue','processInPlace','handlesEnabled','handleSeconds'])assert.ok(section.includes(`id="${id}"`),id);
});
test('Batch Process Dialogue processing steps live in the Main-tab Batch Process Options menu, in pipeline order, not in Options',()=>{
 const html=read('index.html');
 const menu=html.split('id="processingSection"')[1].split('</div>\r\n</div>')[0];
 const order=['enableEnhancer','enhancer','dialoguePostprocess','deess','deessDeclick','ambienceStem','musicStem'];
 const positions=order.map(id=>menu.indexOf(`id="${id}"`));
 positions.forEach((p,i)=>assert.ok(p>=0,order[i]));
 assert.deepEqual([...positions].sort((a,b)=>a-b),positions);
 const options=html.split('id="tabOptions"')[1];
 for(const id of order)assert.ok(!options.includes(`id="${id}"`),`${id} still in Options`);
 const main=html.split('id="tabMain"')[1].split('id="tabOptions"')[0];
 assert.ok(main.indexOf('id="runCleanDialogue"')<main.indexOf('id="toggleProcessing"'));
});
