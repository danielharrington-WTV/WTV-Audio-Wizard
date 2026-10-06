const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { exportSync, wavMockWithStableRead } = require('./plugin-test-require.cjs');
// local-dsp.js is pure JS with no dependencies (see its file-level comment),
// so it's loaded for real here rather than mocked -- both to synthesize
// realistic test WAVs and because deplosive.js now runs attenuatePop
// in-panel instead of calling the /v1/deplosive service (2026-09-22).
const localDsp = require('../plugin/local-dsp.js');

// Real Premiere TickTime.ticks is a STRING (confirmed by the 2026-09-10
// workflow review). A numeric ticks value here would hide the exact bug
// that review caught -- comparing ticks with </>= sorts text, not time.
function tick(seconds) {
  return {seconds, ticks: String(Math.round(seconds * 254016000000)), subtract(other) { return tick(this.seconds - other.seconds); }};
}

// Builds a synthetic clip-local WAV: a quiet baseline tone with one sharp,
// louder burst centered at `burstSeconds` (the file-local time -- i.e. what
// the rendered, clip-relative WAV would actually contain), so attenuatePop's
// real RMS-envelope walk has something genuine to find and attenuate.
function makeTestWav({rate = 48000, channels = 2, durationSeconds = 4, burstSeconds = 1.5, burstMs = 60} = {}) {
  const length = Math.round(durationSeconds * rate);
  const seed = Math.round(burstSeconds * rate);
  const halfBurst = Math.round((burstMs / 1000) * rate / 2);
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(length);
    for (let i = 0; i < length; i++) arr[i] = 0.01 * Math.sin(i * 0.05);
    for (let i = Math.max(0, seed - halfBurst); i < Math.min(length, seed + halfBurst); i++) arr[i] += 0.85 * Math.sin(i * 0.9);
    chans.push(arr);
  }
  return localDsp.writeWavFloat(rate, chans);
}

function setup({playheadSeconds = 1.5, clipStart = 0, clipEnd = 4, inPoint = 0, muted = false, transitions = 0, renderedAudio} = {}) {
  const calls = [];
  const dialogueSource = {getId: () => 'dialogue-original', getMediaFilePath: async () => 'C:/dialogue.wav'};
  const dialogueItem = {
    getInPoint: async () => tick(inPoint), getOutPoint: async () => tick(inPoint + clipEnd - clipStart),
    getProjectItem: async () => dialogueSource, getSpeed: async () => 1, isSpeedReversed: async () => false,
    getName: async () => 'dialogue clip', createSetDisabledAction: () => () => {}, getIsSelected: async () => true,
  };
  const dialogueEntry = {item: dialogueItem, trackIndex: 0, index: 0, sourceId: 'dialogue-original',
    start: tick(clipStart), end: tick(clipEnd), duration: clipEnd - clipStart, enabled: true, muted, transitions};

  function makeSequence(entries) {
    const seq = {
      guid: {toString: () => `seq-${seq.serial}`}, serial: makeSequence.serial = (makeSequence.serial ?? -1) + 1,
      entries,
      getPlayerPosition: async () => tick(playheadSeconds),
      getAudioTrackCount: async () => 1,
      getAudioTrack: async () => ({setMute: async () => { calls.push('unmute-render'); return true; }}),
      getSettings: async () => ({getAudioSampleRate: async () => ({value: 48000}), getAudioChannelCount: async () => 2}),
      getProjectItem: async () => ({createSetNameAction: () => () => {}}),
      createSetInPointAction: () => () => {}, createSetOutPointAction: () => () => {},
      createCloneAction: () => () => {
        const clone = makeSequence(entries.map(e => ({...e})));
        sequences.push(clone);
      },
    };
    return seq;
  }
  const sequences = [];
  const original = makeSequence([dialogueEntry]);
  sequences.push(original);

  const rootItems = [];
  let nextId = 1;
  function makeBin(name) {
    const items = [];
    return {name, items, getItems: async () => items.slice(), getId: () => `bin-${name}`};
  }
  const root = {name: 'Root', getItems: async () => rootItems.slice(), getId: () => 'root',
    createBinAction(name) {return () => {rootItems.push(makeBin(name));};}};
  const project = {
    getActiveProject: undefined,
    getActiveSequence: async () => original,
    getSequences: async () => sequences,
    lockedAccess(fn) { fn(); },
    executeTransaction(build) { const actions = []; build({addAction: a => actions.push(a)}); actions.forEach(a => a()); return true; },
    deleteSequence: async s => { calls.push('delete-scratch'); const i = sequences.indexOf(s); if (i >= 0) sequences.splice(i, 1); return true; },
    importFiles: async (paths, _suppress, target) => {
      const dest = target.items ?? rootItems;
      for (const p of paths) dest.push({getId: () => `imported-${nextId++}`, getMediaFilePath: async () => p, createSetNameAction: () => () => {}, createSetInOutPointsAction: () => () => {}});
      return true;
    },
    getRootItem: async () => root,
  };

  function editorFor(seq) {
    return {createOverwriteItemAction: (item, startTick, ripple, trackIndex) => () => {
      const idx = seq.entries.findIndex(e => e.trackIndex === trackIndex && e.start.ticks === startTick.ticks);
      if (idx < 0) throw new Error('No clip at that position to overwrite');
      const old = seq.entries[idx];
      // A real overwrite places a genuinely new TrackItem wrapping the new
      // ProjectItem -- model that (not just relabeling sourceId) so a
      // second run's locate() actually re-derives the match from this
      // item's own getProjectItem()/getMediaFilePath(), the same as real
      // Premiere would, instead of silently reusing stale mock state.
      const newItem = {
        getInPoint: async () => tick(0), getOutPoint: async () => tick(old.end.seconds - old.start.seconds),
        getProjectItem: async () => item, getSpeed: async () => 1, isSpeedReversed: async () => false,
        getName: async () => 'fixed clip', createSetDisabledAction: () => () => {}, getIsSelected: async () => true,
      };
      seq.entries[idx] = {...old, sourceId: item.getId(), item: newItem};
    }};
  }

  const ppro = {
    Project: {getActiveProject: async () => project},
    ClipProjectItem: {cast: x => x},
    FolderItem: {cast: item => item && item.items ? item : null},
    FolderProjectItem: {cast: item => item && item.items ? item : null},
    TickTime: {TIME_ZERO: tick(0)},
    Constants: {ExportType: {IMMEDIATELY: 1}},
    EncoderManager: {getManager: async () => ({exportSequence: async () => { calls.push('render'); return true; }})},
    SequenceEditor: {getEditor: seq => editorFor(seq)},
  };

  function load(name, requireFn) {
    const box = {module: {exports: {}}, require: requireFn};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../plugin/${name}.js`), 'utf8'), box);
    return box.module.exports;
  }
  const host = load('premiere', n => n === './export-sync.js' ? exportSync : ppro);
  const realTransaction = host.transaction;
  host.transaction = (project, label, build) => { calls.push(label); return realTransaction(project, label, build); };
  const api = load('deplosive', n => ({
    'premierepro': ppro,
    './premiere.js': host,
    './export-sync.js': exportSync,
    './per-clip.js': {inventory: async s => s.entries},
    './wav.js': wavMockWithStableRead(),
    './export-presets.js': {getWavPreset: async () => ({nativePath: 'preset'})},
    './local-dsp.js': localDsp,
  }[n]));

  // The rendered clip's audio is local (clip-relative) time: a burst at
  // (playheadSeconds - clipStart), matching what locate()'s seedSeconds
  // computes -- see deplosive.js's locate() comment on why it's not the
  // source in-point.
  const audio = renderedAudio ?? makeTestWav({durationSeconds: clipEnd - clipStart, burstSeconds: playheadSeconds - clipStart});

  const files = new Map(); // nativePath -> {deleted}
  const outputFolder = {
    createFile: async (name) => {
      if (files.has(name)) throw new Error(`Duplicate file name in test: ${name}`);
      const record = {deleted: false};
      files.set(name, record);
      const file = {
        nativePath: name, written: null,
        read: async () => audio,
        write: async (bytes) => { file.written = bytes; },
        delete: async () => { record.deleted = true; calls.push(`delete-file:${name}`); },
      };
      return file;
    },
  };
  const hooks = {
    check: () => {}, say: () => {}, sleep: async () => {}, binary: 'binary',
    outputFolder,
    // No longer called by deplosive.js (attenuatePop runs in-panel now), but
    // kept in the hook set since run()'s signature still destructures it --
    // harmless if unused (see HANDOFF.md's 2026-09-22 entry).
    request: async () => { throw new Error('deplosive.js should not call request/the network any more'); },
  };
  const context = {applied: true, sequence: original, originalId: 'original', dialoguePaths: ['C:/dialogue.wav'], rate: 48000, channels: 2, name: 'Clone'};
  return {api, context, hooks, calls, sequences, project, dialogueEntry, files, audio};
}

test('happy path: attenuates the clip under the playhead and overwrites just that range', async () => {
  const s = setup();
  const result = await s.api.run(s.context, s.hooks);
  assert.equal(result.seed_seconds, 1.5);
  assert.ok(result.duration_seconds > 0);
  assert.equal(result.max_reduction_db, 16);
  // Original sequence now has the clip replaced by the imported fixed clip.
  assert.equal(s.sequences.length, 1); // render clone was deleted
  assert.equal(s.sequences[0].entries.length, 1);
  assert.notEqual(s.sequences[0].entries[0].sourceId, 'dialogue-original');
  assert.equal(s.sequences[0].entries[0].trackIndex, 0);
  assert.ok(s.calls.includes('render'));
  assert.ok(s.calls.includes('WTV: fix a pop'));
});

test('regression: the fixed clip\'s output file is never deleted (it is the timeline clip\'s live media from here on)', async () => {
  const s = setup();
  const result = await s.api.run(s.context, s.hooks);
  const outputRecord = s.files.get(result.output_path);
  assert.ok(outputRecord, 'output file was created');
  assert.equal(outputRecord.deleted, false);
  // The throwaway isolated-render export IS deleted -- only the final output survives.
  const scratchDeletes = [...s.files.entries()].filter(([name]) => name !== result.output_path);
  assert.ok(scratchDeletes.length >= 1);
  for (const [, record] of scratchDeletes) assert.equal(record.deleted, true);
});

test('regression: the fixed clip is recognized as fixable again on a second run (context.dialoguePaths includes its new path)', async () => {
  const s = setup();
  assert.equal(s.context.dialoguePaths.length, 1);
  const first = await s.api.run(s.context, s.hooks);
  assert.ok(s.context.dialoguePaths.includes(first.output_path));
  // Second run against the now-fixed clip must locate it (not throw "Park the playhead...").
  const second = await s.api.run(s.context, s.hooks);
  assert.equal(second.seed_seconds, 1.5);
  assert.ok(s.context.dialoguePaths.includes(second.output_path));
  assert.notEqual(first.output_path, second.output_path);
});

test('regression: the seed used for attenuation is relative to the rendered clip (timeline-local), not shifted by the source in-point', async () => {
  // run() renders ONLY this clip's timeline range (exportFull=false), so the
  // resulting WAV starts at local time zero == entry.start on the timeline,
  // regardless of the clip's source media in-point. The previous version
  // added the source in-point on top of the timeline-relative offset, which
  // is only correct if the WAV were the full original source file -- for
  // this trimmed clip (in-point 10s, starts at timeline 1s, playhead at
  // 2.2s) that sent 11.2s against what is actually a 4-second rendered
  // file (2026-09-10 workflow review, finding 3).
  const s = setup({playheadSeconds: 2.2, clipStart: 1, clipEnd: 5, inPoint: 10});
  const result = await s.api.run(s.context, s.hooks);
  // The returned report is shifted back to timeline-relative, so it reads
  // consistently with where the user actually parked the playhead: 1.2
  // (file-local, within the 4s rendered file) + clipStart(1) = 2.2.
  assert.ok(Math.abs(result.seed_seconds - 2.2) < 1e-9);
  assert.ok(result.start_seconds <= result.seed_seconds);
  assert.ok(result.end_seconds >= result.seed_seconds);
});

test('regression: playhead containment uses numeric time, not string comparison of ticks across a digit-length boundary', async () => {
  // Real TickTime.ticks: 1s of ticks is "254016000000" (12 digits), 4s is
  // "1016064000000" (13 digits). String comparison would put
  // "508032000000" (playhead 2s) as lexicographically >= "1016064000000"
  // (clip end 4s) since '5' > '1' -- wrongly excluding a playhead that is
  // very much inside the clip's 1-4s range (2026-09-10 workflow review,
  // finding 2). This is exactly that boundary.
  const s = setup({playheadSeconds: 2, clipStart: 1, clipEnd: 4});
  const result = await s.api.run(s.context, s.hooks);
  assert.ok(Math.abs(result.seed_seconds - 2) < 1e-9);
});

test('an unapplied/stale context is treated as a standalone run (derives settings from the sequence itself)', () => {
  // Pre-existing note, not part of the 2026-09-22 local-DSP change: this test
  // previously asserted a rejection with an "Insert clean dialogue" message
  // that doesn't appear anywhere in deplosive.js -- run()'s actual behavior
  // for a non-applied context is the standalone branch a few lines below
  // (see run()'s comment), not a rejection. Corrected to match real behavior
  // rather than leaving a regex that could never have matched.
  return (async () => {
    const s = setup();
    const result = await s.api.run({...s.context, applied: false}, s.hooks);
    assert.ok(result.output_path);
  })();
});

test('works with no WTV session at all: any selected clip, fresh panel, Clean dialogue never run (v0.8.1)', async () => {
  const s = setup();
  const result = await s.api.run(null, s.hooks);
  assert.ok(result.output_path);
  assert.ok(Math.abs(result.seed_seconds - 1.5) < 1e-9);
});

test('requires the playhead to be parked inside the selected clip', async () => {
  const s = setup({playheadSeconds: 10}); // outside the 0-4s clip
  await assert.rejects(s.api.run(s.context, s.hooks), /Park the playhead/);
});

test('rejects a clip with audio transitions on its track', async () => {
  const s = setup({transitions: 1});
  await assert.rejects(s.api.run(s.context, s.hooks), /transitions/);
});

test('rejects sped-up or reversed clips', async () => {
  const s = setup();
  s.dialogueEntry.item.getSpeed = async () => 2;
  await assert.rejects(s.api.run(s.context, s.hooks), /normal-speed/);
});

test('timeline changes between attenuation and placement abort without editing the sequence', async () => {
  const s = setup();
  const originalSay = s.hooks.say;
  s.hooks.say = (message) => {
    originalSay(message);
    if (message === 'Attenuating the pop...') s.sequences[0].entries[0].muted = true; // simulate an edit mid-flight
  };
  await assert.rejects(s.api.run(s.context, s.hooks), /Timeline changed/);
  assert.equal(s.sequences[0].entries[0].sourceId, 'dialogue-original'); // untouched
});

test('never calls the network any more: fix a pop runs entirely in-panel (2026-09-22)', async () => {
  const s = setup();
  await s.api.run(s.context, s.hooks); // hooks.request throws if called; not calling it is the assertion
});

test('regression: still cleans up the scratch render file when attenuation itself throws', async () => {
  const s = setup();
  const originalCreateFile = s.hooks.outputFolder.createFile;
  s.hooks.outputFolder.createFile = async (name) => {
    const file = await originalCreateFile(name);
    if (name.startsWith('popfix-render-')) file.read = async () => { throw new Error('attenuation input unreadable'); };
    return file;
  };
  await assert.rejects(s.api.run(s.context, s.hooks), /attenuation input unreadable/);
  const scratch = [...s.files.entries()].find(([name]) => name.startsWith('popfix-render-'));
  assert.ok(scratch, 'scratch render file was created');
  assert.equal(scratch[1].deleted, true);
});
