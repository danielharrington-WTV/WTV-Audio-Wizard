"""model_identity must see package metadata in both environment layouts."""
from pathlib import Path

from service.stage_cache import model_identity, site_packages


def make_env(root, site, exe):
    site = root / site
    (site / 'torch-2.0.0.dist-info').mkdir(parents=True)
    (site / 'torch-2.0.0.dist-info' / 'METADATA').write_text('Version: 2.0.0')
    (site / 'clearvoice').mkdir()
    (site / 'clearvoice' / 'x.py').write_text('a = 1')
    python = root / exe
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_text('')
    return python, site


def base(tmp_path):
    (tmp_path / 'runners').mkdir(parents=True)
    (tmp_path / 'runners' / 'r.py').write_text('pass')
    (tmp_path / 'service').mkdir()
    (tmp_path / 'service' / 'audio.py').write_text('pass')
    return tmp_path


def test_windows_layout(tmp_path):
    python, site = make_env(tmp_path / 'env', 'Lib/site-packages', 'Scripts/python.exe')
    assert site_packages(python) == [site]


def test_linux_layout_is_found_and_package_changes_change_the_identity(tmp_path):
    python, site = make_env(tmp_path / 'env', 'lib/python3.10/site-packages', 'bin/python')
    assert site_packages(python) == [site]
    project = base(tmp_path / 'project')
    cfg = {'python': str(python)}
    first = model_identity(project, 'mossformer2', cfg)
    assert model_identity(project, 'mossformer2', cfg) == first
    (site / 'torch-2.0.0.dist-info' / 'METADATA').write_text('Version: 2.0.1')
    second = model_identity(project, 'mossformer2', cfg)
    assert second != first
    (site / 'clearvoice' / 'x.py').write_text('a = 2')
    assert model_identity(project, 'mossformer2', cfg) != second


def test_missing_environment_does_not_fail(tmp_path):
    assert site_packages(tmp_path / 'none' / 'bin' / 'python') == []
    assert model_identity(base(tmp_path / 'p'), 'sidon', {})
