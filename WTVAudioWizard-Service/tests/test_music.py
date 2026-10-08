import numpy as np
import pytest
from pydantic import ValidationError
from service.music import MusicAnalysis, analyze, simplify

def settings(**kw):
    return MusicAnalysis(music_asset='a'*32, dialogue_asset='b'*32, **kw)

def source(seconds=4):
    t=np.arange(seconds*48000)/48000
    return (.1*np.sin(2*np.pi*440*t))[:,None]

def at(plan,t):
    points=np.array(plan['points'])
    return np.interp(t,points[:,0],points[:,1])

def test_rms_target_and_silent_dialogue():
    x=source(); plan=analyze(x,np.zeros_like(x),48000,settings(target_mode='rms'))
    assert plan['measured_music_rms_dbfs']==pytest.approx(-23.0103,abs=.001)
    assert plan['baseline_gain_db']==pytest.approx(-4.9897,abs=.001)
    assert len(plan['points'])==2
    assert plan['speech_regions']==0
    assert plan['dialogue_active_percent']==0 and plan['music_ducked_percent']==0
    assert 'No dialogue detected' in plan['warnings'][0]


def test_peak_target_mode_targets_sample_peak_not_rms():
    x=source(); plan=analyze(x,np.zeros_like(x),48000,settings(target_mode='peak'))
    # source() peaks at .1 -> -20 dBFS; RMS of a sine is ~3 dB below peak.
    assert plan['measured_music_peak_dbfs']==pytest.approx(-20,abs=.01)
    assert plan['target_mode']=='peak'
    assert plan['baseline_gain_db']==pytest.approx(-8,abs=.01)
    # Applying the gain should land the new peak within .1 dB of the target.
    applied_peak=20*np.log10(np.max(np.abs(x))*10**(plan['baseline_gain_db']/20))
    assert applied_peak==pytest.approx(-28,abs=.1)

def test_speech_floor_exposes_continuous_noise_ducking():
    x=source();d=np.full_like(x,.015);d[48000:96000]=.1
    timing=dict(attack_ms=100,release_ms=600)
    low=analyze(x,d,48000,settings(**timing))
    assert low['dialogue_active_percent']==100 and low['music_ducked_percent']==100
    assert 'nearly its entire' in low['warnings'][0]
    high=analyze(x,d,48000,settings(threshold_dbfs=-30,**timing))
    assert high['dialogue_active_percent']==25
    assert 25<high['music_ducked_percent']<60
    assert high['max_music_duck_db']==pytest.approx(10)
    assert not high['warnings']

def test_attack_hold_release_and_overlapping_speech_regions():
    x=source(); d=np.zeros_like(x);d[48000:96000]=.1;d[100800:110400]=.1
    plan=analyze(x,d,48000,settings(attack_ms=100,release_ms=600));g=plan['baseline_gain_db']
    assert at(plan,.8)==pytest.approx(g)
    assert at(plan,.95)==pytest.approx(g-5,abs=.05)
    assert at(plan,1.5)==pytest.approx(g-10)
    assert at(plan,2.05)==pytest.approx(g-10)
    assert at(plan,2.5)==pytest.approx(g-10)
    assert at(plan,2.8)==pytest.approx(g-5,abs=.05)
    assert at(plan,3.2)==pytest.approx(g)

def test_calibration_verifies_rendered_ramp_not_only_key_values():
    x=source();t=np.arange(len(x))/48000
    probe=x*10**((-3-6*t/4)/20)[:,None]
    p=analyze(x,np.zeros_like(x),48000,settings(),probe)
    assert p['calibration']['passed']
    assert p['calibration']['p95_error_db']<.01
    with pytest.raises(ValueError,match='calibration failed'):
        analyze(x,np.zeros_like(x),48000,settings(),x)

def test_silent_or_mismatched_music_cannot_change_timeline():
    x=source()
    with pytest.raises(ValueError,match='silent'):analyze(x*0,x*0,48000,settings())
    quiet=x*.0001
    with pytest.raises(ValueError,match='peak'):analyze(quiet,np.zeros_like(quiet),48000,settings())
    with pytest.raises(ValueError,match='matching'):analyze(x,x[:-1],48000,settings())
    with pytest.raises(ValueError,match='outside'):analyze(x*.02,x*0,48000,settings())

def test_simplified_envelope_stays_within_tolerance():
    t=np.linspace(0,10,501);y=np.sin(t)*8
    p=np.array(simplify(t,y))
    assert np.max(np.abs(np.interp(t,p[:,0],p[:,1])-y))<=.05

def test_music_peak_guard_stops_clipping_without_rendering_new_media():
    x=source()*.2;x[4000]=1
    with pytest.raises(ValueError,match='peaks exceed'):
        analyze(x,np.zeros_like(x),48000,settings())

@pytest.mark.parametrize('kwargs',[{'target_dbfs':float('nan')},{'duck_db':31},{'attack_ms':0},{'target_dbfs':-70}])
def test_invalid_settings_rejected(kwargs):
    with pytest.raises(ValidationError):settings(**kwargs)
