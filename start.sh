#!/usr/bin/env bash
# Hackathon 组队雷达 · macOS / Linux 启动脚本
# 用法：./start.sh        （首次使用先 chmod +x start.sh）
set -u
cd "$(dirname "$0")"

echo
echo "  Hackathon 组队雷达"
echo "  黑客松现场：组队名片生成器 + 破冰匹配器"
echo "  ---------------------------------------------"
echo

if ! command -v node >/dev/null 2>&1; then
  cat <<'EOF'
  [x] 没有找到 Node.js

  这个东西需要 Node.js 18 或更高版本才能跑。
  安装方法：
    macOS   brew install node
    其他    打开 https://nodejs.org 下载 LTS 版

  ---- 不想装 Node 也有办法 ----
  把 public 文件夹直接传到任意静态托管（GitHub Pages / Vercel），
  打开时在地址后面加 ?offline=1，名片生成、下载图片、分享链接、
  本地匹配都还能用，只是没法多台手机同步。
EOF
  echo
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [x] Node.js 版本太低：需要 18 以上，当前是 $NODE_MAJOR"
  echo "      请到 https://nodejs.org 下载新版覆盖安装。"
  echo
  exit 1
fi

echo "  Node.js 版本：$NODE_MAJOR（符合要求）"
echo "  正在启动，稍后会自动打开浏览器…"
echo "  按 Ctrl+C 即可停止服务。"
echo

exec node server.js --open
