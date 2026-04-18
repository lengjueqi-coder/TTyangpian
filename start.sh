#!/bin/bash
# 人像 Prompt 生成器 PRO 启动脚本

cd "$(dirname "$0")"

# 检查 Python3
if ! command -v python3 &> /dev/null; then
    echo "错误: 未找到 python3，请先安装 Python 3"
    exit 1
fi

# 检查并创建虚拟环境（如果 venv 不存在或不完整则重建）
if [ ! -f "venv/bin/activate" ]; then
    echo "首次运行，创建虚拟环境..."
    python3 -m venv venv
fi

# 激活虚拟环境
source venv/bin/activate

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
