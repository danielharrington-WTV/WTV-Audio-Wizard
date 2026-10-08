import numpy as np
import soundfile as sf
import pytest
from service.audio import mix
from service.schema import Settings

def test_ambience_output_does_not_depend_on_unused_raw_dialogue(tmp_path):
    x=np.sin(2*np.pi*1000*np.arange(48000)/48000).astype('float32')[:,None]
    settings=Settings(ambience_only=True,enhancer='none',dialogue_postprocess=False,separate_ambience=True)
    settings.stems[2].target=-18
    outputs=[]
    for level in [0,1]:
        out=tmp_path/str(level)
        mix({'dialogue':x*level,'effects':x*.1},settings,out)
        outputs.append(sf.read(out/'effects.wav')[0])
        assert not (out/'dialogue.wav').exists()
    np.testing.assert_array_equal(*outputs)
    assert settings.output_stems == ['effects']

def test_ambience_only_rejects_hidden_dialogue_processing():
    with pytest.raises(ValueError): Settings(ambience_only=True,separate_ambience=True)
