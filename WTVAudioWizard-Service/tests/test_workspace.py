"""The service finds its workspace (the folder holding work/) wherever the service folder sits."""
from pathlib import Path
import subprocess

from service.workspace import find_workspace

SCRIPT = Path(__file__).resolve().parents[1] / 'start-service.sh'


def env(folder, windows=True):
    target = folder / 'work' / 'service-env' / ('Scripts/python.exe' if windows else 'bin/python')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text('')
    return folder


def test_service_folder_beside_or_inside_the_plugin_finds_the_same_workspace(tmp_path, monkeypatch):
    monkeypatch.delenv('WTV_WORKSPACE', raising=False)
    workspace = env(tmp_path / 'files-pasted')
    beside = workspace / 'outputs' / 'WTVAudioWizard-Service'
    inside = workspace / 'outputs' / 'WTVAudioWizard' / 'WTVAudioWizard-Service'
    for folder in (beside, inside):
        folder.mkdir(parents=True)
        assert find_workspace(folder) == workspace


def test_the_nearest_workspace_wins(tmp_path, monkeypatch):
    monkeypatch.delenv('WTV_WORKSPACE', raising=False)
    outer = env(tmp_path / 'outer')
    inner = env(outer / 'outputs', windows=False)
    service = inner / 'WTVAudioWizard' / 'WTVAudioWizard-Service'
    service.mkdir(parents=True)
    assert find_workspace(service) == inner


def test_explicit_setting_wins_and_fallbacks_keep_the_old_defaults(tmp_path, monkeypatch):
    service = tmp_path / 'a' / 'b' / 'WTVAudioWizard-Service'
    service.mkdir(parents=True)
    monkeypatch.delenv('WTV_WORKSPACE', raising=False)
    assert find_workspace(service) == tmp_path / 'a'              # nothing found: two up, as before
    assert find_workspace(service, default_levels=1) == tmp_path / 'a' / 'b'   # fresh Linux install
    monkeypatch.setenv('WTV_WORKSPACE', str(tmp_path / 'elsewhere'))
    assert find_workspace(service) == (tmp_path / 'elsewhere').resolve()


def test_linux_start_script_uses_the_same_rule(tmp_path):
    workspace = env(tmp_path / 'ws', windows=False)
    service = workspace / 'outputs' / 'WTVAudioWizard' / 'WTVAudioWizard-Service'
    service.mkdir(parents=True)
    script = service / 'start-service.sh'
    # Stop right after the workspace is chosen: the fake python is not executable.
    script.write_text(SCRIPT.read_text())
    out = subprocess.run(['bash', str(script)], capture_output=True, text=True, env={'PATH': '/usr/bin:/bin'})
    assert f'Service environment not found at {workspace}/work/service-env/bin/python' in out.stderr
