import numpy as np
import pytest
from runners.mossformer2 import enhance_channel
from service.schema import Settings

@pytest.mark.parametrize('length', [1, 31, 40, 41, 60, 70, 71, 123])
def test_chunk_crossfades_preserve_all_samples_including_tail(length):
    signal = np.linspace(-.4, .8, length, dtype=np.float32)
    result = enhance_channel(signal, lambda block: block, window=40, overlap=10)
    np.testing.assert_allclose(result, signal, atol=1e-7)
    assert result.shape == signal.shape

def test_bad_model_outputs_are_rejected():
    signal = np.ones(50)
    with pytest.raises(ValueError, match='invalid samples'):
        enhance_channel(signal, lambda block: block[:-1], 40, 10)
    with pytest.raises(ValueError, match='invalid samples'):
        enhance_channel(signal, lambda block: block * np.nan, 40, 10)

def test_cleanup_is_default_and_invalid_enhancer_is_rejected():
    assert Settings().enhancer == 'gap_urgenet'
    assert Settings().output_stems == ['dialogue']
    with pytest.raises(ValueError):
        Settings(enhancer='fake')
