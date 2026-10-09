"""Where this machine's service files live: <workspace>/work holds the Python
environments, model files and the data folder (jobs, cache, pairing token).

Order: WTV_WORKSPACE if set; otherwise the nearest folder above the service
folder that has work/service-env (Windows Scripts or Linux bin layout), so the
service folder can sit beside the plugin, inside it, or anywhere below the
workspace; otherwise `default_levels` folders up (2 = the original Windows
layout, 1 = a fresh Linux install, where work/ is created beside the service).
Standard library only: the setup scripts use it before any package exists.
"""
import os
from pathlib import Path


def has_service_env(folder):
    env = Path(folder) / 'work' / 'service-env'
    return (env / 'Scripts' / 'python.exe').is_file() or (env / 'bin' / 'python').exists()


def find_workspace(service_root, default_levels=2):
    explicit = os.environ.get('WTV_WORKSPACE')
    if explicit:
        return Path(explicit).resolve()
    root = Path(service_root).resolve()
    for folder in root.parents:
        if has_service_env(folder):
            return folder
    parents = list(root.parents)
    return parents[min(default_levels, len(parents)) - 1] if parents else root
