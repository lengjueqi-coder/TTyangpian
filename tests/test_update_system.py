import unittest

import app as app_module


class UpdateSystemTest(unittest.TestCase):
    RELEASE = {
        'assets': [
            {'name': 'sample-factory-v1.5.0-source.zip', 'browser_download_url': 'https://github.com/source'},
            {'name': 'sample-factory-v1.5.0-macos-arm64.dmg', 'browser_download_url': 'https://github.com/mac'},
            {'name': 'sample-factory-v1.5.0-windows-x64-setup.exe', 'browser_download_url': 'https://github.com/win'},
        ]
    }

    def test_semantic_version_comparison(self):
        self.assertGreater(app_module._version_tuple('v1.10.0'), app_module._version_tuple('1.9.9'))
        self.assertEqual(app_module._version_tuple('v1.5.0-beta.1'), (1, 5, 0))

    def test_source_runtime_selects_only_source_zip(self):
        asset = app_module._select_release_asset(self.RELEASE, frozen=False, system='Darwin')
        self.assertEqual(asset['browser_download_url'], 'https://github.com/source')

    def test_frozen_windows_selects_installer(self):
        asset = app_module._select_release_asset(self.RELEASE, frozen=True, system='Windows')
        self.assertEqual(asset['browser_download_url'], 'https://github.com/win')

    def test_frozen_macos_selects_dmg(self):
        asset = app_module._select_release_asset(self.RELEASE, frozen=True, system='Darwin')
        self.assertEqual(asset['browser_download_url'], 'https://github.com/mac')

    def test_wrong_platform_assets_are_rejected(self):
        release = {'assets': [self.RELEASE['assets'][1]]}
        self.assertIsNone(app_module._select_release_asset(release, frozen=True, system='Windows'))


if __name__ == '__main__':
    unittest.main()
