// Keep render listeners active while callers verify exported bytes. Legacy
// callers without a verifier retain the bounded event-wait fallback.
const normalizePath = path => String(path || '').replace(/\\/g, '/').toLowerCase();

let inFlight = 0;

function eventOutputPath(event) {
  if (!event || typeof event !== 'object') return '';
  for (const key of ['outputFile', 'outputFilePath', 'outputPath', 'path', 'filePath', 'nativePath']) {
    if (typeof event[key] === 'string' && event[key]) return normalizePath(event[key]);
  }
  return '';
}

function eventMatchesOutput(event, outputNativePath) {
  const expected = normalizePath(outputNativePath);
  if (!expected) return inFlight === 1;
  const fromEvent = eventOutputPath(event);
  if (fromEvent) {
    if (fromEvent === expected) return true;
    const a = fromEvent.replace(/^file:\/\//i, '');
    const b = expected.replace(/^file:\/\//i, '');
    if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
    return false;
  }
  return inFlight === 1;
}

function attachEncoderRenderListeners({ ppro, manager, outputNativePath, check = () => {}, deadlineMs = 5 * 1000, onProgress }) {
  const events = ppro?.EventManager;
  const enc = ppro?.EncoderManager;
  if (!events || !enc || typeof events.addEventListener !== 'function' || !manager) {
    return {
      getSignal() { return { mode: 'poll', usedEvents: false, reason: 'no_event_api' }; },
      async waitForSignal() { return this.getSignal(); },
      dispose() {},
    };
  }

  inFlight++;
  const eventWaitMs = deadlineMs;
  let disposed = false;
  let settled = false;
  let result = { mode: 'poll', usedEvents: false, reason: 'pending' };
  let failure = null;

  const complete = enc.EVENT_RENDER_COMPLETE;
  const errorEv = enc.EVENT_RENDER_ERROR;
  const cancelEv = enc.EVENT_RENDER_CANCEL;
  const progressEv = enc.EVENT_RENDER_PROGRESS;

  const onComplete = event => {
    if (disposed || settled) return;
    try { check(); } catch (err) { failure = err; settled = true; return; }
    if (!eventMatchesOutput(event, outputNativePath)) return;
    settled = true;
    result = { mode: 'events', usedEvents: true, event: event || null };
  };
  const onError = event => {
    if (disposed || settled) return;
    try { check(); } catch (err) { failure = err; settled = true; return; }
    if (!eventMatchesOutput(event, outputNativePath) && inFlight > 1) return;
    settled = true;
    result = { mode: 'poll', usedEvents: false, reason: 'render_error', event: event || null };
  };
  const onCancel = event => {
    if (disposed || settled) return;
    try { check(); } catch (err) { failure = err; settled = true; return; }
    if (!eventMatchesOutput(event, outputNativePath) && inFlight > 1) return;
    settled = true;
    failure = new Error('Premiere canceled the export.');
  };
  const onProgressEvent = event => {
    if (disposed || !onProgress) return;
    try { onProgress(event); } catch (_) { /* status hook */ }
  };

  try {
    events.addEventListener(manager, complete, onComplete);
    events.addEventListener(manager, errorEv, onError);
    events.addEventListener(manager, cancelEv, onCancel);
    if (progressEv && onProgress) events.addEventListener(manager, progressEv, onProgressEvent);
  } catch (_) {
    inFlight = Math.max(0, inFlight - 1);
    return {
      getSignal() { return { mode: 'poll', usedEvents: false, reason: 'listener_failed' }; },
      async waitForSignal() { return this.getSignal(); },
      dispose() {},
    };
  }

  const handlers = [
    [complete, onComplete],
    [errorEv, onError],
    [cancelEv, onCancel],
  ];
  if (progressEv && onProgress) handlers.push([progressEv, onProgressEvent]);

  return {
    getSignal() {
      if (failure) throw failure;
      return result;
    },
    async waitForSignal({ sleep, onWait }) {
      const started = Date.now();
      const deadline = started + eventWaitMs;
      let lastWait = 0;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (settled) return result;
        try { check(); } catch (err) { throw err; }
        const elapsed = Date.now() - started;
        if (onWait && elapsed - lastWait >= 10000) {
          lastWait = elapsed;
          onWait(Math.round(elapsed / 1000));
        }
        if (sleep) await sleep(200);
        else await new Promise(r => setTimeout(r, 200));
      }
      return { mode: 'poll', usedEvents: false, reason: 'event_timeout' };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight = Math.max(0, inFlight - 1);
      for (const [name, handler] of handlers) {
        try { events.removeEventListener(manager, name, handler); } catch (_) { /* host */ }
      }
    },
  };
}

async function exportSequenceWithRenderWait({
  ppro,
  manager,
  sequence,
  exportType,
  outputFile,
  presetFile,
  exportFull,
  outputNativePath,
  check,
  sleep,
  deadlineMs,
  eventWaitMs,
  exportAcceptTimeoutMs,
  onProgress,
  onExportWait,
  verifyOutput,
  rejectedMessage = 'Premiere did not accept the export.',
  exportTimeoutMessage,
}) {
  const path = outputNativePath || outputFile;
  const acceptMs = exportAcceptTimeoutMs ?? deadlineMs ?? 15 * 60 * 1000;
  const eventMs = eventWaitMs ?? 5 * 1000;
  const watcher = attachEncoderRenderListeners({
    ppro, manager, outputNativePath: path, check, deadlineMs: eventMs, onProgress,
  });
  const wait = ms => (sleep ? sleep(ms) : new Promise(r => setTimeout(r, ms)));
  let acceptCancelled = false;
  let acceptTimer;
  const acceptStarted = Date.now();
  if (onExportWait) {
    void (async () => {
      let last = 0;
      while (!acceptCancelled) {
        await wait(15000);
        if (acceptCancelled) break;
        const seconds = Math.round((Date.now() - acceptStarted) / 1000);
        if (seconds > last) {
          last = seconds;
          onExportWait({ phase: 'export_accept', seconds, outputFile: path });
        }
      }
    })();
  }
  try {
    const accepted = await Promise.race([
      manager.exportSequence(sequence, exportType, outputFile, presetFile, exportFull),
      new Promise((_, reject) => {
        acceptTimer=setTimeout(() => reject(new Error(exportTimeoutMessage || `${rejectedMessage.replace(/\.$/, '')}: Premiere did not respond within ${Math.round(acceptMs / 1000)}s. Check for a blocking export or error dialog, then retry. Output: ${path}`)),acceptMs);
      }),
    ]);
    acceptCancelled = true;
    clearTimeout(acceptTimer);
    if (!accepted) throw new Error(rejectedMessage);
    if (verifyOutput) {
      // Keep listeners attached while checking the file immediately. A host
      // event can report cancellation, but never substitutes for valid bytes.
      const verifyCheck = () => { if (check) check(); watcher.getSignal(); };
      verifyCheck();
      await verifyOutput({check: verifyCheck});
      verifyCheck();
      return {...watcher.getSignal(), outputVerified: true};
    }
    return await watcher.waitForSignal({
      sleep,
      onWait: seconds => {
        if (onExportWait) onExportWait({ phase: 'encoder_wait', seconds, outputFile: path });
      },
    });
  } finally {
    clearTimeout(acceptTimer);
    acceptCancelled = true;
    watcher.dispose();
  }
}

module.exports = {
  normalizePath,
  attachEncoderRenderListeners,
  exportSequenceWithRenderWait,
  eventMatchesOutput,
  eventOutputPath,
  _inFlight: () => inFlight,
};
