from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)

class Stem(Strict):
    name: Literal['dialogue', 'music', 'effects']
    # Up to -3 dBFS since 0.7.3 (2026-10-15): the YouTube preset needs about
    # -4 dBFS dialogue peaks to reach -14 LUFS.
    target: float = Field(ge=-70, le=-3)
    duck: bool = False

class Settings(Strict):
    version: int = Field(default=1, ge=1, le=1)
    separator: Literal['bandit_v2', 'provided_stems'] = 'bandit_v2'
    # sidon = speech restoration (regenerates the voice without noise or room sound);
    # the panel's Restore Speech button uses it with dialogue_postprocess off.
    enhancer: Literal['mossformer2', 'gap_urgenet', 'sidon', 'none'] = 'gap_urgenet'
    enhancer_wet: float = Field(default=1.0, ge=0, le=1)
    ambience_only: bool = False
    separate_ambience: bool = False
    separate_music: bool = False
    # Experimental opt-in: click/pop repair only. De-essing is part of dialogue_postprocess when enabled.
    deess_declick: bool = False
    # Multiband compression, sparse whisper lift, and de-ess after the enhancer.
    # Off = neural cleanup (or raw) output without that finishing chain; mix() skips dialogue RMS/peak targeting too.
    dialogue_postprocess: bool = True
    # De-ess as its own step (panel "De-ess" checkbox, 2026-09-29). None = follow
    # dialogue_postprocess, which is how de-ess ran before it was split out, so
    # older clients keep their behaviour.
    deess: bool | None = None
    stems: list[Stem] = Field(default_factory=lambda: [Stem(name='dialogue', target=-12), Stem(name='music', target=-28, duck=True), Stem(name='effects', target=-30)])
    duck_db: float = Field(default=10, ge=0, le=30)
    attack_ms: float = Field(default=200, ge=10, le=1000)
    release_ms: float = Field(default=1200, ge=50, le=3000)
    threshold_dbfs: float = Field(default=-40, ge=-70, le=-10)
    max_boost_db: float = Field(default=8, ge=0, le=24)
    # Per-clip static speech leveling (service/leveler.py): bring every clip's
    # active-speech RMS to dialogue_level_dbfs before compression so whispered
    # and full-voice takes come out at the same volume. The -12 dialogue stem
    # target above stays the compressor's peak ceiling.
    level_dialogue: bool = True
    # Dialogue compressor (compressor.py), exposed 2026-10-15. Defaults are the
    # values the compressor always used. (attack_ms/release_ms above are ducking.)
    compressor_attack_ms: float = Field(default=3, ge=0.5, le=50)
    compressor_release_ms: float = Field(default=60, ge=10, le=1000)
    compressor_knee_db: float = Field(default=12, ge=0, le=24)
    compressor_max_reduction_db: float = Field(default=24, ge=0, le=40)
    dialogue_level_dbfs: float = Field(default=-23, ge=-40, le=-12)
    # Remove noise (service/denoise.py, 2026-10-15): a noise print learned with
    # POST /v1/noise-profile, applied to the raw dialogue before anything else.
    # None = off. Only with the raw-audio path (no neural cleanup, no separation).
    denoise_profile_id: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')
    denoise_reduction_db: float = Field(default=12, ge=0, le=40)
    denoise_threshold_db: float = Field(default=6, ge=-6, le=24)
    output_rate: Literal[44100, 48000, 96000] = 48000

    @property
    def deess_enabled(self):
        return self.dialogue_postprocess if self.deess is None else self.deess

    @property
    def output_stems(self):
        if self.ambience_only: return ['effects']
        return ['dialogue'] + (['effects'] if self.separate_ambience else []) + (['music'] if self.separate_music else [])

    @model_validator(mode='after')
    def names(self):
        if self.ambience_only and (not self.separate_ambience or self.separate_music or self.enhancer != 'none' or self.dialogue_postprocess or self.deess_enabled or self.deess_declick or any(s.duck for s in self.stems if s.name == 'effects')):
            raise ValueError('Ambience-only requires ambience extraction without dialogue processing, music or ducking')
        if sorted(s.name for s in self.stems) != ['dialogue', 'effects', 'music']:
            raise ValueError('Exactly one dialogue, music and effects stem is required')
        if self.denoise_profile_id and (self.enhancer != 'none' or self.separate_music or self.separate_ambience
                                        or self.ambience_only or self.separator != 'bandit_v2'):
            raise ValueError('Remove noise works on raw audio only: no neural cleanup and no stem extraction')
        return self

class DeplosiveRequest(Strict):
    asset_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    # Bounded to the supported 30-minute clip workflow.
    # attenuate_pop's own ValueError for a
    # seed outside the signal's actual duration catches anything shorter.
    seed_seconds: float = Field(ge=0, le=1800)

class LowEndRequest(Strict):
    intensity: float = Field(default=1.0, ge=0.2, le=3.0)
    # A whole-file effect (unlike DeplosiveRequest above) -- no seed needed.
    asset_id: str = Field(pattern=r'^[0-9a-f]{32}$')

class NoiseProfileRequest(Strict):
    # An uploaded render of noise only (the panel's Learn noise: sequence In/Out).
    asset_id: str = Field(pattern=r'^[0-9a-f]{32}$')

class QualityRequest(Strict):
    asset_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    threshold: float = Field(default=1.5, ge=1, le=5)
    delete_asset_when_done: bool = False

class Track(Strict):
    asset_id: str = Field(pattern=r'^[0-9a-f]{32}$')
    role: Literal['mixture', 'dialogue', 'music', 'effects'] = 'mixture'

class JobRequest(Strict):
    stage_mode: Literal["complete", "dialogue_cache"] = "complete"
    require_dialogue_cache: bool = False
    # Panel "Don't use cached files": run again instead of reusing an earlier job or
    # stage-cache entry. Results are still stored. Not part of the job fingerprint.
    fresh: bool = False
    tracks: list[Track] = Field(min_length=1, max_length=3)
    settings: Settings = Field(default_factory=Settings)

    @model_validator(mode='after')
    def roles(self):
        if self.stage_mode == 'dialogue_cache' and (self.settings.enhancer == 'none' or self.settings.separate_ambience or self.settings.separate_music or self.settings.separator != 'bandit_v2' or self.require_dialogue_cache):
            raise ValueError('Dialogue cache pass requires raw input, an enhancer and no separation')
        if self.require_dialogue_cache and self.settings.enhancer == 'none':
            raise ValueError('Required dialogue cache needs an enhancer')
        roles = sorted(t.role for t in self.tracks)
        expected = ['dialogue', 'effects', 'music'] if self.settings.separator == 'provided_stems' else ['mixture']
        if roles != expected:
            raise ValueError(f'This separator requires roles {expected}')
        return self
