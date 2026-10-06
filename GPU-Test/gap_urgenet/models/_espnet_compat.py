"""The two tiny ESPnet helpers GAP-URGENet imports, vendored so GPU-Test does not
need the full ``espnet`` package (hundreds of MB of transitive dependencies).

Copied from espnet 202511:
  * espnet2/enh/separator/abs_separator.py        -> AbsSeparator
  * espnet2/torch_utils/get_layer_from_string.py  -> get_layer

ESPnet is Apache-2.0 licensed; see LICENSES/LICENSE_espnet.
"""
import difflib
from abc import ABC, abstractmethod
from collections import OrderedDict
from typing import Dict, Optional, Tuple

import torch


class AbsSeparator(torch.nn.Module, ABC):
    @abstractmethod
    def forward(
        self,
        input: torch.Tensor,
        ilens: torch.Tensor,
        additional: Optional[Dict] = None,
    ) -> Tuple[Tuple[torch.Tensor], torch.Tensor, OrderedDict]:
        raise NotImplementedError

    def forward_streaming(
        self,
        input_frame: torch.Tensor,
        buffer=None,
    ):
        raise NotImplementedError

    @property
    @abstractmethod
    def num_spk(self):
        raise NotImplementedError


def get_layer(l_name, library=torch.nn):
    """Return a layer class from ``library`` by case-insensitive name, e.g. 'prelu' -> torch.nn.PReLU."""
    all_torch_layers = [x for x in dir(torch.nn)]
    match = [x for x in all_torch_layers if l_name.lower() == x.lower()]
    if len(match) == 0:
        close_matches = difflib.get_close_matches(l_name, [x.lower() for x in all_torch_layers])
        raise NotImplementedError(
            "Layer with name {} not found in {}.\n Closest matches: {}".format(l_name, str(library), close_matches)
        )
    elif len(match) > 1:
        close_matches = difflib.get_close_matches(l_name, [x.lower() for x in all_torch_layers])
        raise NotImplementedError(
            "Multiple matchs for layer with name {} not found in {}.\n "
            "All matches: {}".format(l_name, str(library), close_matches)
        )
    else:
        return getattr(library, match[0])
