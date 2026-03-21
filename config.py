import os
from dotenv import load_dotenv
load_dotenv()

# ─── Database ────────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")  # Supabase PostgreSQL connection string

# ─── Telegram ────────────────────────────────────────────────────────────────
BOT_TOKEN  = os.getenv("BOT_TOKEN")
BOT_USERNAME = os.getenv("BOT_USERNAME", "trewards_ton_bot")
ADMIN_IDS  = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]

# ─── Payment providers ───────────────────────────────────────────────────────
XROCKET_API_KEY          = os.getenv("XROCKET_API_KEY")
XROCKET_WEBHOOK_SECRET   = os.getenv("XROCKET_WEBHOOK_SECRET")
CRYPTOPAY_API_TOKEN      = os.getenv("CRYPTOPAY_API_TOKEN")
CRYPTOPAY_WEBHOOK_SECRET = os.getenv("CRYPTOPAY_WEBHOOK_SECRET")

# ─── App URLs ────────────────────────────────────────────────────────────────
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://trewards.onrender.com")

# ─── Coin / TON rates ────────────────────────────────────────────────────────
# 1 TON = 1,000,000 TR / 0.15 ≈ 6,666,667 TR  (based on convert rate)
# Convert rate: 1,000,000 TR = 0.15 TON
COINS_PER_TON = 6_666_667   # used for display / reference only
TON_PER_COIN  = 0.00000015  # 0.15 / 1_000_000

# ─── Withdrawal tiers (UPDATED) ──────────────────────────────────────────────
WITHDRAWAL_TIERS = [
    {"coins": 1_000_000,  "ton": 0.10, "net": 0.07, "fee": 0.03},
    {"coins": 2_000_000,  "ton": 0.20, "net": 0.17, "fee": 0.03},
    {"coins": 3_000_000,  "ton": 0.30, "net": 0.27, "fee": 0.03},
    {"coins": 10_000_000, "ton": 1.00, "net": 1.00, "fee": 0.00},  # no fee tier
]
NETWORK_FEE = 0.03  # TON (updated from 0.05)

# ─── Task rewards (UPDATED) ──────────────────────────────────────────────────
TASK_REWARD_VISIT   = 3000   # Visit Website   (+3,000 TR)
TASK_REWARD_CHANNEL = 5000   # Join Channel    (+5,000 TR)
TASK_REWARD_GROUP   = 5000   # Join Group      (+5,000 TR)
TASK_REWARD_GAME    = 5000   # Play Game Bot   (+5,000 TR)
TASK_SPIN_BONUS     = 1      # +1 spin per task completion

# ─── Watch Ads reward ────────────────────────────────────────────────────────
WATCH_AD_REWARD     = 2500   # +2,500 TR per ad watched
WATCH_AD_DURATION   = 10     # seconds

# ─── Spin wheel (EQUAL weights — 1/6 each) ───────────────────────────────────
SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500]
SPIN_WEIGHTS  = [1,  1,  1,  1,   1,   1]   # equal probability for all segments

# ─── Streak ──────────────────────────────────────────────────────────────────
STREAK_COIN_REWARD = 10
STREAK_SPIN_REWARD = 1

# ─── Referral ────────────────────────────────────────────────────────────────
REFERRAL_COMMISSION = 0.30  # 30% of friend's earnings credited to referrer

# ─── Convert TR → TON ────────────────────────────────────────────────────────
CONVERT_RATE        = 0.15        # 1,000,000 TR = 0.15 TON
CONVERT_MIN_TR      = 1_000_000  # minimum TR to convert