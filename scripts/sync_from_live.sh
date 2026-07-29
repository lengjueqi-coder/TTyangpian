#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIVE_DIR="${YANGPIAN_LIVE_DIR:-/Users/Apple/Downloads/样片工厂}"
MESSAGE=""
BASE_APP="$ROOT/release_support/live_base_app.py"
BASE_JS="$ROOT/release_support/live_base_app.js"
BASE_TEMPLATE="$ROOT/release_support/live_base_index.html"
MERGE_TMP_DIR=""
COMMITTED=0

usage() {
  echo '用法: ./scripts/sync_from_live.sh --message "fix: 本次修改说明"'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --message)
      MESSAGE="${2:-}"
      shift 2
      ;;
    --live-dir)
      LIVE_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MESSAGE" ]]; then
  echo '必须用 --message 提供清晰的提交说明。' >&2
  exit 2
fi

if [[ ! -d "$ROOT/.git" ]]; then
  echo "发布目录不是 Git 仓库: $ROOT" >&2
  exit 1
fi

required=(
  app.py
  static/js/app.js
  static/css/style.css
  templates/index.html
  tests/test_ecommerce_batch.py
  tests/test_upload_behavior.py
)
for rel in "${required[@]}"; do
  if [[ ! -f "$LIVE_DIR/$rel" ]]; then
    echo "运行目录缺少必要文件: $LIVE_DIR/$rel" >&2
    exit 1
  fi
done

cd "$ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  echo '发布仓库存在未提交修改。请先审阅并提交或处理，脚本不会覆盖它们。' >&2
  git status --short >&2
  exit 1
fi

for base in "$BASE_APP" "$BASE_JS" "$BASE_TEMPLATE"; do
  if [[ ! -f "$base" ]]; then
    echo "缺少三方合并基线: $base" >&2
    exit 1
  fi
done

cleanup() {
  local exit_code=$?
  if [[ -n "$MERGE_TMP_DIR" && -d "$MERGE_TMP_DIR" ]]; then
    rm -rf "$MERGE_TMP_DIR"
  fi
  if [[ $exit_code -ne 0 && $COMMITTED -eq 0 ]]; then
    git restore -- \
      app.py \
      release_support/live_base_app.py \
      static/js/app.js \
      static/css/style.css \
      templates/index.html \
      tests/test_ecommerce_batch.py \
      tests/test_upload_behavior.py
  fi
}
trap cleanup EXIT

# app.py 和更新界面同时包含运行目录的业务修改及发布仓库的更新逻辑，因此必须三方合并。
# 冲突时停止，不覆盖任何一方。
MERGE_TMP_DIR="$(mktemp -d /tmp/yangpian-sync.XXXXXX)"
merge_file() {
  local rel="$1"
  local base="$2"
  local merged="$MERGE_TMP_DIR/$(basename "$rel")"
  set +e
  git merge-file -p "$rel" "$base" "$LIVE_DIR/$rel" > "$merged"
  local merge_status=$?
  set -e
  if [[ $merge_status -ne 0 ]]; then
    echo "$rel 三方合并出现冲突，已停止；请人工审阅，未提交任何内容。" >&2
    exit 1
  fi
  cp "$merged" "$rel"
  cp "$LIVE_DIR/$rel" "$base"
}

merge_file app.py "$BASE_APP"
merge_file static/js/app.js "$BASE_JS"
merge_file templates/index.html "$BASE_TEMPLATE"

# 其余白名单文件直接同步。跨平台打包、发布流程、版本号和脱敏默认数据
# 由发布仓库单独维护，不能用运行目录里的旧文件覆盖。
copy_file() {
  local rel="$1"
  mkdir -p "$(dirname "$ROOT/$rel")"
  cp "$LIVE_DIR/$rel" "$ROOT/$rel"
}

for rel in static/css/style.css tests/test_ecommerce_batch.py tests/test_upload_behavior.py; do
  copy_file "$rel"
done

python3 scripts/validate_release_tree.py
python3 -m json.tool version.json >/dev/null
python3 -m pytest -q tests
git diff --check

if git diff --quiet; then
  echo '没有检测到需要同步的代码变化。'
  exit 0
fi

git status --short
git add -- \
  app.py \
  release_support/live_base_app.py \
  release_support/live_base_app.js \
  release_support/live_base_index.html \
  static/js/app.js \
  static/css/style.css \
  templates/index.html \
  tests/test_ecommerce_batch.py \
  tests/test_upload_behavior.py
git commit -m "$MESSAGE"
COMMITTED=1

echo
echo '本地提交已创建。请审阅后执行：git push origin HEAD:main'
