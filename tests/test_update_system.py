import unittest
from pathlib import Path
from unittest.mock import Mock, patch

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

    def test_check_update_reports_local_ahead_of_release(self):
        response = Mock(status_code=200)
        response.json.return_value = {
            'tag_name': 'v1.4.0', 'assets': [], 'body': '', 'html_url': 'https://github.com/release'
        }
        with patch.object(app_module.requests, 'get', return_value=response):
            payload = app_module.app.test_client().get('/api/check-update').get_json()
        self.assertFalse(payload['has_update'])
        self.assertEqual(payload['release_status'], 'local_ahead')
        self.assertEqual(payload['local_version'], '1.5.0')
        self.assertEqual(payload['remote_version'], '1.4.0')

    def test_check_update_rejects_release_without_compatible_asset(self):
        response = Mock(status_code=200)
        response.json.return_value = {
            'tag_name': 'v1.6.0', 'assets': [], 'body': '', 'html_url': 'https://github.com/release'
        }
        with patch.object(app_module.requests, 'get', return_value=response):
            payload = app_module.app.test_client().get('/api/check-update').get_json()
        self.assertFalse(payload['has_update'])
        self.assertEqual(payload['release_status'], 'missing_asset')
        self.assertIn('缺少适用于本机', payload['error'])

    def test_packaging_does_not_hardcode_current_release_asset_version(self):
        root = Path(app_module.__file__).resolve().parent
        workflow_path = root / '.github/workflows/release.yml'
        installer = (root / 'packaging/windows/installer.iss').read_text(encoding='utf-8')
        spec = (root / 'packaging/sample_factory.spec').read_text(encoding='utf-8')
        self.assertNotIn('#define MyAppVersion "1.5.0"', installer)
        self.assertIn("json.load(version_file)['version']", spec)
        if workflow_path.exists():
            workflow = workflow_path.read_text(encoding='utf-8')
            self.assertNotIn('sample-factory-v1.5.0', workflow)
            self.assertIn('/DMyAppVersion=$env:APP_VERSION', workflow)


if __name__ == '__main__':
    unittest.main()
