"""Private stdin/stdout protocol. One runner/model per process; no listener."""
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import traceback

class ProgressLog:
    """The runner's stdout: everything goes to the job log, and a line that is
    exactly {"progress": <0-100>} is also relayed to the service as a
    {"id", "progress"} message, so the job's percentage moves during inference."""
    def __init__(self, log, protocol, rid):
        self.log, self.protocol, self.rid, self.pending, self.last = log, protocol, rid, '', None

    def write(self, text):
        self.log.write(text)
        self.pending += text
        *lines, self.pending = self.pending.split('\n')
        for line in lines:
            self._relay(line)
        return len(text)

    def _relay(self, line):
        line = line.strip()
        if not line.startswith('{'):
            return
        try:
            message = json.loads(line)
        except ValueError:
            return
        value = message.get('progress') if isinstance(message, dict) and len(message) == 1 else None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 100 and value != self.last:
            self.last = value
            self.protocol.write(json.dumps({'id': self.rid, 'progress': value}) + '\n'); self.protocol.flush()

    def flush(self):
        self.log.flush()

def main():
    runner = Path(sys.argv[1]).resolve()
    if runner.parent != Path(__file__).resolve().parent or runner.stem not in ('bandit_v2','gap_urgenet','mossformer2','sidon'):
        raise ValueError('Unsupported worker runner')
    protocol = sys.stdout
    module = None
    for line in sys.stdin:
        request = json.loads(line)
        try:
            with open(request['log'], 'w', encoding='utf-8') as log, contextlib.redirect_stdout(ProgressLog(log, protocol, request['id'])), contextlib.redirect_stderr(log):
                try:
                    if module is None:
                        spec = importlib.util.spec_from_file_location('wtv_loaded_runner', runner)
                        module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(module)
                    sys.argv = [str(runner)] + request['args']
                    module.main()
                except BaseException:
                    traceback.print_exc()
                    raise
            response = {'id':request['id'], 'ok':True}
        except BaseException as error:
            response = {'id':request['id'], 'ok':False, 'error':str(error)}
        protocol.write(json.dumps(response)+'\n');protocol.flush()
        if not response['ok']:
            break  # Discard potentially corrupted CUDA/model state.

if __name__ == '__main__':
    main()
