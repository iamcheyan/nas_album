#!/bin/bash

# NAS Album 一键部署为系统服务
# 用法: ./deploy.sh

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="nas-album"
PORT=8888
USER="$(whoami)"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "🚀 部署 NAS Album 为系统服务"
echo "=============================="
echo "项目路径: $PROJECT_DIR"
echo "端口: $PORT"
echo "用户: $USER"
echo ""

# 1. 停止现有服务
echo "🛑 停止现有服务..."
sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true

# 2. 清理旧进程
echo "🧹 清理旧进程..."
PIDS=$(ss -tlnp | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u)
if [ -n "$PIDS" ]; then
    for PID in $PIDS; do
        kill -9 "$PID" 2>/dev/null || true
    done
fi

# 3. 确保 uv 可用
if ! command -v uv &> /dev/null; then
    echo "❌ uv 未安装，请先安装: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# 4. 安装依赖
echo "📦 安装依赖..."
cd "$PROJECT_DIR"
uv sync

# 5. 创建 systemd 服务文件
echo "📝 创建系统服务..."
sudo tee "$SERVICE_FILE" > /dev/null << SERVICE
[Unit]
Description=NAS Album - 本地照片/视频管理服务
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$HOME/.local/bin/uv run python app.py $PORT
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
SERVICE

# 6. 重载 systemd 并启动
echo "🔧 启动服务..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

sleep 2

# 7. 验证状态
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "✅ 部署成功！"
    echo "=============================="
    echo "服务状态: $(sudo systemctl is-active "$SERVICE_NAME")"
    echo "本机访问: http://127.0.0.1:$PORT"
    
    IP=$(ip addr show | grep "inet 192" | head -1 | awk '{print $2}' | cut -d/ -f1)
    if [ -n "$IP" ]; then
        echo "局域网访问: http://$IP:$PORT"
    fi
    echo ""
    echo "📋 管理命令:"
    echo "   查看状态: sudo systemctl status $SERVICE_NAME"
    echo "   查看日志: sudo journalctl -u $SERVICE_NAME -f"
    echo "   重启服务: sudo systemctl restart $SERVICE_NAME"
    echo "   停止服务: sudo systemctl stop $SERVICE_NAME"
    echo ""
    echo "🗑️  卸载服务:"
    echo "   sudo systemctl stop $SERVICE_NAME"
    echo "   sudo systemctl disable $SERVICE_NAME"
    echo "   sudo rm $SERVICE_FILE"
    echo "   sudo systemctl daemon-reload"
else
    echo "❌ 服务启动失败"
    echo "查看日志: sudo journalctl -u $SERVICE_NAME -n 50"
    exit 1
fi
