"""
TRewards Backend — FastAPI + PostgreSQL (Supabase)
"""
import os, hashlib, hmac, json, random, httpx
from datetime import datetime, date, timedelta
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

# ─── CONFIG ────────────────────────────────────────────────────────────────
SUPABASE_URL     = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY     = os.environ.get("SUPABASE_KEY", "")
BOT_TOKEN        = os.environ.get("BOT_TOKEN", "")
XROCKET_TOKEN    = os.environ.get("XROCKET_TOKEN", "")
CRYPTOPAY_TOKEN  = os.environ.get("CRYPTOPAY_TOKEN", "")
ADMIN_KEY        = os.environ.get("ADMIN_KEY", "changeme")
ADMIN_IDS        = [int(x) for x in os.environ.get("ADMIN_IDS", "").split(",") if x.strip()]
WEBHOOK_SECRET_XROCKET   = os.environ.get("WEBHOOK_SECRET_XROCKET", "")
WEBHOOK_SECRET_CRYPTOPAY = os.environ.get("WEBHOOK_SECRET_CRYPTOPAY", "")

REFERRAL_PCT  = 0.30
SPIN_REWARDS  = [10, 50, 80, 100, 300, 500]
SPIN_WEIGHTS  = [40, 25, 15, 12, 5, 3]

WITHDRAW_TIERS = [
    {"coins": 250_000,   "ton": 0.10, "net": 0.05},
    {"coins": 500_000,   "ton": 0.20, "net": 0.15},
    {"coins": 750_000,   "ton": 0.30, "net": 0.25},
    {"coins": 1_000_000, "ton": 0.40, "net": 0.35},
]

# ─── APP & DB ──────────────────────────────────────────────────────────────
app = FastAPI(title="TRewards API", docs_url="/docs", redoc_url="/redoc")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# ─── PYDANTIC MODELS ───────────────────────────────────────────────────────
class UserIn(BaseModel):
    telegram_id: int
    username:    str = ""
    first_name:  str = ""
    last_name:   str = ""
    init_data:   str = ""

class TelegramIdIn(BaseModel):
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

class WithdrawIn(BaseModel):
    telegram_id: int
    tier_index: int

class TopupIn(BaseModel):
    telegram_id: int
    amount: float
    method: str

class CreateTaskIn(BaseModel):
    telegram_id: int
    name: str
    task_type: str
    target_url: str
    completion_limit: int

class PromoCreateIn(BaseModel):
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int

class PromoDeleteIn(BaseModel):
    code: str

# ─── HELPERS ───────────────────────────────────────────────────────────────
def get_user(telegram_id: int):
    try:
        res = db.table("users").select("*").eq("telegram_id", telegram_id).single().execute()
        if res.data:
            return res.data
    except Exception as e:
        raise HTTPException(404, f"User not found: {e}")
    raise HTTPException(404, "User not found")

def add_coins(telegram_id: int, amount: int, tx_type: str, description: str, currency: str = "TR"):
    user      = get_user(telegram_id)
    new_coins = int(user["coins"]) + int(amount)
    db.table("users").update({"coins": new_coins}).eq("telegram_id", telegram_id).execute()
    db.table("transactions").insert({
        "telegram_id": telegram_id,
        "type":        tx_type,
        "amount":      amount,
        "description": description,
        "currency":    currency,
    }).execute()
    if amount > 0 and user.get("referrer_id") and tx_type != "referral":
        bonus = int(amount * REFERRAL_PCT)
        if bonus > 0:
            try:
                ref = db.table("users").select("pending_referral_coins").eq("telegram_id", user["referrer_id"]).single().execute()
                if ref.data:
                    new_p = int(ref.data.get("pending_referral_coins") or 0) + bonus
                    db.table("users").update({"pending_referral_coins": new_p}).eq("telegram_id", user["referrer_id"]).execute()
            except Exception:
                pass
    return new_coins

def check_admin(key: str):
    if key != ADMIN_KEY:
        raise HTTPException(403, "Forbidden")

# ─── HEALTH ────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}

# ─── USER ──────────────────────────────────────────────────────────────────
@app.post("/api/user")
async def register_user(body: UserIn):
    try:
        existing = db.table("users").select("*").eq("telegram_id", body.telegram_id).execute()
    except Exception as e:
        raise HTTPException(500, f"Database error: {e}")

    if existing.data:
        user = existing.data[0]
        db.table("users").update({
            "username":   body.username,
            "first_name": body.first_name,
            "last_name":  body.last_name,
        }).eq("telegram_id", body.telegram_id).execute()
        user["daily_tasks_claimed"] = user.get("daily_tasks_claimed") or []
        return user

    referrer_id = None
    try:
        if body.init_data:
            params = dict(p.split("=", 1) for p in body.init_data.split("&") if "=" in p)
            start  = params.get("start_param", "")
            if start and start.isdigit():
                ref = int(start)
                if ref != body.telegram_id:
                    chk = db.table("users").select("telegram_id").eq("telegram_id", ref).execute()
                    if chk.data:
                        referrer_id = ref
    except Exception:
        pass

    user_data = {
        "telegram_id":           body.telegram_id,
        "username":               body.username,
        "first_name":             body.first_name,
        "last_name":              body.last_name,
        "coins":                  0,
        "spins":                  1,
        "streak_days":            0,
        "streak_claimed_today":   False,
        "last_streak_date":       None,
        "referrer_id":            referrer_id,
        "pending_referral_coins": 0,
        "ad_balance":             0.0,
        "daily_tasks_claimed":    [],
    }
    try:
        db.table("users").insert(user_data).execute()
    except Exception as e:
        raise HTTPException(500, f"Insert error: {e}")

    return user_data

# ─── STREAK ────────────────────────────────────────────────────────────────
@app.post("/api/claim-streak")
async def claim_streak(body: TelegramIdIn):
    user  = get_user(body.telegram_id)
    today = date.today().isoformat()
    last  = user.get("last_streak_date")

    if last == today:
        raise HTTPException(400, "Already claimed today")

    yesterday  = (date.today() - timedelta(days=1)).isoformat()
    new_streak = (int(user.get("streak_days") or 0) + 1) if last == yesterday else 1
    if new_streak >= 7:
        new_streak = 0

    db.table("users").update({
        "streak_days":          new_streak,
        "streak_claimed_today": True,
        "last_streak_date":     today,
        "spins":                int(user.get("spins") or 0) + 1,
    }).eq("telegram_id", body.telegram_id).execute()

    add_coins(body.telegram_id, 10, "streak", "Daily streak bonus")
    return {
        "coins_earned":         10,
        "streak_days":          new_streak,
        "spins":                int(user.get("spins") or 0) + 1,
        "streak_claimed_today": True,
        "coins":                int(user["coins"]) + 10,
    }

# ─── SPIN ──────────────────────────────────────────────────────────────────
@app.post("/api/spin")
async def spin_wheel(body: SpinIn):
    user = get_user(body.telegram_id)
    if int(user.get("spins") or 0) < 1:
        raise HTTPException(400, "No spins available")

    result = random.choices(SPIN_REWARDS, weights=SPIN_WEIGHTS, k=1)[0]
    db.table("users").update({"spins": int(user["spins"]) - 1}).eq("telegram_id", body.telegram_id).execute()
    db.table("spin_history").insert({"telegram_id": body.telegram_id, "coins_won": result}).execute()
    add_coins(body.telegram_id, result, "spin", "Spin wheel reward")

    return {
        "coins_won": result,
        "coins":     int(user["coins"]) + result,
        "spins":     int(user["spins"]) - 1,
    }

# ─── PROMO ─────────────────────────────────────────────────────────────────
@app.post("/api/redeem-promo")
async def redeem_promo(body: RedeemPromoIn):
    try:
        promo = db.table("promo_codes").select("*").eq("code", body.code.upper().strip()).single().execute()
    except Exception:
        raise HTTPException(400, "Invalid promo code")

    if not promo.data:
        raise HTTPException(400, "Invalid promo code")

    p = promo.data
    if int(p["activations"]) >= int(p["max_activations"]):
        raise HTTPException(400, "Promo code exhausted")

    used = db.table("promo_activations").select("id").eq("promo_id", p["id"]).eq("telegram_id", body.telegram_id).execute()
    if used.data:
        raise HTTPException(400, "Already used this code")

    db.table("promo_activations").insert({"promo_id": p["id"], "telegram_id": body.telegram_id}).execute()
    db.table("promo_codes").update({"activations": int(p["activations"]) + 1}).eq("id", p["id"]).execute()

    if p["reward_type"] == "coins":
        add_coins(body.telegram_id, int(p["reward_amount"]), "promo", f"Promo: {p['code']}")
    else:
        db.table("transactions").insert({
            "telegram_id": body.telegram_id,
            "type":        "promo",
            "amount":      p["reward_amount"],
            "description": f"Promo TON: {p['code']}",
            "currency":    "TON",
        }).execute()

    return {"reward_type": p["reward_type"], "reward_amount": p["reward_amount"]}

# ─── DAILY TASKS ───────────────────────────────────────────────────────────
@app.post("/api/claim-daily-task")
async def claim_daily_task(body: ClaimDailyTaskIn):
    user    = get_user(body.telegram_id)
    today   = date.today().isoformat()
    claimed = list(user.get("daily_tasks_claimed") or [])
    key     = f"{body.task_id}:{today}"

    if key in claimed:
        raise HTTPException(400, "Already claimed today")

    claimed.append(key)
    claimed = claimed[-100:]
    spins_add = 1 if body.task_id == "checkin" else 0

    db.table("users").update({
        "daily_tasks_claimed": claimed,
        "spins": int(user.get("spins") or 0) + spins_add,
    }).eq("telegram_id", body.telegram_id).execute()

    add_coins(body.telegram_id, 10, "daily", f"Daily task: {body.task_id}")
    today_claimed = [x.split(":")[0] for x in claimed if x.endswith(today)]

    return {
        "coins_earned":        10,
        "daily_tasks_claimed": today_claimed,
        "coins":               int(user["coins"]) + 10,
        "spins":               int(user.get("spins") or 0) + spins_add,
    }

# ─── TASKS ─────────────────────────────────────────────────────────────────
@app.get("/api/tasks")
async def get_tasks(telegram_id: int):
    tasks_res = db.table("tasks").select("*").eq("status", "active").execute()
    tasks     = tasks_res.data or []
    comp_res  = db.table("task_completions").select("task_id").eq("telegram_id", telegram_id).execute()
    done_ids  = {c["task_id"] for c in (comp_res.data or [])}
    for t in tasks:
        t["user_completed"] = t["id"] in done_ids
    return {"tasks": tasks}

@app.post("/api/claim-task")
async def claim_task(body: ClaimTaskIn):
    user = get_user(body.telegram_id)
    try:
        task_res = db.table("tasks").select("*").eq("id", body.task_id).single().execute()
    except Exception:
        raise HTTPException(404, "Task not found")

    task = task_res.data
    if not task:
        raise HTTPException(404, "Task not found")

    existing = db.table("task_completions").select("id").eq("telegram_id", body.telegram_id).eq("task_id", body.task_id).execute()
    if existing.data:
        raise HTTPException(400, "Task already completed")

    if int(task["completions"]) >= int(task["completion_limit"]):
        raise HTTPException(400, "Task limit reached")

    db.table("task_completions").insert({"telegram_id": body.telegram_id, "task_id": body.task_id}).execute()
    db.table("tasks").update({"completions": int(task["completions"]) + 1}).eq("id", body.task_id).execute()
    db.table("users").update({"spins": int(user.get("spins") or 0) + 1}).eq("telegram_id", body.telegram_id).execute()

    reward_map = {"channel": 1000, "group": 1000, "game": 1000, "website": 500}
    coins = reward_map.get(task["task_type"], 500)
    add_coins(body.telegram_id, coins, "task", f"Task: {task['name']}")
    return {"coins_earned": coins, "spins": int(user.get("spins") or 0) + 1}

@app.post("/api/verify-join")
async def verify_join(body: VerifyJoinIn):
    try:
        task_res = db.table("tasks").select("*").eq("id", body.task_id).single().execute()
    except Exception:
        raise HTTPException(404, "Task not found")

    task    = task_res.data
    chat_id = task["target_url"].rstrip("/").split("/")[-1]

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember",
            params={"chat_id": f"@{chat_id}", "user_id": body.telegram_id},
            timeout=10,
        )
    status = resp.json().get("result", {}).get("status", "left")
    if status in ("left", "kicked"):
        raise HTTPException(400, "Not a member yet. Please join first!")

    return await claim_task(ClaimTaskIn(telegram_id=body.telegram_id, task_id=body.task_id))

# ─── FRIENDS ───────────────────────────────────────────────────────────────
@app.get("/api/friends")
async def get_friends(telegram_id: int):
    user        = get_user(telegram_id)
    friends_res = db.table("users").select("telegram_id,first_name,username,coins").eq("referrer_id", telegram_id).execute()
    friends     = friends_res.data or []
    total_earned = 0
    for f in friends:
        share = int(int(f.get("coins") or 0) * REFERRAL_PCT)
        f["your_share"] = share
        total_earned   += share
    return {
        "total_friends": len(friends),
        "total_earned":  total_earned,
        "pending":       int(user.get("pending_referral_coins") or 0),
        "friends":       friends,
    }

@app.post("/api/claim-referral")
async def claim_referral(body: TelegramIdIn):
    user    = get_user(body.telegram_id)
    pending = int(user.get("pending_referral_coins") or 0)
    if pending <= 0:
        raise HTTPException(400, "No pending referral earnings")
    db.table("users").update({"pending_referral_coins": 0}).eq("telegram_id", body.telegram_id).execute()
    add_coins(body.telegram_id, pending, "referral", "Referral earnings")
    return {"coins_earned": pending}

# ─── TRANSACTIONS ──────────────────────────────────────────────────────────
@app.get("/api/transactions")
async def get_transactions(telegram_id: int):
    res = db.table("transactions").select("*").eq("telegram_id", telegram_id).order("created_at", desc=True).limit(50).execute()
    return {"transactions": res.data or []}

# ─── WITHDRAW ──────────────────────────────────────────────────────────────
@app.post("/api/withdraw")
async def withdraw(body: WithdrawIn):
    if body.tier_index < 0 or body.tier_index >= len(WITHDRAW_TIERS):
        raise HTTPException(400, "Invalid tier")
    user = get_user(body.telegram_id)
    tier = WITHDRAW_TIERS[body.tier_index]
    if int(user["coins"]) < tier["coins"]:
        raise HTTPException(400, "Insufficient coins")
    db.table("withdrawals").insert({
        "telegram_id": body.telegram_id,
        "coins_spent": tier["coins"],
        "ton_gross":   tier["ton"],
        "ton_net":     tier["net"],
        "status":      "pending",
    }).execute()
    add_coins(body.telegram_id, -tier["coins"], "withdraw", f"Withdrawal {tier['net']} TON")
    return {"status": "pending", "ton_net": tier["net"]}

# ─── TOPUP ─────────────────────────────────────────────────────────────────
@app.post("/api/create-topup")
async def create_topup(body: TopupIn):
    if body.amount <= 0:
        raise HTTPException(400, "Invalid amount")
    desc         = f"TRewards top-up {body.amount} TON for {body.telegram_id}"
    payment_url  = None

    if body.method == "xrocket":
        async with httpx.AsyncClient() as client:
            r = await client.post(
                "https://pay.xrocket.tg/tg-invoices",
                headers={"Rocket-Pay-Key": XROCKET_TOKEN, "Content-Type": "application/json"},
                json={"amount": body.amount, "currency": "TONCOIN", "description": desc,
                      "payload": str(body.telegram_id), "expiredIn": 3600},
                timeout=10,
            )
        d = r.json()
        payment_url = d.get("data", {}).get("link") or d.get("link")

    elif body.method == "cryptopay":
        async with httpx.AsyncClient() as client:
            r = await client.post(
                "https://pay.crypt.bot/api/createInvoice",
                headers={"Crypto-Pay-API-Token": CRYPTOPAY_TOKEN},
                json={"asset": "TON", "amount": str(body.amount), "description": desc,
                      "payload": str(body.telegram_id), "expires_in": 3600},
                timeout=10,
            )
        d = r.json()
        payment_url = (d.get("result") or {}).get("mini_app_invoice_url") or (d.get("result") or {}).get("bot_invoice_url")
    else:
        raise HTTPException(400, "Invalid payment method")

    db.table("payments").insert({
        "telegram_id": body.telegram_id, "amount": body.amount,
        "method": body.method, "status": "pending", "description": desc,
    }).execute()
    return {"payment_url": payment_url}

# ─── ADVERTISER ────────────────────────────────────────────────────────────
@app.get("/api/advertiser")
async def get_advertiser(telegram_id: int):
    user      = get_user(telegram_id)
    tasks_res = db.table("tasks").select("*").eq("created_by", telegram_id).execute()
    return {"ad_balance": float(user.get("ad_balance") or 0), "tasks": tasks_res.data or []}

@app.post("/api/create-task")
async def create_task(body: CreateTaskIn):
    user = get_user(body.telegram_id)
    cost = round(body.completion_limit * 0.001, 3)
    if float(user.get("ad_balance") or 0) < cost:
        raise HTTPException(400, f"Insufficient ad balance. Need {cost} TON")
    db.table("users").update({"ad_balance": float(user["ad_balance"]) - cost}).eq("telegram_id", body.telegram_id).execute()
    db.table("tasks").insert({
        "name": body.name, "task_type": body.task_type, "target_url": body.target_url,
        "completion_limit": body.completion_limit, "completions": 0,
        "status": "active", "created_by": body.telegram_id,
    }).execute()
    return {"status": "created", "cost": cost}

# ─── PAYMENT WEBHOOKS ──────────────────────────────────────────────────────
@app.post("/payment-webhook/xrocket")
async def webhook_xrocket(request: Request):
    body = await request.body()
    if WEBHOOK_SECRET_XROCKET:
        sig      = request.headers.get("rocket-pay-signature", "")
        expected = hashlib.sha256(WEBHOOK_SECRET_XROCKET.encode() + body).hexdigest()
        if not hmac.compare_digest(sig, expected):
            raise HTTPException(403, "Invalid signature")

    data = json.loads(body)
    if data.get("type") != "invoice" or data.get("status") != "paid":
        return {"ok": True}

    invoice    = data.get("data", {})
    payload    = invoice.get("payload", "")
    amount     = float(invoice.get("amount", 0))
    invoice_id = str(invoice.get("id", ""))

    if str(invoice.get("currency", "")).upper() not in ("TONCOIN", "TON"):
        return {"ok": True}

    dup = db.table("payments").select("id").eq("invoice_id", invoice_id).execute()
    if dup.data:
        return {"ok": True}

    telegram_id = int(payload)
    user = get_user(telegram_id)
    db.table("users").update({"ad_balance": float(user.get("ad_balance") or 0) + amount}).eq("telegram_id", telegram_id).execute()
    db.table("payments").insert({"telegram_id": telegram_id, "amount": amount, "method": "xrocket",
                                  "status": "paid", "invoice_id": invoice_id, "description": "xRocket top-up"}).execute()
    db.table("transactions").insert({"telegram_id": telegram_id, "type": "topup", "amount": amount,
                                      "description": "Top-up via xRocket", "currency": "TON"}).execute()
    return {"ok": True}

@app.post("/payment-webhook/cryptopay")
async def webhook_cryptopay(request: Request):
    body = await request.body()
    if CRYPTOPAY_TOKEN:
        sig      = request.headers.get("crypto-pay-api-signature", "")
        expected = hmac.new(hashlib.sha256(CRYPTOPAY_TOKEN.encode()).digest(), body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            raise HTTPException(403, "Invalid signature")

    data    = json.loads(body)
    invoice = data.get("payload", {})
    if data.get("update_type") != "invoice_paid" or invoice.get("asset") != "TON":
        return {"ok": True}

    invoice_id  = str(invoice.get("invoice_id", ""))
    amount      = float(invoice.get("amount", 0))
    payload     = invoice.get("payload", "")

    dup = db.table("payments").select("id").eq("invoice_id", invoice_id).execute()
    if dup.data:
        return {"ok": True}

    telegram_id = int(payload)
    user = get_user(telegram_id)
    db.table("users").update({"ad_balance": float(user.get("ad_balance") or 0) + amount}).eq("telegram_id", telegram_id).execute()
    db.table("payments").insert({"telegram_id": telegram_id, "amount": amount, "method": "cryptopay",
                                  "status": "paid", "invoice_id": invoice_id, "description": "CryptoPay top-up"}).execute()
    db.table("transactions").insert({"telegram_id": telegram_id, "type": "topup", "amount": amount,
                                      "description": "Top-up via Crypto Pay", "currency": "TON"}).execute()
    return {"ok": True}

# ─── ADMIN ROUTES ──────────────────────────────────────────────────────────
@app.post("/admin/create-promo")
async def create_promo(body: PromoCreateIn, x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    existing = db.table("promo_codes").select("id").eq("code", body.code.upper()).execute()
    if existing.data:
        raise HTTPException(400, "Code already exists")
    db.table("promo_codes").insert({
        "code": body.code.upper(), "reward_type": body.reward_type,
        "reward_amount": body.reward_amount, "max_activations": body.max_activations, "activations": 0,
    }).execute()
    return {"status": "created"}

@app.post("/admin/delete-promo")
async def delete_promo(body: PromoDeleteIn, x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    db.table("promo_codes").delete().eq("code", body.code.upper()).execute()
    return {"status": "deleted"}

@app.get("/admin/promos")
async def list_promos(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    return db.table("promo_codes").select("*").execute().data or []

@app.get("/admin/activations")
async def list_activations(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    return db.table("promo_activations").select("*").order("created_at", desc=True).limit(50).execute().data or []

@app.get("/admin/payments")
async def list_payments(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    return db.table("payments").select("*").order("created_at", desc=True).limit(50).execute().data or []

@app.get("/admin/stats")
async def admin_stats(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    res = db.table("users").select("telegram_id", count="exact").execute()
    return {"total_users": res.count or 0}