"""Immutable local inference artifacts, separate from levels/ducking/repair."""
import hashlib
import json
from pathlib import Path
import re
import shutil
import uuid

def digest_file(path):
    with Path(path).open('rb') as file: return hashlib.file_digest(file,'sha256').hexdigest()

def identity(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def site_packages(python):
    # Windows environments: <env>/Lib/site-packages. Linux/macOS: <env>/lib/pythonX.Y/site-packages.
    # The Windows path stays first and alone there, so Windows cache keys do not change.
    env=Path(python).parent.parent
    windows=env/'Lib/site-packages'
    if windows.is_dir(): return [windows]
    return sorted(p for p in (env/'lib').glob('python*/site-packages') if p.is_dir())

def model_identity(base,name,cfg):
    # Small source/config/package metadata hashes, not repeated weight reads.
    files=set((base/'runners').glob('*.py'))
    files.add(base/'service/audio.py')  # Native input conversion policy.
    repo=cfg.get('repo')
    if repo:
        for folder in ('models','src','configs','utils'):
            path=Path(repo)/folder
            files.update(p for p in path.rglob('*') if p.suffix in ('.py','.yaml','.yml','.json') and '__pycache__' not in p.parts)
    python=Path(cfg.get('python','__missing__'))
    for site in site_packages(python):
        if name=='mossformer2': files.update((site/'clearvoice').rglob('*.py'))
        for prefix in ('torch-','torchaudio-','numpy-','scipy-','librosa-','clearvoice-','transformers-','numba-'):
            files.update(site.glob(prefix+'*.dist-info/METADATA'))
    sources=[(str(p.resolve()),digest_file(p)) for p in sorted(files) if p.is_file()]
    python_state=(python.stat().st_size,python.stat().st_mtime_ns) if python.is_file() else None
    return identity({'model':name,'config':cfg,'sources':sources,'python_state':python_state,'policy':'native48-v1'})

class StageCache:
    def __init__(self,root): self.root=Path(root)/'stage-cache'

    def _folder(self,key):
        if not re.fullmatch('[0-9a-f]{64}',key): raise ValueError('Invalid stage key')
        return self.root/key

    def get(self,key,names):
        folder=self._folder(key)
        try:
            manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
            if manifest['key']!=key or sorted(manifest['files'])!=sorted(names): return None
            for name in names:
                if Path(name).name!=name or digest_file(folder/name)!=manifest['files'][name]: return None
            return {'folder':folder,'metadata':manifest['metadata']}
        except (OSError,ValueError,KeyError,TypeError): return None

    def put(self,key,files,metadata,check):
        destination=self._folder(key)
        self.root.mkdir(exist_ok=True)
        temp=self.root/(key+'.tmp-'+uuid.uuid4().hex)
        temp.mkdir()
        try:
            hashes={}
            for name,source in files.items():
                check()
                if Path(name).name!=name: raise ValueError('Invalid cache filename')
                shutil.copyfile(source,temp/name);hashes[name]=digest_file(temp/name)
            (temp/'manifest.json').write_text(json.dumps({'key':key,'files':hashes,'metadata':metadata},allow_nan=False),encoding='utf-8')
            check()
            if destination.exists():
                if self.get(key,list(files)): return
                # Retain corrupt artifacts for diagnosis; never overwrite files
                # in job/Premiere output directories.
                destination.rename(self.root/(key+'.invalid-'+uuid.uuid4().hex))
            temp.rename(destination)
        finally:
            if temp.exists():
                for child in temp.iterdir(): child.unlink()
                temp.rmdir()
