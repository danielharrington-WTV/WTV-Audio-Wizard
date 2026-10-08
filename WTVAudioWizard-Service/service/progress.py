"""Job progress during a model run (2026-09-29).

A model call is most of a job's time. Before this, the job sat at 15% for the
whole call and jumped to 80% when it returned. Now two sources move it:

- Real progress: runners print {"progress": 0-100} as they work (per block or
  window); runners/worker.py relays those lines and worker_pool calls
  StageProgress.report().
- An estimate from the clip's length and how fast this model ran before
  (SpeedHistory, kept in the service data folder), advanced on every
  quarter-second poll via report(None). It covers models or clips that report
  coarsely, and the model-loading time before the first real report.

The shown value never goes backwards and never reaches the stage's end until
the model actually returns.
"""
import json
from pathlib import Path
import threading
import time

# Seconds of model time per second of audio per channel, before any history.
# Rough RTX 5080 figures; replaced by measurements after the first clip.
DEFAULT_WARM = {'gap_urgenet': .25, 'mossformer2': .25, 'bandit_v2': .35, 'sidon': .25}
DEFAULT_COLD = 20.0  # Extra seconds to start a worker and load the model.
ESTIMATE_CAP = .9    # An estimate alone never claims more than 90% of the stage.


class SpeedHistory:
    """Per-model speed: seconds per audio-channel-second when the worker was
    already loaded, plus the extra seconds a cold start adds. Exponential moving
    averages in <data>/model-speed.json."""

    def __init__(self, path, alpha=.4):
        self.path, self.alpha, self.lock = Path(path), alpha, threading.Lock()

    def _load(self):
        try:
            data = json.loads(self.path.read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def expected_seconds(self, model, work_seconds, cold):
        entry = self._load().get(model, {})
        rate = entry.get('rate', DEFAULT_WARM.get(model, .3))
        return max(1.0, rate * work_seconds + (entry.get('cold', DEFAULT_COLD) if cold else 0))

    def record(self, model, work_seconds, elapsed, cold):
        if work_seconds <= 0 or elapsed <= 0:
            return
        with self.lock:
            data = self._load()
            entry = data.setdefault(model, {})
            rate = entry.get('rate', DEFAULT_WARM.get(model, .3))
            if cold:
                # Split a cold run into the known warm rate plus start-up time.
                overhead = max(0.0, elapsed - rate * work_seconds)
                entry['cold'] = overhead if 'cold' not in entry else entry['cold'] + self.alpha * (overhead - entry['cold'])
            else:
                measured = elapsed / work_seconds
                entry['rate'] = measured if 'rate' not in entry else rate + self.alpha * (measured - rate)
            try:
                temp = self.path.with_suffix('.tmp')
                temp.write_text(json.dumps(data, indent=2))
                temp.replace(self.path)
            except OSError:
                pass  # Progress estimates are a convenience; never fail a job over them.


class StageProgress:
    """Maps a model call onto the job's [start, end] percent range."""

    def __init__(self, publish, start, end, expected_seconds, clock=time.monotonic):
        self.publish, self.start, self.end = publish, start, end
        self.expected, self.clock = expected_seconds, clock
        self.t0 = clock()
        self.real = 0.0          # Latest runner report, 0..1.
        self.real_at = None      # When it arrived (seconds since t0).
        self.first_at = None     # When the first report arrived.
        self.shown = 0.0         # Fraction already published; never decreases.
        self.first_real = 0.0
        self.last_percent = None

    def fraction(self):
        elapsed = self.clock() - self.t0
        if self.real_at is None:
            estimate = min(ESTIMATE_CAP, elapsed / self.expected) if self.expected else 0.0
            return max(self.shown, estimate)
        # Between reports, carry on at the pace the reports have shown so far,
        # but never past halfway to the next unknown report or the cap.
        if self.real > 0 and self.real_at > self.first_at:
            pace = (self.real_at - self.first_at) / max(self.real - self.first_real, 1e-6)
        else:
            pace = self.expected / 1.0 if self.expected else None
        ahead = (elapsed - self.real_at) / pace if pace else 0.0
        limit = min(ESTIMATE_CAP if self.real < ESTIMATE_CAP else .99, self.real + (1 - self.real) / 2)
        return max(self.shown, self.real, min(self.real + ahead, limit))

    def __call__(self, value=None):
        try:
            if value is not None:
                value = min(1.0, max(0.0, float(value) / 100))
                now = self.clock() - self.t0
                if self.first_at is None:
                    self.first_at, self.first_real = now, value
                if value >= self.real:
                    self.real, self.real_at = value, now
            self.shown = min(.99, self.fraction())
            percent = int(self.start + (self.end - self.start) * self.shown)
            if percent != self.last_percent:
                self.last_percent = percent
                self.publish(percent)
        except Exception:
            pass  # Never let a progress display break inference.
