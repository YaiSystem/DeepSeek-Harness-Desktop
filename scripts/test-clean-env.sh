#!/bin/bash
# 在"没有安装 Node/npm"的环境下验证应用能否独立工作。
#
# 原理：把 PATH 里所有含 node/npm/工作台工具链的目录剔除，再启动应用。
# 此时应用的 findNode() / findDshBinJs() 只能回退到自带的 Node 与核心 bundle，
# 与"全新重装的 Windows"效果等价（Windows Sandbox 不可用时的替代方案）。
#
# 用法: bash scripts/test-clean-env.sh [应用目录]
#   默认应用目录为仓库上一级的 "DeepSeek Harness"

set -u

APP_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/DeepSeek Harness}"
EXE="$APP_DIR/DeepSeek Harness.exe"
# 注意：必须用 Windows 风格路径。mktemp 返回的 /tmp/... 是 MSYS 路径，
# Windows 程序（应用本体）识别不了，会导致 smoke 报告写不出来而误判为失败。
TMP_WIN="$(cygpath -m "${TEMP:-/tmp}" 2>/dev/null || echo "C:/Users/Public")"
LOG="$TMP_WIN/dsh-clean-env-$$.json"
PROFILE="$TMP_WIN/dsh-clean-profile-$$"
EMPTY_APPDATA="$TMP_WIN/dsh-clean-appdata-$$"

if [ ! -f "$EXE" ]; then
  echo "✗ 未找到应用: $EXE"
  exit 1
fi

echo "=== 应用目录: $APP_DIR ==="

# 1. 构造不含 Node/npm 的 PATH
CLEAN_PATH="$(echo "$PATH" \
  | tr ':' '\n' \
  | grep -viE 'node|npm|nvm|workbuddy|个人博客|Flocks|\.workbuddy' \
  | paste -sd: -)"
echo "=== 净化后的 PATH 条目数: $(echo "$CLEAN_PATH" | tr ':' '\n' | grep -c .) ==="

# 2. 确认系统里确实"没有" node（防止测试失真）
if PATH="$CLEAN_PATH" command -v node >/dev/null 2>&1; then
  echo "⚠ 净化后仍能找到 node: $(PATH="$CLEAN_PATH" command -v node)"
  echo "  测试结果可能失真，请检查 PATH 过滤规则"
  exit 2
fi
echo "✓ 净化后环境无 node/npm（等效于全新系统）"

# 3. 用净化环境启动（独立 user-data-dir 避开单实例锁，smoke 模式跑完自动退出）
#    关键：还要换掉 APPDATA —— 应用的 findDshBinJs() 会优先找
#    %APPDATA%/npm/node_modules 里的全局 dsh。不隔离它，测到的就是全局安装，
#    而不是"全新系统只能靠自带环境"这条路径。
rm -f "$LOG"
rm -rf "$PROFILE" "$EMPTY_APPDATA"
mkdir -p "$EMPTY_APPDATA"
PATH="$CLEAN_PATH" \
  APPDATA="$EMPTY_APPDATA" \
  env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  "$EXE" --smoke-test \
  --user-data-dir="$PROFILE" \
  --port 3111 \
  --smoke-log "$LOG"

echo "=== smoke 报告 ==="
cat "$LOG" 2>/dev/null || echo "✗ 未生成报告"

# 4. 判定
if grep -q '"ok": true' "$LOG" 2>/dev/null; then
  echo "✓ 无 Node 环境下启动成功"
  exit 0
fi
echo "✗ 无 Node 环境下启动失败"
exit 1
