#!/usr/bin/env bash
set -euo pipefail

# 从源码直接运行 CLI，用于开发调试。可加 --no-env 清掉模型凭据。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NO_ENV=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # 只清 DeepSeek 凭据：这是本框架唯一使用的凭据。
  unset DEEPSEEK_API_KEY
  unset DEEPSEEK_BASE_URL
  echo "Running without API keys..."
fi

exec "$SCRIPT_DIR/node_modules/.bin/tsx" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$SCRIPT_DIR/packages/cli/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
