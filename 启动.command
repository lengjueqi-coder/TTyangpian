#!/bin/bash

# 人像 Prompt 生成器 PRO - 启动脚本
# 双击此文件即可启动

# 获取脚本所在目录
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 扫描 5800-5819 端口范围，检测是否已有本程序实例在运行
EXISTING_PORT=""
EXISTING_PID=""
for CHECK_PORT in $(seq 5800 5819); do
    PID=$(lsof -iTCP:$CHECK_PORT -sTCP:LISTEN -P -n 2>/dev/null | awk '/Python/{print $2; exit}')
    if [ -n "$PID" ]; then
        # 验证是否是本程序的实例（检查 API 接口）
        GALLERY_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:$CHECK_PORT/api/gallery 2>/dev/null)
        SPLIT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:$CHECK_PORT/api/split-queue-data 2>/dev/null)
        if [ "$GALLERY_CODE" = "200" ] && [ "$SPLIT_CODE" = "200" ]; then
            EXISTING_PORT=$CHECK_PORT
            EXISTING_PID=$PID
            break
        fi
    fi
done

if [ -n "$EXISTING_PORT" ]; then
    echo ""
    echo "⚠️ 检测到端口 $EXISTING_PORT 已有本程序实例: PID=$EXISTING_PID"
    echo "   正在检查后端接口是否完整..."
    # 检查关键源码是否比当前进程更新；若更新则自动重启，避免"刷新看不到新改动"
    NOW_EPOCH=$(date +%s)
    ETIMES=$(ps -o etimes= -p "$EXISTING_PID" 2>/dev/null | tr -d ' ')
    if [ -z "$ETIMES" ]; then
        ETIMES=0
    fi
    PROC_START_EPOCH=$((NOW_EPOCH - ETIMES))

    APP_MTIME=$(stat -f %m app.py 2>/dev/null || echo 0)
    JS_MTIME=$(stat -f %m static/js/app.js 2>/dev/null || echo 0)
    HTML_MTIME=$(stat -f %m templates/index.html 2>/dev/null || echo 0)
    START_MTIME=$(stat -f %m 启动.command 2>/dev/null || echo 0)

    LATEST_MTIME=$APP_MTIME
    if [ "$JS_MTIME" -gt "$LATEST_MTIME" ]; then LATEST_MTIME=$JS_MTIME; fi
    if [ "$HTML_MTIME" -gt "$LATEST_MTIME" ]; then LATEST_MTIME=$HTML_MTIME; fi
    if [ "$START_MTIME" -gt "$LATEST_MTIME" ]; then LATEST_MTIME=$START_MTIME; fi

    if [ "$LATEST_MTIME" -le "$PROC_START_EPOCH" ]; then
        echo "✅ 当前后端可用且已是最新代码（端口 $EXISTING_PORT）"
        echo "   直接打开浏览器..."
        echo ""
        open http://localhost:$EXISTING_PORT
        exit 0
    fi

    echo "🔄 检测到源码已更新（进程启动后有新改动），将自动重启后端..."
    # 杀掉旧进程（包括热重载的父子进程）
    kill "$EXISTING_PID" 2>/dev/null || true
    # 同时杀掉同端口的其他 Python 进程（热重载的 reloader 主进程）
    lsof -iTCP:$EXISTING_PORT -sTCP:LISTEN -P -n 2>/dev/null | awk '/Python/{print $2}' | sort -u | while read p; do
        kill "$p" 2>/dev/null || true
    done
    sleep 2
fi

# 检查虚拟环境（如果 venv 不存在、缺文件或 Python 链接失效则重建）
if [ ! -f "venv/bin/activate" ] || [ ! -x "venv/bin/python3" ]; then
    echo "首次运行或虚拟环境已失效，正在创建虚拟环境并安装依赖..."
    rm -rf venv
    python3 -m venv venv
    source venv/bin/activate
    python3 -m pip install Flask==3.1.3 pillow==11.3.0 requests==2.32.5
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

# 后台自动打开浏览器：等待端口文件出现后打开正确地址
PORT_FILE="/tmp/ai_prompt_generator_port"
# 清理旧端口文件
rm -f "$PORT_FILE"

_auto_open() {
    local waited=0
    local actual_port=""
    while [ $waited -lt 30 ]; do
        if [ -z "$actual_port" ] && [ -f "$PORT_FILE" ]; then
            actual_port=$(cat "$PORT_FILE" 2>/dev/null)
        fi
        if [ -n "$actual_port" ]; then
            # 验证服务已就绪
            if curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:$actual_port/api/model-config 2>/dev/null | grep -q "200"; then
                open "http://localhost:$actual_port"
                return
            fi
        fi
        sleep 1
        waited=$((waited + 1))
    done
}

# 在子 shell 中后台等待并打开浏览器
(_auto_open) &

# 前台启动 Flask（日志直接输出到终端，Ctrl+C 可退出）
if command -v python3 >/dev/null 2>&1; then
    python3 app.py
elif command -v python >/dev/null 2>&1; then
    python app.py
else
    echo "❌ 未找到 python3/python，请先安装 Python 3"
    exit 1
fi
