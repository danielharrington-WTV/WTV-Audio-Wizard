"""One reusable GPU process, serialized admission, idle unload and hard cancel."""
import json
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid

class ModelWorker:
    def __init__(self, idle_seconds=60):
        self.idle_seconds=idle_seconds
        self.lock=threading.RLock()
        self.process=None; self.key=None; self.responses=None; self.timer=None; self.busy=False

    def _stop(self):
        if self.timer: self.timer.cancel(); self.timer=None
        process=self.process
        self.process=None; self.key=None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            for pipe in (process.stdin,process.stdout):
                if pipe: pipe.close()

    def release_idle(self):
        with self.lock:
            if self.busy: return False
            self._stop()
            return True

    @staticmethod
    def _read(process,responses):
        try:
            for line in process.stdout:
                responses.put(json.loads(line))
        except Exception as error: responses.put({'error':str(error)})
        finally: responses.put(None)

    def run(self,key,args,log,check,verify,progress=None):
        # progress(value): value is the runner's 0-100 report, or None on each
        # quarter-second poll so an estimate can advance between reports.
        with self.lock:
            if self.busy: raise RuntimeError('Model worker is already busy')
            self.busy=True
            if self.timer: self.timer.cancel();self.timer=None
        reused=False
        try:
            check()
            with self.lock:
                reused=self.process is not None and self.process.poll() is None and self.key==key
                if not reused: self._stop()
            if not reused:
                # Verify content before deserializing, once per new worker.
                verify();check()
                worker=Path(__file__).resolve().parents[1]/'runners/worker.py'
                process=subprocess.Popen([args[0],'-u',str(worker),args[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,text=True,encoding='utf-8',bufsize=1,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                responses=queue.Queue()
                with self.lock: self.process=process;self.responses=responses;self.key=key
                threading.Thread(target=self._read,args=(process,responses),daemon=True).start()
            process=self.process;responses=self.responses
            rid=uuid.uuid4().hex
            process.stdin.write(json.dumps({'id':rid,'args':args[2:],'log':str(log)})+'\n');process.stdin.flush()
            deadline=time.monotonic()+90*60
            while True:
                check()
                if time.monotonic()>deadline: raise TimeoutError('Model worker timed out after 90 minutes')
                try: result=responses.get(timeout=.25)
                except queue.Empty:
                    if process.poll() is not None: raise RuntimeError('Model worker exited; see job log')
                    if progress: progress(None)
                    continue
                if result and result.get('id')==rid and 'ok' not in result and 'progress' in result:
                    if progress: progress(result['progress'])
                    continue
                if not result or result.get('id')!=rid: raise RuntimeError('Model worker protocol failed; see job log')
                if not result.get('ok'): raise RuntimeError('Model inference failed: '+result.get('error','see job log'))
                return {'worker_reused':reused}
        except BaseException:
            with self.lock: self._stop()
            raise
        finally:
            with self.lock:
                self.busy=False
                if self.process is not None:
                    self.timer=threading.Timer(self.idle_seconds,self.release_idle);self.timer.daemon=True;self.timer.start()
