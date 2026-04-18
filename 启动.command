#!/bin/bash

# 人像 Prompt 生成器 PRO - 启动脚本
# 双击此文件即可启动

# 获取脚本所在目录
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 检查虚拟环境（如果 venv 不存在或不完整则重建）
if [ ! -f "venv/bin/activate" ]; then
    echo "首次运行，正在创建虚拟环境并安装依赖..."
    python3 -m venv venv
    source venv/bin/activate
    pip install Flask==3.1.3 pillow==11.3.0 requests==2.32.5
    echo "安装完成！"
else
    source venv/bin/activate
fi

# 启动服务
echo ""
echo "========================================"
echo "  人像 Prompt 生成器 PRO"
echo "  启动中..."
echo "========================================"
echo ""

python app.py &
SERVER_PID=$!

# 等待服务启动
sleep 2

# 打开浏览器
open http://localhost:5800

echo "已打开浏览器！"
echo "关闭此窗口将停止服务"
echo ""

# 等待服务进程
wait $SERVER_PID
