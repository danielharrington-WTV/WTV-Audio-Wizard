import numpy as np
import pytest
from service.lowend import enhance_low_end, peak4


def tone(f=275, amp=.02):
    return (amp*np.sin(2*np.pi*f*np.arange(48000)/48000))[:, None].astype('float32')


@pytest.mark.parametrize('intensity', [.2, 1, 3])
def test_body_gain_and_preserved_timing(intensity):
    x=tone(); original=x.copy()
    y, report=enhance_low_end(x, 48000, intensity)
    gain=np.sqrt(np.mean(y[5000:-5000]**2)/np.mean(x[5000:-5000]**2))
    assert gain == pytest.approx(1+intensity, rel=.01)
    assert y.shape == x.shape and y.dtype == x.dtype
    np.testing.assert_array_equal(x, original)
    assert np.argmax(np.correlate(x[:1000,0],y[:1000,0],'full')) == 999
    assert report['intensity'] == intensity


@pytest.mark.parametrize('frequency', [40, 3000])
def test_outside_body_stays_close(frequency):
    x=tone(frequency);y,_=enhance_low_end(x,48000,3)
    assert np.sqrt(np.mean((y-x)[5000:-5000]**2)) < np.sqrt(np.mean(x*x))*.02


def test_peak_safety_stereo_linked():
    x=np.repeat(tone(275,.85),2,axis=1)
    y,report=enhance_low_end(x,48000,3)
    assert peak4(y,48000) <= 10**(-1/20)+1e-6
    np.testing.assert_array_equal(y[:,0],y[:,1])
    assert report['safety_gain_db'] < 0


@pytest.mark.parametrize('length', [1, 20, 48000])
def test_silence_and_short_clips(length):
    x=np.zeros((length,2),dtype='float32');y,report=enhance_low_end(x,48000)
    np.testing.assert_array_equal(y,x)
    assert not report['applied']


@pytest.mark.parametrize('intensity', [.1, 3.1, float('nan'), float('inf')])
def test_invalid_intensity(intensity):
    with pytest.raises(ValueError): enhance_low_end(tone(),48000,intensity)
