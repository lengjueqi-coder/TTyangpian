#!/usr/bin/env python3
"""桌面应用入口点：启动 Flask 后台服务 + 打开 pywebview 原生窗口"""

import sys
import os
import threading
import time
import socket

# PyInstaller frozen 模式标识（必须在 import app 之前设置）
if getattr(sys, 'frozen', False):
    os.environ['PYINSTALLER_FROZEN'] = '1'

# 导入 Flask 应用（会触发 get_app_dirs() 等初始化）
from app import app, _init_default_data, _migrate_legacy_data

# 初始化默认数据和迁移旧数据
_init_default_data()
_migrate_legacy_data()


def find_free_port(start_port=5800, max_tries=20):
    """在 localhost 上寻找可用端口"""
    for port in range(start_port, start_port + max_tries):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('127.0.0.1', port))
                return port
        except OSError:
            continue
    return None


def start_flask(port):
    """在 daemon 线程中启动 Flask 服务器"""
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True, use_reloader=False)


if __name__ == '__main__':
    port = find_free_port()
    if port is None:
        print("错误：找不到可用端口")
        sys.exit(1)

    # 启动 Flask 后台线程
    flask_thread = threading.Thread(target=start_flask, args=(port,), daemon=True)
    flask_thread.start()

    # 等待 Flask 就绪（最多 15 秒）
    for _ in range(30):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect(('127.0.0.1', port))
            s.close()
            break
        except OSError:
            time.sleep(0.5)

    # 打开 pywebview 原生窗口
    import webview
    window = webview.create_window(
        '人像 Prompt 生成器 PRO',
        f'http://127.0.0.1:{port}',
        width=1400,
        height=900,
        min_size=(1024, 700),
        text_select=True,
    )
    webview.start(debug=False)

    # 窗口关闭后退出
    sys.exit(0)
