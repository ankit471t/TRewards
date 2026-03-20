"""
TRewards Backend - FastAPI + PostgreSQL (Supabase)
Run: uvicorn main:app --host 0.0.0.0 --port 8000
"""

import os
import hmac
import hashlib
import json
import time
import secrets
import string
import threading
from datetime import datetime, date, timedelta
from typing import Optional
from urllib.parse import unquote, parse_qsl
from contextlib import asynccontextmanager

import httpx
import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ─── Config ────────────────────────────────────────────────
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
DATABASE_URL = os.getenv("DATABASE_URL", "")  # Supabase pooler URL port 6543
XROCKET_API_KEY = os.getenv("XROCKET_API_KEY", "")
CRYPTOPAY_API_KEY = os.getenv("CRYPTOPAY_API_KEY", "")
CRYPTOPAY_BASE = "https://pay.crypt.bot/api"  # mainnet; testnet: https://testnet-pay.crypt.bot/api
XROCKET_BASE = "https://pay.xrocket.tg"
ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "123456789").split(",") if x.strip()]
CHANNEL_USERNAME = os.getenv("CHANNEL_USERNAME", "trewards_ton")
WITHDRAWAL_CHANNEL_ID = os.getenv("WITHDRAWAL_CHANNEL_ID", "")  # e.g. -1001234567890

app = FastAPI(title="TRewards API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── DB ────────────────────────────────────────────────────
def get_db():
    # Strip any ?ssl or ?sslmode params — psycopg2 uses sslmode keyword instead
    url = DATABASE_URL
    if "?" in url:
        url = url.split("?")[0]
    conn = psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor, sslmode="require")
    return conn

def db_exec(query, params=(), fetch=False, fetchone=False):
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute(query, params)
        conn.commit()
        if fetchone:
            return cur.fetchone()
        if fetch:
            return cur.fetchall()
        return None
    finally:
        conn.close()

# ─── Validation ────────────────────────────────────────────
def verify_telegram_init_data(init_data: str) -> Optional[dict]:
    """Validate Telegram WebApp initData HMAC"""
    if not init_data or not BOT_TOKEN:
        return None
    try:
        parsed = dict(parse_qsl(init_data, keep_blank_values=True))
        hash_str = parsed.pop("hash", "")
        data_check = "\n".join(sorted(f"{k}={v}" for k, v in parsed.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed = hmac.new(secret_key, data_check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed, hash_str):
            return None
        user_data = json.loads(parsed.get("user", "{}"))
        return user_data
    except Exception:
        return None

def get_user_from_request(request: Request, x_telegram_init_data: str = "") -> Optional[dict]:
    """Extract and validate user from initData header"""
    init_data = x_telegram_init_data or request.headers.get("x-telegram-init-data", "")
    user = verify_telegram_init_data(init_data)
    return user

# ─── Models ────────────────────────────────────────────────
class UserRequest(BaseModel):
    user_id: int
    first_name: str = ""
    last_name: str = ""
    username: str = ""

class SpinRequest(BaseModel):
    user_id: int

class StreakRequest(BaseModel):
    user_id: int

class DailyTaskRequest(BaseModel):
    user_id: int
    task_id: str

class PromoRequest(BaseModel):
    user_id: int
    code: str

class ClaimTaskRequest(BaseModel):
    user_id: int
    task_id: int

class VerifyJoinRequest(BaseModel):
    user_id: int
    task_id: int

class ClaimReferralRequest(BaseModel):
    user_id: int

class WithdrawRequest(BaseModel):
    user_id: int
    tier_tr: int
    tier_ton: float
    net_ton: float

class TopUpRequest(BaseModel):
    user_id: int
    amount: float
    method: str
    target: str = "wallet"

class CreateTaskRequest(BaseModel):
    user_id: int
    name: str
    type: str
    url: str
    limit: int

class ConvertRequest(BaseModel):
    user_id: int
    tr_amount: int

class XRocketWebhook(BaseModel):
    invoiceId: Optional[str] = None
    status: Optional[str] = None

# ─── Helpers ───────────────────────────────────────────────
def log_transaction(user_id, type_, description, amount, currency="TR"):
    db_exec(
        "INSERT INTO transactions (user_id, type, description, amount, currency) VALUES (%s,%s,%s,%s,%s)",
        (user_id, type_, description, amount, currency)
    )

async def get_telegram_user_status(chat_id: str, user_id: int) -> str:
    """Check if user is member of a channel/group"""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember",
                params={"chat_id": chat_id, "user_id": user_id},
                timeout=10
            )
            data = r.json()
            if data.get("ok"):
                return data["result"]["status"]
    except Exception:
        pass
    return "left"

# ─── Routes ────────────────────────────────────────────────

@app.get("/")
@app.head("/")
def root():
    return {"status": "TRewards API running", "version": "1.0.0"}

@app.get("/health")
@app.head("/health")
def health():
    # Also test DB connection
    try:
        db_exec("SELECT 1", fetchone=True)
        db_ok = True
    except Exception as e:
        db_ok = False
        print(f"Health check DB error: {e}")
    return {
        "status": "ok",
        "db": "connected" if db_ok else "error",
        "timestamp": datetime.utcnow().isoformat()
    }

@app.post("/api/user")
async def get_or_create_user(req: UserRequest):
    """Register or fetch user"""
    user = db_exec(
        "SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True
    )
    if not user:
        db_exec(
            """INSERT INTO users (user_id, first_name, last_name, username, balance, spins, streak, created_at)
               VALUES (%s,%s,%s,%s,0,3,0,NOW())""",
            (req.user_id, req.first_name, req.last_name, req.username)
        )
        log_transaction(req.user_id, "earn", "Welcome Bonus", 100)
        db_exec("UPDATE users SET balance=100 WHERE user_id=%s", (req.user_id,))
        user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)

    today = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today

    # Get pending referral
    pending = db_exec(
        "SELECT COALESCE(SUM(pending_amount),0) as total FROM referral_earnings WHERE user_id=%s AND claimed=false",
        (req.user_id,), fetchone=True
    )

    return {
        "user_id": user["user_id"],
        "first_name": user["first_name"],
        "username": user["username"],
        "balance": user["balance"],
        "spins": user["spins"],
        "streak": user["streak"],
        "streak_claimed_today": streak_claimed,
        "pending_referral": int(pending["total"]) if pending else 0,
        "daily_tasks_completed": user.get("daily_tasks_completed") or []
    }

@app.post("/api/claim-streak")
async def claim_streak(req: StreakRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")
    today = date.today().isoformat()
    if str(user.get("last_streak_date", "")) == today:
        raise HTTPException(400, "Already claimed today")

    yesterday = (date.today() - timedelta(days=1)).isoformat()
    if str(user.get("last_streak_date", "")) == yesterday:
        new_streak = (user["streak"] or 0) + 1
    else:
        new_streak = 1
    if new_streak > 7:
        new_streak = 1

    db_exec(
        "UPDATE users SET balance=balance+10, spins=spins+1, streak=%s, last_streak_date=%s WHERE user_id=%s",
        (new_streak, today, req.user_id)
    )
    log_transaction(req.user_id, "streak", f"Day {new_streak} streak bonus", 10)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return {
        "balance": user["balance"], "spins": user["spins"], "streak": new_streak,
        "streak_claimed_today": True, "user_id": user["user_id"],
        "daily_tasks_completed": user.get("daily_tasks_completed") or [],
        "pending_referral": 0
    }

@app.post("/api/spin")
async def spin_wheel(req: SpinRequest):
    import random
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")
    if (user["spins"] or 0) <= 0:
        raise HTTPException(400, "No spin tokens")

    # Equal probability for all segments
    rewards = [10, 50, 80, 100, 300, 500]
    reward = random.choice(rewards)

    db_exec(
        "UPDATE users SET balance=balance+%s, spins=spins-1 WHERE user_id=%s",
        (reward, req.user_id)
    )
    db_exec(
        "INSERT INTO spin_history (user_id, reward, created_at) VALUES (%s,%s,NOW())",
        (req.user_id, reward)
    )
    log_transaction(req.user_id, "spin", f"Spin Wheel reward", reward)

    # Referral commission for referrer
    await process_referral_earnings(req.user_id, reward)

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return {
        "reward": reward, "balance": user["balance"], "spins": user["spins"],
        "streak": user["streak"], "streak_claimed_today": False,
        "user_id": user["user_id"], "daily_tasks_completed": user.get("daily_tasks_completed") or [],
        "pending_referral": 0
    }

async def process_referral_earnings(user_id: int, amount: int):
    """Add 30% to referrer's pending earnings"""
    ref = db_exec("SELECT referrer_id FROM users WHERE user_id=%s", (user_id,), fetchone=True)
    if ref and ref.get("referrer_id"):
        commission = int(amount * 0.30)
        if commission > 0:
            db_exec(
                """INSERT INTO referral_earnings (user_id, from_user_id, pending_amount, claimed, created_at)
                   VALUES (%s,%s,%s,false,NOW())""",
                (ref["referrer_id"], user_id, commission)
            )

@app.post("/api/redeem-promo")
async def redeem_promo(req: PromoRequest):
    promo = db_exec(
        "SELECT * FROM promo_codes WHERE code=%s AND is_active=true", (req.code.upper(),), fetchone=True
    )
    if not promo:
        raise HTTPException(400, "Invalid or expired promo code")

    # Check max activations
    count = db_exec(
        "SELECT COUNT(*) as c FROM promo_activations WHERE promo_id=%s",
        (promo["id"],), fetchone=True
    )
    if count["c"] >= promo["max_activations"]:
        raise HTTPException(400, "Promo code limit reached")

    # Check user already used
    already = db_exec(
        "SELECT id FROM promo_activations WHERE promo_id=%s AND user_id=%s",
        (promo["id"], req.user_id), fetchone=True
    )
    if already:
        raise HTTPException(400, "Already redeemed this code")

    db_exec(
        "INSERT INTO promo_activations (promo_id, user_id, created_at) VALUES (%s,%s,NOW())",
        (promo["id"], req.user_id)
    )

    reward_type = promo["reward_type"]
    reward_amount = promo["reward_amount"]

    if reward_type == "tr":
        db_exec("UPDATE users SET balance=balance+%s WHERE user_id=%s", (reward_amount, req.user_id))
        log_transaction(req.user_id, "promo", f"Promo: {promo['code']}", reward_amount)
    # TON rewards stored in user's withdrawal queue manually

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return {
        "reward_type": reward_type, "reward_amount": reward_amount,
        "balance": user["balance"], "spins": user["spins"],
        "streak": user["streak"], "user_id": user["user_id"],
        "streak_claimed_today": False, "daily_tasks_completed": user.get("daily_tasks_completed") or [],
        "pending_referral": 0
    }

@app.post("/api/claim-daily-task")
async def claim_daily_task(req: DailyTaskRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")

    completed = user.get("daily_tasks_completed") or []
    today = date.today().isoformat()

    # Reset daily tasks if it's a new day
    last_reset = user.get("daily_tasks_reset_date")
    if str(last_reset) != today:
        completed = []
        db_exec("UPDATE users SET daily_tasks_completed=%s, daily_tasks_reset_date=%s WHERE user_id=%s",
                (json.dumps([]), today, req.user_id))

    if req.task_id in completed:
        raise HTTPException(400, "Task already completed today")

    completed.append(req.task_id)
    db_exec(
        "UPDATE users SET balance=balance+500, spins=spins+1, daily_tasks_completed=%s WHERE user_id=%s",
        (json.dumps(completed), req.user_id)
    )
    log_transaction(req.user_id, "task", f"Daily task: {req.task_id}", 500)
    await process_referral_earnings(req.user_id, 500)

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    today_str = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today_str
    return {
        "balance": user["balance"], "spins": user["spins"], "streak": user["streak"],
        "streak_claimed_today": streak_claimed, "user_id": user["user_id"],
        "daily_tasks_completed": completed, "pending_referral": 0
    }

@app.get("/api/tasks")
async def get_tasks(user_id: int):
    tasks = db_exec(
        "SELECT * FROM tasks WHERE status='active' ORDER BY created_at DESC",
        fetch=True
    )
    completed = db_exec(
        "SELECT task_id FROM task_completions WHERE user_id=%s",
        (user_id,), fetch=True
    )
    completed_ids = {r["task_id"] for r in (completed or [])}
    result = []
    for t in (tasks or []):
        result.append({
            "id": t["id"], "name": t["name"], "type": t["type"],
            "url": t["url"], "reward": t["reward"],
            "completed": t["id"] in completed_ids,
            "status": t["status"]
        })
    return {"tasks": result}

@app.post("/api/claim-task")
async def claim_task(req: ClaimTaskRequest):
    task = db_exec("SELECT * FROM tasks WHERE id=%s AND status='active'", (req.task_id,), fetchone=True)
    if not task:
        raise HTTPException(404, "Task not found or inactive")

    existing = db_exec(
        "SELECT id FROM task_completions WHERE user_id=%s AND task_id=%s",
        (req.user_id, req.task_id), fetchone=True
    )
    if existing:
        raise HTTPException(400, "Task already completed")

    reward = task["reward"] or (3000 if task["type"] == "website" else 5000)
    db_exec(
        "INSERT INTO task_completions (user_id, task_id, created_at) VALUES (%s,%s,NOW())",
        (req.user_id, req.task_id)
    )
    db_exec(
        "UPDATE users SET balance=balance+%s, spins=spins+1 WHERE user_id=%s",
        (reward, req.user_id)
    )
    db_exec(
        "UPDATE tasks SET completed_count=completed_count+1 WHERE id=%s", (req.task_id,)
    )
    # Deduct from advertiser balance
    cost = 0.001  # TON per completion
    db_exec(
        "UPDATE users SET ad_balance=GREATEST(0, ad_balance-%s) WHERE user_id=(SELECT advertiser_id FROM tasks WHERE id=%s)",
        (cost, req.task_id)
    )
    # Update task status if limit reached
    db_exec(
        "UPDATE tasks SET status='completed' WHERE id=%s AND completed_count >= completion_limit",
        (req.task_id,)
    )
    log_transaction(req.user_id, "task", f"Task: {task['name']}", reward)
    await process_referral_earnings(req.user_id, reward)

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    today_str = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today_str
    return {
        "reward": reward, "balance": user["balance"], "spins": user["spins"],
        "streak": user["streak"], "streak_claimed_today": streak_claimed,
        "user_id": user["user_id"], "daily_tasks_completed": user.get("daily_tasks_completed") or [],
        "pending_referral": 0
    }

@app.post("/api/verify-join")
async def verify_join(req: VerifyJoinRequest):
    task = db_exec("SELECT * FROM tasks WHERE id=%s", (req.task_id,), fetchone=True)
    if not task:
        raise HTTPException(404, "Task not found")

    # Extract chat username/ID from URL
    url = task["url"]
    chat_id = url.split("t.me/")[-1].split("/")[0] if "t.me/" in url else url
    if not chat_id.startswith("@"):
        chat_id = "@" + chat_id

    status = await get_telegram_user_status(chat_id, req.user_id)
    if status in ["left", "kicked", "banned"]:
        raise HTTPException(400, "You haven't joined yet. Please join first.")

    # Same as claim_task from here
    existing = db_exec(
        "SELECT id FROM task_completions WHERE user_id=%s AND task_id=%s",
        (req.user_id, req.task_id), fetchone=True
    )
    if existing:
        raise HTTPException(400, "Task already completed")

    reward = 5000
    db_exec(
        "INSERT INTO task_completions (user_id, task_id, created_at) VALUES (%s,%s,NOW())",
        (req.user_id, req.task_id)
    )
    db_exec(
        "UPDATE users SET balance=balance+%s, spins=spins+1 WHERE user_id=%s",
        (reward, req.user_id)
    )
    db_exec("UPDATE tasks SET completed_count=completed_count+1 WHERE id=%s", (req.task_id,))
    log_transaction(req.user_id, "task", f"Join task: {task['name']}", reward)
    await process_referral_earnings(req.user_id, reward)

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    today_str = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today_str
    return {
        "reward": reward, "balance": user["balance"], "spins": user["spins"],
        "streak": user["streak"], "streak_claimed_today": streak_claimed,
        "user_id": user["user_id"], "daily_tasks_completed": user.get("daily_tasks_completed") or [],
        "pending_referral": 0
    }

@app.get("/api/friends")
async def get_friends(user_id: int):
    friends = db_exec(
        """SELECT u.user_id, u.first_name, u.last_name, u.username, u.balance as total_earned
           FROM users u WHERE u.referrer_id=%s ORDER BY u.balance DESC LIMIT 10""",
        (user_id,), fetch=True
    )
    total_earned = db_exec(
        "SELECT COALESCE(SUM(pending_amount),0) as total FROM referral_earnings WHERE user_id=%s",
        (user_id,), fetchone=True
    )
    return {
        "friends": [dict(f) for f in (friends or [])],
        "total_earned": int(total_earned["total"]) if total_earned else 0
    }

@app.post("/api/claim-referral")
async def claim_referral(req: ClaimReferralRequest):
    pending = db_exec(
        "SELECT COALESCE(SUM(pending_amount),0) as total FROM referral_earnings WHERE user_id=%s AND claimed=false",
        (req.user_id,), fetchone=True
    )
    amount = int(pending["total"]) if pending else 0
    if amount <= 0:
        raise HTTPException(400, "No pending referral rewards")

    db_exec(
        "UPDATE referral_earnings SET claimed=true WHERE user_id=%s AND claimed=false",
        (req.user_id,)
    )
    db_exec("UPDATE users SET balance=balance+%s WHERE user_id=%s", (amount, req.user_id))
    log_transaction(req.user_id, "referral", "Referral commission claimed", amount)

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    today_str = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today_str
    return {
        "balance": user["balance"], "spins": user["spins"], "streak": user["streak"],
        "streak_claimed_today": streak_claimed, "user_id": user["user_id"],
        "daily_tasks_completed": user.get("daily_tasks_completed") or [], "pending_referral": 0
    }

@app.get("/api/transactions")
async def get_transactions(user_id: int):
    txs = db_exec(
        "SELECT * FROM transactions WHERE user_id=%s ORDER BY created_at DESC LIMIT 20",
        (user_id,), fetch=True
    )
    return {"transactions": [dict(t) for t in (txs or [])]}

@app.post("/api/withdraw")
async def withdraw(req: WithdrawRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")
    if (user["balance"] or 0) < req.tier_tr:
        raise HTTPException(400, "Insufficient balance")

    db_exec("UPDATE users SET balance=balance-%s WHERE user_id=%s", (req.tier_tr, req.user_id))
    db_exec(
        """INSERT INTO withdrawals (user_id, tr_amount, ton_gross, ton_net, status, created_at)
           VALUES (%s,%s,%s,%s,'pending',NOW())""",
        (req.user_id, req.tier_tr, req.tier_ton, req.net_ton)
    )
    log_transaction(req.user_id, "withdraw", f"Withdrawal {req.net_ton} TON", -req.tier_tr)

    # Notify admin channel with inline keyboard
    withdrawal_id = db_exec(
        "SELECT id FROM withdrawals WHERE user_id=%s ORDER BY created_at DESC LIMIT 1",
        (req.user_id,), fetchone=True
    )
    wid = withdrawal_id["id"] if withdrawal_id else 0

    await send_withdrawal_notification(
        user_id=req.user_id,
        first_name=user.get("first_name", "User"),
        username=user.get("username", ""),
        tr_amount=req.tier_tr,
        ton_net=req.net_ton,
        withdrawal_id=wid
    )

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    today_str = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today_str
    return {
        "balance": user["balance"], "spins": user["spins"], "streak": user["streak"],
        "streak_claimed_today": streak_claimed, "user_id": user["user_id"],
        "daily_tasks_completed": user.get("daily_tasks_completed") or [], "pending_referral": 0
    }

async def send_withdrawal_notification(user_id, first_name, username, tr_amount, ton_net, withdrawal_id):
    if not WITHDRAWAL_CHANNEL_ID or not BOT_TOKEN:
        return
    text = (
        f"💸 *Withdrawal Request*\n\n"
        f"👤 User: {first_name} (@{username}) `{user_id}`\n"
        f"💰 Amount: `{ton_net:.4f} TON`\n"
        f"🪙 TR Deducted: `{ton_net:,}` TR\n"
        f"🆔 Withdrawal ID: `{withdrawal_id}`\n"
        f"⏰ Time: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"
    )
    keyboard = {
        "inline_keyboard": [[
            {"text": "✅ Approve", "callback_data": f"wd_approve_{withdrawal_id}"},
            {"text": "❌ Decline", "callback_data": f"wd_decline_{withdrawal_id}"},
            {"text": "💸 Complete", "callback_data": f"wd_complete_{withdrawal_id}"}
        ]]
    }
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={
                "chat_id": WITHDRAWAL_CHANNEL_ID,
                "text": text,
                "parse_mode": "Markdown",
                "reply_markup": keyboard
            }
        )

@app.post("/api/convert")
async def convert_tr_to_ton(req: ConvertRequest):
    if req.tr_amount < 1000000:
        raise HTTPException(400, "Minimum 1,000,000 TR to convert")
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user or (user["balance"] or 0) < req.tr_amount:
        raise HTTPException(400, "Insufficient balance")

    ton_amount = round(req.tr_amount / 1000000 * 0.15, 4)
    db_exec("UPDATE users SET balance=balance-%s WHERE user_id=%s", (req.tr_amount, req.user_id))
    db_exec(
        """INSERT INTO withdrawals (user_id, tr_amount, ton_gross, ton_net, status, type, created_at)
           VALUES (%s,%s,%s,%s,'pending','convert',NOW())""",
        (req.user_id, req.tr_amount, ton_amount, ton_amount)
    )
    log_transaction(req.user_id, "convert", f"Convert {req.tr_amount:,} TR → {ton_amount} TON", -req.tr_amount)

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    today_str = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today_str
    return {
        "ton_amount": ton_amount, "balance": user["balance"], "spins": user["spins"],
        "streak": user["streak"], "streak_claimed_today": streak_claimed,
        "user_id": user["user_id"], "daily_tasks_completed": user.get("daily_tasks_completed") or [],
        "pending_referral": 0
    }

@app.post("/api/create-topup")
async def create_topup(req: TopUpRequest):
    if req.amount <= 0:
        raise HTTPException(400, "Invalid amount")

    invoice_id = "TR_" + secrets.token_hex(8).upper()

    if req.method == "xrocket":
        if not XROCKET_API_KEY:
            raise HTTPException(500, "xRocket not configured")
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{XROCKET_BASE}/tg-invoices",
                headers={"Rocket-Pay-Key": XROCKET_API_KEY, "Content-Type": "application/json"},
                json={
                    "amount": str(req.amount),
                    "currency": "TONCOIN",
                    "description": f"TRewards top-up {req.amount} TON",
                    "payload": json.dumps({"user_id": req.user_id, "invoice_id": invoice_id, "target": req.target}),
                    "callbackUrl": f"{os.getenv('BACKEND_URL', '')}/payment-webhook/xrocket"
                }
            )
            data = r.json()
            pay_url = data.get("data", {}).get("payUrl") or data.get("payUrl")
            if not pay_url:
                raise HTTPException(500, f"xRocket error: {data}")

    elif req.method == "cryptopay":
        if not CRYPTOPAY_API_KEY:
            raise HTTPException(500, "CryptoPay not configured")
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{CRYPTOPAY_BASE}/createInvoice",
                headers={"Crypto-Pay-API-Token": CRYPTOPAY_API_KEY},
                json={
                    "asset": "TON",
                    "amount": str(req.amount),
                    "description": f"TRewards top-up {req.amount} TON",
                    "payload": json.dumps({"user_id": req.user_id, "invoice_id": invoice_id, "target": req.target}),
                    "paid_btn_name": "openBot",
                    "paid_btn_url": f"https://t.me/{os.getenv('BOT_USERNAME', 'trewards_ton_bot')}"
                }
            )
            data = r.json()
            pay_url = data.get("result", {}).get("pay_url")
            if not pay_url:
                raise HTTPException(500, f"CryptoPay error: {data}")
    else:
        raise HTTPException(400, "Invalid payment method")

    db_exec(
        """INSERT INTO payments (user_id, invoice_id, amount, method, status, target, created_at)
           VALUES (%s,%s,%s,%s,'pending',%s,NOW())""",
        (req.user_id, invoice_id, req.amount, req.method, req.target)
    )
    return {"pay_url": pay_url, "invoice_id": invoice_id}

@app.get("/api/advertiser")
async def get_advertiser(user_id: int):
    user = db_exec("SELECT ad_balance FROM users WHERE user_id=%s", (user_id,), fetchone=True)
    tasks = db_exec(
        "SELECT * FROM tasks WHERE advertiser_id=%s ORDER BY created_at DESC",
        (user_id,), fetch=True
    )
    return {
        "ad_balance": float(user["ad_balance"] or 0) if user else 0,
        "tasks": [dict(t) for t in (tasks or [])]
    }

@app.post("/api/create-task")
async def create_task(req: CreateTaskRequest):
    reward = 3000 if req.type == "website" else 5000
    cost = req.limit * 0.001

    user = db_exec("SELECT ad_balance FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user or (user.get("ad_balance") or 0) < cost:
        raise HTTPException(400, f"Insufficient ad balance. Need {cost:.3f} TON")

    db_exec("UPDATE users SET ad_balance=ad_balance-%s WHERE user_id=%s", (cost, req.user_id))
    db_exec(
        """INSERT INTO tasks (advertiser_id, name, type, url, reward, completion_limit, completed_count, status, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,0,'active',NOW())""",
        (req.user_id, req.name, req.type, req.url, reward, req.limit)
    )
    return {"success": True, "cost": cost}

# ─── Webhooks ──────────────────────────────────────────────

@app.post("/payment-webhook/xrocket")
async def xrocket_webhook(request: Request):
    body = await request.json()
    try:
        # Verify signature
        sig = request.headers.get("rocket-pay-signature", "")
        raw = await request.body()
        expected = hmac.new(XROCKET_API_KEY.encode(), raw, hashlib.sha256).hexdigest()
        if sig and sig != expected:
            return JSONResponse({"ok": False, "error": "Invalid signature"})

        status = body.get("status")
        if status != "PAID":
            return {"ok": True}

        payload_str = body.get("payload", "{}")
        payload = json.loads(payload_str) if isinstance(payload_str, str) else payload_str
        user_id = payload.get("user_id")
        invoice_id = payload.get("invoice_id")
        target = payload.get("target", "wallet")
        amount = float(body.get("amount", 0))
        currency = body.get("currency", "TONCOIN")

        if currency not in ("TONCOIN", "TON"):
            return {"ok": True}

        # Prevent double credit
        existing = db_exec(
            "SELECT id FROM payments WHERE invoice_id=%s AND status='paid'",
            (invoice_id,), fetchone=True
        )
        if existing:
            return {"ok": True, "duplicate": True}

        db_exec(
            "UPDATE payments SET status='paid', paid_at=NOW() WHERE invoice_id=%s",
            (invoice_id,)
        )
        if target == "advertiser":
            db_exec("UPDATE users SET ad_balance=ad_balance+%s WHERE user_id=%s", (amount, user_id))
            log_transaction(user_id, "topup", f"Ad balance top-up via xRocket", amount, "TON")
        else:
            db_exec("UPDATE users SET ton_balance=COALESCE(ton_balance,0)+%s WHERE user_id=%s", (amount, user_id))
            log_transaction(user_id, "topup", f"Top-up via xRocket", amount, "TON")

        # Notify user via bot
        await notify_user_payment(user_id, amount, "xRocket")
    except Exception as e:
        print(f"xRocket webhook error: {e}")
    return {"ok": True}

@app.post("/payment-webhook/cryptopay")
async def cryptopay_webhook(request: Request):
    body = await request.json()
    try:
        # Verify signature
        token_hash = hashlib.sha256(CRYPTOPAY_API_KEY.encode()).hexdigest()
        sig = request.headers.get("crypto-pay-api-signature", "")
        raw = await request.body()
        expected = hmac.new(token_hash.encode(), raw, hashlib.sha256).hexdigest()
        if sig and sig != expected:
            return JSONResponse({"ok": False})

        if body.get("update_type") != "invoice_paid":
            return {"ok": True}

        invoice = body.get("payload", {})
        if invoice.get("status") != "paid":
            return {"ok": True}
        if invoice.get("asset") != "TON":
            return {"ok": True}

        invoice_id = invoice.get("payload", "")
        payload_data = {}
        try:
            payload_data = json.loads(invoice_id) if invoice_id else {}
        except Exception:
            pass

        user_id = payload_data.get("user_id")
        cp_invoice_id = str(invoice.get("invoice_id", ""))
        target = payload_data.get("target", "wallet")
        amount = float(invoice.get("amount", 0))

        existing = db_exec(
            "SELECT id FROM payments WHERE invoice_id=%s AND status='paid'",
            (cp_invoice_id,), fetchone=True
        )
        if existing:
            return {"ok": True}

        db_exec(
            "UPDATE payments SET status='paid', paid_at=NOW() WHERE invoice_id=%s",
            (cp_invoice_id,)
        )
        if target == "advertiser":
            db_exec("UPDATE users SET ad_balance=ad_balance+%s WHERE user_id=%s", (amount, user_id))
            log_transaction(user_id, "topup", "Ad balance top-up via CryptoPay", amount, "TON")
        else:
            db_exec("UPDATE users SET ton_balance=COALESCE(ton_balance,0)+%s WHERE user_id=%s", (amount, user_id))
            log_transaction(user_id, "topup", "Top-up via CryptoPay", amount, "TON")

        await notify_user_payment(user_id, amount, "CryptoPay")
    except Exception as e:
        print(f"CryptoPay webhook error: {e}")
    return {"ok": True}

async def notify_user_payment(user_id: int, amount: float, method: str):
    if not BOT_TOKEN or not user_id:
        return
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={
                    "chat_id": user_id,
                    "text": f"✅ Payment received!\n\n💰 {amount:.4f} TON added via {method}.\n\nOpen TRewards to use your balance.",
                    "parse_mode": "Markdown"
                }
            )
    except Exception as e:
        print(f"Notify user error: {e}")

# ─── Withdrawal callback handler (called from bot) ─────────
@app.post("/api/withdrawal-action")
async def withdrawal_action(request: Request):
    body = await request.json()
    admin_id = body.get("admin_id")
    withdrawal_id = body.get("withdrawal_id")
    action = body.get("action")  # approve / decline / complete

    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")

    withdrawal = db_exec(
        "SELECT * FROM withdrawals WHERE id=%s", (withdrawal_id,), fetchone=True
    )
    if not withdrawal:
        raise HTTPException(404, "Withdrawal not found")

    if action == "complete":
        db_exec("UPDATE withdrawals SET status='completed' WHERE id=%s", (withdrawal_id,))
        # Notify user
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={
                    "chat_id": withdrawal["user_id"],
                    "text": "✅ *Payment Sent!*\n\nYour withdrawal has been processed. Please check your wallet.\n\n💸 Thank you for using TRewards!",
                    "parse_mode": "Markdown"
                }
            )
        return {"success": True, "status": "completed"}
    elif action == "approve":
        db_exec("UPDATE withdrawals SET status='approved' WHERE id=%s", (withdrawal_id,))
        return {"success": True, "status": "approved"}
    elif action == "decline":
        # Refund coins
        db_exec(
            "UPDATE users SET balance=balance+%s WHERE user_id=%s",
            (withdrawal["tr_amount"], withdrawal["user_id"])
        )
        db_exec("UPDATE withdrawals SET status='declined' WHERE id=%s", (withdrawal_id,))
        log_transaction(withdrawal["user_id"], "earn", "Withdrawal declined - refund", withdrawal["tr_amount"])
        async with httpx.AsyncClient() as client:
            await client.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                json={
                    "chat_id": withdrawal["user_id"],
                    "text": "❌ Your withdrawal request was declined. Your TR coins have been refunded.",
                }
            )
        return {"success": True, "status": "declined"}

    raise HTTPException(400, "Invalid action")

# ─── Admin Routes (merged from admin_routes.py) ────────────

class CreatePromoRequest(BaseModel):
    admin_id: int
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int

class SetReferrerRequest(BaseModel):
    user_id: int
    referrer_id: int

@app.post("/api/set-referrer")
async def set_referrer(req: SetReferrerRequest):
    if req.user_id == req.referrer_id:
        return {"ok": False, "error": "Self-referral not allowed"}
    user = db_exec("SELECT referrer_id FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if user and not user.get("referrer_id"):
        referrer = db_exec("SELECT user_id FROM users WHERE user_id=%s", (req.referrer_id,), fetchone=True)
        if referrer:
            db_exec("UPDATE users SET referrer_id=%s WHERE user_id=%s", (req.referrer_id, req.user_id))
    return {"ok": True}

@app.post("/api/admin/create-promo")
async def admin_create_promo(req: CreatePromoRequest):
    if req.admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    existing = db_exec("SELECT id FROM promo_codes WHERE code=%s", (req.code,), fetchone=True)
    if existing:
        raise HTTPException(400, "Promo code already exists")
    db_exec(
        "INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, is_active, created_by, created_at) VALUES (%s,%s,%s,%s,true,%s,NOW())",
        (req.code, req.reward_type, req.reward_amount, req.max_activations, req.admin_id)
    )
    return {"ok": True}

@app.get("/api/admin/promo-codes")
async def admin_list_promos(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    codes = db_exec(
        "SELECT p.*, (SELECT COUNT(*) FROM promo_activations WHERE promo_id=p.id) as used FROM promo_codes p ORDER BY created_at DESC",
        fetch=True
    )
    return {"codes": [dict(c) for c in (codes or [])]}

@app.delete("/api/admin/promo-codes/{code}")
async def admin_delete_promo(code: str, admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    db_exec("UPDATE promo_codes SET is_active=false WHERE code=%s", (code,))
    return {"ok": True}

@app.get("/api/admin/promo-history")
async def admin_promo_history(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    acts = db_exec(
        "SELECT pa.*, pc.code FROM promo_activations pa JOIN promo_codes pc ON pa.promo_id=pc.id ORDER BY pa.created_at DESC LIMIT 50",
        fetch=True
    )
    return {"activations": [dict(a) for a in (acts or [])]}

@app.get("/api/admin/payments")
async def admin_payments(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    pays = db_exec("SELECT * FROM payments ORDER BY created_at DESC LIMIT 50", fetch=True)
    return {"payments": [dict(p) for p in (pays or [])]}

@app.get("/api/admin/stats")
async def admin_stats(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    total_users      = db_exec("SELECT COUNT(*) as c FROM users", fetchone=True)
    active_today     = db_exec("SELECT COUNT(*) as c FROM users WHERE updated_at::date=CURRENT_DATE", fetchone=True)
    total_withdrawals= db_exec("SELECT COALESCE(SUM(ton_net),0) as t FROM withdrawals WHERE status='completed'", fetchone=True)
    total_completions= db_exec("SELECT COUNT(*) as c FROM task_completions", fetchone=True)
    return {
        "total_users":       total_users["c"]            if total_users else 0,
        "active_today":      active_today["c"]           if active_today else 0,
        "total_withdrawals": float(total_withdrawals["t"]) if total_withdrawals else 0,
        "total_completions": total_completions["c"]      if total_completions else 0,
    }


# ─── Telegram Bot (runs in background thread) ──────────────
def run_bot():
    """Start the Telegram bot using long polling in a background thread."""
    import requests as req_lib

    if not BOT_TOKEN:
        print("⚠️  BOT_TOKEN not set — bot disabled")
        return

    WEBAPP_URL_BOT = os.getenv("WEBAPP_URL", "https://trewards.onrender.com")
    offset = 0

    def tg(method, **kwargs):
        try:
            r = req_lib.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
                json=kwargs, timeout=30
            )
            return r.json()
        except Exception as e:
            print(f"TG API error [{method}]: {e}")
            return {}

    def answer_cb(cid): tg("answerCallbackQuery", callback_query_id=cid)

    promo_wizard = {}   # user_id → wizard state

    def handle_update(upd):
        nonlocal promo_wizard

        # ── callback_query ──────────────────────────────────
        if "callback_query" in upd:
            cq = upd["callback_query"]
            chat_id  = cq["message"]["chat"]["id"]
            msg_id   = cq["message"]["message_id"]
            user_id  = cq["from"]["id"]
            data     = cq.get("data", "")
            answer_cb(cq["id"])

            # Withdrawal admin actions
            if data.startswith("wd_"):
                if user_id not in ADMIN_IDS:
                    return
                parts = data.split("_")          # wd_approve_5  or  wd_complete_5
                action = parts[1]
                wid    = int(parts[2])

                import requests as rr
                res = rr.post(
                    f"http://localhost:{os.getenv('PORT', 8000)}/api/withdrawal-action",
                    json={"admin_id": user_id, "withdrawal_id": wid, "action": action},
                    timeout=10
                ).json()

                if res.get("error"):
                    tg("sendMessage", chat_id=chat_id, text=f"❌ {res['error']}")
                    return

                orig_text = cq["message"].get("text", "")
                if action == "complete":
                    tg("editMessageReplyMarkup", chat_id=chat_id, message_id=msg_id,
                       reply_markup={"inline_keyboard": []})
                    tg("editMessageText", chat_id=chat_id, message_id=msg_id,
                       text=orig_text + "\n\n✅ COMPLETED — Payment sent",
                       parse_mode="Markdown")
                elif action == "approve":
                    tg("editMessageText", chat_id=chat_id, message_id=msg_id,
                       text=orig_text + "\n\n✅ APPROVED — Processing...",
                       parse_mode="Markdown",
                       reply_markup={"inline_keyboard": [[
                           {"text": "❌ Decline",  "callback_data": f"wd_decline_{wid}"},
                           {"text": "💸 Complete", "callback_data": f"wd_complete_{wid}"}
                       ]]})
                elif action == "decline":
                    tg("editMessageReplyMarkup", chat_id=chat_id, message_id=msg_id,
                       reply_markup={"inline_keyboard": []})
                    tg("editMessageText", chat_id=chat_id, message_id=msg_id,
                       text=orig_text + "\n\n❌ DECLINED — Coins refunded",
                       parse_mode="Markdown")
                return

            # Admin panel callbacks
            if user_id not in ADMIN_IDS:
                return

            if data == "admin_promo_create":
                promo_wizard[user_id] = {"step": 1}
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text="🎁 *Create Promo Code — Step 1/4*\n\nEnter the promo code name (e.g. WELCOME100):")
                return

            if data == "admin_promo_list":
                codes = db_exec(
                    """SELECT p.*, (SELECT COUNT(*) FROM promo_activations WHERE promo_id=p.id) as used
                       FROM promo_codes p ORDER BY created_at DESC""", fetch=True
                ) or []
                if not codes:
                    tg("sendMessage", chat_id=chat_id, text="📋 No promo codes found.")
                    return
                lines = "\n\n".join(
                    f"• `{c['code']}` — {c['reward_amount']} {c['reward_type'].upper()}\n"
                    f"  Used: {c['used']}/{c['max_activations']} | {'✅ Active' if c['is_active'] else '❌ Inactive'}"
                    for c in codes
                )
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text=f"📋 *Promo Codes:*\n\n{lines}")
                return

            if data == "admin_promo_delete":
                promo_wizard[user_id] = {"step": "delete"}
                tg("sendMessage", chat_id=chat_id, text="🗑 Enter the promo code to delete:")
                return

            if data == "admin_promo_history":
                acts = db_exec(
                    """SELECT pa.*, pc.code FROM promo_activations pa
                       JOIN promo_codes pc ON pa.promo_id=pc.id
                       ORDER BY pa.created_at DESC LIMIT 20""", fetch=True
                ) or []
                if not acts:
                    tg("sendMessage", chat_id=chat_id, text="No activations yet.")
                    return
                lines = "\n".join(
                    f"• {a['code']} → User {a['user_id']} on {str(a['created_at'])[:10]}"
                    for a in acts
                )
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text=f"📈 *Recent Activations:*\n\n{lines}")
                return

            if data == "admin_payment_history":
                pays = db_exec(
                    "SELECT * FROM payments ORDER BY created_at DESC LIMIT 10", fetch=True
                ) or []
                if not pays:
                    tg("sendMessage", chat_id=chat_id, text="No payments yet.")
                    return
                lines = "\n".join(
                    f"• {p['amount']} TON via {p['method']} — {p['status']} (User {p['user_id']})"
                    for p in pays
                )
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text=f"💸 *Recent Payments:*\n\n{lines}")
                return

            if data == "admin_total_users":
                total   = db_exec("SELECT COUNT(*) as c FROM users", fetchone=True)
                active  = db_exec("SELECT COUNT(*) as c FROM users WHERE updated_at::date=CURRENT_DATE", fetchone=True)
                wdraw   = db_exec("SELECT COALESCE(SUM(ton_net),0) as t FROM withdrawals WHERE status='completed'", fetchone=True)
                compl   = db_exec("SELECT COUNT(*) as c FROM task_completions", fetchone=True)
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text=(
                       f"👥 *Platform Stats*\n\n"
                       f"Total Users: *{total['c']}*\n"
                       f"Active Today: *{active['c']}*\n"
                       f"Total Withdrawn: *{float(wdraw['t']):.4f} TON*\n"
                       f"Task Completions: *{compl['c']}*"
                   ))
                return

            if data.startswith("promo_type_") and promo_wizard.get(user_id, {}).get("step") == 2:
                promo_wizard[user_id]["reward_type"] = data.replace("promo_type_", "")
                promo_wizard[user_id]["step"] = 3
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text="🎁 *Create Promo Code — Step 3/4*\n\nEnter reward amount (e.g. 5000 for TR, 0.5 for TON):")
                return

        # ── message ─────────────────────────────────────────
        if "message" not in upd:
            return

        msg     = upd["message"]
        chat_id = msg["chat"]["id"]
        user_id = msg["from"]["id"]
        text    = msg.get("text", "")
        first   = msg["from"].get("first_name", "Friend")

        # /start [ref]
        if text.startswith("/start"):
            parts = text.split(maxsplit=1)
            ref_param = parts[1].strip() if len(parts) > 1 else ""
            referrer_id = None
            if ref_param.isdigit() and int(ref_param) != user_id:
                referrer_id = int(ref_param)

            # Register user
            try:
                import requests as rr
                rr.post(f"http://localhost:{os.getenv('PORT', 8000)}/api/user", json={
                    "user_id": user_id,
                    "first_name": msg["from"].get("first_name", ""),
                    "last_name":  msg["from"].get("last_name", ""),
                    "username":   msg["from"].get("username", ""),
                }, timeout=10)
                if referrer_id:
                    rr.post(f"http://localhost:{os.getenv('PORT', 8000)}/api/set-referrer", json={
                        "user_id": user_id, "referrer_id": referrer_id
                    }, timeout=10)
            except Exception as e:
                print(f"Register error: {e}")

            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text=(
                   f"🏆 *Welcome to TRewards, {first}!*\n\n"
                   f"Earn *TR Coins* by completing tasks, spinning the wheel, and inviting friends.\n\n"
                   f"💎 *Withdraw your coins as TON cryptocurrency!*\n\n"
                   f"━━━━━━━━━━━━━━━━━━━━\n"
                   f"🔥 Daily streak bonuses\n"
                   f"🎰 Spin the wheel for prizes\n"
                   f"👥 30% referral commission\n"
                   f"📢 Advertiser task rewards\n"
                   f"━━━━━━━━━━━━━━━━━━━━\n\n"
                   f"Tap the button below to open TRewards! 👇"
               ),
               reply_markup={"inline_keyboard": [[
                   {"text": "🚀 Open TRewards", "web_app": {"url": WEBAPP_URL_BOT}}
               ], [
                   {"text": "📢 TRewards Channel", "url": "https://t.me/trewards_ton"}
               ]]})
            return

        # /amiadminyes
        if text == "/amiadminyes":
            if user_id not in ADMIN_IDS:
                tg("sendMessage", chat_id=chat_id, text="⛔ Access denied.")
                return
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text="⚙️ *TRewards Admin Panel*\n\nWelcome, Admin. Choose an action:",
               reply_markup={"inline_keyboard": [
                   [{"text": "🎁 Create Promo Code",  "callback_data": "admin_promo_create"}],
                   [{"text": "📋 List Promo Codes",   "callback_data": "admin_promo_list"}],
                   [{"text": "🗑 Delete Promo Code",  "callback_data": "admin_promo_delete"}],
                   [{"text": "📈 Activation History", "callback_data": "admin_promo_history"}],
                   [{"text": "💸 Payment History",    "callback_data": "admin_payment_history"}],
                   [{"text": "👥 Total Users",        "callback_data": "admin_total_users"}],
               ]})
            return

        # Promo wizard text input
        if user_id not in ADMIN_IDS or user_id not in promo_wizard:
            return

        wizard = promo_wizard[user_id]

        if wizard["step"] == "delete":
            del promo_wizard[user_id]
            code = text.strip().upper()
            db_exec("UPDATE promo_codes SET is_active=false WHERE code=%s", (code,))
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text=f"✅ Promo code `{code}` deactivated.")
            return

        if wizard["step"] == 1:
            wizard["code"] = text.strip().upper()
            wizard["step"] = 2
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text=f"🎁 *Step 2/4*\n\nCode: `{wizard['code']}`\n\nSelect reward type:",
               reply_markup={"inline_keyboard": [[
                   {"text": "🪙 TR Coins", "callback_data": "promo_type_tr"},
                   {"text": "💎 TON",      "callback_data": "promo_type_ton"},
               ]]})
            return

        if wizard["step"] == 3:
            try:
                wizard["reward_amount"] = float(text.strip())
            except ValueError:
                tg("sendMessage", chat_id=chat_id, text="❌ Invalid amount. Enter a number:")
                return
            wizard["step"] = 4
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text="🎁 *Step 4/4*\n\nEnter maximum number of activations (e.g. 100):")
            return

        if wizard["step"] == 4:
            try:
                wizard["max_activations"] = int(text.strip())
            except ValueError:
                tg("sendMessage", chat_id=chat_id, text="❌ Enter a positive integer:")
                return
            del promo_wizard[user_id]
            # Check duplicate
            existing = db_exec("SELECT id FROM promo_codes WHERE code=%s", (wizard["code"],), fetchone=True)
            if existing:
                tg("sendMessage", chat_id=chat_id, text="❌ Promo code already exists.")
                return
            db_exec(
                """INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, is_active, created_by, created_at)
                   VALUES (%s,%s,%s,%s,true,%s,NOW())""",
                (wizard["code"], wizard["reward_type"], wizard["reward_amount"],
                 wizard["max_activations"], user_id)
            )
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text=(
                   f"✅ *Promo Code Created!*\n\n"
                   f"Code: `{wizard['code']}`\n"
                   f"Reward: {wizard['reward_amount']} {wizard['reward_type'].upper()}\n"
                   f"Max Uses: {wizard['max_activations']}"
               ))

    # ── Polling loop ────────────────────────────────────────
    print("🤖 TRewards Bot polling started...")
    while True:
        try:
            resp = req_lib.get(
                f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates",
                params={"offset": offset, "timeout": 30, "allowed_updates": ["message", "callback_query"]},
                timeout=35
            ).json()
            for upd in resp.get("result", []):
                offset = upd["update_id"] + 1
                try:
                    handle_update(upd)
                except Exception as e:
                    print(f"Handle update error: {e}")
        except Exception as e:
            print(f"Polling error: {e}")
            time.sleep(5)


# ── Start bot thread when uvicorn starts ────────────────────
@app.on_event("startup")
def startup_event():
    t = threading.Thread(target=run_bot, daemon=True)
    t.start()
    print("✅ TRewards API + Bot started")