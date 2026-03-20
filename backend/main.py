"""
TRewards Backend - FastAPI + PostgreSQL (Supabase)
Run: uvicorn main:app --host 0.0.0.0 --port $PORT
"""

import os, hmac, hashlib, json, time, secrets, string, threading, random
from datetime import datetime, date, timedelta
from typing import Optional
from urllib.parse import parse_qsl

import httpx, psycopg2, psycopg2.extras
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ─── Config ────────────────────────────────────────────────
BOT_TOKEN            = os.getenv("BOT_TOKEN", "")
DATABASE_URL         = os.getenv("DATABASE_URL", "")
XROCKET_API_KEY      = os.getenv("XROCKET_API_KEY", "")
CRYPTOPAY_API_KEY    = os.getenv("CRYPTOPAY_API_KEY", "")
CRYPTOPAY_BASE       = "https://pay.crypt.bot/api"
XROCKET_BASE         = "https://pay.xrocket.tg"
ADMIN_IDS            = [int(x) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip().isdigit()]
WITHDRAWAL_CHANNEL_ID = os.getenv("WITHDRAWAL_CHANNEL_ID", "")
WEBAPP_URL           = os.getenv("WEBAPP_URL", "https://trewards.onrender.com")
BOT_USERNAME         = os.getenv("BOT_USERNAME", "trewards_ton_bot")

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
    url = DATABASE_URL
    # Strip query params — psycopg2 doesn't accept ?sslmode= in URI
    if "?" in url:
        url = url.split("?")[0]
    # Supabase requires SSL
    try:
        return psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor, sslmode="require")
    except Exception:
        # Fallback without sslmode if it fails
        return psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)

def db_exec(query, params=(), fetch=False, fetchone=False):
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute(query, params)
        conn.commit()
        if fetchone: return cur.fetchone()
        if fetch:    return cur.fetchall()
        return None
    except Exception as e:
        try: conn.rollback()
        except: pass
        print(f"DB error: {e} | Query: {query[:80]}")
        raise e
    finally:
        try: conn.close()
        except: pass

# ─── Helpers ───────────────────────────────────────────────
def log_tx(user_id, type_, desc, amount, currency="TR"):
    try:
        db_exec(
            "INSERT INTO transactions (user_id, type, description, amount, currency) VALUES (%s,%s,%s,%s,%s)",
            (user_id, type_, desc, amount, currency)
        )
    except Exception as e:
        print(f"log_tx error: {e}")

def user_response(user, extra={}):
    """Standard user state response"""
    today = date.today().isoformat()
    streak_claimed = str(user.get("last_streak_date", "")) == today
    completed = user.get("daily_tasks_completed") or []
    if isinstance(completed, str):
        try: completed = json.loads(completed)
        except: completed = []
    pending = db_exec(
        "SELECT COALESCE(SUM(pending_amount),0) as total FROM referral_earnings WHERE user_id=%s AND claimed=false",
        (user["user_id"],), fetchone=True
    )
    base = {
        "user_id":               user["user_id"],
        "first_name":            user.get("first_name", ""),
        "username":              user.get("username", ""),
        "balance":               int(user.get("balance") or 0),
        "spins":                 int(user.get("spins") or 0),
        "streak":                int(user.get("streak") or 0),
        "streak_claimed_today":  streak_claimed,
        "daily_tasks_completed": completed,
        "pending_referral":      int(pending["total"]) if pending else 0,
    }
    base.update(extra)
    return base

async def process_referral(user_id: int, amount: int):
    try:
        ref = db_exec("SELECT referrer_id FROM users WHERE user_id=%s", (user_id,), fetchone=True)
        if ref and ref.get("referrer_id"):
            commission = int(amount * 0.30)
            if commission > 0:
                db_exec(
                    "INSERT INTO referral_earnings (user_id, from_user_id, pending_amount, claimed, created_at) VALUES (%s,%s,%s,false,NOW())",
                    (ref["referrer_id"], user_id, commission)
                )
    except Exception as e:
        print(f"process_referral error: {e}")

async def tg_post(method, **kwargs):
    if not BOT_TOKEN: return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", json=kwargs)
    except Exception as e:
        print(f"tg_post {method} error: {e}")

# ─── Models ────────────────────────────────────────────────
class UserRequest(BaseModel):
    user_id: int
    first_name: str = ""
    last_name: str = ""
    username: str = ""

class UidRequest(BaseModel):
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

class SetReferrerRequest(BaseModel):
    user_id: int
    referrer_id: int

class CreatePromoRequest(BaseModel):
    admin_id: int
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int

class WithdrawalActionRequest(BaseModel):
    admin_id: int
    withdrawal_id: int
    action: str  # approve / decline / complete

# ─── Routes ────────────────────────────────────────────────

@app.get("/")
@app.head("/")
def root():
    return {"status": "TRewards API running", "version": "1.0.0"}

@app.get("/health")
@app.head("/health")
def health():
    db_ok = False
    db_err = ""
    try:
        db_exec("SELECT 1", fetchone=True)
        db_ok = True
    except Exception as e:
        db_err = str(e)
        print(f"DB health error: {e}")
    return {
        "status": "ok",
        "db": "connected" if db_ok else "error",
        "db_error": db_err if not db_ok else None,
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/api/debug")
def debug():
    """Debug endpoint — shows env vars status (no secrets)"""
    db_ok = False
    db_err = ""
    try:
        result = db_exec("SELECT COUNT(*) as c FROM users", fetchone=True)
        db_ok = True
        user_count = result["c"] if result else 0
    except Exception as e:
        db_err = str(e)
        user_count = -1
    return {
        "db_connected":    db_ok,
        "db_error":        db_err,
        "user_count":      user_count,
        "has_bot_token":   bool(BOT_TOKEN),
        "has_db_url":      bool(DATABASE_URL),
        "has_xrocket":     bool(XROCKET_API_KEY),
        "has_cryptopay":   bool(CRYPTOPAY_API_KEY),
        "admin_ids":       ADMIN_IDS,
        "withdrawal_ch":   bool(WITHDRAWAL_CHANNEL_ID),
        "webapp_url":      WEBAPP_URL,
    }

# ── /api/user ───────────────────────────────────────────────
@app.post("/api/user")
async def get_or_create_user(req: UserRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        db_exec(
            "INSERT INTO users (user_id, first_name, last_name, username, balance, spins, streak, created_at, updated_at) VALUES (%s,%s,%s,%s,100,3,0,NOW(),NOW())",
            (req.user_id, req.first_name, req.last_name, req.username)
        )
        log_tx(req.user_id, "earn", "Welcome Bonus", 100)
        user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    else:
        # Update name in case it changed
        db_exec(
            "UPDATE users SET first_name=%s, last_name=%s, username=%s, updated_at=NOW() WHERE user_id=%s",
            (req.first_name, req.last_name, req.username, req.user_id)
        )
        user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user)

# ── /api/claim-streak ───────────────────────────────────────
@app.post("/api/claim-streak")
async def claim_streak(req: UidRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")
    today = date.today().isoformat()
    if str(user.get("last_streak_date", "")) == today:
        raise HTTPException(400, "Already claimed today")

    yesterday = (date.today() - timedelta(days=1)).isoformat()
    cur_streak = int(user.get("streak") or 0)
    if str(user.get("last_streak_date", "")) == yesterday:
        new_streak = cur_streak + 1
    else:
        new_streak = 1
    if new_streak > 7:
        new_streak = 1

    db_exec(
        "UPDATE users SET balance=balance+10, spins=spins+1, streak=%s, last_streak_date=%s, updated_at=NOW() WHERE user_id=%s",
        (new_streak, today, req.user_id)
    )
    log_tx(req.user_id, "streak", f"Day {new_streak} streak bonus", 10)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user)

# ── /api/spin ───────────────────────────────────────────────
@app.post("/api/spin")
async def spin_wheel(req: UidRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")
    if int(user.get("spins") or 0) <= 0:
        raise HTTPException(400, "No spin tokens")

    reward = random.choice([10, 50, 80, 100, 300, 500])

    db_exec(
        "UPDATE users SET balance=balance+%s, spins=spins-1, updated_at=NOW() WHERE user_id=%s",
        (reward, req.user_id)
    )
    db_exec(
        "INSERT INTO spin_history (user_id, reward, created_at) VALUES (%s,%s,NOW())",
        (req.user_id, reward)
    )
    log_tx(req.user_id, "spin", "Spin Wheel", reward)
    await process_referral(req.user_id, reward)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user, {"reward": reward})

# ── /api/redeem-promo ───────────────────────────────────────
@app.post("/api/redeem-promo")
async def redeem_promo(req: PromoRequest):
    promo = db_exec(
        "SELECT * FROM promo_codes WHERE UPPER(code)=UPPER(%s) AND is_active=true",
        (req.code.strip(),), fetchone=True
    )
    if not promo:
        raise HTTPException(400, "Invalid or expired promo code")

    count = db_exec(
        "SELECT COUNT(*) as c FROM promo_activations WHERE promo_id=%s",
        (promo["id"],), fetchone=True
    )
    if int(count["c"]) >= int(promo["max_activations"]):
        raise HTTPException(400, "Promo code limit reached")

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

    reward_type   = promo["reward_type"]
    reward_amount = float(promo["reward_amount"])

    if reward_type == "tr":
        db_exec("UPDATE users SET balance=balance+%s, updated_at=NOW() WHERE user_id=%s", (int(reward_amount), req.user_id))
        log_tx(req.user_id, "promo", f"Promo: {promo['code']}", int(reward_amount))

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user, {"reward_type": reward_type, "reward_amount": reward_amount})

# ── /api/claim-daily-task ───────────────────────────────────
@app.post("/api/claim-daily-task")
async def claim_daily_task(req: DailyTaskRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")

    today = date.today().isoformat()
    last_reset = str(user.get("daily_tasks_reset_date", "") or "")
    completed = user.get("daily_tasks_completed") or []
    if isinstance(completed, str):
        try: completed = json.loads(completed)
        except: completed = []

    # Reset if new day
    if last_reset != today:
        completed = []
        db_exec(
            "UPDATE users SET daily_tasks_completed=%s, daily_tasks_reset_date=%s WHERE user_id=%s",
            (json.dumps([]), today, req.user_id)
        )

    if req.task_id in completed:
        raise HTTPException(400, "Task already completed today")

    completed.append(req.task_id)
    db_exec(
        "UPDATE users SET balance=balance+500, spins=spins+1, daily_tasks_completed=%s, updated_at=NOW() WHERE user_id=%s",
        (json.dumps(completed), req.user_id)
    )
    log_tx(req.user_id, "task", f"Daily task: {req.task_id}", 500)
    await process_referral(req.user_id, 500)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user)

# ── /api/tasks ──────────────────────────────────────────────
@app.get("/api/tasks")
async def get_tasks(user_id: int):
    tasks = db_exec("SELECT * FROM tasks WHERE status='active' ORDER BY created_at DESC", fetch=True)
    completed = db_exec(
        "SELECT task_id FROM task_completions WHERE user_id=%s", (user_id,), fetch=True
    )
    done_ids = {r["task_id"] for r in (completed or [])}
    result = []
    for t in (tasks or []):
        result.append({
            "id":        t["id"],
            "name":      t["name"],
            "type":      t["type"],
            "url":       t["url"],
            "reward":    t["reward"],
            "completed": t["id"] in done_ids,
            "status":    t["status"],
        })
    return {"tasks": result}

# ── /api/claim-task ─────────────────────────────────────────
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

    reward = int(task.get("reward") or (3000 if task["type"] == "website" else 5000))

    db_exec("INSERT INTO task_completions (user_id, task_id, created_at) VALUES (%s,%s,NOW())", (req.user_id, req.task_id))
    db_exec("UPDATE users SET balance=balance+%s, spins=spins+1, updated_at=NOW() WHERE user_id=%s", (reward, req.user_id))
    db_exec("UPDATE tasks SET completed_count=completed_count+1 WHERE id=%s", (req.task_id,))
    db_exec("UPDATE tasks SET status='completed' WHERE id=%s AND completed_count >= completion_limit", (req.task_id,))
    # Deduct advertiser
    db_exec(
        "UPDATE users SET ad_balance=GREATEST(0, ad_balance-0.001) WHERE user_id=(SELECT advertiser_id FROM tasks WHERE id=%s)",
        (req.task_id,)
    )
    log_tx(req.user_id, "task", f"Task: {task['name']}", reward)
    await process_referral(req.user_id, reward)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user, {"reward": reward})

# ── /api/verify-join ────────────────────────────────────────
@app.post("/api/verify-join")
async def verify_join(req: VerifyJoinRequest):
    task = db_exec("SELECT * FROM tasks WHERE id=%s", (req.task_id,), fetchone=True)
    if not task:
        raise HTTPException(404, "Task not found")

    existing = db_exec(
        "SELECT id FROM task_completions WHERE user_id=%s AND task_id=%s",
        (req.user_id, req.task_id), fetchone=True
    )
    if existing:
        raise HTTPException(400, "Task already completed")

    # Extract @username from URL
    url = task["url"]
    chat_id = url.split("t.me/")[-1].split("/")[0].split("?")[0] if "t.me/" in url else url
    if not chat_id.startswith("@") and not chat_id.startswith("-"):
        chat_id = "@" + chat_id

    # Check membership
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember",
                params={"chat_id": chat_id, "user_id": req.user_id}
            )
            data = r.json()
            if data.get("ok"):
                status = data["result"]["status"]
                if status in ["left", "kicked"]:
                    raise HTTPException(400, "You haven't joined yet. Please join first.")
            else:
                # If we can't check (private channel), allow claim
                pass
    except HTTPException:
        raise
    except Exception as e:
        print(f"verify_join check error: {e}")
        # Allow claim if check fails (bot not in channel)

    reward = 5000
    db_exec("INSERT INTO task_completions (user_id, task_id, created_at) VALUES (%s,%s,NOW())", (req.user_id, req.task_id))
    db_exec("UPDATE users SET balance=balance+%s, spins=spins+1, updated_at=NOW() WHERE user_id=%s", (reward, req.user_id))
    db_exec("UPDATE tasks SET completed_count=completed_count+1 WHERE id=%s", (req.task_id,))
    log_tx(req.user_id, "task", f"Join: {task['name']}", reward)
    await process_referral(req.user_id, reward)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user, {"reward": reward})

# ── /api/friends ────────────────────────────────────────────
@app.get("/api/friends")
async def get_friends(user_id: int):
    friends = db_exec(
        "SELECT user_id, first_name, last_name, username, balance as total_earned FROM users WHERE referrer_id=%s ORDER BY balance DESC LIMIT 10",
        (user_id,), fetch=True
    )
    total = db_exec(
        "SELECT COALESCE(SUM(pending_amount),0) as total FROM referral_earnings WHERE user_id=%s",
        (user_id,), fetchone=True
    )
    return {
        "friends":      [dict(f) for f in (friends or [])],
        "total_earned": int(total["total"]) if total else 0
    }

# ── /api/claim-referral ─────────────────────────────────────
@app.post("/api/claim-referral")
async def claim_referral(req: UidRequest):
    pending = db_exec(
        "SELECT COALESCE(SUM(pending_amount),0) as total FROM referral_earnings WHERE user_id=%s AND claimed=false",
        (req.user_id,), fetchone=True
    )
    amount = int(pending["total"]) if pending else 0
    if amount <= 0:
        raise HTTPException(400, "No pending referral rewards")

    db_exec("UPDATE referral_earnings SET claimed=true WHERE user_id=%s AND claimed=false", (req.user_id,))
    db_exec("UPDATE users SET balance=balance+%s, updated_at=NOW() WHERE user_id=%s", (amount, req.user_id))
    log_tx(req.user_id, "referral", "Referral commission", amount)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user)

# ── /api/transactions ───────────────────────────────────────
@app.get("/api/transactions")
async def get_transactions(user_id: int):
    txs = db_exec(
        "SELECT * FROM transactions WHERE user_id=%s ORDER BY created_at DESC LIMIT 20",
        (user_id,), fetch=True
    )
    return {"transactions": [dict(t) for t in (txs or [])]}

# ── /api/withdraw ───────────────────────────────────────────
@app.post("/api/withdraw")
async def withdraw(req: WithdrawRequest):
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user:
        raise HTTPException(404, "User not found")
    if int(user.get("balance") or 0) < req.tier_tr:
        raise HTTPException(400, f"Insufficient balance. Need {req.tier_tr:,} TR")

    db_exec("UPDATE users SET balance=balance-%s, updated_at=NOW() WHERE user_id=%s", (req.tier_tr, req.user_id))
    db_exec(
        "INSERT INTO withdrawals (user_id, tr_amount, ton_gross, ton_net, status, created_at) VALUES (%s,%s,%s,%s,'pending',NOW())",
        (req.user_id, req.tier_tr, req.tier_ton, req.net_ton)
    )
    log_tx(req.user_id, "withdraw", f"Withdraw {req.net_ton} TON", -req.tier_tr)

    # Get withdrawal ID for notification
    wd = db_exec("SELECT id FROM withdrawals WHERE user_id=%s ORDER BY created_at DESC LIMIT 1", (req.user_id,), fetchone=True)
    wid = wd["id"] if wd else 0

    # Notify admin channel
    if WITHDRAWAL_CHANNEL_ID and BOT_TOKEN:
        fname = user.get("first_name", "User")
        uname = user.get("username", "")
        await tg_post(
            "sendMessage",
            chat_id=WITHDRAWAL_CHANNEL_ID,
            parse_mode="Markdown",
            text=(
                f"💸 *Withdrawal Request*\n\n"
                f"👤 {fname} (@{uname}) `{req.user_id}`\n"
                f"💰 Amount: `{req.net_ton:.4f} TON`\n"
                f"🪙 TR Deducted: `{req.tier_tr:,} TR`\n"
                f"🆔 ID: `{wid}`\n"
                f"⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}"
            ),
            reply_markup={
                "inline_keyboard": [[
                    {"text": "✅ Approve",  "callback_data": f"wd_approve_{wid}"},
                    {"text": "❌ Decline",  "callback_data": f"wd_decline_{wid}"},
                    {"text": "💸 Complete", "callback_data": f"wd_complete_{wid}"}
                ]]
            }
        )

    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user)

# ── /api/convert ────────────────────────────────────────────
@app.post("/api/convert")
async def convert_tr(req: ConvertRequest):
    if req.tr_amount < 1000000:
        raise HTTPException(400, "Minimum 1,000,000 TR")
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user or int(user.get("balance") or 0) < req.tr_amount:
        raise HTTPException(400, "Insufficient balance")

    ton = round(req.tr_amount / 1000000 * 0.15, 4)
    db_exec("UPDATE users SET balance=balance-%s, updated_at=NOW() WHERE user_id=%s", (req.tr_amount, req.user_id))
    db_exec(
        "INSERT INTO withdrawals (user_id, tr_amount, ton_gross, ton_net, status, type, created_at) VALUES (%s,%s,%s,%s,'pending','convert',NOW())",
        (req.user_id, req.tr_amount, ton, ton)
    )
    log_tx(req.user_id, "convert", f"Convert {req.tr_amount:,} TR", -req.tr_amount)
    user = db_exec("SELECT * FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    return user_response(user, {"ton_amount": ton})

# ── /api/create-topup ───────────────────────────────────────
@app.post("/api/create-topup")
async def create_topup(req: TopUpRequest):
    if req.amount <= 0:
        raise HTTPException(400, "Invalid amount")

    invoice_id = "TR_" + secrets.token_hex(8).upper()
    pay_url = None

    if req.method == "xrocket":
        if not XROCKET_API_KEY:
            raise HTTPException(500, "xRocket not configured")
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{XROCKET_BASE}/tg-invoices",
                headers={"Rocket-Pay-Key": XROCKET_API_KEY, "Content-Type": "application/json"},
                json={
                    "amount": str(req.amount),
                    "currency": "TONCOIN",
                    "description": f"TRewards top-up {req.amount} TON",
                    "payload": json.dumps({"user_id": req.user_id, "invoice_id": invoice_id, "target": req.target}),
                    "callbackUrl": f"{os.getenv('BACKEND_URL','https://trewards-backend.onrender.com')}/payment-webhook/xrocket"
                }
            )
        data = r.json()
        pay_url = data.get("data", {}).get("payUrl") or data.get("payUrl")
        if not pay_url:
            raise HTTPException(500, f"xRocket error: {data}")

    elif req.method == "cryptopay":
        if not CRYPTOPAY_API_KEY:
            raise HTTPException(500, "CryptoPay not configured")
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{CRYPTOPAY_BASE}/createInvoice",
                headers={"Crypto-Pay-API-Token": CRYPTOPAY_API_KEY},
                json={
                    "asset": "TON",
                    "amount": str(req.amount),
                    "description": f"TRewards top-up {req.amount} TON",
                    "payload": json.dumps({"user_id": req.user_id, "invoice_id": invoice_id, "target": req.target}),
                    "paid_btn_name": "openBot",
                    "paid_btn_url": f"https://t.me/{BOT_USERNAME}"
                }
            )
        data = r.json()
        pay_url = data.get("result", {}).get("pay_url")
        if not pay_url:
            raise HTTPException(500, f"CryptoPay error: {data}")
    else:
        raise HTTPException(400, "Invalid method")

    db_exec(
        "INSERT INTO payments (user_id, invoice_id, amount, method, status, target, created_at) VALUES (%s,%s,%s,%s,'pending',%s,NOW())",
        (req.user_id, invoice_id, req.amount, req.method, req.target)
    )
    return {"pay_url": pay_url, "invoice_id": invoice_id}

# ── /api/advertiser ─────────────────────────────────────────
@app.get("/api/advertiser")
async def get_advertiser(user_id: int):
    user = db_exec("SELECT ad_balance FROM users WHERE user_id=%s", (user_id,), fetchone=True)
    tasks = db_exec("SELECT * FROM tasks WHERE advertiser_id=%s ORDER BY created_at DESC", (user_id,), fetch=True)
    return {
        "ad_balance": float(user["ad_balance"] or 0) if user else 0,
        "tasks": [dict(t) for t in (tasks or [])]
    }

# ── /api/create-task ────────────────────────────────────────
@app.post("/api/create-task")
async def create_task(req: CreateTaskRequest):
    reward = 3000 if req.type == "website" else 5000
    cost   = round(req.limit * 0.001, 4)
    user   = db_exec("SELECT ad_balance FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if not user or float(user.get("ad_balance") or 0) < cost:
        raise HTTPException(400, f"Insufficient ad balance. Need {cost:.3f} TON")

    db_exec("UPDATE users SET ad_balance=ad_balance-%s WHERE user_id=%s", (cost, req.user_id))
    db_exec(
        "INSERT INTO tasks (advertiser_id, name, type, url, reward, completion_limit, completed_count, status, created_at) VALUES (%s,%s,%s,%s,%s,%s,0,'active',NOW())",
        (req.user_id, req.name, req.type, req.url, reward, req.limit)
    )
    return {"success": True, "cost": cost, "reward": reward}

# ── /api/set-referrer ───────────────────────────────────────
@app.post("/api/set-referrer")
async def set_referrer(req: SetReferrerRequest):
    if req.user_id == req.referrer_id:
        return {"ok": False, "error": "Self-referral not allowed"}
    user = db_exec("SELECT referrer_id FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if user and not user.get("referrer_id"):
        ref = db_exec("SELECT user_id FROM users WHERE user_id=%s", (req.referrer_id,), fetchone=True)
        if ref:
            db_exec("UPDATE users SET referrer_id=%s WHERE user_id=%s", (req.referrer_id, req.user_id))
    return {"ok": True}

# ── /api/withdrawal-action ──────────────────────────────────
@app.post("/api/withdrawal-action")
async def withdrawal_action(req: WithdrawalActionRequest):
    if req.admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    wd = db_exec("SELECT * FROM withdrawals WHERE id=%s", (req.withdrawal_id,), fetchone=True)
    if not wd:
        raise HTTPException(404, "Withdrawal not found")

    if req.action == "complete":
        db_exec("UPDATE withdrawals SET status='completed', updated_at=NOW() WHERE id=%s", (req.withdrawal_id,))
        await tg_post("sendMessage", chat_id=wd["user_id"],
            text="✅ *Payment Sent!*\n\nYour withdrawal has been processed. Please check your TON wallet. 💸",
            parse_mode="Markdown")
        return {"success": True, "status": "completed"}

    elif req.action == "approve":
        db_exec("UPDATE withdrawals SET status='approved', updated_at=NOW() WHERE id=%s", (req.withdrawal_id,))
        return {"success": True, "status": "approved"}

    elif req.action == "decline":
        db_exec("UPDATE users SET balance=balance+%s, updated_at=NOW() WHERE user_id=%s", (wd["tr_amount"], wd["user_id"]))
        db_exec("UPDATE withdrawals SET status='declined', updated_at=NOW() WHERE id=%s", (req.withdrawal_id,))
        log_tx(wd["user_id"], "earn", "Withdrawal declined - refund", wd["tr_amount"])
        await tg_post("sendMessage", chat_id=wd["user_id"],
            text="❌ Your withdrawal was declined. Your TR coins have been refunded.")
        return {"success": True, "status": "declined"}

    raise HTTPException(400, "Invalid action")

# ── Admin routes ────────────────────────────────────────────
@app.post("/api/admin/create-promo")
async def admin_create_promo(req: CreatePromoRequest):
    if req.admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    if db_exec("SELECT id FROM promo_codes WHERE UPPER(code)=UPPER(%s)", (req.code,), fetchone=True):
        raise HTTPException(400, "Code already exists")
    db_exec(
        "INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, is_active, created_by, created_at) VALUES (%s,%s,%s,%s,true,%s,NOW())",
        (req.code.upper(), req.reward_type, req.reward_amount, req.max_activations, req.admin_id)
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
    db_exec("UPDATE promo_codes SET is_active=false WHERE UPPER(code)=UPPER(%s)", (code,))
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
    return {
        "total_users":        (db_exec("SELECT COUNT(*) as c FROM users", fetchone=True) or {}).get("c", 0),
        "active_today":       (db_exec("SELECT COUNT(*) as c FROM users WHERE updated_at::date=CURRENT_DATE", fetchone=True) or {}).get("c", 0),
        "total_withdrawals":  float((db_exec("SELECT COALESCE(SUM(ton_net),0) as t FROM withdrawals WHERE status='completed'", fetchone=True) or {}).get("t", 0)),
        "total_completions":  (db_exec("SELECT COUNT(*) as c FROM task_completions", fetchone=True) or {}).get("c", 0),
    }

# ─── Payment Webhooks ──────────────────────────────────────

@app.post("/payment-webhook/xrocket")
async def xrocket_webhook(request: Request):
    try:
        body    = await request.json()
        raw     = await request.body()
        sig     = request.headers.get("rocket-pay-signature", "")

        if sig and XROCKET_API_KEY:
            expected = hmac.new(XROCKET_API_KEY.encode(), raw, hashlib.sha256).hexdigest()
            if sig != expected:
                return JSONResponse({"ok": False, "error": "bad signature"})

        if body.get("status") != "PAID":
            return {"ok": True}

        payload  = json.loads(body.get("payload", "{}")) if isinstance(body.get("payload"), str) else {}
        user_id  = payload.get("user_id")
        inv_id   = payload.get("invoice_id", "")
        target   = payload.get("target", "wallet")
        amount   = float(body.get("amount", 0))

        if body.get("currency") not in ("TONCOIN", "TON"):
            return {"ok": True}
        if not user_id:
            return {"ok": True}

        if db_exec("SELECT id FROM payments WHERE invoice_id=%s AND status='paid'", (inv_id,), fetchone=True):
            return {"ok": True, "duplicate": True}

        db_exec("UPDATE payments SET status='paid', paid_at=NOW() WHERE invoice_id=%s", (inv_id,))
        if target == "advertiser":
            db_exec("UPDATE users SET ad_balance=ad_balance+%s WHERE user_id=%s", (amount, user_id))
            log_tx(user_id, "topup", "Ad balance top-up via xRocket", amount, "TON")
        else:
            db_exec("UPDATE users SET ton_balance=COALESCE(ton_balance,0)+%s WHERE user_id=%s", (amount, user_id))
            log_tx(user_id, "topup", "Top-up via xRocket", amount, "TON")

        await tg_post("sendMessage", chat_id=user_id,
            text=f"✅ *Payment received!*\n\n💰 {amount:.4f} TON added via xRocket.\n\nOpen TRewards to continue!",
            parse_mode="Markdown")
    except Exception as e:
        print(f"xRocket webhook error: {e}")
    return {"ok": True}

@app.post("/payment-webhook/cryptopay")
async def cryptopay_webhook(request: Request):
    try:
        body = await request.json()
        raw  = await request.body()
        sig  = request.headers.get("crypto-pay-api-signature", "")

        if sig and CRYPTOPAY_API_KEY:
            token_hash = hashlib.sha256(CRYPTOPAY_API_KEY.encode()).hexdigest()
            expected   = hmac.new(token_hash.encode(), raw, hashlib.sha256).hexdigest()
            if sig != expected:
                return JSONResponse({"ok": False})

        if body.get("update_type") != "invoice_paid":
            return {"ok": True}

        invoice = body.get("payload", {})
        if invoice.get("status") != "paid" or invoice.get("asset") != "TON":
            return {"ok": True}

        payload  = json.loads(invoice.get("payload", "{}")) if isinstance(invoice.get("payload"), str) else {}
        user_id  = payload.get("user_id")
        cp_id    = str(invoice.get("invoice_id", ""))
        target   = payload.get("target", "wallet")
        amount   = float(invoice.get("amount", 0))

        if not user_id:
            return {"ok": True}

        if db_exec("SELECT id FROM payments WHERE invoice_id=%s AND status='paid'", (cp_id,), fetchone=True):
            return {"ok": True}

        db_exec("UPDATE payments SET status='paid', paid_at=NOW() WHERE invoice_id=%s", (cp_id,))
        if target == "advertiser":
            db_exec("UPDATE users SET ad_balance=ad_balance+%s WHERE user_id=%s", (amount, user_id))
            log_tx(user_id, "topup", "Ad balance top-up via CryptoPay", amount, "TON")
        else:
            db_exec("UPDATE users SET ton_balance=COALESCE(ton_balance,0)+%s WHERE user_id=%s", (amount, user_id))
            log_tx(user_id, "topup", "Top-up via CryptoPay", amount, "TON")

        await tg_post("sendMessage", chat_id=user_id,
            text=f"✅ *Payment received!*\n\n💰 {amount:.4f} TON added via CryptoPay.\n\nOpen TRewards to continue!",
            parse_mode="Markdown")
    except Exception as e:
        print(f"CryptoPay webhook error: {e}")
    return {"ok": True}


# ─── Telegram Bot (background thread) ─────────────────────

def run_bot():
    import requests as req_lib

    if not BOT_TOKEN:
        print("⚠️  BOT_TOKEN not set — bot disabled")
        return

    offset = 0
    promo_wizard = {}

    def tg(method, **kwargs):
        try:
            r = req_lib.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
                json=kwargs, timeout=30
            )
            return r.json()
        except Exception as e:
            print(f"Bot API error [{method}]: {e}")
            return {}

    def handle(upd):
        nonlocal promo_wizard

        # ── Callback query ──
        if "callback_query" in upd:
            cq      = upd["callback_query"]
            chat_id = cq["message"]["chat"]["id"]
            msg_id  = cq["message"]["message_id"]
            user_id = cq["from"]["id"]
            data    = cq.get("data", "")
            tg("answerCallbackQuery", callback_query_id=cq["id"])

            if data.startswith("wd_"):
                if user_id not in ADMIN_IDS:
                    return
                parts  = data.split("_")
                action = parts[1]
                wid    = int(parts[2])
                try:
                    res = req_lib.post(
                        f"http://localhost:{os.getenv('PORT', 8000)}/api/withdrawal-action",
                        json={"admin_id": user_id, "withdrawal_id": wid, "action": action},
                        timeout=10
                    ).json()
                except Exception as e:
                    tg("sendMessage", chat_id=chat_id, text=f"❌ Error: {e}")
                    return

                orig = cq["message"].get("text", "")
                if action == "complete":
                    tg("editMessageReplyMarkup", chat_id=chat_id, message_id=msg_id, reply_markup={"inline_keyboard": []})
                    tg("editMessageText", chat_id=chat_id, message_id=msg_id, parse_mode="Markdown",
                       text=orig + "\n\n✅ *COMPLETED — Payment sent*")
                elif action == "approve":
                    tg("editMessageText", chat_id=chat_id, message_id=msg_id, parse_mode="Markdown",
                       text=orig + "\n\n✅ *APPROVED*",
                       reply_markup={"inline_keyboard": [[
                           {"text": "❌ Decline",  "callback_data": f"wd_decline_{wid}"},
                           {"text": "💸 Complete", "callback_data": f"wd_complete_{wid}"}
                       ]]})
                elif action == "decline":
                    tg("editMessageReplyMarkup", chat_id=chat_id, message_id=msg_id, reply_markup={"inline_keyboard": []})
                    tg("editMessageText", chat_id=chat_id, message_id=msg_id, parse_mode="Markdown",
                       text=orig + "\n\n❌ *DECLINED — Coins refunded*")
                return

            if user_id not in ADMIN_IDS:
                return

            if data == "admin_promo_create":
                promo_wizard[user_id] = {"step": 1}
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text="🎁 *Create Promo — Step 1/4*\n\nEnter code name (e.g. WELCOME100):")
                return

            if data == "admin_promo_list":
                codes = db_exec(
                    "SELECT p.*, (SELECT COUNT(*) FROM promo_activations WHERE promo_id=p.id) as used FROM promo_codes p ORDER BY created_at DESC",
                    fetch=True
                ) or []
                if not codes:
                    tg("sendMessage", chat_id=chat_id, text="No promo codes yet.")
                    return
                lines = "\n\n".join(
                    f"• `{c['code']}` — {c['reward_amount']} {c['reward_type'].upper()}\n  Used: {c['used']}/{c['max_activations']} | {'✅' if c['is_active'] else '❌'}"
                    for c in codes
                )
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown", text=f"📋 *Promo Codes:*\n\n{lines}")
                return

            if data == "admin_promo_delete":
                promo_wizard[user_id] = {"step": "delete"}
                tg("sendMessage", chat_id=chat_id, text="🗑 Enter code to delete:")
                return

            if data == "admin_promo_history":
                acts = db_exec(
                    "SELECT pa.*, pc.code FROM promo_activations pa JOIN promo_codes pc ON pa.promo_id=pc.id ORDER BY pa.created_at DESC LIMIT 20",
                    fetch=True
                ) or []
                lines = "\n".join(f"• {a['code']} → {a['user_id']} on {str(a['created_at'])[:10]}" for a in acts) or "None"
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown", text=f"📈 *Activations:*\n\n{lines}")
                return

            if data == "admin_payment_history":
                pays = db_exec("SELECT * FROM payments ORDER BY created_at DESC LIMIT 10", fetch=True) or []
                lines = "\n".join(f"• {p['amount']} TON via {p['method']} — {p['status']}" for p in pays) or "None"
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown", text=f"💸 *Payments:*\n\n{lines}")
                return

            if data == "admin_total_users":
                stats_data = {
                    "total_users":       (db_exec("SELECT COUNT(*) as c FROM users", fetchone=True) or {}).get("c", 0),
                    "active_today":      (db_exec("SELECT COUNT(*) as c FROM users WHERE updated_at::date=CURRENT_DATE", fetchone=True) or {}).get("c", 0),
                    "total_withdrawals": float((db_exec("SELECT COALESCE(SUM(ton_net),0) as t FROM withdrawals WHERE status='completed'", fetchone=True) or {}).get("t", 0)),
                    "completions":       (db_exec("SELECT COUNT(*) as c FROM task_completions", fetchone=True) or {}).get("c", 0),
                }
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text=(
                       f"👥 *Stats*\n\n"
                       f"Total Users: *{stats_data['total_users']}*\n"
                       f"Active Today: *{stats_data['active_today']}*\n"
                       f"Withdrawn: *{stats_data['total_withdrawals']:.4f} TON*\n"
                       f"Task Completions: *{stats_data['completions']}*"
                   ))
                return

            if data.startswith("promo_type_") and promo_wizard.get(user_id, {}).get("step") == 2:
                promo_wizard[user_id]["reward_type"] = data.replace("promo_type_", "")
                promo_wizard[user_id]["step"] = 3
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text="🎁 *Step 3/4*\n\nEnter reward amount (e.g. 5000 for TR or 0.5 for TON):")
                return

        # ── Message ──
        if "message" not in upd:
            return

        msg     = upd["message"]
        chat_id = msg["chat"]["id"]
        user_id = msg["from"]["id"]
        text    = msg.get("text", "")
        first   = msg["from"].get("first_name", "Friend")

        if text.startswith("/start"):
            parts     = text.split(maxsplit=1)
            ref_param = parts[1].strip() if len(parts) > 1 else ""
            ref_id    = int(ref_param) if ref_param.isdigit() and int(ref_param) != user_id else None

            try:
                req_lib.post(
                    f"http://localhost:{os.getenv('PORT', 8000)}/api/user",
                    json={"user_id": user_id, "first_name": msg["from"].get("first_name",""),
                          "last_name": msg["from"].get("last_name",""), "username": msg["from"].get("username","")},
                    timeout=10
                )
                if ref_id:
                    req_lib.post(
                        f"http://localhost:{os.getenv('PORT', 8000)}/api/set-referrer",
                        json={"user_id": user_id, "referrer_id": ref_id},
                        timeout=10
                    )
            except Exception as e:
                print(f"Bot /start register error: {e}")

            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text=(
                   f"🏆 *Welcome to TRewards, {first}!*\n\n"
                   f"Earn *TR Coins* by completing tasks, spinning the wheel & inviting friends.\n\n"
                   f"💎 Withdraw as *TON cryptocurrency*!\n\n"
                   f"━━━━━━━━━━━━━━━━━━━━\n"
                   f"🔥 Daily streak bonuses\n"
                   f"🎰 Spin wheel prizes\n"
                   f"👥 30% referral commission\n"
                   f"📢 Advertiser tasks\n"
                   f"━━━━━━━━━━━━━━━━━━━━"
               ),
               reply_markup={"inline_keyboard": [[
                   {"text": "🚀 Open TRewards", "web_app": {"url": WEBAPP_URL}}
               ],[
                   {"text": "📢 TRewards Channel", "url": "https://t.me/trewards_ton"}
               ]]})
            return

        if text.strip() == "/amiadminyes":
            if user_id not in ADMIN_IDS:
                tg("sendMessage", chat_id=chat_id, text="⛔ Access denied.")
                return
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text="⚙️ *TRewards Admin Panel*",
               reply_markup={"inline_keyboard": [
                   [{"text": "🎁 Create Promo",     "callback_data": "admin_promo_create"}],
                   [{"text": "📋 List Promos",       "callback_data": "admin_promo_list"}],
                   [{"text": "🗑 Delete Promo",      "callback_data": "admin_promo_delete"}],
                   [{"text": "📈 Activation History","callback_data": "admin_promo_history"}],
                   [{"text": "💸 Payment History",   "callback_data": "admin_payment_history"}],
                   [{"text": "👥 Total Users",       "callback_data": "admin_total_users"}],
               ]})
            return

        # Promo wizard
        if user_id not in ADMIN_IDS or user_id not in promo_wizard:
            return

        wizard = promo_wizard[user_id]

        if wizard["step"] == "delete":
            del promo_wizard[user_id]
            code = text.strip().upper()
            db_exec("UPDATE promo_codes SET is_active=false WHERE UPPER(code)=%s", (code,))
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown", text=f"✅ Code `{code}` deactivated.")
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
                wizard["step"] = 4
                tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
                   text="🎁 *Step 4/4*\n\nEnter max activations (e.g. 100):")
            except ValueError:
                tg("sendMessage", chat_id=chat_id, text="❌ Enter a valid number:")
            return

        if wizard["step"] == 4:
            try:
                wizard["max_activations"] = int(text.strip())
            except ValueError:
                tg("sendMessage", chat_id=chat_id, text="❌ Enter a positive integer:")
                return
            del promo_wizard[user_id]
            if db_exec("SELECT id FROM promo_codes WHERE UPPER(code)=UPPER(%s)", (wizard["code"],), fetchone=True):
                tg("sendMessage", chat_id=chat_id, text="❌ Code already exists.")
                return
            db_exec(
                "INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, is_active, created_by, created_at) VALUES (%s,%s,%s,%s,true,%s,NOW())",
                (wizard["code"], wizard["reward_type"], wizard["reward_amount"], wizard["max_activations"], user_id)
            )
            tg("sendMessage", chat_id=chat_id, parse_mode="Markdown",
               text=(
                   f"✅ *Promo Created!*\n\n"
                   f"Code: `{wizard['code']}`\n"
                   f"Reward: {wizard['reward_amount']} {wizard['reward_type'].upper()}\n"
                   f"Max Uses: {wizard['max_activations']}"
               ))

    print("🤖 TRewards Bot polling started...")
    while True:
        try:
            resp = req_lib.get(
                f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates",
                params={"offset": offset, "timeout": 30, "allowed_updates": ["message","callback_query"]},
                timeout=35
            ).json()
            for upd in resp.get("result", []):
                offset = upd["update_id"] + 1
                try:
                    handle(upd)
                except Exception as e:
                    print(f"Bot handle error: {e}")
        except Exception as e:
            print(f"Bot polling error: {e}")
            time.sleep(5)

@app.on_event("startup")
def startup_event():
    threading.Thread(target=run_bot, daemon=True).start()
    print("✅ TRewards API + Bot started")