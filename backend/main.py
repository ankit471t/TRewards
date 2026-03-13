"""
TRewards Backend — FastAPI + PostgreSQL (Supabase)
"""
import os, hashlib, hmac, time, json, random, httpx
from datetime import datetime, date, timedelta
from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from supabase import create_client, Client

# ─── CONFIG ────────────────────────────────────────────────────────────────
SUPABASE_URL  = os.environ["SUPABASE_URL"]
SUPABASE_KEY  = os.environ["SUPABASE_KEY"]
BOT_TOKEN     = os.environ["BOT_TOKEN"]
XROCKET_TOKEN = os.environ.get("XROCKET_TOKEN", "")
CRYPTOPAY_TOKEN = os.environ.get("CRYPTOPAY_TOKEN", "")
ADMIN_IDS     = [int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x]
WEBHOOK_SECRET_XROCKET  = os.environ.get("WEBHOOK_SECRET_XROCKET", "")
WEBHOOK_SECRET_CRYPTOPAY = os.environ.get("WEBHOOK_SECRET_CRYPTOPAY", "")

TON_PER_COIN  = 0.0000004
REFERRAL_PCT  = 0.30
SPIN_REWARDS  = [10, 50, 80, 100, 300, 500]
SPIN_WEIGHTS  = [40, 25, 15, 12, 5, 3]

WITHDRAW_TIERS = [
    {"coins": 250_000, "ton": 0.10, "net": 0.05},
    {"coins": 500_000, "ton": 0.20, "net": 0.15},
    {"coins": 750_000, "ton": 0.30, "net": 0.25},
    {"coins":1_000_000,"ton": 0.40, "net": 0.35},
]

# ─── APP ───────────────────────────────────────────────────────────────────
app = FastAPI(title="TRewards API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Serve frontend from /frontend directory if present
if os.path.exists("frontend"):
    app.mount("/", StaticFiles(directory="frontend", html=True), name="static")

# ─── PYDANTIC MODELS ───────────────────────────────────────────────────────
class UserIn(BaseModel):
    telegram_id: int
    username: str = ""
    first_name: str = ""
    last_name: str = ""
    init_data: str = ""

class ClaimStreakIn(BaseModel):
    telegram_id: int

class SpinIn(BaseModel):
    telegram_id: int

class RedeemPromoIn(BaseModel):
    telegram_id: int
    code: str

class ClaimDailyTaskIn(BaseModel):
    telegram_id: int
    task_id: str

class ClaimTaskIn(BaseModel):
    telegram_id: int
    task_id: int

class VerifyJoinIn(BaseModel):
    telegram_id: int
    task_id: int

class ClaimReferralIn(BaseModel):
    telegram_id: int

class WithdrawIn(BaseModel):
    telegram_id: int
    tier_index: int

class TopupIn(BaseModel):
    telegram_id: int
    amount: float
    method: str  # xrocket | cryptopay

class CreateTaskIn(BaseModel):
    telegram_id: int
    name: str
    task_type: str
    target_url: str
    completion_limit: int

# ─── HELPERS ───────────────────────────────────────────────────────────────
def get_user(telegram_id: int):
    res = db.table("users").select("*").eq("telegram_id", telegram_id).single().execute()
    if not res.data:
        raise HTTPException(404, "User not found")
    return res.data

def add_coins(telegram_id: int, amount: int, tx_type: str, description: str, currency: str = "TR"):
    user = get_user(telegram_id)
    new_coins = user["coins"] + amount
    db.table("users").update({"coins": new_coins}).eq("telegram_id", telegram_id).execute()
    db.table("transactions").insert({
        "telegram_id": telegram_id,
        "type": tx_type,
        "amount": amount,
        "description": description,
        "currency": currency,
    }).execute()
    # Referral passthrough
    if amount > 0 and user.get("referrer_id") and tx_type not in ("referral",):
        referral_bonus = int(amount * REFERRAL_PCT)
        if referral_bonus > 0:
            ref_user = db.table("users").select("pending_referral_coins, telegram_id").eq("telegram_id", user["referrer_id"]).single().execute()
            if ref_user.data:
                new_pending = ref_user.data["pending_referral_coins"] + referral_bonus
                db.table("users").update({"pending_referral_coins": new_pending}).eq("telegram_id", user["referrer_id"]).execute()
    return new_coins

def validate_init_data(init_data: str) -> bool:
    if not init_data or not BOT_TOKEN:
        return True  # skip in dev
    try:
        params = dict(item.split("=", 1) for item in init_data.split("&") if "=" in item)
        check_hash = params.pop("hash", "")
        data_check = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
        secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed = hmac.new(secret, data_check.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(computed, check_hash)
    except Exception:
        return False

# ─── ROUTES ────────────────────────────────────────────────────────────────

@app.post("/api/user")
async def register_user(body: UserIn, x_init_data: str = Header(default="")):
    existing = db.table("users").select("*").eq("telegram_id", body.telegram_id).execute()
    if existing.data:
        user = existing.data[0]
        # Update name fields
        db.table("users").update({
            "username": body.username,
            "first_name": body.first_name,
            "last_name": body.last_name,
        }).eq("telegram_id", body.telegram_id).execute()
        return {**user, "daily_tasks_claimed": user.get("daily_tasks_claimed") or []}

    # Parse referrer from init_data start param
    referrer_id = None
    try:
        params = dict(item.split("=", 1) for item in body.init_data.split("&") if "=" in item)
        start = json.loads(params.get("start_param") or params.get("user", "{}")).get("start_param") or ""
        if start and start.isdigit():
            ref = int(start)
            if ref != body.telegram_id:
                ref_exists = db.table("users").select("telegram_id").eq("telegram_id", ref).execute()
                if ref_exists.data:
                    referrer_id = ref
    except Exception:
        pass

    user_data = {
        "telegram_id": body.telegram_id,
        "username": body.username,
        "first_name": body.first_name,
        "last_name": body.last_name,
        "coins": 0,
        "spins": 1,
        "streak_days": 0,
        "streak_claimed_today": False,
        "last_streak_date": None,
        "referrer_id": referrer_id,
        "pending_referral_coins": 0,
        "ad_balance": 0.0,
        "daily_tasks_claimed": [],
    }
    db.table("users").insert(user_data).execute()
    return user_data


@app.post("/api/claim-streak")
async def claim_streak(body: ClaimStreakIn):
    user = get_user(body.telegram_id)
    today = date.today().isoformat()

    if user.get("streak_claimed_today") and user.get("last_streak_date") == today:
        raise HTTPException(400, "Already claimed today")

    last = user.get("last_streak_date")
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    if last == yesterday:
        new_streak = min((user.get("streak_days") or 0) + 1, 7)
    elif last == today:
        raise HTTPException(400, "Already claimed today")
    else:
        new_streak = 1  # reset

    if new_streak >= 7:
        new_streak = 0  # reset after 7

    db.table("users").update({
        "streak_days": new_streak,
        "streak_claimed_today": True,
        "last_streak_date": today,
        "spins": (user.get("spins") or 0) + 1,
    }).eq("telegram_id", body.telegram_id).execute()

    add_coins(body.telegram_id, 10, "streak", "Daily streak bonus")
    return {"coins_earned": 10, "streak_days": new_streak, "spins": user.get("spins", 0) + 1,
            "streak_claimed_today": True, "coins": user["coins"] + 10}


@app.post("/api/spin")
async def spin_wheel(body: SpinIn):
    user = get_user(body.telegram_id)
    if (user.get("spins") or 0) < 1:
        raise HTTPException(400, "No spins available")

    result = random.choices(SPIN_REWARDS, weights=SPIN_WEIGHTS, k=1)[0]

    db.table("users").update({
        "spins": user["spins"] - 1
    }).eq("telegram_id", body.telegram_id).execute()

    db.table("spin_history").insert({
        "telegram_id": body.telegram_id,
        "coins_won": result,
    }).execute()

    add_coins(body.telegram_id, result, "spin", f"Spin wheel reward")
    return {"coins_won": result, "coins": user["coins"] + result, "spins": user["spins"] - 1}


@app.post("/api/redeem-promo")
async def redeem_promo(body: RedeemPromoIn):
    promo = db.table("promo_codes").select("*").eq("code", body.code.upper()).single().execute()
    if not promo.data:
        raise HTTPException(400, "Invalid promo code")

    p = promo.data
    if p["activations"] >= p["max_activations"]:
        raise HTTPException(400, "Promo code exhausted")

    # Check already used
    used = db.table("promo_activations").select("id").eq("promo_id", p["id"]).eq("telegram_id", body.telegram_id).execute()
    if used.data:
        raise HTTPException(400, "Already used this code")

    db.table("promo_activations").insert({"promo_id": p["id"], "telegram_id": body.telegram_id}).execute()
    db.table("promo_codes").update({"activations": p["activations"] + 1}).eq("id", p["id"]).execute()

    if p["reward_type"] == "coins":
        add_coins(body.telegram_id, p["reward_amount"], "promo", f"Promo code: {p['code']}")
    elif p["reward_type"] == "ton":
        # Record TON reward — manual processing
        db.table("transactions").insert({
            "telegram_id": body.telegram_id,
            "type": "promo",
            "amount": p["reward_amount"],
            "description": f"Promo TON reward: {p['code']}",
            "currency": "TON"
        }).execute()

    return {"reward_type": p["reward_type"], "reward_amount": p["reward_amount"]}


@app.post("/api/claim-daily-task")
async def claim_daily_task(body: ClaimDailyTaskIn):
    user = get_user(body.telegram_id)
    today = date.today().isoformat()
    claimed = user.get("daily_tasks_claimed") or []

    key = f"{body.task_id}:{today}"
    if key in claimed:
        raise HTTPException(400, "Already claimed today")

    claimed.append(key)
    # Keep last 30 days of claimed tasks
    claimed = claimed[-100:]

    spins_add = 1 if body.task_id == "checkin" else 0
    coins = 10

    db.table("users").update({
        "daily_tasks_claimed": claimed,
        "spins": (user.get("spins") or 0) + spins_add,
    }).eq("telegram_id", body.telegram_id).execute()

    add_coins(body.telegram_id, coins, "daily", f"Daily task: {body.task_id}")
    return {
        "coins_earned": coins,
        "daily_tasks_claimed": [t.split(":")[0] for t in claimed if t.endswith(today)],
        "coins": user["coins"] + coins,
        "spins": user.get("spins", 0) + spins_add,
    }


@app.get("/api/tasks")
async def get_tasks(telegram_id: int):
    tasks_res = db.table("tasks").select("*").eq("status", "active").execute()
    tasks = tasks_res.data or []

    completions_res = db.table("task_completions").select("task_id").eq("telegram_id", telegram_id).execute()
    completed_ids = {c["task_id"] for c in (completions_res.data or [])}

    for t in tasks:
        t["user_completed"] = t["id"] in completed_ids

    return {"tasks": tasks}


@app.post("/api/claim-task")
async def claim_task(body: ClaimTaskIn):
    user = get_user(body.telegram_id)
    task_res = db.table("tasks").select("*").eq("id", body.task_id).single().execute()
    if not task_res.data:
        raise HTTPException(404, "Task not found")
    task = task_res.data

    existing = db.table("task_completions").select("id").eq("telegram_id", body.telegram_id).eq("task_id", body.task_id).execute()
    if existing.data:
        raise HTTPException(400, "Task already completed")

    if task["completions"] >= task["completion_limit"]:
        raise HTTPException(400, "Task limit reached")

    db.table("task_completions").insert({"telegram_id": body.telegram_id, "task_id": body.task_id}).execute()
    db.table("tasks").update({"completions": task["completions"] + 1}).eq("id", body.task_id).execute()
    db.table("users").update({"spins": (user.get("spins") or 0) + 1}).eq("telegram_id", body.telegram_id).execute()

    reward_map = {"channel": 1000, "group": 1000, "game": 1000, "website": 500}
    coins = reward_map.get(task["task_type"], 500)
    add_coins(body.telegram_id, coins, "task", f"Task: {task['name']}")

    return {"coins_earned": coins, "spins": user.get("spins", 0) + 1}


@app.post("/api/verify-join")
async def verify_join(body: VerifyJoinIn):
    task_res = db.table("tasks").select("*").eq("id", body.task_id).single().execute()
    if not task_res.data:
        raise HTTPException(404, "Task not found")
    task = task_res.data

    # Check via Telegram API
    chat_id = task["target_url"].split("/")[-1]
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember",
            params={"chat_id": f"@{chat_id}", "user_id": body.telegram_id},
            timeout=5
        )
    result = resp.json()
    status = result.get("result", {}).get("status", "left")

    if status in ("left", "kicked", "restricted"):
        raise HTTPException(400, "Not a member yet. Please join first!")

    return await claim_task(ClaimTaskIn(telegram_id=body.telegram_id, task_id=body.task_id))


@app.get("/api/friends")
async def get_friends(telegram_id: int):
    user = get_user(telegram_id)
    friends_res = db.table("users").select("telegram_id, first_name, username, coins").eq("referrer_id", telegram_id).execute()
    friends = friends_res.data or []

    total_earned = 0
    for f in friends:
        f["your_share"] = int(f["coins"] * REFERRAL_PCT)
        total_earned += f["your_share"]

    return {
        "total_friends": len(friends),
        "total_earned": total_earned,
        "pending": user.get("pending_referral_coins") or 0,
        "friends": friends,
    }


@app.post("/api/claim-referral")
async def claim_referral(body: ClaimReferralIn):
    user = get_user(body.telegram_id)
    pending = user.get("pending_referral_coins") or 0
    if pending <= 0:
        raise HTTPException(400, "No pending referral earnings")

    db.table("users").update({"pending_referral_coins": 0}).eq("telegram_id", body.telegram_id).execute()
    add_coins(body.telegram_id, pending, "referral", "Referral earnings")
    return {"coins_earned": pending}


@app.get("/api/transactions")
async def get_transactions(telegram_id: int):
    res = db.table("transactions").select("*").eq("telegram_id", telegram_id).order("created_at", desc=True).limit(50).execute()
    return {"transactions": res.data or []}


@app.post("/api/withdraw")
async def withdraw(body: WithdrawIn):
    if body.tier_index < 0 or body.tier_index >= len(WITHDRAW_TIERS):
        raise HTTPException(400, "Invalid tier")

    user = get_user(body.telegram_id)
    tier = WITHDRAW_TIERS[body.tier_index]

    if user["coins"] < tier["coins"]:
        raise HTTPException(400, "Insufficient coins")

    db.table("withdrawals").insert({
        "telegram_id": body.telegram_id,
        "coins_spent": tier["coins"],
        "ton_gross": tier["ton"],
        "ton_net": tier["net"],
        "status": "pending",
    }).execute()

    add_coins(body.telegram_id, -tier["coins"], "withdraw", f"Withdrawal: {tier['net']} TON")
    return {"status": "pending", "ton_net": tier["net"]}


@app.post("/api/create-topup")
async def create_topup(body: TopupIn):
    if body.amount <= 0:
        raise HTTPException(400, "Invalid amount")

    description = f"TRewards top-up {body.amount} TON for {body.telegram_id}"

    if body.method == "xrocket":
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://pay.xrocket.tg/tg-invoices",
                headers={"Rocket-Pay-Key": XROCKET_TOKEN, "Content-Type": "application/json"},
                json={
                    "amount": body.amount,
                    "currency": "TONCOIN",
                    "description": description,
                    "payload": f"{body.telegram_id}",
                    "expiredIn": 3600,
                },
                timeout=10
            )
        data = resp.json()
        payment_url = data.get("data", {}).get("link") or data.get("link")

    elif body.method == "cryptopay":
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://pay.crypt.bot/api/createInvoice",
                headers={"Crypto-Pay-API-Token": CRYPTOPAY_TOKEN},
                json={
                    "asset": "TON",
                    "amount": str(body.amount),
                    "description": description,
                    "payload": str(body.telegram_id),
                    "expires_in": 3600,
                },
                timeout=10
            )
        data = resp.json()
        payment_url = data.get("result", {}).get("mini_app_invoice_url") or data.get("result", {}).get("bot_invoice_url")
    else:
        raise HTTPException(400, "Invalid payment method")

    db.table("payments").insert({
        "telegram_id": body.telegram_id,
        "amount": body.amount,
        "method": body.method,
        "status": "pending",
        "description": description,
    }).execute()

    return {"payment_url": payment_url}


@app.get("/api/advertiser")
async def get_advertiser(telegram_id: int):
    user = get_user(telegram_id)
    tasks_res = db.table("tasks").select("*").eq("created_by", telegram_id).execute()
    return {"ad_balance": user.get("ad_balance") or 0, "tasks": tasks_res.data or []}


@app.post("/api/create-task")
async def create_task(body: CreateTaskIn):
    user = get_user(body.telegram_id)
    cost = body.completion_limit * 0.001

    if (user.get("ad_balance") or 0) < cost:
        raise HTTPException(400, f"Insufficient ad balance. Need {cost:.3f} TON")

    db.table("users").update({"ad_balance": user["ad_balance"] - cost}).eq("telegram_id", body.telegram_id).execute()
    db.table("tasks").insert({
        "name": body.name,
        "task_type": body.task_type,
        "target_url": body.target_url,
        "completion_limit": body.completion_limit,
        "completions": 0,
        "status": "active",
        "created_by": body.telegram_id,
    }).execute()

    return {"status": "created", "cost": cost}


# ─── PAYMENT WEBHOOKS ────────────────────────────────────────────────────

@app.post("/payment-webhook/xrocket")
async def webhook_xrocket(request: Request):
    body = await request.body()
    sig = request.headers.get("rocket-pay-signature", "")
    expected = hashlib.sha256(WEBHOOK_SECRET_XROCKET.encode() + body).hexdigest()
    if WEBHOOK_SECRET_XROCKET and not hmac.compare_digest(sig, expected):
        raise HTTPException(403, "Invalid signature")

    data = json.loads(body)
    if data.get("type") != "invoice" or data.get("status") != "paid":
        return {"ok": True}

    invoice = data.get("data", {})
    payload = invoice.get("payload", "")
    amount = float(invoice.get("amount", 0))
    invoice_id = invoice.get("id", "")
    asset = invoice.get("currency", "")

    if asset.upper() not in ("TONCOIN", "TON"):
        return {"ok": True}

    # Dedup
    dup = db.table("payments").select("id").eq("invoice_id", invoice_id).eq("status", "paid").execute()
    if dup.data:
        return {"ok": True}

    telegram_id = int(payload)
    db.table("payments").update({"status": "paid", "invoice_id": invoice_id}).eq("telegram_id", telegram_id).eq("status", "pending").execute()
    db.table("users").update({}).eq("telegram_id", telegram_id)  # dummy to check exists

    # Add to ad balance
    user = get_user(telegram_id)
    db.table("users").update({"ad_balance": (user.get("ad_balance") or 0) + amount}).eq("telegram_id", telegram_id).execute()
    db.table("transactions").insert({"telegram_id": telegram_id, "type": "topup", "amount": amount, "description": f"Top-up via xRocket", "currency": "TON"}).execute()

    return {"ok": True}


@app.post("/payment-webhook/cryptopay")
async def webhook_cryptopay(request: Request):
    body = await request.body()
    sig = request.headers.get("crypto-pay-api-signature", "")
    expected = hmac.new(hashlib.sha256(CRYPTOPAY_TOKEN.encode()).digest(), body, hashlib.sha256).hexdigest()
    if CRYPTOPAY_TOKEN and not hmac.compare_digest(sig, expected):
        raise HTTPException(403, "Invalid signature")

    data = json.loads(body)
    invoice = data.get("payload", {})
    if data.get("update_type") != "invoice_paid":
        return {"ok": True}
    if invoice.get("asset") != "TON":
        return {"ok": True}

    invoice_id = str(invoice.get("invoice_id", ""))
    amount = float(invoice.get("amount", 0))
    payload = invoice.get("payload", "")

    dup = db.table("payments").select("id").eq("invoice_id", invoice_id).eq("status", "paid").execute()
    if dup.data:
        return {"ok": True}

    telegram_id = int(payload)
    db.table("payments").update({"status": "paid", "invoice_id": invoice_id}).eq("telegram_id", telegram_id).eq("status", "pending").execute()

    user = get_user(telegram_id)
    db.table("users").update({"ad_balance": (user.get("ad_balance") or 0) + amount}).eq("telegram_id", telegram_id).execute()
    db.table("transactions").insert({"telegram_id": telegram_id, "type": "topup", "amount": amount, "description": "Top-up via Crypto Pay", "currency": "TON"}).execute()

    return {"ok": True}


# ─── HEALTH ────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}