"""Checkpoint-compatible inference with one model stage on the GPU at a time."""

import torch

from .gap_urgenet import GAP_URGENet


class GAP_URGENetLowVRAM(GAP_URGENet):
    """Keep idle weights in RAM. Pass CUDA inputs; do not call model.to('cuda').

    This inference-only model is intended for sequential calls, not concurrent
    requests. CPU/GPU transfers trade throughput for lower peak GPU memory.
    """

    def __init__(self, device='cuda:0', **kwargs):
        super().__init__(**kwargs)
        self.execution_device = torch.device(device)
        self.cpu().eval()

    def _run_stage(self, name, *args, **kwargs):
        stage = getattr(self, name)
        try:
            stage.to(self.execution_device)
            return stage(*args, **kwargs)
        finally:
            stage.cpu()
            # Legacy weight_norm caches a computed weight outside parameters
            # and buffers, so Module.cpu() alone leaves that tensor on CUDA.
            for module in stage.modules():
                if hasattr(module, 'weight_g') and hasattr(module, 'weight_v'):
                    module.weight = module.weight.cpu()
            if self.execution_device.type == 'cuda':
                with torch.cuda.device(self.execution_device):
                    torch.cuda.empty_cache()

    @torch.inference_mode()
    def forward(self, x, sr_in, sr_out=None, enable_plc=True):
        if self.training:
            raise RuntimeError('Low-VRAM mode supports inference only; call eval().')
        return super().forward(x.to(self.execution_device), sr_in, sr_out, enable_plc)
