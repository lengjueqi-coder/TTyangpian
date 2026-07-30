#!/bin/bash

set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
VENV_DIR="$RUNTIME_DIR/venv"
UV_VERSION="0.10.9"
UV_BIN=""

cd "$ROOT_DIR" || exit 1

pause_on_error() {
    echo ""
    echo "❌ $1"
    echo ""
    echo "请检查网络后重新双击本文件。"
    read -r -n 1 -p "按任意键关闭窗口…"
    echo ""
    exit 1
}

echo "========================================"
echo "  样片工厂 Web v1.5.1"
echo "========================================"
echo ""

mkdir -p "$RUNTIME_DIR" "$ROOT_DIR/data" "$ROOT_DIR/logs" \
    "$ROOT_DIR/backups" "$ROOT_DIR/models" "$ROOT_DIR/static/images"

MACHINE_ARCH="$(uname -m)"
if [ "$MACHINE_ARCH" = "arm64" ] && [ -x "$ROOT_DIR/runtime/uv-arm64" ]; then
    UV_BIN="$ROOT_DIR/runtime/uv-arm64"
elif command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
else
    echo "首次运行：正在安装依赖管理器（需要联网）…"
    INSTALLER="$RUNTIME_DIR/uv-installer.sh"
    curl --fail --location --silent --show-error \
        "https://astral.sh/uv/${UV_VERSION}/install.sh" \
        --output "$INSTALLER" || pause_on_error "无法下载依赖管理器"
    UV_INSTALL_DIR="$RUNTIME_DIR/bin" UV_NO_MODIFY_PATH=1 sh "$INSTALLER" \
        || pause_on_error "依赖管理器安装失败"
    UV_BIN="$RUNTIME_DIR/bin/uv"
fi

[ -x "$UV_BIN" ] || pause_on_error "没有找到可用的依赖管理器"

if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "首次运行：正在准备 Python 3.11…"
    "$UV_BIN" python install 3.11 || pause_on_error "Python 3.11 安装失败"
    "$UV_BIN" venv --python 3.11 "$VENV_DIR" || pause_on_error "Python 环境创建失败"
fi

DEPENDENCY_FILE="$ROOT_DIR/requirements-web.txt"
# GitHub 的后续源码更新包会携带 requirements.txt。更新后优先使用它，
# 这样新增依赖也会在下一次启动时自动安装；首次便携包则使用精简 Web 清单。
if [ -f "$ROOT_DIR/requirements.txt" ]; then
    DEPENDENCY_FILE="$ROOT_DIR/requirements.txt"
fi
REQ_HASH="$(shasum -a 256 "$DEPENDENCY_FILE" | awk '{print $1}')"
INSTALLED_HASH=""
if [ -f "$RUNTIME_DIR/requirements.sha256" ]; then
    INSTALLED_HASH="$(tr -d '[:space:]' < "$RUNTIME_DIR/requirements.sha256")"
fi

if [ "$REQ_HASH" != "$INSTALLED_HASH" ]; then
    echo "首次运行或版本已更新：正在安装功能依赖…"
    echo "根据网络速度可能需要几分钟，请不要关闭窗口。"
    "$UV_BIN" pip install --python "$VENV_DIR/bin/python" \
        --link-mode copy --requirement "$DEPENDENCY_FILE" \
        || pause_on_error "功能依赖安装失败"
    printf '%s\n' "$REQ_HASH" > "$RUNTIME_DIR/requirements.sha256"
fi

echo "正在检查运行环境…"
"$VENV_DIR/bin/python" -c \
    "import importlib.util; import flask, requests, PIL, numpy, cv2, torch, onnxruntime, send2trash; assert importlib.util.find_spec('dwpose')" \
    || pause_on_error "依赖自检失败"

echo ""
echo "✅ 环境正常，正在打开浏览器…"
echo "终端窗口需要保持打开；关闭窗口即可停止服务。"
echo ""

export AI_HOT_RELOAD=0
export AI_AUTO_OPEN_BROWSER=1
exec "$VENV_DIR/bin/python" "$ROOT_DIR/app.py"
