import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('quality_helper', Path(__file__).parents[1] / 'service/quality.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class QualityTests(unittest.TestCase):
    def test_calibration_and_invalid_scores(self):
        self.assertAlmostEqual(helper.calibrated([3, 3, 3])['overall'], 2.78345392)
        with self.assertRaises(ValueError):
            helper.calibrated([float('nan'), 3, 3])

    def test_merge_and_threshold(self):
        def w(start, end, score):
            return dict(start=start, end=end, overall=score, speech=score, background=score)
        result = helper.merge_flags([w(0,9,2),w(1,10,2.5),w(10,19,4),w(20,29,1)],3)
        self.assertEqual([(r['start'],r['end']) for r in result], [(0,10),(20,29)])
        self.assertEqual(result[0]['overall'],2)

    @unittest.skipUnless(helper.MODEL.exists(), 'DNSMOS model not yet installed on service')
    def test_cpu_inference_silence_tail_and_cancellation(self):
        import numpy as np
        import soundfile as sf
        analyzer = helper.Analyzer()
        self.assertEqual(analyzer.session.get_providers(), ['CPUExecutionProvider'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.wav'
            sf.write(path,np.zeros(48000),48000)
            result=analyzer.analyze(path)
            self.assertEqual(result['windows'],0)
            self.assertEqual(result['regions'],[])
            t=np.arange(48000*11)/48000
            # Opposite phase channels must not collapse to silence.
            signal=(.1*np.sin(2*np.pi*180*t)).astype('float32')
            sf.write(path,np.stack([signal,-signal],axis=1),48000)
            progress=[]
            result=analyzer.analyze(path,5,progress.append)
            self.assertEqual(result['windows'],3)
            self.assertEqual(result['regions'][-1]['end'],11)
            self.assertEqual(progress[-1],100)
            with self.assertRaises(InterruptedError):
                analyzer.analyze(path,cancel=lambda:True)
            with self.assertRaises(ValueError):
                analyzer.analyze(path,0)




if __name__ == '__main__':
    unittest.main()
