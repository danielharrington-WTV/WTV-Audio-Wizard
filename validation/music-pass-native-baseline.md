# Music pass native timing baseline (Dan)

Reload the plugin, run **4. Conform & duck selected music** on the ~22 min clone (service stopped). Copy report and fill in measured seconds.

## Expected shape (from design review)

| Phase | Expected share of wall time |
|-------|-----------------------------|
| `render_music` / `render_dialogue` / `render_calibration` (especially `export` sub-phase) | **Majority** (~3× sequence realtime in Premiere) |
| `wav_read` | Moderate (3× full WAV scan) |
| `analyze` | Small (seconds) |
| `guard_unchanged` | Small–moderate (scales with reference clip count; reduced vs full video signature) |
| `apply_*` | Moderate (scales with music clip count) |

## Paste from Copy report

```
Music timing: 
Music render breakdown: 
sequence_duration_s: 
music_clips: 
dialogue_clips: 
```

## Notes

- Partial music selection still exports **full sequence duration**.
- Optional analysis-summary cache is documented as follow-up only (not implemented).
