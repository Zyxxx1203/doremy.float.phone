#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
pkg update -y
pkg install -y python ffmpeg
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
mkdir -p "$HOME/.momo-video-cache"
echo '安装完成。运行：python app.py；默认监听 127.0.0.1:8765。请保持 Termux 进程运行。'
