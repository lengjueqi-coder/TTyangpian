#!/bin/bash
# 人像 Prompt 生成器 PRO 启动脚本

cd "$(dirname "$0")"
APP_SUPPORT_DIR="$HOME/Library/Application Support/样片工厂"
VENV_DIR="$APP_SUPPORT_DIR/venv"
mkdir -p "$APP_SUPPORT_DIR"

# 检查 Python3
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 python3，请先安装 Python 3"
    exit 1
fi

# 检查并创建虚拟环境（放在项目目录外，避免软件文件夹被依赖撑大）
if [ ! -f "$VENV_DIR/bin/activate" ] || [ ! -x "$VENV_DIR/bin/python3" ]; then
    echo "首次运行或虚拟环境已失效，创建虚拟环境..."
    rm -rf "$VENV_DIR"
    python3 -m venv "$VENV_DIR"
fi

# 激活虚拟环境
source "$VENV_DIR/bin/activate"

# 安装依赖
echo "检查依赖..."
pip install -q -r requirements.txt

# 确保数据目录存在
mkdir -p data
mkdir -p static/images

# 启动应用
echo ""
echo "========================================"
echo "  人像 Prompt 生成器 PRO"
echo "  访问地址: http://localhost:5800"
echo "========================================"
echo ""

python3 app.py
