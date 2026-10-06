const test = require('node:test');
const assert = require('node:assert/strict');
const {
  attachEncoderRenderListeners,
  exportSequenceWithRenderWait,
  eventOutputPath,
  _inFlight,
} = require('../plugin/export-sync.js');

const COMPLETE = 'EVENT_RENDER_COMPLETE';
const ERROR = 'EVENT_RENDER_ERROR';
const CANCEL = 'EVENT_RENDER_CANCEL';

function createMockHost({ completeEvent = {}, delayFireMs = 0 } = {}) {
  const listeners = [];
  const manager = {
    async exportSequence(sequence, exportType, outputFile, presetFile, exportFull) {
      assert.equal(outputFile, 'c:/test.wav');
      if (delayFireMs) await new Promise(r => setTimeout(r, delayFireMs));
      for (const l of [...listeners]) {
        if (l.name === COMPLETE) l.handler({ ...completeEvent, outputFile: completeEvent.outputFile || outputFile });
      }
      return true;
    },
  };
  const ppro = {
    EncoderManager: {
      EVENT_RENDER_COMPLETE: COMPLETE,
      EVENT_RENDER_ERROR: ERROR,
      EVENT_RENDER_CANCEL: CANCEL,
    },
    EventManager: {
      addEventListener(target, name, handler) {
        listeners.push({ target, name, handler });
      },
      removeEventListener(target, name, handler) {
        const index = listeners.findIndex(l => l.target === target && l.name === name && l.handler === handler);
        if (index >= 0) listeners.splice(index, 1);
      },
    },
    Constants: { ExportType: { IMMEDIATELY: 'now' } },
  };
  return { ppro, manager, listeners };
}

test('eventOutputPath reads common fields', () => {
  assert.equal(eventOutputPath({ outputFile: 'C:\\out.wav' }), 'c:/out.wav');
  assert.equal(eventOutputPath({}), '');
});

test('attachEncoderRenderListeners increments inFlight until dispose', () => {
  const { ppro, manager } = createMockHost();
  assert.equal(_inFlight(), 0);
  const watcher = attachEncoderRenderListeners({ ppro, manager, outputNativePath: 'c:/a.wav', sleep: async () => {} });
  assert.equal(_inFlight(), 1);
  watcher.dispose();
  assert.equal(_inFlight(), 0);
});

test('exportSequenceWithRenderWait uses events when complete fires', async () => {
  const { ppro, manager, listeners } = createMockHost({ completeEvent: { outputFile: 'c:/test.wav' } });
  const signal = await exportSequenceWithRenderWait({
    ppro,
    manager,
    sequence: { id: 1 },
    exportType: 'now',
    outputFile: 'c:/test.wav',
    presetFile: 'preset.epr',
    exportFull: false,
    outputNativePath: 'c:/test.wav',
    sleep: async () => {},
  });
  assert.equal(signal.mode, 'events');
  assert.equal(listeners.length, 0);
});

test('exportSequenceWithRenderWait falls back to poll without EventManager', async () => {
  const manager = { exportSequence: async () => true };
  const signal = await exportSequenceWithRenderWait({
    ppro: { EncoderManager: {}, Constants: { ExportType: { IMMEDIATELY: 'now' } } },
    manager,
    sequence: {},
    exportType: 'now',
    outputFile: 'c:/test.wav',
    presetFile: 'preset.epr',
    exportFull: false,
    sleep: async () => {},
  });
  assert.equal(signal.mode, 'poll');
  assert.equal(signal.reason, 'no_event_api');
});

test('render error event falls back to poll stabilization', async () => {
  const listeners = [];
  const manager = { exportSequence: async () => true };
  const ppro = {
    EncoderManager: { EVENT_RENDER_COMPLETE: COMPLETE, EVENT_RENDER_ERROR: ERROR, EVENT_RENDER_CANCEL: CANCEL },
    EventManager: {
      addEventListener(target, name, handler) { listeners.push({ target, name, handler }); },
      removeEventListener(target, name, handler) {
        const i = listeners.findIndex(l => l.target === target && l.name === name && l.handler === handler);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    Constants: { ExportType: { IMMEDIATELY: 'now' } },
  };
  const watcher = attachEncoderRenderListeners({ ppro, manager, outputNativePath: 'c:/x.wav', sleep: async () => {} });
  for (const l of listeners) if (l.name === ERROR) l.handler({});
  const signal = await watcher.waitForSignal({ sleep: async () => {} });
  watcher.dispose();
  assert.equal(signal.mode, 'poll');
  assert.equal(signal.reason, 'render_error');
});

test('export rejection throws before waiting', async () => {
  const { ppro, manager } = createMockHost();
  manager.exportSequence = async () => false;
  await assert.rejects(() => exportSequenceWithRenderWait({
    ppro,
    manager,
    sequence: {},
    exportType: 'now',
    outputFile: 'c:/test.wav',
    presetFile: 'preset.epr',
    exportFull: false,
    rejectedMessage: 'nope',
    sleep: async () => {},
  }), /nope/);
});


function validWav() {
  const b=new ArrayBuffer(46),v=new DataView(b);
  for(const [o,t] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']]) [...t].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
  v.setUint32(4,38,true);v.setUint32(16,16,true);v.setUint16(20,1,true);
  v.setUint16(22,1,true);v.setUint32(24,48000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,2,true);
  return b;
}
for(const event of [false,true]) test(`file verification runs immediately alongside listeners (completion event=${event})`,async()=>{
  const {waitForStableWav}=require('../plugin/wav.js');
  const {ppro,manager,listeners}=createMockHost();
  manager.exportSequence=async()=>true;
  const delays=[];let reads=0;
  const signal=await exportSequenceWithRenderWait({ppro,manager,outputFile:'c:/test.wav',
    // Keep the acceptance timeout pending without scheduling a real timer.
    sleep:()=>new Promise(()=>{}),
    verifyOutput:async({check})=>{
      assert.ok(listeners.length>0);
      await waitForStableWav({read:async()=>{
        reads++;
        if(event && reads===1) listeners.find(l=>l.name===COMPLETE).handler({outputFile:'c:/test.wav'});
        return reads===1?new ArrayBuffer(0):validWav();
      }},{rate:48000,channels:1,duration:1/48000},{check,sleep:async ms=>delays.push(ms),pollIntervalMs:200});
    }});
  assert.equal(reads,3); // Event cannot bypass incomplete bytes or two-read stability.
  assert.deepEqual(delays,[200,200]);
  assert.equal(signal.mode,event?'events':'poll');
  assert.equal(signal.outputVerified,true);assert.equal(listeners.length,0);
});
test('cancellation during file verification rejects and removes listeners',async()=>{
  const {ppro,manager,listeners}=createMockHost();manager.exportSequence=async()=>true;
  await assert.rejects(exportSequenceWithRenderWait({ppro,manager,outputFile:'c:/test.wav',sleep:()=>new Promise(()=>{}),
    verifyOutput:async({check})=>{
      listeners.find(l=>l.name===CANCEL).handler({outputFile:'c:/test.wav'});
      check();
    }}),/canceled/);
  assert.equal(listeners.length,0);assert.equal(_inFlight(),0);
});
