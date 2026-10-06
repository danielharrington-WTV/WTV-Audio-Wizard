const exportSync = require('../plugin/export-sync.js');
const wavHelpers = require('../plugin/wav.js');

function wavMockWithStableRead() {
  return {
    inspectWav: wavHelpers.inspectWav,
    waitForStableWav: async (file, expected, opts) => {
      const bytes = await file.read({ format: opts?.binary });
      return { bytes, exportWait: opts?.renderWaitMode || 'poll' };
    },
  };
}

module.exports = { exportSync, wavHelpers, wavMockWithStableRead };
