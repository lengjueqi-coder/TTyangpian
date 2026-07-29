# -*- mode: python ; coding: utf-8 -*-
import json
import os
import sys
from PyInstaller.utils.hooks import collect_all

project = os.path.dirname(os.path.abspath(SPECPATH))
with open(os.path.join(project, 'version.json'), encoding='utf-8') as version_file:
    app_version = json.load(version_file)['version']

dwpose_datas, dwpose_binaries, dwpose_hidden = collect_all('dwpose')

hiddenimports = [
    'flask',
    'requests',
    'PIL',
    'webview',
    'webview.platforms',
    'numpy',
    'cv2',
    'torch',
    'onnxruntime',
    *dwpose_hidden,
]
if sys.platform == 'win32':
    hiddenimports += ['webview.platforms.edgechromium', 'clr', 'pythonnet']
elif sys.platform == 'darwin':
    hiddenimports += ['webview.platforms.cocoa']

a = Analysis(
    [os.path.join(project, 'desktop_app.py')],
    pathex=[project],
    binaries=dwpose_binaries,
    datas=[
        (os.path.join(project, 'templates'), 'templates'),
        (os.path.join(project, 'static', 'css'), 'static/css'),
        (os.path.join(project, 'static', 'js'), 'static/js'),
        (os.path.join(project, 'default_data'), 'default_data'),
        (os.path.join(project, 'default_assets'), 'default_assets'),
        (os.path.join(project, 'version.json'), '.'),
        *dwpose_datas,
    ],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'django'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='样片工厂',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    argv_emulation=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name='样片工厂',
)

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='样片工厂.app',
        icon=None,
        bundle_identifier='com.ttyangpian.samplefactory',
        info_plist={
            'CFBundleName': '样片工厂',
            'CFBundleDisplayName': '样片工厂',
            'CFBundleVersion': app_version,
            'CFBundleShortVersionString': app_version,
            'LSMinimumSystemVersion': '11.0',
            'NSHighResolutionCapable': True,
            'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': True},
        },
    )
