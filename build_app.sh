#!/bin/bash
# ============================================================
#  人像 Prompt 生成器 PRO — macOS 桌面应用自动构建脚本
#  使用方法: chmod +x build_app.sh && ./build_app.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_NAME="AI人脸提示词"
SPEC_FILE="AI人脸提示词.spec"
DIST_DIR="dist"
BUILD_DIR="build"
DMG_NAME="人像Prompt生成器PRO_安装包"

echo "=========================================="
echo "  人像 Prompt 生成器 PRO — 桌面应用构建"
echo "=========================================="

# 1. 检查 Python3
if ! command -v python3 &>/dev/null; then
    echo "❌ 未找到 python3，请先安装 Python 3"
    exit 1
fi
echo "✅ Python3: $(python3 --version)"

# 2. 创建/激活虚拟环境
if [ ! -d "build_venv" ]; then
    echo "📦 创建构建虚拟环境..."
    python3 -m venv build_venv
fi
source build_venv/bin/activate

# 3. 安装依赖
echo "📦 安装依赖..."
pip install --upgrade pip -q
pip install flask pillow requests pywebview pyinstaller -q

# 4. 验证语法
echo "🔍 验证代码语法..."
python3 -c "import py_compile; py_compile.compile('app.py', doraise=True)" && echo "  ✅ app.py"
python3 -c "import py_compile; py_compile.compile('desktop_app.py', doraise=True)" && echo "  ✅ desktop_app.py"

# 5. 确认 default_data 存在
if [ ! -d "default_data" ]; then
    echo "❌ default_data/ 目录不存在，请先运行数据准备"
    exit 1
fi
echo "✅ default_data/ 就绪"

# 6. 确认 version.json 存在
if [ ! -f "version.json" ]; then
    echo '{"version":"1.1.0"}' > version.json
    echo "✅ 已创建 version.json"
fi

# 7. 清理旧构建
echo "🧹 清理旧构建..."
rm -rf "$BUILD_DIR" "$DIST_DIR"

# 8. 执行 PyInstaller 构建
echo "🔨 执行 PyInstaller 构建（可能需要几分钟）..."
pyinstaller --clean --noconfirm "$SPEC_FILE"

# 9. 验证 .app 生成
APP_PATH="$DIST_DIR/$APP_NAME.app"
if [ ! -d "$APP_PATH" ]; then
    echo "❌ 构建失败：未找到 $APP_PATH"
    exit 1
fi
echo "✅ .app 构建成功: $APP_PATH"

# 10. Ad-hoc 签名（允许在未上架 App Store 的情况下运行）
echo "✍️  Ad-hoc 签名..."
codesign --force --deep --sign - "$APP_PATH" 2>/dev/null || echo "  ⚠️ 签名跳过（不影响使用）"

# 11. 创建 DMG 安装镜像
echo "💿 创建 DMG 安装镜像..."
DMG_PATH="$DIST_DIR/$DMG_NAME.dmg"
if [ -f "$DMG_PATH" ]; then
    rm -f "$DMG_PATH"
fi

# 创建临时 DMG 目录
DMG_STAGING="$DIST_DIR/dmg_staging"
rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING"

# 复制 .app 到 DMG 暂存目录
cp -R "$APP_PATH" "$DMG_STAGING/"

# 创建 Applications 快捷方式
ln -s /Applications "$DMG_STAGING/Applications"

# 创建 DMG
hdiutil create -volname "$DMG_NAME" \
    -srcfolder "$DMG_STAGING" \
    -ov -format UDZO \
    "$DMG_PATH"

rm -rf "$DMG_STAGING"

DMG_SIZE=$(du -sh "$DMG_PATH" | cut -f1)
echo "✅ DMG 创建成功: $DMG_PATH ($DMG_SIZE)"

# 12. 完成
echo ""
echo "=========================================="
echo "  🎉 构建完成！"
echo "=========================================="
echo ""
echo "  📱 应用: $APP_PATH"
echo "  💿 安装包: $DMG_PATH"
echo ""
echo "  安装方法："
echo "  1. 双击打开 DMG 文件"
echo "  2. 将 .app 拖入 Applications 文件夹"
echo "  3. 首次打开时右键 → 打开（绕过 Gatekeeper）"
echo ""

# 13. 清理构建虚拟环境
echo "🧹 清理构建环境..."
deactivate 2>/dev/null || true
rm -rf build_venv

echo "✅ 全部完成！"
