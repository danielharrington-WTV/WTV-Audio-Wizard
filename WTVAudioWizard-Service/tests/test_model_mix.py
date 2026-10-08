import numpy as np
import pytest
from service.audio import blend_dialogue
from service.schema import Settings

def test_blend_endpoints_and_linear_stereo_mix():
    dry=np.array([[.4,-.2],[.2,.3]],dtype=np.float32)
    wet=np.array([[.1,-.1],[.1,.2]],dtype=np.float32)
    assert blend_dialogue(dry,wet,0) is dry
    assert blend_dialogue(dry,wet,1) is wet
    np.testing.assert_allclose(blend_dialogue(dry,wet,.25),dry*.75+wet*.25)

@pytest.mark.parametrize('value',[-.1,1.1,float('nan')])
def test_invalid_mix_rejected(value):
    with pytest.raises(ValueError): Settings(enhancer_wet=value)
    with pytest.raises(ValueError): blend_dialogue(np.zeros((2,1)),np.zeros((2,1)),value)

def test_shape_must_match_and_default_preserves_old_behavior():
    assert Settings().enhancer_wet == 1
    with pytest.raises(ValueError): blend_dialogue(np.zeros((2,1)),np.zeros((3,1)),.5)
