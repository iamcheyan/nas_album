#!/bin/bash

# NAS Album 服务重启脚本
# 用法: ./restart.sh [端口，默认 5002]

set -e

PORT="${1:-8888}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="/tmp/nas_album.log"

echo "🔄 重启 NAS Album 服务 (端口: $PORT)"
echo "========================================"

# 1. 查找并停止占用端口的进程
echo "🔍 查找占用端口 $PORT 的进程..."
PIDS=$(ss -tlnp | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u)

if [ -n "$PIDS" ]; then
    for PID in $PIDS; do
        echo "   🛑 终止进程 PID: $PID"
        kill "$PID" 2>/dev/null || true
    done
    sleep 1
    
    # 强制清理残留
    PIDS_LEFT=$(ss -tlnp | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u)
    if [ -n "$PIDS_LEFT" ]; then
        for PID in $PIDS_LEFT; do
            echo "   💀 强制终止残留进程 PID: $PID"
            kill -9 "$PID" 2>/dev/null || true
        done
        sleep 1
    fi
fi

# 确认端口已释放
if ss -tln | grep -q ":$PORT "; then
    echo "❌ 端口 $PORT 仍被占用，无法启动"
    exit 1
fi

echo "✅ 端口 $PORT 已释放"

# 2. 清理旧日志
echo "🧹 清理旧日志..."
> "$LOG_FILE"

# 3. 启动服务
echo "🚀 启动服务..."
cd "$PROJECT_DIR"
nohup uv run python app.py "$PORT" > "$LOG_FILE" 2>&1 &
NEW_PID=$!

sleep 2

# 4. 验证启动
if ss -tln | grep -q ":$PORT "; then
    echo "✅ 服务启动成功！"
    echo "   PID: $NEW_PID"
    echo "   本机访问: http://127.0.0.1:$PORT"
    
    # 获取本机 IP
    IP=$(ip addr show | grep "inet 192" | head -1 | awk '{print $2}' | cut -d/ -f1)
    if [ -n "$IP" ]; then
        echo "   局域网访问: http://$IP:$PORT"
    fi
    
    echo ""
    echo "📋 常用命令:"
    echo "   查看日志: tail -f $LOG_FILE"
    echo "   停止服务: kill $NEW_PID"
else
    echo "❌ 服务启动失败，查看日志:"
    tail -n 20 "$LOG_FILE"
    exit 1
fi
