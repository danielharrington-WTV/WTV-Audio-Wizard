"""CPU-only analysis for native Premiere automation. Never writes output audio."""
import numpy as np
from typing import Literal
from pydantic import Field
from .schema import Strict

class MusicAnalysis(Strict):
    music_asset: str = Field(pattern=r'^[0-9a-f]{32}$')
    dialogue_asset: str = Field(pattern=r'^[0-9a-f]{32}$')
    probe_asset: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')
    target_dbfs: float = Field(default=-28, ge=-60, le=-6)
    # 'rms': target_dbfs is the combined active-audio RMS (original/default
    # behaviour). 'peak': target_dbfs is the sample peak of the selected
    # music instead -- what most people expect a "-28 dBFS" fader-style
    # target to mean, and the only way to land ducked peaks at a predictable
    # target_dbfs - duck_db.
    target_mode: Literal['rms', 'peak'] = 'peak'
    duck_db: float = Field(default=10, ge=0, le=30)
    attack_ms: float = Field(default=200, ge=10, le=1000)
    release_ms: float = Field(default=1200, ge=50, le=3000)
    threshold_dbfs: float = Field(default=-40, ge=-60, le=-15)

def levels(x, rate):
    size = round(rate * .02)
    count = (len(x) + size - 1) // size
    result = np.empty(count, np.float64)
    for frame in range(0, count, 128):
        block = x[frame*size:min(len(x), (frame+128)*size)]
        block = np.pad(block, ((0, (-len(block)) % size), (0, 0)))
        value = np.sqrt(np.mean(block.reshape(-1, size, x.shape[1]).astype(np.float64)**2, axis=(1,2)))
        result[frame:frame+len(value)] = value
    return result

def simplify(t, y, tolerance=.05):
    keep = {0, len(t)-1}
    pending = [(0, len(t)-1)]
    while pending:
        a, b = pending.pop()
        if b <= a+1: continue
        expected = y[a] + (y[b]-y[a]) * (t[a+1:b]-t[a]) / (t[b]-t[a])
        errors = np.abs(expected-y[a+1:b])
        i = a+1+int(np.argmax(errors))
        if np.max(errors) > tolerance:
            keep.add(i)
            pending.extend([(a,i),(i,b)])
    if len(keep) > 6000: raise ValueError('Too many activity changes; use a shorter sequence')
    return [[float(t[i]), float(y[i])] for i in sorted(keep)]

def analyze(music, dialogue, rate, settings, probe=None):
    if music.shape != dialogue.shape or len(music)/rate < .4:
        raise ValueError('Analysis renders must have matching layouts and at least 0.4 seconds of audio')
    duration = len(music)/rate
    m, d = levels(music,rate), levels(dialogue,rate)
    active = m[m > 10 ** (-70 / 20)]
    peak_db = float(20 * np.log10(max(float(np.max(np.abs(music))), 1e-15)))
    if peak_db < -70:
        raise ValueError(f'Selected music is silent (peak {peak_db:.1f} dBFS); no gain or keyframes applied')
    measured_rms = float(20 * np.log10(np.sqrt(np.mean(active ** 2)))) if len(active) else peak_db
    measured = peak_db if settings.target_mode == 'peak' else measured_rms
    gain = settings.target_dbfs-measured
    if not -60 <= gain <= 18:
        raise ValueError('Required music gain is outside −60 to +18 dB; adjust the source level first')
    if probe is not None:
        if probe.shape != music.shape: raise ValueError('Calibration render duration/layout mismatch')
        p = levels(probe,rate)
        valid = m > 10**(-45/20)
        if valid.sum() < 5: raise ValueError('Music too quiet/brief to verify Premiere gain mapping')
        centres = np.minimum((np.arange(len(m))+.5)*.02,duration)
        expected = -3-6*centres/duration
        observed = 20*np.log10(np.maximum(p,1e-12)/np.maximum(m,1e-12))
        error = np.abs(observed[valid]-expected[valid])
        median_error, p95_error = float(np.median(error)), float(np.quantile(error,.95))
        if median_error > .3 or p95_error > .8:
            # Report the actual measured error rather than just failing --
            # this is the only place that would otherwise ever see these
            # numbers, and whether it's e.g. 0.4 dB (borderline, plausibly a
            # rounding/systematic-offset issue in the gain encoding) versus
            # 12 dB (the encoding assumption is fundamentally wrong) changes
            # what the next fix should even look like.
            raise ValueError(f'Premiere gain/keyframe calibration failed: median error {median_error:.2f} dB (limit 0.30), '
                              f'95th-percentile error {p95_error:.2f} dB (limit 0.80). Keep track/master processing neutral '
                              'and copy the report; timeline music was not changed')
        calibration = {'passed':True, 'median_error_db':float(np.median(error)), 'p95_error_db':float(np.quantile(error,.95))}
    else:
        calibration = None
    present = d > 10**(settings.threshold_dbfs/20)
    edges = np.diff(np.pad(present.astype(int),(1,1)))
    starts, ends = np.where(edges==1)[0], np.where(edges==-1)[0]
    duck = np.zeros(len(m)+1)
    attack=max(1,round(settings.attack_ms/20)); release=max(1,round(settings.release_ms/20)); hold=10
    for start,end in zip(starts,ends):
        end=min(len(duck)-1,end+hold)
        left=max(0,start-attack); right=min(len(duck),end+release+1)
        duck[left:start]=np.maximum(duck[left:start], settings.duck_db*(np.arange(left,start)-(start-attack))/attack)
        duck[start:end+1]=settings.duck_db
        duck[end:right]=np.maximum(duck[end:right],settings.duck_db*(1-np.arange(right-end)/release))
    times=np.minimum(np.arange(len(duck))*.02,duration)
    # Last partial analysis frame can produce duplicate times; keep one endpoint.
    unique=np.r_[True,np.diff(times)>0]
    points=simplify(times[unique],(gain-duck)[unique])
    centres=np.minimum((np.arange(len(m))+.5)*.02,duration)
    reduction=gain-np.interp(centres,np.array(points)[:,0],np.array(points)[:,1])
    audible=m>10**(-60/20)
    dialogue_percent=float(np.mean(present)*100)
    ducked_percent=float(np.mean(reduction[audible]>.1)*100)
    warnings=[]
    if settings.duck_db>0:
        if not present.any(): warnings.append('No dialogue detected above the speech threshold; no ducking was generated.')
        elif ducked_percent==0: warnings.append('Detected dialogue does not cause ducking during the selected audible music.')
        elif ducked_percent>=95: warnings.append('Music is ducked for nearly its entire audible duration. Check continuous speech, residual noise and the speech threshold.')
    peak=0.0
    curve=np.array(points)
    for offset in range(0,len(music),rate):
        block=music[offset:offset+rate]
        envelope=np.interp((offset+np.arange(len(block)))/rate,curve[:,0],curve[:,1])
        peak=max(peak,float(np.max(np.abs(block)*10**(envelope[:,None]/20))))
    predicted_peak=float(20*np.log10(max(peak,1e-12)))
    if predicted_peak>-.1:
        raise ValueError('Predicted music peaks exceed −0.1 dBFS. Lower the music target or manage its dynamics before applying automation')
    return {'duration':duration,'measured_music_rms_dbfs':measured_rms,'measured_music_peak_dbfs':peak_db,
            'target_dbfs':settings.target_dbfs,'target_mode':settings.target_mode,
            'baseline_gain_db':gain,'predicted_sample_peak_dbfs':predicted_peak,'points':points,'speech_regions':len(starts),'calibration':calibration,
            'threshold_dbfs':settings.threshold_dbfs,'dialogue_active_percent':dialogue_percent,
            'music_ducked_percent':ducked_percent,'max_music_duck_db':float(np.max(reduction[audible])),
            'dialogue_peak_rms_dbfs':float(20*np.log10(max(float(np.max(d)),1e-12))),'warnings':warnings,
            'method':'clean-dialogue energy threshold, 200 ms hold, look-ahead attack and linear release; native effect keyframes'}
