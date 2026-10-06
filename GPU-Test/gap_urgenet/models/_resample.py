"""Vendored copy of ``torchaudio.functional.resample`` (sinc_interp_hann path only).

GPU-Test ships without torchaudio so that users only need a CUDA build of
PyTorch. torchaudio wheels must match the torch build exactly, which is the
most common install failure; this file removes that dependency.

The code below is copied from torchaudio 2.11.0 (torchaudio/functional/functional.py,
functions ``_get_sinc_resample_kernel``, ``_apply_sinc_resample_kernel`` and
``resample``) with only the unused Kaiser-window branch and deprecation shims
removed. With the default arguments it produces identical output.

torchaudio is BSD-2-Clause licensed; see LICENSES/LICENSE_torchaudio_BSD-2-Clause.
"""
import math
from typing import Optional

import torch
from torch import Tensor


def _get_sinc_resample_kernel(
    orig_freq: int,
    new_freq: int,
    gcd: int,
    lowpass_filter_width: int = 6,
    rolloff: float = 0.99,
    device: torch.device = torch.device("cpu"),
    dtype: Optional[torch.dtype] = None,
):
    if not (int(orig_freq) == orig_freq and int(new_freq) == new_freq):
        raise ValueError("Resampling frequencies must be integers.")

    orig_freq = int(orig_freq) // gcd
    new_freq = int(new_freq) // gcd

    if lowpass_filter_width <= 0:
        raise ValueError("Low pass filter width should be positive.")
    base_freq = min(orig_freq, new_freq)
    base_freq *= rolloff

    width = math.ceil(lowpass_filter_width * orig_freq / base_freq)
    idx_dtype = dtype if dtype is not None else torch.float64

    idx = torch.arange(-width, width + orig_freq, dtype=idx_dtype, device=device)[None, None] / orig_freq

    t = torch.arange(0, -new_freq, -1, dtype=dtype, device=device)[:, None, None] / new_freq + idx
    t *= base_freq
    t = t.clamp_(-lowpass_filter_width, lowpass_filter_width)

    # sinc_interp_hann
    window = torch.cos(t * math.pi / lowpass_filter_width / 2) ** 2

    t *= math.pi

    scale = base_freq / orig_freq
    kernels = torch.where(t == 0, torch.tensor(1.0).to(t), t.sin() / t)
    kernels *= window * scale

    if dtype is None:
        kernels = kernels.to(dtype=torch.float32)

    return kernels, width


def _apply_sinc_resample_kernel(
    waveform: Tensor,
    orig_freq: int,
    new_freq: int,
    gcd: int,
    kernel: Tensor,
    width: int,
):
    if not waveform.is_floating_point():
        raise TypeError(f"Expected floating point type for waveform tensor, but received {waveform.dtype}.")

    orig_freq = int(orig_freq) // gcd
    new_freq = int(new_freq) // gcd

    # pack batch
    shape = waveform.size()
    waveform = waveform.view(-1, shape[-1])

    num_wavs, length = waveform.shape
    waveform = torch.nn.functional.pad(waveform, (width, width + orig_freq))
    resampled = torch.nn.functional.conv1d(waveform[:, None], kernel, stride=orig_freq)
    resampled = resampled.transpose(1, 2).reshape(num_wavs, -1)
    target_length = torch.ceil(torch.as_tensor(new_freq * length / orig_freq)).long()
    resampled = resampled[..., :target_length]

    # unpack batch
    resampled = resampled.view(shape[:-1] + resampled.shape[-1:])
    return resampled


def resample(
    waveform: Tensor,
    orig_freq: int,
    new_freq: int,
    lowpass_filter_width: int = 6,
    rolloff: float = 0.99,
) -> Tensor:
    """Band-limited sinc (Hann window) resampling, identical to torchaudio's default."""
    if orig_freq <= 0.0 or new_freq <= 0.0:
        raise ValueError("Original frequency and desired frequency should be positive")

    if orig_freq == new_freq:
        return waveform

    gcd = math.gcd(int(orig_freq), int(new_freq))

    kernel, width = _get_sinc_resample_kernel(
        orig_freq,
        new_freq,
        gcd,
        lowpass_filter_width,
        rolloff,
        waveform.device,
        waveform.dtype,
    )
    return _apply_sinc_resample_kernel(waveform, orig_freq, new_freq, gcd, kernel, width)
