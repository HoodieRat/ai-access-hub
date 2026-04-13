#!/bin/sh
# AI Access Hub – Linux/macOS install script
set -e

cd "$(dirname "$0")"

echo "╔═══════════════════════════════════════════╗"
echo "║         AI Access Hub – Install           ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js 18+ from https://nodejs.org" >&2
  echo "  Or via: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20" >&2
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required. Found: $(node --version)" >&2
  exit 1
fi
echo "[OK] Node.js $NODE_MAJOR detected"

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found." >&2
  exit 1
fi
echo "[OK] npm detected"

# Create .env if missing
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp ".env.example" ".env"
    echo "[OK] Created .env from .env.example"
    echo ""
    echo "IMPORTANT: Open .env and set at minimum:"
    echo "  HUB_SECRET_KEY  (32+ random chars)"
    echo "  HUB_ADMIN_TOKEN (16+ chars)"
    echo "  At least one provider API key (e.g. GEMINI_API_KEY)"
    echo ""
  fi
else
  echo "[OK] .env already exists"
fi

HUB_PORT=$(grep -E '^HUB_PORT=' .env | head -n1 | cut -d= -f2)
[ -z "$HUB_PORT" ] && HUB_PORT=3000

# Create data directory
mkdir -p data
echo "[OK] data/ directory ready"

# Install npm dependencies
echo ""
echo "Installing npm dependencies..."
npm install
echo "[OK] Dependencies installed"

# Build TypeScript
echo ""
echo "Building TypeScript..."
npm run build
echo "[OK] Build successful"

# Make scripts executable
chmod +x start.sh stop.sh install.sh 2>/dev/null || true

echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║          Installation complete!           ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Edit .env to add your provider API keys"
echo "  2. Run ./start.sh to launch the hub"
echo "  3. Run ./stop.sh for a clean shutdown"
echo "  4. Open http://127.0.0.1:${HUB_PORT}/dashboard"
echo ""
