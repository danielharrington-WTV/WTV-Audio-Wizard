"""Pure parts of the Linux installer (no network, no GPU)."""
import hashlib
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('setup_linux', Path(__file__).parents[1] / 'scripts/setup_linux.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


@pytest.mark.parametrize('driver,tag', [('580.65.06', 'cu128'), ('570.86', 'cu128'), ('550.163.01', 'cu126'),
                                        ('535.247.01', 'cu126'), ('470.256', None), ('n/a', None)])
def test_cuda_build_follows_the_driver(driver, tag):
    assert setup.cuda_tag(driver) == tag


def test_weights_are_copied_from_a_folder_and_verified(tmp_path):
    source = tmp_path / 'usb' / 'deep'
    source.mkdir(parents=True)
    (source / 'checkpoint-multi.ckpt').write_bytes(b'weights')
    digest = hashlib.sha256(b'weights').hexdigest()
    target = tmp_path / 'work' / 'bandit-v2-multi.ckpt'
    setup.fetch(target, 'http://invalid.invalid/x', 7, digest, tmp_path / 'usb', setup.BANDIT_ALIASES)
    assert target.read_bytes() == b'weights'
    setup.fetch(target, 'http://invalid.invalid/x', 7, digest)  # Present and verified: no download attempted.


def test_a_file_with_the_wrong_hash_is_set_aside_and_never_used(tmp_path):
    (tmp_path / 'usb').mkdir()
    (tmp_path / 'usb' / 'model.pt').write_bytes(b'tampered')
    target = tmp_path / 'work' / 'model.pt'
    with pytest.raises(SystemExit):
        setup.fetch(target, 'http://invalid.invalid/x', None, '0' * 64, tmp_path / 'usb')
    assert not target.exists() and (tmp_path / 'work' / 'model.pt.bad').exists()


def test_pinned_lists_are_complete_and_the_config_matches_the_service(tmp_path, monkeypatch):
    for name, (_, torch, requirements, _) in setup.ENVS.items():
        assert (setup.PROJECT / requirements).is_file(), name
    monkeypatch.setattr(setup, 'CONFIG', tmp_path / 'local-config.json')
    setup.write_config({'sidon': {'python': 'p'}})
    setup.write_config({'mossformer2': {'python': 'q'}})
    import json
    written = json.loads((tmp_path / 'local-config.json').read_text())
    assert set(written) == {'sidon', 'mossformer2', 'retention_days'} and written['retention_days'] == 7
    assert len(list(tmp_path.glob('local-config.json.bak-*'))) == 1


def test_bandit_weights_come_from_the_pinned_hugging_face_mirror():
    # Zenodo timed out from the office (2026-10-09); jsoncx/bandit-v2 has the same file (same size and SHA-256).
    assert setup.BANDIT_URL == f'https://huggingface.co/jsoncx/bandit-v2/resolve/{setup.BANDIT_REVISION}/checkpoint-multi.ckpt'
    assert len(setup.BANDIT_REVISION) == 40 and 'zenodo' not in setup.BANDIT_URL
    assert setup.BANDIT_FILE[1:] == (446680129, 'abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc')
