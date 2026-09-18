#!/bin/bash
# Limkenion Linux 启动器（由 limkenion.desktop 以 Terminal=false 调用，不弹终端）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# 优先用包内 Node，缺失再回退系统 node
BUNDLED="$SCRIPT_DIR/node/linux-x64/node"
if [ -x "$BUNDLED" ]; then
  node_bin="$BUNDLED"
else
  node_bin="$(command -v node 2>/dev/null)"
fi

if [ -z "$node_bin" ]; then
  MSG="未找到可用的 Node.js（包内 node 缺失且系统未安装）。

Limkenion 已内置 Node.js；若被误删请重新解压发布包，或到 https://nodejs.org 安装 Node.js（>=20.11）。"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap --title="Limkenion · 缺少 Node.js" --text="$MSG" 2>/dev/null
  elif command -v xmessage >/dev/null 2>&1; then
    printf '%s\n' "$MSG" | xmessage -center -file - 2>/dev/null
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "Limkenion · 缺少 Node.js" "$MSG" 2>/dev/null
  fi
  exit 1
fi

ver="$("$node_bin" -v 2>/dev/null)"
major="$(printf '%s' "$ver" | sed -E 's/^v?([0-9]+)\..*/\1/')"
minor="$(printf '%s' "$ver" | sed -E 's/^v?[0-9]+\.([0-9]+).*/\1/')"
if [ "${major:-0}" -lt 20 ] || { [ "${major:-0}" -eq 20 ] && [ "${minor:-0}" -lt 11 ]; }; then
  MSG="Node.js 版本过低（当前 ${ver}）。

请重新解压发布包使用内置新版 Node，或升级系统 Node.js >=20.11。
下载地址：https://nodejs.org"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap --title="Limkenion · Node.js 版本过低" --text="$MSG" 2>/dev/null
  elif command -v xmessage >/dev/null 2>&1; then
    printf '%s\n' "$MSG" | xmessage -center -file - 2>/dev/null
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "Limkenion · Node.js 版本过低" "$MSG" 2>/dev/null
  fi
  exit 1
fi

exec "$node_bin" "$SCRIPT_DIR/launcher.mjs"
