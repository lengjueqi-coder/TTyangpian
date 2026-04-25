# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 构建配置：将 Flask+pywebview 应用打包为 macOS .app"""

import os

block_cipher = None
PROJ = os.path.dirname(os.path.abspath(SPEC))

a = Analysis(
    ['desktop_app.py'],
    pathex=[PROJ],
    binaries=[],
    datas=[
        # 模板和前端资源（打包到 bundle 内，只读）
        (os.path.join(PROJ, 'templates'), 'templates'),
        (os.path.join(PROJ, 'static', 'css'), 'static/css'),
        (os.path.join(PROJ, 'static', 'js'), 'static/js'),
        # 默认数据文件（首次启动时复制到 Application Support）
        (os.path.join(PROJ, 'default_data'), 'default_data'),
        # 版本信息
        (os.path.join(PROJ, 'version.json'), '.'),
    ],
    hiddenimports=[
        'flask',
        'requests',
        'PIL',
        'Pillow',
        'webview',
        'webview.platforms',
        'webview.platforms.cocoa',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib', 'numpy', 'scipy',
        'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
        'sqlalchemy', 'django', 'tornado',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='人像Prompt生成器PRO',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='人像Prompt生成器PRO',
)

app = BUNDLE(
    coll,
    name='AI人脸提示词.app',
    icon=None,
    bundle_identifier='com.ttyangpian.app',
    info_plist={
        'CFBundleName': '人像 Prompt 生成器 PRO',
        'CFBundleDisplayName': '人像 Prompt 生成器 PRO',
        'CFBundleVersion': '1.1.0',
        'CFBundleShortVersionString': '1.1.0',
        'LSMinimumSystemVersion': '10.15',
        'NSHighResolutionCapable': True,
        'NSSupportsAutomaticGraphicsSwitching': True,
        'LSUIElement': False,
        'NSAppTransportSecurity': {
            'NSAllowsArbitraryLoads': True,
        },
    },
)
