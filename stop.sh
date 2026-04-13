#!/bin/sh
# AI Access Hub – Linux/macOS stop script
set -e

cd "$(dirname "$0")"

if [ ! -f ".env" ]; then
  echo "AI Access Hub is not configured yet (.env missing)."
  exit 0
fi

HUB_PORT=$(grep -E '^HUB_PORT=' .env | head -n1 | cut -d= -f2)
[ -z "$HUB_PORT" ] && HUB_PORT=3000
HUB_LOG_DIR=$(grep -E '^HUB_LOG_DIR=' .env | head -n1 | cut -d= -f2)
[ -z "$HUB_LOG_DIR" ] && HUB_LOG_DIR=./logs
HUB_ADMIN_TOKEN=$(grep -E '^HUB_ADMIN_TOKEN=' .env | head -n1 | cut -d= -f2-)

PID_FILE="$HUB_LOG_DIR/hub.pid"

PROCESS_ID=""
if [ -f "$PID_FILE" ]; then
  PROCESS_ID=$(cat "$PID_FILE" 2>/dev/null || true)
fi

if [ -n "$HUB_ADMIN_TOKEN" ]; then
  SHUTDOWN_TOKEN="$HUB_ADMIN_TOKEN" node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/v1/admin/shutdown',{method:'POST',headers:{'Authorization':'Bearer ' + process.env.SHUTDOWN_TOKEN,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status>=200&&r.status<300?0:1)).catch(()=>process.exit(1))" -- "$HUB_PORT" || true
fi

attempt=0
while [ "$attempt" -lt 10 ]; do
  if [ -n "$PROCESS_ID" ] && kill -0 "$PROCESS_ID" 2>/dev/null; then
    sleep 1
    attempt=$((attempt + 1))
    continue
  fi

  if ! node -e "require('net').createConnection(process.argv[1], '127.0.0.1', ()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(1000,()=>process.exit(1))" -- "$HUB_PORT"; then
    rm -f "$PID_FILE"
    echo "AI Access Hub stopped."
    exit 0
  fi

  sleep 1
  attempt=$((attempt + 1))
done

if [ -n "$PROCESS_ID" ] && kill -0 "$PROCESS_ID" 2>/dev/null; then
  echo "Graceful shutdown timed out. Force stopping PID $PROCESS_ID..."
  kill -9 "$PROCESS_ID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "AI Access Hub stopped."