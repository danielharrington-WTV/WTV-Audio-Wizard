# Encoder export events — host acceptance

Run in Premiere Pro **26.x** (EncoderManager events since 25.6) with the updated plugin loaded.

## Per-clip Prepare

1. Connect, per-clip mode, Prepare a small batch (2–3 clips).
2. Watch status during “Waiting for export …” — fast exports should not sit on 1s ticks for the full render when events fire.
3. Copy report should include `Export wait: {"events":N,"poll":M}` with `events > 0` when the host delivered `EVENT_RENDER_COMPLETE`.

## Music pass (optional long clone)

1. Stop the service; run step 4 on the long clone.
2. Copy report should include `Music export wait: {"events":3,"poll":0}` (three analysis exports) when events work.
3. Compare `Music timing:` to a prior run — export **duration** should be similar; idle wait between export start and WAV read may shrink slightly.

## One-time payload spike

Temporarily log the handler argument for `EVENT_RENDER_COMPLETE` (or inspect in a debugger) on one IMMEDIATE export. If Adobe includes an output path field, note its key name for tighter correlation in `plugin/export-sync.js` (`eventOutputPath`).

## Fallback behavior

If events never arrive (forum reports on some builds), the panel should still complete via poll fallback (`poll` counts increase in Copy report) without changing WAV validation errors.
