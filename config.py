import os
from dotenv import load_dotenv
load_dotenv()

# ─── Database ────────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL")

# ─── Telegram ────────────────────────────────────────────────────────────────
BOT_TOKEN        = os.getenv("BOT_TOKEN")
BOT_USERNAME     = os.getenv("BOT_USERNAME", "treward_ton_bot")  # @treward_ton_bot
CHANNEL_USERNAME = os.getenv("CHANNEL_USERNAME", "treward_ton")  # @treward_ton
ADMIN_IDS        = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]

# ─── Payment Providers ───────────────────────────────────────────────────────
XROCKET_API_KEY          = os.getenv("XROCKET_API_KEY")
XROCKET_WEBHOOK_SECRET   = os.getenv("XROCKET_WEBHOOK_SECRET")
CRYPTOPAY_API_TOKEN      = os.getenv("CRYPTOPAY_API_TOKEN")
CRYPTOPAY_WEBHOOK_SECRET = os.getenv("CRYPTOPAY_WEBHOOK_SECRET")

# ─── App URLs ─────────────────────────────────────────────────────────────────
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://trewards.onrender.com")
API_URL      = os.getenv("API_URL",      "https://trewards-api.onrender.com")

# ─── Coin / TON Rates ─────────────────────────────────────────────────────────
COINS_PER_TON = 1_000_000 / 0.15
TON_PER_COIN  = 0.15 / 1_000_000

# ─── Withdrawal Tiers ────────────────────────────────────────────────────────
WITHDRAWAL_TIERS = [
    {"coins": 1_000_000,  "ton": 0.10, "net": 0.07, "fee": 0.03},
    {"coins": 2_000_000,  "ton": 0.20, "net": 0.17, "fee": 0.03},
    {"coins": 3_000_000,  "ton": 0.30, "net": 0.27, "fee": 0.03},
    {"coins": 10_000_000, "ton": 1.00, "net": 1.00, "fee": 0.00},
]
NETWORK_FEE = 0.03

# ─── Task Rewards ─────────────────────────────────────────────────────────────
TASK_REWARD_VISIT   = 3_000
TASK_REWARD_CHANNEL = 5_000
TASK_REWARD_GROUP   = 5_000
TASK_REWARD_GAME    = 5_000
TASK_SPIN_BONUS     = 1

# ─── Ad / Task Pricing ───────────────────────────────────────────────────────
AD_COST_PER_COMPLETION  = 0.001
DAILY_TASK_COST_PER_DAY = 5.0

# ─── Spin Wheel ───────────────────────────────────────────────────────────────
SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500]
SPIN_WEIGHTS  = [35, 25, 20, 12,  6,   2]

# ─── Streak ───────────────────────────────────────────────────────────────────
STREAK_COIN_REWARD = 10
STREAK_SPIN_REWARD = 1

# ─── Daily Tasks ──────────────────────────────────────────────────────────────
DAILY_TASK_COIN_REWARD = 10
DAILY_TASK_SPIN_REWARD = 1

# ─── Watch Ads ────────────────────────────────────────────────────────────────
WATCH_AD_REWARD = 2_500

# ─── Referral ────────────────────────────────────────────────────────────────
REFERRAL_COMMISSION = 0.30

# ─── TON Check ────────────────────────────────────────────────────────────────
CHECK_MIN_AMOUNT = 0.01

# ─── Broadcast ────────────────────────────────────────────────────────────────
# Telegram allows ~30 msgs/sec to different users; batch to stay safe
BROADCAST_BATCH_SIZE  = 30   # users per batch
BROADCAST_BATCH_DELAY = 1.0  # seconds to sleep between batches