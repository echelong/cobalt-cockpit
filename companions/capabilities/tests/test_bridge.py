import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).parents[1] / 'bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_disabled_zero_io(self):
        with patch.object(bridge, 'load_config', side_effect=AssertionError('IO')):
            self.assertEqual(bridge.dispatch({'capability':'memory'})['status'], 'disabled')
            self.assertEqual(bridge.dispatch({'capability':'browser'})['status'], 'disabled')

    def test_config_must_be_private_regular_owned_file(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'config.json'
            p.write_text(json.dumps({'memory_enabled':False}))
            p.chmod(0o644)
            with self.assertRaises(ValueError): bridge.load_config(str(p))
            p.chmod(0o600)
            self.assertFalse(bridge.load_config(str(p))['memory_enabled'])
            link = Path(directory) / 'link.json'; link.symlink_to(p)
            with self.assertRaises(OSError): bridge.load_config(str(link))
            fifo = Path(directory) / 'fifo'; os.mkfifo(fifo, 0o600)
            with self.assertRaises(ValueError): bridge.load_config(str(fifo))

    def test_second_switch_disabled_starts_no_workers(self):
        with patch.object(bridge, 'load_config', return_value={'browser_enabled':False}), patch.object(bridge.subprocess, 'run', side_effect=AssertionError('worker')):
            self.assertEqual(bridge.dispatch({'capability':'browser','enabled':True})['status'],'disabled')

    def test_path_traversal_refused_before_creation(self):
        with patch.object(bridge, 'load_config', return_value={'browser_enabled':True,'lock_directory':'/mnt/mem2/../../tmp/invalid-lock'}):
            with self.assertRaises(ValueError): bridge.dispatch({'capability':'browser','enabled':True})


if __name__ == '__main__': unittest.main()
