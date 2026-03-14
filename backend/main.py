import hashlib
import hmac
import json
import logging
import random
import secrets
import urllib.parse
from datetime import date, datetime, timedelta
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import config
from database import (
    get_pool, init_db, get_user, create_user,
    add_coins, add_spins
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="TRewards API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    await init_db()
    logger.info("TRewards API started")


# ─── Helpers ────────────────────────────────────────────────────────────────

def verify_telegram_init_data(init_data: str) -> dict:
    """Validate Telegram WebApp initData HMAC-SHA256"""
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data))
        received_hash = parsed.pop("hash", "")
        data_check = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", config.BOT_TOKEN.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret_key, data_check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, received_hash):
            raise ValueError("Invalid hash")
        user_data = json.loads(parsed.get("user", "{}"))
        return user_data
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid init data: {str(e)}")


async def get_current_user(request: Request):
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    if not init_data:
        # Dev fallback - check body
        try:
            body = await request.json()
            init_data = body.get("init_data", "")
        except Exception:
            pass
    if not init_data:
        raise HTTPException(status_code=401, detail="Missing init data")
    return verify_telegram_init_data(init_data)


# ─── Models ─────────────────────────────────────────────────────────────────

class UserRequest(BaseModel):
    init_data: str
    referrer_id: Optional[int] = None
    language: Optional[str] = "en"


class PromoRequest(BaseModel):
    init_data: str
    code: str


class SpinRequest(BaseModel):
    init_data: str


class StreakRequest(BaseModel):
    init_data: str


class DailyTaskRequest(BaseModel):
    init_data: str
    task_type: str  # checkin, update, share


class ClaimTaskRequest(BaseModel):
    init_data: str
    task_id: int


class VerifyJoinRequest(BaseModel):
    init_data: str
    task_id: int


class ClaimReferralRequest(BaseModel):
    init_data: str


class WithdrawRequest(BaseModel):
    init_data: str
    tier_index: int  # 0-3
    wallet_address: str


class TopUpRequest(BaseModel):
    init_data: str
    amount: float
    method: str  # xrocket or cryptopay


class CreateTaskRequest(BaseModel):
    init_data: str
    name: str
    task_type: str
    url: str
    completion_limit: int


class LanguageRequest(BaseModel):
    init_data: str
    language: str


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "service": "TRewards API"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


# POST /api/user - Register or get user
@app.post("/api/user")
async def upsert_user(req: UserRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await create_user(
            conn,
            user_id,
            tg_user.get("username"),
            tg_user.get("first_name", ""),
            tg_user.get("last_name", ""),
            req.referrer_id
        )

        # Update language preference
        if req.language:
            await conn.execute(
                "UPDATE users SET language = $1 WHERE id = $2",
                req.language, user_id
            )

        return {
            "id": user["id"],
            "username": user["username"],
            "first_name": user["first_name"],
            "coins": user["coins"],
            "spins": user["spins"],
            "streak": user["streak"],
            "last_streak_date": user["last_streak_date"].isoformat() if user["last_streak_date"] else None,
            "ton_balance": float(user["ton_balance"]),
            "ad_balance": float(user["ad_balance"]),
            "language": user["language"],
            "referral_link": f"https://t.me/{config.BOT_USERNAME}?start={user_id}",
        }


# POST /api/claim-streak
@app.post("/api/claim-streak")
async def claim_streak(req: StreakRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        today = date.today()
        last_date = user["last_streak_date"]

        if last_date == today:
            raise HTTPException(status_code=400, detail="Already claimed today")

        # Calculate streak
        if last_date == today - timedelta(days=1):
            new_streak = (user["streak"] % 7) + 1
        else:
            new_streak = 1

        await conn.execute("""
            UPDATE users SET
                streak = $1,
                last_streak_date = $2,
                streak_started = CASE WHEN $1 = 1 THEN $2 ELSE streak_started END
            WHERE id = $3
        """, new_streak, today, user_id)

        await add_coins(conn, user_id, config.STREAK_COIN_REWARD, "streak", f"Day {new_streak} streak bonus")
        await add_spins(conn, user_id, config.STREAK_SPIN_REWARD)

        return {
            "success": True,
            "coins_earned": config.STREAK_COIN_REWARD,
            "spins_earned": config.STREAK_SPIN_REWARD,
            "streak": new_streak,
        }


# POST /api/spin
@app.post("/api/spin")
async def spin_wheel(req: SpinRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        if user["spins"] < 1:
            raise HTTPException(status_code=400, detail="No spins available")

        # Weighted random result
        result = random.choices(config.SPIN_SEGMENTS, weights=config.SPIN_WEIGHTS, k=1)[0]
        segment_index = config.SPIN_SEGMENTS.index(result)

        # Deduct spin, add coins
        await conn.execute(
            "UPDATE users SET spins = spins - 1 WHERE id = $1",
            user_id
        )
        await add_coins(conn, user_id, result, "spin", f"Spin wheel reward")
        await conn.execute(
            "INSERT INTO spin_history (user_id, result_coins) VALUES ($1, $2)",
            user_id, result
        )

        updated = await get_user(conn, user_id)
        return {
            "success": True,
            "result": result,
            "segment_index": segment_index,
            "coins_earned": result,
            "new_balance": updated["coins"],
            "remaining_spins": updated["spins"],
        }


# POST /api/redeem-promo
@app.post("/api/redeem-promo")
async def redeem_promo(req: PromoRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        promo = await conn.fetchrow("""
            SELECT * FROM promo_codes
            WHERE LOWER(code) = LOWER($1) AND is_active = TRUE
        """, req.code.strip())

        if not promo:
            raise HTTPException(status_code=404, detail="Invalid or expired promo code")

        if promo["current_activations"] >= promo["max_activations"]:
            raise HTTPException(status_code=400, detail="Promo code limit reached")

        # Check if user already used it
        existing = await conn.fetchrow("""
            SELECT id FROM promo_activations WHERE promo_id = $1 AND user_id = $2
        """, promo["id"], user_id)
        if existing:
            raise HTTPException(status_code=400, detail="Already redeemed this code")

        # Apply reward
        async with conn.transaction():
            await conn.execute("""
                UPDATE promo_codes SET current_activations = current_activations + 1
                WHERE id = $1
            """, promo["id"])
            await conn.execute("""
                INSERT INTO promo_activations (promo_id, user_id) VALUES ($1, $2)
            """, promo["id"], user_id)

            if promo["reward_type"] == "coins":
                amount = int(promo["reward_amount"])
                await add_coins(conn, user_id, amount, "promo", f"Promo code: {promo['code']}")
                return {"success": True, "reward_type": "coins", "amount": amount}
            else:  # ton
                ton_amt = float(promo["reward_amount"])
                await conn.execute(
                    "UPDATE users SET ton_balance = ton_balance + $1 WHERE id = $2",
                    ton_amt, user_id
                )
                await conn.execute("""
                    INSERT INTO transactions (user_id, type, description, ton_amount)
                    VALUES ($1, 'promo', $2, $3)
                """, user_id, f"Promo code: {promo['code']}", ton_amt)
                return {"success": True, "reward_type": "ton", "amount": ton_amt}


# GET /api/tasks
@app.get("/api/tasks")
async def get_tasks(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        tasks = await conn.fetch("""
            SELECT t.*,
                EXISTS(
                    SELECT 1 FROM task_completions tc
                    WHERE tc.task_id = t.id AND tc.user_id = $1
                ) as completed
            FROM tasks t
            WHERE t.status = 'active' AND t.completed_count < t.completion_limit
            ORDER BY t.created_at DESC
        """, user_id)

        return [dict(t) for t in tasks]


# POST /api/claim-task
@app.post("/api/claim-task")
async def claim_task(req: ClaimTaskRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        task = await conn.fetchrow(
            "SELECT * FROM tasks WHERE id = $1 AND status = 'active'",
            req.task_id
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task not found or inactive")

        if task["type"] in ("channel", "group"):
            raise HTTPException(status_code=400, detail="Use verify-join for channel/group tasks")

        if task["completed_count"] >= task["completion_limit"]:
            raise HTTPException(status_code=400, detail="Task limit reached")

        existing = await conn.fetchrow("""
            SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2
        """, req.task_id, user_id)
        if existing:
            raise HTTPException(status_code=400, detail="Task already completed")

        async with conn.transaction():
            await conn.execute("""
                INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)
            """, req.task_id, user_id)
            await conn.execute("""
                UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1
            """, req.task_id)
            await add_coins(conn, user_id, task["reward_coins"], "task", f"Task: {task['name']}")
            await add_spins(conn, user_id, config.TASK_SPIN_BONUS)

            # Mark task completed if limit reached
            await conn.execute("""
                UPDATE tasks SET status = 'completed'
                WHERE id = $1 AND completed_count >= completion_limit
            """, req.task_id)

        updated = await get_user(conn, user_id)
        return {
            "success": True,
            "coins_earned": task["reward_coins"],
            "spins_earned": config.TASK_SPIN_BONUS,
            "new_balance": updated["coins"],
        }


# POST /api/verify-join
@app.post("/api/verify-join")
async def verify_join(req: VerifyJoinRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        task = await conn.fetchrow(
            "SELECT * FROM tasks WHERE id = $1 AND status = 'active'",
            req.task_id
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task not found or inactive")

        if task["type"] not in ("channel", "group"):
            raise HTTPException(status_code=400, detail="Not a channel/group task")

        if task["completed_count"] >= task["completion_limit"]:
            raise HTTPException(status_code=400, detail="Task limit reached")

        existing = await conn.fetchrow("""
            SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2
        """, req.task_id, user_id)
        if existing:
            raise HTTPException(status_code=400, detail="Task already completed")

        # Extract chat username from URL
        chat_id = task["url"].split("t.me/")[-1].strip("/")
        if chat_id.startswith("+"):
            # Private invite link - can't verify programmatically, just award
            is_member = True
        else:
            # Check via Telegram API
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(
                        f"https://api.telegram.org/bot{config.BOT_TOKEN}/getChatMember",
                        params={"chat_id": f"@{chat_id}", "user_id": user_id},
                        timeout=10
                    )
                    data = resp.json()
                    if data.get("ok"):
                        status = data["result"]["status"]
                        is_member = status in ("member", "administrator", "creator")
                    else:
                        is_member = False
            except Exception as e:
                logger.error(f"Telegram getChatMember error: {e}")
                is_member = False

        if not is_member:
            raise HTTPException(status_code=400, detail="Not a member of the channel/group")

        async with conn.transaction():
            await conn.execute("""
                INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)
            """, req.task_id, user_id)
            await conn.execute("""
                UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1
            """, req.task_id)
            await add_coins(conn, user_id, task["reward_coins"], "task", f"Task: {task['name']}")
            await add_spins(conn, user_id, config.TASK_SPIN_BONUS)

            await conn.execute("""
                UPDATE tasks SET status = 'completed'
                WHERE id = $1 AND completed_count >= completion_limit
            """, req.task_id)

        updated = await get_user(conn, user_id)
        return {
            "success": True,
            "coins_earned": task["reward_coins"],
            "spins_earned": config.TASK_SPIN_BONUS,
            "new_balance": updated["coins"],
        }


# POST /api/claim-daily-task
@app.post("/api/claim-daily-task")
async def claim_daily_task(req: DailyTaskRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    valid_types = ("checkin", "update", "share")
    if req.task_type not in valid_types:
        raise HTTPException(status_code=400, detail="Invalid task type")

    pool = await get_pool()
    async with pool.acquire() as conn:
        today = date.today()
        existing = await conn.fetchrow("""
            SELECT id FROM daily_task_completions
            WHERE user_id = $1 AND task_type = $2 AND completed_date = $3
        """, user_id, req.task_type, today)

        if existing:
            raise HTTPException(status_code=400, detail="Daily task already claimed today")

        async with conn.transaction():
            await conn.execute("""
                INSERT INTO daily_task_completions (user_id, task_type, completed_date)
                VALUES ($1, $2, $3)
            """, user_id, req.task_type, today)

            reward_coins = config.STREAK_COIN_REWARD  # 10 TR
            reward_spins = 1

            await add_coins(conn, user_id, reward_coins, "daily_task", f"Daily task: {req.task_type}")
            await add_spins(conn, user_id, reward_spins)

        updated = await get_user(conn, user_id)
        return {
            "success": True,
            "coins_earned": reward_coins,
            "spins_earned": reward_spins,
            "new_balance": updated["coins"],
        }


# GET /api/daily-task-status
@app.get("/api/daily-task-status")
async def daily_task_status(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        today = date.today()
        rows = await conn.fetch("""
            SELECT task_type FROM daily_task_completions
            WHERE user_id = $1 AND completed_date = $2
        """, user_id, today)
        return {"completed": [r["task_type"] for r in rows]}


# GET /api/friends
@app.get("/api/friends")
async def get_friends(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        friends = await conn.fetch("""
            SELECT id, username, first_name, last_name, coins
            FROM users WHERE referrer_id = $1
            ORDER BY coins DESC
        """, user_id)

        friend_list = []
        for f in friends:
            your_share = int(f["coins"] * config.REFERRAL_COMMISSION)
            friend_list.append({
                "id": f["id"],
                "name": f["first_name"] or f["username"] or "Unknown",
                "username": f["username"],
                "coins": f["coins"],
                "your_share": your_share,
            })

        return {
            "friends": friend_list,
            "total_friends": len(friend_list),
            "total_earned": user["referral_earnings"],
            "unclaimed": user["unclaimed_referral"],
            "referral_link": f"https://t.me/{config.BOT_USERNAME}?start={user_id}",
        }


# POST /api/claim-referral
@app.post("/api/claim-referral")
async def claim_referral(req: ClaimReferralRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        unclaimed = user["unclaimed_referral"]
        if unclaimed <= 0:
            raise HTTPException(status_code=400, detail="No referral earnings to claim")

        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET unclaimed_referral = 0, coins = coins + $1 WHERE id = $2",
                unclaimed, user_id
            )
            await conn.execute("""
                INSERT INTO transactions (user_id, type, description, amount)
                VALUES ($1, 'referral', 'Referral commission claimed', $2)
            """, user_id, unclaimed)

        return {"success": True, "claimed": unclaimed}


# GET /api/transactions
@app.get("/api/transactions")
async def get_transactions(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        txns = await conn.fetch("""
            SELECT * FROM transactions WHERE user_id = $1
            ORDER BY created_at DESC LIMIT 50
        """, user_id)

        return [dict(t) for t in txns]


# POST /api/withdraw
@app.post("/api/withdraw")
async def withdraw(req: WithdrawRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    if req.tier_index < 0 or req.tier_index >= len(config.WITHDRAWAL_TIERS):
        raise HTTPException(status_code=400, detail="Invalid tier")

    tier = config.WITHDRAWAL_TIERS[req.tier_index]

    if not req.wallet_address or len(req.wallet_address) < 10:
        raise HTTPException(status_code=400, detail="Invalid wallet address")

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        if user["coins"] < tier["coins"]:
            raise HTTPException(status_code=400, detail="Insufficient coins")

        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET coins = coins - $1 WHERE id = $2",
                tier["coins"], user_id
            )
            withdrawal_id = await conn.fetchval("""
                INSERT INTO withdrawals (user_id, coins_deducted, ton_amount, net_ton, wallet_address)
                VALUES ($1, $2, $3, $4, $5) RETURNING id
            """, user_id, tier["coins"], tier["ton"], tier["net"], req.wallet_address)

            await conn.execute("""
                INSERT INTO transactions (user_id, type, description, amount)
                VALUES ($1, 'withdrawal', $2, $3)
            """, user_id, f"Withdrawal #{withdrawal_id}: {tier['ton']} TON → {req.wallet_address[:8]}...", -tier["coins"])

        return {
            "success": True,
            "withdrawal_id": withdrawal_id,
            "coins_deducted": tier["coins"],
            "ton_amount": tier["ton"],
            "net_ton": tier["net"],
            "message": "Withdrawal queued. Processed within 24 hours."
        }


# POST /api/create-topup
@app.post("/api/create-topup")
async def create_topup(req: TopUpRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid amount")

    pool = await get_pool()
    async with pool.acquire() as conn:
        if req.method == "xrocket":
            invoice_url, invoice_id = await create_xrocket_invoice(user_id, req.amount)
        elif req.method == "cryptopay":
            invoice_url, invoice_id = await create_cryptopay_invoice(user_id, req.amount)
        else:
            raise HTTPException(status_code=400, detail="Invalid payment method")

        await conn.execute("""
            INSERT INTO payments (user_id, provider, invoice_id, amount_ton, payload)
            VALUES ($1, $2, $3, $4, $5)
        """, user_id, req.method, invoice_id, req.amount, json.dumps({"user_id": user_id}))

        return {"invoice_url": invoice_url, "invoice_id": invoice_id}


async def create_xrocket_invoice(user_id: int, amount: float) -> tuple:
    """Create xRocket invoice"""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://pay.xrocket.tg/app/invoice/create",
                headers={
                    "Rocket-Pay-Key": config.XROCKET_API_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "currency": "TONCOIN",
                    "amount": amount,
                    "description": f"TRewards top-up for user {user_id}",
                    "payload": json.dumps({"user_id": user_id}),
                    "callbackUrl": f"https://api.trewards.onrender.com/payment-webhook/xrocket"
                },
                timeout=15
            )
            data = resp.json()
            if data.get("success"):
                invoice = data["data"]
                return invoice["link"], str(invoice["id"])
            raise HTTPException(status_code=500, detail=f"xRocket error: {data.get('message')}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Payment provider error: {str(e)}")


async def create_cryptopay_invoice(user_id: int, amount: float) -> tuple:
    """Create Crypto Pay invoice"""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://pay.crypt.bot/api/createInvoice",
                headers={"Crypto-Pay-API-Token": config.CRYPTOPAY_API_TOKEN},
                json={
                    "asset": "TON",
                    "amount": str(amount),
                    "description": f"TRewards top-up",
                    "payload": json.dumps({"user_id": user_id}),
                    "allow_comments": False,
                    "allow_anonymous": False,
                },
                timeout=15
            )
            data = resp.json()
            if data.get("ok"):
                invoice = data["result"]
                return invoice["pay_url"], str(invoice["invoice_id"])
            raise HTTPException(status_code=500, detail=f"CryptoPay error: {data.get('error')}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Payment provider error: {str(e)}")


# GET /api/advertiser
@app.get("/api/advertiser")
async def get_advertiser(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        tasks = await conn.fetch("""
            SELECT * FROM tasks WHERE advertiser_id = $1 ORDER BY created_at DESC
        """, user_id)

        return {
            "ad_balance": float(user["ad_balance"]),
            "tasks": [dict(t) for t in tasks]
        }


# POST /api/create-task
@app.post("/api/create-task")
async def create_task(req: CreateTaskRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    valid_types = ("visit", "channel", "group", "game")
    if req.task_type not in valid_types:
        raise HTTPException(status_code=400, detail="Invalid task type")

    valid_limits = (500, 1000, 2000, 5000, 10000)
    if req.completion_limit not in valid_limits:
        raise HTTPException(status_code=400, detail="Invalid completion limit")

    cost = req.completion_limit * 0.001  # 0.001 TON per completion

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if float(user["ad_balance"]) < cost:
            raise HTTPException(status_code=400, detail=f"Insufficient ad balance. Need {cost} TON")

        reward_map = {
            "visit": config.TASK_REWARD_VISIT,
            "channel": config.TASK_REWARD_CHANNEL,
            "group": config.TASK_REWARD_GROUP,
            "game": config.TASK_REWARD_GAME,
        }

        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET ad_balance = ad_balance - $1 WHERE id = $2",
                cost, user_id
            )
            task_id = await conn.fetchval("""
                INSERT INTO tasks (advertiser_id, name, type, url, reward_coins, completion_limit, cost_ton)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
            """, user_id, req.name, req.task_type, req.url,
                reward_map[req.task_type], req.completion_limit, cost)

        return {"success": True, "task_id": task_id, "cost": cost}


# POST /api/set-language
@app.post("/api/set-language")
async def set_language(req: LanguageRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    if req.language not in ("en", "ru"):
        raise HTTPException(status_code=400, detail="Invalid language")

    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET language = $1 WHERE id = $2",
            req.language, user_id
        )
    return {"success": True}


# ─── Payment Webhooks ────────────────────────────────────────────────────────

@app.post("/payment-webhook/xrocket")
async def xrocket_webhook(request: Request):
    body = await request.body()
    signature = request.headers.get("rocket-pay-signature", "")

    # Verify signature
    expected = hmac.new(
        config.XROCKET_WEBHOOK_SECRET.encode(),
        body,
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature):
        logger.warning("xRocket webhook: invalid signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    data = json.loads(body)
    logger.info(f"xRocket webhook: {data}")

    if data.get("type") != "invoice" or data.get("status") != "paid":
        return {"ok": True}

    invoice_id = str(data.get("id"))
    amount = float(data.get("amount", 0))
    currency = data.get("currency", "")

    if currency != "TONCOIN":
        return {"ok": True}

    await process_payment("xrocket", invoice_id, amount)
    return {"ok": True}


@app.post("/payment-webhook/cryptopay")
async def cryptopay_webhook(request: Request):
    body = await request.body()
    signature = request.headers.get("crypto-pay-api-signature", "")

    # Verify HMAC
    secret = hashlib.sha256(config.CRYPTOPAY_WEBHOOK_SECRET.encode()).digest()
    expected = hmac.new(secret, body, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, signature):
        logger.warning("CryptoPay webhook: invalid signature")
        raise HTTPException(status_code=401, detail="Invalid signature")

    data = json.loads(body)
    if data.get("update_type") != "invoice_paid":
        return {"ok": True}

    payload_data = data.get("payload", {})
    invoice_id = str(payload_data.get("invoice_id"))
    amount = float(payload_data.get("amount", 0))
    asset = payload_data.get("asset", "")

    if asset != "TON":
        return {"ok": True}

    await process_payment("cryptopay", invoice_id, amount)
    return {"ok": True}


async def process_payment(provider: str, invoice_id: str, amount: float):
    """Credit user after successful payment - idempotent"""
    pool = await get_pool()
    async with pool.acquire() as conn:
        payment = await conn.fetchrow(
            "SELECT * FROM payments WHERE invoice_id = $1",
            invoice_id
        )
        if not payment:
            logger.warning(f"Payment {invoice_id} not found in DB")
            return

        if payment["status"] == "paid":
            logger.info(f"Payment {invoice_id} already processed (duplicate webhook)")
            return

        async with conn.transaction():
            await conn.execute("""
                UPDATE payments SET status = 'paid', paid_at = NOW()
                WHERE invoice_id = $1
            """, invoice_id)

            user_id = payment["user_id"]
            # Credit ad balance
            await conn.execute(
                "UPDATE users SET ad_balance = ad_balance + $1 WHERE id = $2",
                amount, user_id
            )
            await conn.execute("""
                INSERT INTO transactions (user_id, type, description, ton_amount)
                VALUES ($1, 'topup', $2, $3)
            """, user_id, f"Ad balance top-up via {provider}", amount)

        logger.info(f"Payment processed: user={payment['user_id']}, amount={amount} TON via {provider}")


# ─── Admin endpoints ─────────────────────────────────────────────────────────

def require_admin(user_id: int):
    if user_id not in config.ADMIN_IDS:
        raise HTTPException(status_code=403, detail="Admin only")


class AdminPromoCreate(BaseModel):
    init_data: str
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int


@app.post("/api/admin/create-promo")
async def admin_create_promo(req: AdminPromoCreate):
    tg_user = verify_telegram_init_data(req.init_data)
    require_admin(tg_user["id"])

    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            promo_id = await conn.fetchval("""
                INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by)
                VALUES ($1, $2, $3, $4, $5) RETURNING id
            """, req.code.upper(), req.reward_type, req.reward_amount, req.max_activations, tg_user["id"])
            return {"success": True, "promo_id": promo_id}
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Code already exists: {str(e)}")


@app.get("/api/admin/promos")
async def admin_list_promos(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    require_admin(tg_user["id"])

    pool = await get_pool()
    async with pool.acquire() as conn:
        promos = await conn.fetch("SELECT * FROM promo_codes ORDER BY created_at DESC")
        return [dict(p) for p in promos]


@app.delete("/api/admin/promo/{promo_id}")
async def admin_delete_promo(promo_id: int, init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    require_admin(tg_user["id"])

    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE promo_codes SET is_active = FALSE WHERE id = $1",
            promo_id
        )
        return {"success": True}


@app.get("/api/admin/stats")
async def admin_stats(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    require_admin(tg_user["id"])

    pool = await get_pool()
    async with pool.acquire() as conn:
        total_users = await conn.fetchval("SELECT COUNT(*) FROM users")
        total_payments = await conn.fetchval(
            "SELECT COALESCE(SUM(amount_ton), 0) FROM payments WHERE status = 'paid'"
        )
        total_withdrawals = await conn.fetchval(
            "SELECT COUNT(*) FROM withdrawals WHERE status = 'pending'"
        )
        return {
            "total_users": total_users,
            "total_payments_ton": float(total_payments),
            "pending_withdrawals": total_withdrawals,
        }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)