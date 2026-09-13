#!/bin/bash
# 提审台 —— macOS 启动器（双击运行）
cd "$(dirname "$0")" || exit 1

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/current/bin/node"; do
    if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi
# nvm 常见安装位置（取版本号最大的一个）
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST="$(ls "$HOME/.nvm/versions/node" | sort -V | tail -1)"
  [ -n "$LATEST" ] && NODE_BIN="$HOME/.nvm/versions/node/$LATEST/bin/node"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  osascript -e 'display dialog "未找到 Node.js。\n\n请先安装 Node.js LTS（https://nodejs.org），安装完成后重新双击「启动.command」。" buttons {"好"} default button 1 with title "提审台"' 2>/dev/null
  echo "[提审台] 未找到 Node.js，请先安装 Node.js LTS。"
  exit 1
fi

exec "$NODE_BIN" server/main.js
