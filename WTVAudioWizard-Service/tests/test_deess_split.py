"""Level & compress and De-ess are separate steps (panel checkboxes, 2026-09-29)."""
import numpy as np
import pytest

from service.schema import Settings
from test_service import client, upload, wait  # noqa: F401  (pytest fixture)


def test_deess_follows_level_when_unset_for_older_clients():
    assert Settings().deess_enabled is True
    assert Settings(dialogue_postprocess=False).deess_enabled is False
    assert Settings(dialogue_postprocess=False, deess=True).deess_enabled is True
    assert Settings(dialogue_postprocess=True, deess=False).deess_enabled is False


def test_ambience_only_still_rejects_deess():
    base = dict(ambience_only=True, separate_ambience=True, enhancer='none', dialogue_postprocess=False)
    Settings(**base)
    with pytest.raises(ValueError):
        Settings(**base, deess=True)


@pytest.mark.parametrize('level,deess,compressed,deessed', [
    (True, True, True, True),
    (True, False, True, False),
    (False, True, False, True),
])
def test_level_and_deess_run_independently(client, level, deess, compressed, deessed):
    c, _ = client
    rate = 48000
    t = np.arange(rate * 2) / rate
    speech = (.1 * np.sin(2 * np.pi * 220 * t) * (np.sin(2 * np.pi * 2 * t) > 0)).astype(np.float32)
    aid = upload(c, speech)
    settings = {'enhancer': 'none', 'dialogue_postprocess': level, 'deess': deess, 'deess_declick': False}
    response = c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': settings})
    assert response.status_code == 202, response.text
    job = wait(c, response.json()['job_id'])
    assert job['status'] == 'done', job
    assert (job['result']['compress_dialogue'] is not None) is compressed
    assert (job['result']['deess'] is not None) is deessed
    assert ('deess_seconds' in job['result']['timings']) is deessed


def test_deess_alone_is_enough_to_run_a_job(client):
    c, _ = client
    aid = upload(c, np.zeros(4800, dtype=np.float32))
    body = {'enhancer': 'none', 'dialogue_postprocess': False, 'deess_declick': False, 'separate_music': False, 'separate_ambience': False}
    assert c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {**body, 'deess': False}}).status_code == 422
    assert c.post('/v1/jobs', json={'tracks': [{'asset_id': aid}], 'settings': {**body, 'deess': True}}).status_code == 202
