#!/bin/bash
# ─────────────────────────────────────────────────────────────
# TRewards — Single Web Service Starter
# Runs FastAPI backend + Telegram bot together
# ─────────────────────────────────────────────────────────────

echo "🚀 Starting TRewards services..."

# Install Python dependencies
echo "📦 Installing Python dependencies..."
pip install -r requirements.txt --quiet

# Install Node dependencies
echo "📦 Installing Node dependencies..."
npm install --quiet

echo "✅ Dependencies installed"

# Start FastAPI backend in background
echo "🔧 Starting FastAPI backend..."
uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} &
FASTAPI_PID=$!
echo "✅ FastAPI started (PID: $FASTAPI_PID)"

# Wait a moment for FastAPI to boot
sleep 3

# Start Node.js bot in background
echo "🤖 Starting Telegram bot..."
node bot.js &
BOT_PID=$!
echo "✅ Bot started (PID: $BOT_PID)"

echo ""
echo "════════════════════════════════════"
echo "✅ All services running!"
echo "   FastAPI PID : $FASTAPI_PID"
echo "   Bot PID     : $BOT_PID"
echo "════════════════════════════════════"

# If either process dies, kill everything and exit
# Render will auto-restart the service
wait -n
echo "❌ A service died — restarting..."
kill $FASTAPI_PID $BOT_PID 2>/dev/null
exit 1