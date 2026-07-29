import os
import tempfile
import unittest
from unittest.mock import patch

import app as app_module


class PlatformSupportTest(unittest.TestCase):
    def test_source_mode_keeps_mutable_data_in_project(self):
        paths = app_module._resolve_runtime_paths(
            frozen=False,
            system='Darwin',
            module_file='/project/app.py',
            home='/Users/test',
        )
        self.assertEqual(paths['resource_dir'], '/project')
        self.assertEqual(paths['user_root'], '/project')

    def test_frozen_windows_uses_local_app_data(self):
        paths = app_module._resolve_runtime_paths(
            frozen=True,
            system='Windows',
            environ={'LOCALAPPDATA': r'C:\Users\Test\AppData\Local'},
            home=r'C:\Users\Test',
            meipass=r'C:\Program Files\SampleFactory\_internal',
        )
        self.assertEqual(paths['resource_dir'], os.path.abspath(r'C:\Program Files\SampleFactory\_internal'))
        self.assertIn(r'C:\Users\Test\AppData\Local', paths['user_root'])
        self.assertTrue(paths['user_root'].endswith('样片工厂'))

    def test_frozen_macos_uses_application_support(self):
        paths = app_module._resolve_runtime_paths(
            frozen=True,
            system='Darwin',
            environ={},
            home='/Users/test',
            meipass='/Applications/样片工厂.app/Contents/Frameworks',
        )
        self.assertEqual(paths['user_root'], '/Users/test/Library/Application Support/样片工厂')

    def test_default_data_is_copied_once_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            resource = os.path.join(temp, 'resources')
            data = os.path.join(temp, 'user', 'data')
            images = os.path.join(temp, 'user', 'images')
            backups = os.path.join(temp, 'user', 'backups')
            os.makedirs(os.path.join(resource, 'default_data'))
            with open(os.path.join(resource, 'default_data', 'settings.json'), 'w', encoding='utf-8') as handle:
                handle.write('{"value": "default"}')
            with patch.multiple(
                app_module,
                RESOURCE_DIR=resource,
                DATA_DIR=data,
                IMAGES_DIR=images,
                BACKUP_DIR=backups,
            ):
                app_module._init_default_data()
                target = os.path.join(data, 'settings.json')
                with open(target, 'w', encoding='utf-8') as handle:
                    handle.write('{"value": "user"}')
                app_module._init_default_data()
                with open(target, encoding='utf-8') as handle:
                    self.assertEqual(handle.read(), '{"value": "user"}')


if __name__ == '__main__':
    unittest.main()
