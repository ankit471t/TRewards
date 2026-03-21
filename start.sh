#!/bin/bash
# ─────────────────────────────────────────────────────────────
# TRewards — Single Web Service Starter
# ─────────────────────────────────────────────────────────────

echo "🚀 Starting TRewards services..."

# ── Find Python & Pip ─────────────────────────────────────────
PYTHON=$(which python3 || which python)
PIP=$(which pip3 || which pip)

echo "🐍 Python: $PYTHON"
echo "📦 Pip: $PIP"

# ── Install Python dependencies ───────────────────────────────
echo "📦 Installing Python dependencies..."
$PIP install -r requirements.txt --quiet --no-cache-dir

# ── Find uvicorn wherever it got installed ────────────────────
# Try all possible locations
UVICORN=""

# 1. Same location as pip (venv bin folder)
PIP_DIR=$(dirname $PIP)
if [ -f "$PIP_DIR/uvicorn" ]; then
  UVICORN="$PIP_DIR/uvicorn"
fi

# 2. Fallback: use python -m uvicorn (always works)
if [ -z "$UVICORN" ]; then
  UVICORN="$PYTHON -m uvicorn"
fi

echo "✅ uvicorn: $UVICORN"

# ── Start FastAPI using python -m uvicorn (most reliable) ─────
echo "🔧 Starting FastAPI backend on port ${PORT:-10000}..."
$PYTHON -m uvicorn main:app --host 0.0.0.0 --port ${PORT:-10000} &
FASTAPI_PID=$!
echo "✅ FastAPI started (PID: $FASTAPI_PID)"

# Wait for FastAPI to boot
sleep 5

# Check if FastAPI is still running
if ! kill -0 $FASTAPI_PID 2>/dev/null; then
  echo "❌ FastAPI failed to start — check errors above"
  exit 1
fi

echo "✅ FastAPI is alive"

# ── Start Telegram bot ────────────────────────────────────────
echo "🤖 Starting Telegram bot..."
node bot.js &
BOT_PID=$!
echo "✅ Bot started (PID: $BOT_PID)"

sleep 2

# Check if bot is still running
if ! kill -0 $BOT_PID 2>/dev/null; then
  echo "❌ Bot failed to start — check errors above"
  kill $FASTAPI_PID 2>/dev/null
  exit 1
fi

echo ""
echo "════════════════════════════════════"
echo "✅ All services running!"
echo "   FastAPI PID : $FASTAPI_PID"
echo "   Bot PID     : $BOT_PID"
echo "   Port        : ${PORT:-10000}"
echo "════════════════════════════════════"

# If either process dies, exit so Render restarts
wait -n
echo "❌ A service died — triggering restart..."
kill $FASTAPI_PID $BOT_PID 2>/dev/null
exit 1