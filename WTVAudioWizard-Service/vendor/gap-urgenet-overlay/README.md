# GAP-URGENet overlay

Two files copied from the working Windows checkout of `Xiaobin-Rong/gap-urgenet` (MIT, see `LICENSE`), which differs from upstream commit `fbf467378fbfd27dd8fd8d0318c05a98eb926705`:

- `models/gap_urgenet.py`: the upstream model with intermediate tensors released between stages (`_run_stage`, `del`). Same checkpoints, same call.
- `models/gap_urgenet_low_vram.py`: an optional variant that keeps one stage on the GPU at a time. The service does not use it today.

`scripts/setup_linux.py` clones upstream at that commit and copies these files over it, so Linux runs the same model code as the Windows PC.
