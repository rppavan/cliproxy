#!/bin/bash
# star-cliproxy - Server Start Script (Dashboard + API on port 8300)
# Usage: ./start.sh [start|stop|restart|status]

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_PID_FILE="$PROJECT_DIR/.backend.pid"
DASHBOARD_PID_FILE="$PROJECT_DIR/.dashboard.pid"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"

start_servers() {
    if [ ! -f "$PROJECT_DIR/packages/dashboard/dist/index.html" ]; then
        echo "Building dashboard frontend..."
        cd "$PROJECT_DIR"
        npm run build --workspace=packages/dashboard
    fi

    if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
        echo "Server is already running (PID: $(cat "$SERVER_PID_FILE"))"
    else
        echo "Starting star-cliproxy server (Dashboard + API on port 8300)..."
        cd "$PROJECT_DIR"
        nohup npm run dev > "$LOG_DIR/backend.log" 2>&1 &
        echo $! > "$SERVER_PID_FILE"
        echo "Server started (PID: $!, http://localhost:8300)"
    fi
}

stop_servers() {
    if [ -f "$SERVER_PID_FILE" ]; then
        PID=$(cat "$SERVER_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            pkill -P "$PID" 2>/dev/null
            kill "$PID" 2>/dev/null
            echo "Server stopped (PID: $PID)"
        fi
        rm -f "$SERVER_PID_FILE"
    else
        echo "Server is not running"
    fi

    if [ -f "$DASHBOARD_PID_FILE" ]; then
        PID=$(cat "$DASHBOARD_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            pkill -P "$PID" 2>/dev/null
            kill "$PID" 2>/dev/null
        fi
        rm -f "$DASHBOARD_PID_FILE"
    fi
}

show_status() {
    echo "=== star-cliproxy Server Status ==="
    if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
        echo "Server (Dashboard & API): ✅ Running (PID: $(cat "$SERVER_PID_FILE"), http://localhost:8300)"
    else
        echo "Server:                   ❌ Stopped"
    fi
}

case "${1:-start}" in
    start)  start_servers ;;
    stop)   stop_servers ;;
    status) show_status ;;
    restart)
        stop_servers
        sleep 2
        start_servers
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
