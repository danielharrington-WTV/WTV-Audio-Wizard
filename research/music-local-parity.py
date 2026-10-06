"""Generate small reference summaries from the existing Python analyzer."""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from service.music import analyze, levels, MusicAnalysis

cases=[]
for rate,channels,mode,pattern,attack,release in [
    (48000,2,'peak','overlap',100,600), (44100,1,'rms','overlap',110,610),
    (96000,2,'peak','continuous',200,1200), (48000,1,'rms','silent',200,1200),
    (48000,2,'peak','overlap',10,50), (48000,1,'peak','disabled',200,1200)]:
    t=np.arange(round(rate*4.137))/rate
    x=(.1*np.sin(2*np.pi*440*t))[:,None]*np.ones((1,channels))
    d=np.zeros_like(x)
    if pattern=='continuous': d[:]=.03
    elif pattern!='silent':
        d[round(rate):round(2*rate)]=.1
        d[round(2.1*rate):round(2.3*rate)]=.1
    probe=x*10**((-3-6*t/(len(t)/rate))/20)[:,None]
    options=dict(target_mode=mode,attack_ms=attack,release_ms=release,duck_db=0 if pattern=='disabled' else 10)
    settings=MusicAnalysis(music_asset='a'*32,dialogue_asset='b'*32,**options)
    def summary(y):
        n=round(rate*.02)
        return dict(rate=rate,channels=channels,samples=len(y),levels=levels(y,rate).tolist(),
                    peak=float(np.max(np.abs(y))),peaks=[float(np.max(np.abs(y[i:i+n]))) for i in range(0,len(y),n)])
    cases.append(dict(name=f'{rate}-{channels}-{mode}-{pattern}',music=summary(x),dialogue=summary(d),probe=summary(probe),
                      settings=options,expected=analyze(x,d,rate,settings,probe)))
path=Path(__file__).resolve().parents[1]/'validation/music-local-parity.json'
path.write_text(json.dumps(cases,indent=2),encoding='utf-8')
print(f'Wrote {len(cases)} Python reference cases')
