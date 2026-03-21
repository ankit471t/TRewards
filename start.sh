#!/bin/bash
# ─────────────────────────────────────────────────────────────
# TRewards — Single Web Service Starter
# Runs FastAPI backend + Telegram bot together
# ─────────────────────────────────────────────────────────────

echo "🚀 Starting TRewards services..."

# ── Find Python ───────────────────────────────────────────────
PYTHON=$(which python3 || which python)
PIP=$(which pip3 || which pip)

echo "🐍 Python: $PYTHON"
echo "📦 Pip: $PIP"

# ── Install Python dependencies ───────────────────────────────
echo "📦 Installing Python dependencies..."
$PIP install -r requirements.txt --quiet --no-cache-dir

# Add pip install location to PATH
export PATH="$HOME/.local/bin:$PATH"

# Verify uvicorn
UVICORN=$(which uvicorn)
echo "✅ uvicorn: $UVICORN"

# ── Install Node dependencies ─────────────────────────────────
echo "📦 Node dependencies already installed via build command"

echo "✅ All dependencies ready"

# ── Start FastAPI backend in background ───────────────────────
echo "🔧 Starting FastAPI backend on port ${PORT:-8000}..."
$HOME/.local/bin/uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} &
FASTAPI_PID=$!
echo "✅ FastAPI started (PID: $FASTAPI_PID)"

# Wait for FastAPI to boot
sleep 4

# Check if FastAPI is still running
if ! kill -0 $FASTAPI_PID 2>/dev/null; then
  echo "❌ FastAPI failed to start. Check logs above."
  exit 1
fi

echo "✅ FastAPI is running"

# ── Start Telegram bot in background ──────────────────────────
echo "🤖 Starting Telegram bot..."
node bot.js &
BOT_PID=$!
echo "✅ Bot started (PID: $BOT_PID)"

# Wait for bot to start
sleep 2

# Check if bot is still running
if ! kill -0 $BOT_PID 2>/dev/null; then
  echo "❌ Bot failed to start. Check logs above."
  kill $FASTAPI_PID 2>/dev/null
  exit 1
fi

echo ""
echo "════════════════════════════════════"
echo "✅ All services running!"
echo "   FastAPI PID : $FASTAPI_PID"
echo "   Bot PID     : $BOT_PID"
echo "   Port        : ${PORT:-8000}"
echo "════════════════════════════════════"

# Keep alive — if either dies, restart everything
# Render will auto-restart the whole service
wait -n
echo "❌ A service died — triggering restart..."
kill $FASTAPI_PID $BOT_PID 2>/dev/null
exit 1