#!/bin/sh
# AI Access Hub – Linux/macOS startup script
set -e

cd "$(dirname "$0")"

# Check Node.js installed
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi

# Check version >= 18
NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required. Found: $(node --version)" >&2
  exit 1
fi

# Check build exists
if [ ! -f "dist/index.js" ]; then
  echo "ERROR: dist/index.js not found. Run ./install.sh first." >&2
  exit 1
fi

# Auto-create .env from example if missing
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    echo "WARNING: .env not found – copying .env.example to .env"
    cp ".env.example" ".env"
  else
    echo "ERROR: .env not found and .env.example is missing." >&2
    exit 1
  fi
fi

HUB_PORT=$(grep -E '^HUB_PORT=' .env | head -n1 | cut -d= -f2)
[ -z "$HUB_PORT" ] && HUB_PORT=3000
HUB_LOG_DIR=$(grep -E '^HUB_LOG_DIR=' .env | head -n1 | cut -d= -f2)
[ -z "$HUB_LOG_DIR" ] && HUB_LOG_DIR=./logs

mkdir -p "$HUB_LOG_DIR"

PID_FILE="$HUB_LOG_DIR/hub.pid"
OUT_LOG="$HUB_LOG_DIR/hub.out.log"
ERR_LOG="$HUB_LOG_DIR/hub.err.log"

if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "AI Access Hub is already running (PID: $EXISTING_PID)"
    echo "Dashboard: http://127.0.0.1:${HUB_PORT}/dashboard"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if node -e "require('net').createConnection(process.argv[1], '127.0.0.1', ()=>process.exit(0)).on('error',()=>process.exit(1)).setTimeout(1000,()=>process.exit(1))" -- "$HUB_PORT"; then
  echo "ERROR: Port ${HUB_PORT} is already in use. Stop the other process first." >&2
  exit 1
fi

echo "Starting AI Access Hub..."
echo "Dashboard: http://127.0.0.1:${HUB_PORT}/dashboard"
echo "API:       http://127.0.0.1:${HUB_PORT}/v1/"
echo "Logs:      ${OUT_LOG} / ${ERR_LOG}"
echo "Stop with: ./stop.sh"
echo "Ready when: GET /health returns status=ok"
echo ""

nohup node dist/index.js >"$OUT_LOG" 2>"$ERR_LOG" &
PROCESS_ID=$!
echo "$PROCESS_ID" > "$PID_FILE"

attempt=0
while [ "$attempt" -lt 20 ]; do
  if ! kill -0 "$PROCESS_ID" 2>/dev/null; then
    echo "ERROR: AI Access Hub exited during startup." >&2
    rm -f "$PID_FILE"
    tail -n 20 "$ERR_LOG" 2>/dev/null || true
    exit 1
  fi

  if node scripts/check-health.cjs "$HUB_PORT" >/dev/null 2>&1; then
    echo "AI Access Hub started (PID: $PROCESS_ID)"
    exit 0
  fi

  attempt=$((attempt + 1))
  sleep 1
done

echo "ERROR: AI Access Hub did not become ready in time." >&2
kill "$PROCESS_ID" 2>/dev/null || true
rm -f "$PID_FILE"
tail -n 20 "$ERR_LOG" 2>/dev/null || true
exit 1
