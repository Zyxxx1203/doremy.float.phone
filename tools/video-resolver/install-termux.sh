#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

# One-command Termux deployment:
# curl -fsSL https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver/install-termux.sh | bash

APP_DIR="$HOME/.momo-video-resolver"
RAW_BASE="https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver"
SOURCE_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/app.py" && -f "$SCRIPT_DIR/requirements.txt" ]]; then
  SOURCE_DIR="$SCRIPT_DIR"
fi

echo "[1/4] 更新 Termux 软件包并安装运行环境…"
pkg update -y
pkg install -y python ffmpeg curl

echo "[2/4] 部署视频解析服务到 $APP_DIR …"
mkdir -p "$APP_DIR"
if [[ -n "$SOURCE_DIR" ]]; then
  cp "$SOURCE_DIR/app.py" "$SOURCE_DIR/requirements.txt" "$APP_DIR/"
else
  curl -fsSL "$RAW_BASE/app.py" -o "$APP_DIR/app.py"
  curl -fsSL "$RAW_BASE/requirements.txt" -o "$APP_DIR/requirements.txt"
fi

echo "[3/4] 安装解析引擎…"
python -m pip install -r "$APP_DIR/requirements.txt"
mkdir -p "$APP_DIR/cache"
touch "$APP_DIR/service.log"

# Install stable start/stop/status commands into Termux PATH.
cat > "$PREFIX/bin/momo-video-start" <<'START_EOF'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
APP_DIR="$HOME/.momo-video-resolver"
if curl -fsS --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "Momo 视频解析服务已经在运行：http://127.0.0.1:8765"
  exit 0
fi
cd "$APP_DIR"
nohup python app.py >> "$APP_DIR/service.log" 2>&1 </dev/null &
echo $! > "$APP_DIR/service.pid"
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8765/health; then
    echo
    echo "服务已启动。保持 Termux 不被系统强制停止即可使用。"
    exit 0
  fi
  sleep 1
done
echo "服务启动失败，日志位置：$APP_DIR/service.log"
tail -n 60 "$APP_DIR/service.log" || true
exit 1
START_EOF
cat > "$PREFIX/bin/momo-video-stop" <<'STOP_EOF'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
APP_DIR="$HOME/.momo-video-resolver"
if [[ -f "$APP_DIR/service.pid" ]]; then
  PID="$(cat "$APP_DIR/service.pid")"
  kill "$PID" 2>/dev/null || true
  rm -f "$APP_DIR/service.pid"
fi
# Health check is authoritative if the saved PID was stale.
if curl -fsS --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  echo "服务仍在运行；若是旧进程，请查看 $APP_DIR/service.log"
else
  echo "停止请求已发送。"
fi
STOP_EOF
cat > "$PREFIX/bin/momo-video-status" <<'STATUS_EOF'
#!/data/data/com.termux/files/usr/bin/bash
if curl -fsS --max-time 3 http://127.0.0.1:8765/health; then
  echo
else
  echo "Momo 视频解析服务未运行。执行 momo-video-start 启动。"
  exit 1
fi
STATUS_EOF
chmod +x "$PREFIX/bin/momo-video-start" "$PREFIX/bin/momo-video-stop" "$PREFIX/bin/momo-video-status"

echo "[4/4] 启动服务并检查状态…"
momo-video-start
echo
echo "部署完成："
echo "  状态检查：momo-video-status"
echo "  启动服务：momo-video-start"
echo "  停止服务：momo-video-stop"
echo "  日志文件：$APP_DIR/service.log"
echo "  健康检查：http://127.0.0.1:8765/health"
