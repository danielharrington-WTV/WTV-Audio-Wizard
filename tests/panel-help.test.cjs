const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../plugin/index.html'),'utf8');
const main=fs.readFileSync(path.join(__dirname,'../plugin/main.js'),'utf8');
test('all action/tab controls have hover descriptions and old help controls are absent',()=>{
 for(const tag of html.match(/<div[^>]*role="(?:button|tab)"[^>]*>/g))assert.match(tag,/title="[^"]+"/);
 assert.doesNotMatch(html,/HelpToggle|HelpClose|HelpPopover|button-group/);
 assert.doesNotMatch(main,/HelpToggle|HelpClose|HelpPopover/);
});
test('every registered panel button exists in the markup',()=>{
 const list=main.match(/for \(const id of \[([\s\S]*?)\]\) makeButtonDiv/)[1];
 for(const match of list.matchAll(/'([^']+)'/g))assert.ok(html.includes(`id="${match[1]}"`),match[1]);
});
test('the folder button chooses when there is no folder, and Change re-chooses and remembers per project (2026-10-05)',()=>{
 const render=main.slice(main.indexOf('function renderDestinationFolder()'),main.indexOf('function updateActions()'));
 const none=render.slice(render.indexOf("label.textContent = 'No folder'"));
 assert.match(none,/btn\.disabled = busy;/);assert.doesNotMatch(none.split('void host.getProjectFolder')[0],/btn\.disabled = true/);
 const open=main.slice(main.indexOf('async function openDestinationFolder()'),main.indexOf('async function chooseExportFolder()'));
 assert.match(open,/if \(!folder\) \{ await chooseExportFolder\(\); return; \}/);
 const choose=main.slice(main.indexOf('async function chooseExportFolder()'),main.indexOf('async function resolveWorkFolder('));
 assert.match(choose,/pickFolder\(workFolderChosen \? workFolder : null\)/);assert.match(choose,/await setChosenFolder\(chosen\)/);
 const pick=main.slice(main.indexOf('async function pickFolder('),main.indexOf('async function openDestinationFolder()'));
 assert.match(pick,/initial \|\| await host\.getProjectFolder\(fs\)/);
 assert.match(main,/action\('changeFolder', async \(\) => \{ await chooseExportFolder\(\); \}\)/);
 assert.ok(html.includes('id="changeFolder"'));
});
test('every kept file goes through the WTVAudioWizard output folder; Full sequence no longer prompts for one (2026-10-05)',()=>{
 assert.equal((main.match(/\(await resolveOutputFolder\(context\)\)\?\.output/g)||[]).length,3);
 const apply=main.slice(main.indexOf('async function doApply()'),main.indexOf('function workflowButtonState()'));
 assert.match(apply,/await resolveOutputFolder\(context\)/);assert.doesNotMatch(apply,/pickFolder\(/);
 const prepare=main.slice(main.indexOf('async function doPrepare()'),main.indexOf('async function doApply()'));
 assert.match(prepare,/await resolveOutputFolder\(context\)/);assert.doesNotMatch(prepare,/resolveWorkFolder\(/);
});
