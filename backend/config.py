import os
from dotenv import load_dotenv

load_dotenv()

# Database
DATABASE_URL = os.getenv("DATABASE_URL")  # Supabase PostgreSQL connection string

# Telegram
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]

# Payment providers
XROCKET_API_KEY = os.getenv("XROCKET_API_KEY")
XROCKET_WEBHOOK_SECRET = os.getenv("XROCKET_WEBHOOK_SECRET")
CRYPTOPAY_API_TOKEN = os.getenv("CRYPTOPAY_API_TOKEN")
CRYPTOPAY_WEBHOOK_SECRET = os.getenv("CRYPTOPAY_WEBHOOK_SECRET")

# App
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://trewards-frontend.onrender.com")
BOT_USERNAME = os.getenv("BOT_USERNAME", "trewards_ton_bot")

# Rates
COINS_PER_TON = 2500000  # 1 TON = 2,500,000 TR coins
TON_PER_COIN = 0.0000004

# Withdrawal tiers
WITHDRAWAL_TIERS = [
    {"coins": 250000,  "ton": 0.10, "net": 0.05},
    {"coins": 500000,  "ton": 0.20, "net": 0.15},
    {"coins": 750000,  "ton": 0.30, "net": 0.25},
    {"coins": 1000000, "ton": 0.40, "net": 0.35},
]

NETWORK_FEE = 0.05  # TON

# Task rewards
TASK_REWARD_CHANNEL = 1000
TASK_REWARD_GROUP = 1000
TASK_REWARD_GAME = 1000
TASK_REWARD_VISIT = 500
TASK_SPIN_BONUS = 1  # extra spin per task completion

# Spin wheel segments
SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500]
SPIN_WEIGHTS = [35, 25, 20, 12, 6, 2]  # probability weights

# Streak
STREAK_COIN_REWARD = 10
STREAK_SPIN_REWARD = 1

# Referral
REFERRAL_COMMISSION = 0.30  # 30%