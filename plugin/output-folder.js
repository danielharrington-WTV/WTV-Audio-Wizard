// Where the plugin's kept files go (2026-10-05): one "WTVAudioWizard" folder
// inside the export folder shown on the Main tab, so nothing lands loose
// among the project's own files. Works on UXP folder entries (getEntry /
// createFolder / isFolder / name); no Premiere calls.
const OUTPUT_FOLDER_NAME = 'WTVAudioWizard';

async function existingFolder(parent, name) {
  try {
    const entry = await parent.getEntry(name);
    return entry && entry.isFolder ? entry : null;
  } catch (_) { return null; }  // Not there yet.
}

// The WTVAudioWizard folder inside `root`, created on first use. A root that
// is itself named WTVAudioWizard is used as it is, never nested.
async function outputFolder(root) {
  if (String(root.name || '').toLowerCase() === OUTPUT_FOLDER_NAME.toLowerCase()) return root;
  return await existingFolder(root, OUTPUT_FOLDER_NAME) || root.createFolder(OUTPUT_FOLDER_NAME);
}

// Per-sequence clips folder for per-clip Batch Process Dialogue. Stable name, so a
// later run on the same sequence reuses its exports and cleaned stems.
// Order: the folder inside WTVAudioWizard if it exists; otherwise a folder
// from before this layout, loose in the export folder (keeps an in-progress
// project's reuse and its timeline links in one place); otherwise a new one
// inside WTVAudioWizard.
async function clipsFolder(output, root, sequenceName) {
  const name = `${sequenceName}-clips`;
  return await existingFolder(output, name)
    || (root && root !== output ? await existingFolder(root, name) : null)
    || output.createFolder(name);
}

module.exports = {OUTPUT_FOLDER_NAME, outputFolder, clipsFolder};
