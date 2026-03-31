import asyncio
import hashlib
import hmac
import json
import logging
import random
import secrets
import urllib.parse
from datetime import date, timedelta
from typing import Optional
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import config
from database import (
    get_pool, init_db, get_user, create_user,
    add_coins, add_spins, add_ton,
    _current_week_id, _prev_week_id
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

# ─── In-memory cache ──────────────────────────────────────────────────────────
_cache: dict = {}
_cache_ttl: dict = {}

def cache_get(key: str):
    if key in _cache and time.time() < _cache_ttl.get(key, 0):
        return _cache[key]
    return None

def cache_set(key: str, val, ttl: int = 60):
    _cache[key] = val
    _cache_ttl[key] = time.time() + ttl

def cache_del(key: str):
    _cache.pop(key, None)
    _cache_ttl.pop(key, None)

def cache_del_prefix(prefix: str):
    for k in list(_cache):
        if k.startswith(prefix):
            cache_del(k)


@app.on_event("startup")
async def startup():
    await init_db()
    logger.info("TRewards API started")


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def verify_telegram_init_data(init_data: str) -> dict:
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data))
        received_hash = parsed.pop("hash", "")
        data_check = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", config.BOT_TOKEN.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret_key, data_check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, received_hash):
            raise ValueError("Invalid hash")
        return json.loads(parsed.get("user", "{}"))
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid init data: {e}")


def require_admin(user_id: int):
    if user_id not in config.ADMIN_IDS:
        raise HTTPException(status_code=403, detail="Admin only")


# ─── Week helpers (Sunday→Saturday, matching frontend) ────────────────────────

def _sunday_week_id(d: date = None) -> str:
    """
    Week ID based on Sunday→Saturday weeks.
    Returns YYYY-WNN where week 1 starts on the first Sunday of the year (or Jan 1 if it's Sunday).
    Uses ISO-compatible approach: find the Sunday that started the current week.
    """
    if d is None:
        d = date.today()
    # Find the most recent Sunday (weekday 6 = Sunday in Python's isoweekday: Mon=1..Sun=7)
    # Python: weekday() Mon=0..Sun=6
    days_since_sunday = (d.weekday() + 1) % 7  # 0 if Sunday, 1 if Monday, ..., 6 if Saturday
    week_start = d - timedelta(days=days_since_sunday)
    # Use ISO week number of the week_start for consistency
    year = week_start.isocalendar()[0]
    # Simple week number: days from Jan 1 of that year
    jan1 = date(year, 1, 1)
    week_num = (week_start - jan1).days // 7 + 1
    return f"{year}-W{week_num:02d}"


def _prev_sunday_week_id() -> str:
    d = date.today() - timedelta(days=7)
    return _sunday_week_id(d)


# ─── Pydantic models ──────────────────────────────────────────────────────────

class UserRequest(BaseModel):
    init_data: str
    referrer_id: Optional[int] = None
    language: Optional[str] = "en"

class InitDataOnly(BaseModel):
    init_data: str

class StreakRequest(BaseModel):
    init_data: str

class SpinRequest(BaseModel):
    init_data: str

class PromoRequest(BaseModel):
    init_data: str
    code: str

class DailyTaskRequest(BaseModel):
    init_data: str
    task_type: str

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
    tier_index: int
    wallet_address: str

class ConvertRequest(BaseModel):
    init_data: str
    tr_amount: int

class TopUpRequest(BaseModel):
    init_data: str
    amount: float
    method: str

class StarsTopUpRequest(BaseModel):
    init_data: str
    stars_amount: int
    telegram_charge_id: str

class ConnectWalletRequest(BaseModel):
    init_data: str
    wallet_address: str

class DisconnectWalletRequest(BaseModel):
    init_data: str

class CreateTaskRequest(BaseModel):
    init_data: str
    name: str
    task_type: str
    url: str
    completion_limit: Optional[int] = None
    days_limit: Optional[int] = None

class WatchAdRequest(BaseModel):
    init_data: str
    ad_id: str

class LanguageRequest(BaseModel):
    init_data: str
    language: str

class CreateCheckRequest(BaseModel):
    init_data: str
    amount: float
    check_type: str
    recipients: Optional[int] = 1

class ClaimCheckRequest(BaseModel):
    init_data: str
    check_id: str

class StarsInvoiceRequest(BaseModel):
    init_data: str
    stars_amount: int

class AdminPromoCreate(BaseModel):
    init_data: str
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int

class BroadcastRequest(BaseModel):
    init_data: str
    message: str
    parse_mode: Optional[str] = "HTML"
    button_text: Optional[str] = None
    button_url: Optional[str] = None


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    return {"status": "ok", "service": "TRewards API"}

@app.get("/health")
async def health():
    return {"status": "healthy"}


# ─── POST /api/user ───────────────────────────────────────────────────────────
# referrer_id: numeric user ID passed as webapp URL param (not bot start param)

@app.post("/api/user")
async def upsert_user(req: UserRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    cached = cache_get(f"user:{user_id}")
    if cached:
        return cached

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await create_user(
            conn, user_id,
            tg_user.get("username"),
            tg_user.get("first_name", ""),
            tg_user.get("last_name", ""),
            req.referrer_id
        )
        if req.language:
            await conn.execute(
                "UPDATE users SET language = $1 WHERE id = $2", req.language, user_id
            )
        payload = _user_payload(user)
        cache_set(f"user:{user_id}", payload, ttl=config.CACHE_TTL_USER)
        return payload


def _user_payload(user):
    return {
        "id": user["id"],
        "username": user["username"],
        "first_name": user["first_name"],
        "coins": user["coins"],
        "spins": user["spins"],
        "streak": user["streak"],
        "last_streak_date": user["last_streak_date"].isoformat() if user["last_streak_date"] else None,
        "ton_balance": float(user["ton_balance"]),
        "language": user["language"],
        # Referral link now points to the Mini App with ref= param (not bot /start)
        "referral_link": f"https://t.me/{config.BOT_USERNAME}/{config.MINI_APP_SHORT_NAME}?startapp=ref_{user['id']}",
        "ton_wallet_address": user["ton_wallet_address"],
        "ton_comment_id": user["ton_comment_id"],
    }


# ─── POST /api/claim-streak ───────────────────────────────────────────────────

@app.post("/api/claim-streak")
async def claim_streak(req: StreakRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        today = date.today()
        last_date = user["last_streak_date"]
        if last_date == today:
            raise HTTPException(status_code=400, detail="Already claimed today")
        yesterday = today - timedelta(days=1)
        new_streak = (user["streak"] % 7) + 1 if last_date == yesterday else 1
        async with conn.transaction():
            await conn.execute("""
                UPDATE users SET
                    streak = $1, last_streak_date = $2,
                    streak_started = CASE WHEN $1 = 1 THEN $2 ELSE streak_started END
                WHERE id = $3
            """, new_streak, today, user_id)
            await add_coins(conn, user_id, config.STREAK_COIN_REWARD, "streak",
                            f"Day {new_streak} streak bonus")
            await add_spins(conn, user_id, config.STREAK_SPIN_REWARD)
        return {
            "success": True,
            "coins_earned": config.STREAK_COIN_REWARD,
            "spins_earned": config.STREAK_SPIN_REWARD,
            "streak": new_streak
        }


# ─── POST /api/spin ───────────────────────────────────────────────────────────

@app.post("/api/spin")
async def spin_wheel(req: SpinRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if user["spins"] < 1:
            raise HTTPException(status_code=400, detail="No spins available")
        result = random.choices(config.SPIN_SEGMENTS, weights=config.SPIN_WEIGHTS, k=1)[0]
        segment_index = config.SPIN_SEGMENTS.index(result)
        async with conn.transaction():
            await conn.execute("UPDATE users SET spins = spins - 1 WHERE id = $1", user_id)
            await add_coins(conn, user_id, result, "spin", "Spin wheel reward")
            await conn.execute(
                "INSERT INTO spin_history (user_id, result_coins) VALUES ($1, $2)", user_id, result
            )
        updated = await get_user(conn, user_id)
        return {
            "success": True, "result": result, "segment_index": segment_index,
            "coins_earned": result, "new_balance": updated["coins"],
            "remaining_spins": updated["spins"]
        }


# ─── POST /api/redeem-promo ───────────────────────────────────────────────────

@app.post("/api/redeem-promo")
async def redeem_promo(req: PromoRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        promo = await conn.fetchrow(
            "SELECT * FROM promo_codes WHERE LOWER(code) = LOWER($1) AND is_active = TRUE",
            req.code.strip()
        )
        if not promo:
            raise HTTPException(status_code=404, detail="Invalid or expired promo code")
        if promo["current_activations"] >= promo["max_activations"]:
            raise HTTPException(status_code=400, detail="Promo code limit reached")
        existing = await conn.fetchrow(
            "SELECT id FROM promo_activations WHERE promo_id = $1 AND user_id = $2",
            promo["id"], user_id
        )
        if existing:
            raise HTTPException(status_code=400, detail="Already redeemed this code")
        async with conn.transaction():
            await conn.execute(
                "UPDATE promo_codes SET current_activations = current_activations + 1 WHERE id = $1",
                promo["id"]
            )
            await conn.execute(
                "INSERT INTO promo_activations (promo_id, user_id) VALUES ($1, $2)",
                promo["id"], user_id
            )
            if promo["reward_type"] == "coins":
                amount = int(promo["reward_amount"])
                await add_coins(conn, user_id, amount, "promo", f"Promo code: {promo['code']}")
                return {"success": True, "reward_type": "coins", "amount": amount}
            else:
                ton_amt = float(promo["reward_amount"])
                await add_ton(conn, user_id, ton_amt, "promo", f"Promo code: {promo['code']}")
                return {"success": True, "reward_type": "ton", "amount": ton_amt}


# ─── GET /api/tasks ───────────────────────────────────────────────────────────

@app.get("/api/tasks")
async def get_tasks(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    cache_key = f"tasks:{user_id}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    pool = await get_pool()
    async with pool.acquire() as conn:
        tasks = await conn.fetch("""
            SELECT t.*,
                EXISTS(SELECT 1 FROM task_completions tc
                       WHERE tc.task_id = t.id AND tc.user_id = $1) AS completed
            FROM tasks t
            WHERE t.status = 'active'
              AND (t.completion_limit IS NULL OR t.completed_count < t.completion_limit)
            ORDER BY t.created_at DESC
        """, user_id)
        result = [dict(t) for t in tasks]
        cache_set(cache_key, result, ttl=config.CACHE_TTL_TASKS)
        return result


# ─── POST /api/claim-task ─────────────────────────────────────────────────────

@app.post("/api/claim-task")
async def claim_task(req: ClaimTaskRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    cache_del(f"tasks:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        task = await conn.fetchrow(
            "SELECT * FROM tasks WHERE id = $1 AND status = 'active'", req.task_id
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task not found or inactive")
        if task["type"] in ("channel", "group"):
            raise HTTPException(status_code=400, detail="Use verify-join for channel/group tasks")
        if task["completion_limit"] and task["completed_count"] >= task["completion_limit"]:
            raise HTTPException(status_code=400, detail="Task limit reached")
        existing = await conn.fetchrow(
            "SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2",
            req.task_id, user_id
        )
        if existing:
            raise HTTPException(status_code=400, detail="Task already completed")
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)", req.task_id, user_id
            )
            await conn.execute(
                "UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1", req.task_id
            )
            await add_coins(conn, user_id, task["reward_coins"], "task", f"Task: {task['name']}")
            await add_spins(conn, user_id, config.TASK_SPIN_BONUS)
            if task["completion_limit"]:
                await conn.execute(
                    "UPDATE tasks SET status = 'completed' WHERE id = $1 AND completed_count >= completion_limit",
                    req.task_id
                )
        updated = await get_user(conn, user_id)
        return {
            "success": True, "coins_earned": task["reward_coins"],
            "spins_earned": config.TASK_SPIN_BONUS, "new_balance": updated["coins"]
        }


# ─── POST /api/verify-join ────────────────────────────────────────────────────

@app.post("/api/verify-join")
async def verify_join(req: VerifyJoinRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    cache_del(f"tasks:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        task = await conn.fetchrow(
            "SELECT * FROM tasks WHERE id = $1 AND status = 'active'", req.task_id
        )
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if task["type"] not in ("channel", "group"):
            raise HTTPException(status_code=400, detail="Not a channel/group task")
        if task["completion_limit"] and task["completed_count"] >= task["completion_limit"]:
            raise HTTPException(status_code=400, detail="Task limit reached")
        existing = await conn.fetchrow(
            "SELECT id FROM task_completions WHERE task_id = $1 AND user_id = $2",
            req.task_id, user_id
        )
        if existing:
            raise HTTPException(status_code=400, detail="Task already completed")

        chat_id_raw = task["url"].split("t.me/")[-1].strip("/")
        if chat_id_raw.startswith("+"):
            is_member = True
        else:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    resp = await client.get(
                        f"https://api.telegram.org/bot{config.BOT_TOKEN}/getChatMember",
                        params={"chat_id": f"@{chat_id_raw}", "user_id": user_id}
                    )
                    data = resp.json()
                    is_member = data.get("ok") and data["result"]["status"] in (
                        "member", "administrator", "creator"
                    )
            except Exception as e:
                logger.error(f"getChatMember error: {e}")
                is_member = False

        if not is_member:
            raise HTTPException(status_code=400, detail="Not a member of the channel/group")

        async with conn.transaction():
            await conn.execute(
                "INSERT INTO task_completions (task_id, user_id) VALUES ($1, $2)", req.task_id, user_id
            )
            await conn.execute(
                "UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1", req.task_id
            )
            await add_coins(conn, user_id, task["reward_coins"], "task", f"Task: {task['name']}")
            await add_spins(conn, user_id, config.TASK_SPIN_BONUS)
            if task["completion_limit"]:
                await conn.execute(
                    "UPDATE tasks SET status = 'completed' WHERE id = $1 AND completed_count >= completion_limit",
                    req.task_id
                )
        updated = await get_user(conn, user_id)
        return {
            "success": True, "coins_earned": task["reward_coins"],
            "spins_earned": config.TASK_SPIN_BONUS, "new_balance": updated["coins"]
        }


# ─── POST /api/claim-daily-task ───────────────────────────────────────────────

@app.post("/api/claim-daily-task")
async def claim_daily_task(req: DailyTaskRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    if req.task_type not in ("checkin", "update", "share"):
        raise HTTPException(status_code=400, detail="Invalid task type")
    cache_del(f"user:{user_id}")
    cache_del(f"daily:{user_id}:{date.today()}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        today = date.today()
        existing = await conn.fetchrow(
            "SELECT id FROM daily_task_completions WHERE user_id = $1 AND task_type = $2 AND completed_date = $3",
            user_id, req.task_type, today
        )
        if existing:
            raise HTTPException(status_code=400, detail="Daily task already claimed today")
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO daily_task_completions (user_id, task_type, completed_date) VALUES ($1, $2, $3)",
                user_id, req.task_type, today
            )
            await add_coins(conn, user_id, config.DAILY_TASK_COIN_REWARD, "daily_task",
                            f"Daily task: {req.task_type}")
            await add_spins(conn, user_id, config.DAILY_TASK_SPIN_REWARD)
        updated = await get_user(conn, user_id)
        return {
            "success": True, "coins_earned": config.DAILY_TASK_COIN_REWARD,
            "spins_earned": config.DAILY_TASK_SPIN_REWARD, "new_balance": updated["coins"]
        }


# ─── GET /api/daily-task-status ───────────────────────────────────────────────

@app.get("/api/daily-task-status")
async def daily_task_status(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    cache_key = f"daily:{user_id}:{date.today()}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    pool = await get_pool()
    async with pool.acquire() as conn:
        today = date.today()
        rows = await conn.fetch(
            "SELECT task_type FROM daily_task_completions WHERE user_id = $1 AND completed_date = $2",
            user_id, today
        )
        result = {"completed": [r["task_type"] for r in rows]}
        cache_set(cache_key, result, ttl=config.CACHE_TTL_DAILY)
        return result


# ─── POST /api/watch-ad ───────────────────────────────────────────────────────

@app.post("/api/watch-ad")
async def watch_ad(req: WatchAdRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        await add_coins(conn, user_id, config.WATCH_AD_REWARD, "watch_ad",
                        f"Watched ad: {req.ad_id}")
        updated = await get_user(conn, user_id)
        return {
            "success": True, "coins_earned": config.WATCH_AD_REWARD,
            "new_balance": updated["coins"]
        }


# ─── GET /api/friends ─────────────────────────────────────────────────────────
# Full friends page data. All tracking is webapp-based (no bot dependency).
# Week = Sunday→Saturday. Leaderboard uses _sunday_week_id().

@app.get("/api/friends")
async def get_friends(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    cache_key = f"friends:{user_id}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        curr_week = _sunday_week_id()
        prev_week = _prev_sunday_week_id()

        (
            friends_rows,
            weekly_row,
            total_friends_count,
            lb_rows,
            prev_rows,
        ) = await asyncio.gather(
            # Last 10 friends with their earnings
            conn.fetch("""
                SELECT id, username, first_name, coins
                FROM users
                WHERE referrer_id = $1
                ORDER BY created_at DESC
                LIMIT 10
            """, user_id),
            # This week's referral count
            conn.fetchrow("""
                SELECT friend_count
                FROM weekly_referral_stats
                WHERE referrer_id = $1 AND week_id = $2
            """, user_id, curr_week),
            # Total all-time referral count
            conn.fetchval("""
                SELECT COUNT(*) FROM users WHERE referrer_id = $1
            """, user_id),
            # Current week leaderboard top 20
            conn.fetch("""
                SELECT w.referrer_id, u.first_name, u.username, w.friend_count
                FROM weekly_referral_stats w
                JOIN users u ON u.id = w.referrer_id
                WHERE w.week_id = $1
                ORDER BY w.friend_count DESC
                LIMIT 20
            """, curr_week),
            # Previous week leaderboard top 20
            conn.fetch("""
                SELECT w.referrer_id, u.first_name, u.username, w.friend_count
                FROM weekly_referral_stats w
                JOIN users u ON u.id = w.referrer_id
                WHERE w.week_id = $1
                ORDER BY w.friend_count DESC
                LIMIT 20
            """, prev_week),
        )

        weekly_friends = weekly_row["friend_count"] if weekly_row else 0

        # Build friends list (last 10)
        friend_list = [
            {
                "id": f["id"],
                "name": f["first_name"] or f["username"] or "Unknown",
                "coins": f["coins"],
                "your_share": int(f["coins"] * config.REFERRAL_COMMISSION),
            }
            for f in friends_rows
        ]

        def build_lb(rows):
            result = []
            for i, r in enumerate(rows):
                result.append({
                    "rank": i + 1,
                    "name": r["first_name"] or r["username"] or "Unknown",
                    "weekly_friends": r["friend_count"],
                    "is_me": r["referrer_id"] == user_id,
                })
            return result

        lb = build_lb(lb_rows)
        prev_lb = build_lb(prev_rows)

        # Append current user to leaderboard if not in top 20
        user_in_lb = any(x["is_me"] for x in lb)
        if not user_in_lb and weekly_row and weekly_row["friend_count"] > 0:
            user_rank = await conn.fetchval("""
                SELECT COUNT(*) + 1
                FROM weekly_referral_stats
                WHERE week_id = $1 AND friend_count > $2
            """, curr_week, weekly_row["friend_count"])
            lb.append({
                "rank": user_rank,
                "name": (user["first_name"] or "You"),
                "weekly_friends": weekly_row["friend_count"],
                "is_me": True,
            })

        # unclaimed = accumulated but not yet claimed referral commissions
        unclaimed = user["unclaimed_referral"] or 0
        total_earned = user["referral_earnings"] or 0

        mini_app_name = getattr(config, "MINI_APP_SHORT_NAME", "TRewards")
        referral_link = f"https://t.me/{config.BOT_USERNAME}/{mini_app_name}?startapp=ref_{user_id}"

        result = {
            "friends": friend_list,
            "total_friends": total_friends_count,
            "weekly_friends": weekly_friends,
            "total_earned": total_earned,
            "unclaimed": unclaimed,
            "referral_link": referral_link,
            "leaderboard": lb,
            "prev_leaderboard": prev_lb,
            "current_week": curr_week,
            "prev_week": prev_week,
        }
        cache_set(cache_key, result, ttl=config.CACHE_TTL_FRIENDS)
        return result


# ─── POST /api/claim-referral ─────────────────────────────────────────────────

@app.post("/api/claim-referral")
async def claim_referral(req: ClaimReferralRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    cache_del(f"friends:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        unclaimed = user["unclaimed_referral"] or 0
        if unclaimed <= 0:
            raise HTTPException(status_code=400, detail="No referral earnings to claim")
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET unclaimed_referral = 0, coins = coins + $1 WHERE id = $2",
                unclaimed, user_id
            )
            await conn.execute(
                "INSERT INTO transactions (user_id, type, description, amount) "
                "VALUES ($1,'referral','Referral commission claimed',$2)",
                user_id, unclaimed
            )
        return {"success": True, "claimed": unclaimed}


# ─── GET /api/transactions ────────────────────────────────────────────────────

@app.get("/api/transactions")
async def get_transactions(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]
    pool = await get_pool()
    async with pool.acquire() as conn:
        txns = await conn.fetch(
            "SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50",
            user_id
        )
        return [dict(t) for t in txns]


# ─── POST /api/withdraw ───────────────────────────────────────────────────────

@app.post("/api/withdraw")
async def withdraw(req: WithdrawRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    if req.tier_index < 0 or req.tier_index >= len(config.WITHDRAWAL_TIERS):
        raise HTTPException(status_code=400, detail="Invalid tier")
    tier = config.WITHDRAWAL_TIERS[req.tier_index]
    if not req.wallet_address or len(req.wallet_address) < 10:
        raise HTTPException(status_code=400, detail="Invalid wallet address")
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if user["coins"] < tier["coins"]:
            raise HTTPException(status_code=400, detail="Insufficient coins")
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET coins = coins - $1 WHERE id = $2", tier["coins"], user_id
            )
            wid = await conn.fetchval("""
                INSERT INTO withdrawals (user_id, coins_deducted, ton_amount, net_ton, fee_ton, wallet_address)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id
            """, user_id, tier["coins"], tier["ton"], tier["net"], tier.get("fee", 0), req.wallet_address)
            await conn.execute(
                "INSERT INTO transactions (user_id, type, description, amount) VALUES ($1,'withdrawal',$2,$3)",
                user_id, f"Withdrawal #{wid}: {tier['ton']} TON → {req.wallet_address[:8]}...", -tier["coins"]
            )
        return {
            "success": True, "withdrawal_id": wid, "coins_deducted": tier["coins"],
            "ton_amount": tier["ton"], "net_ton": tier["net"],
            "message": "Withdrawal queued. Processed within 24 hours."
        }


# ─── POST /api/convert ────────────────────────────────────────────────────────

@app.post("/api/convert")
async def convert_tr_to_ton(req: ConvertRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    if req.tr_amount < 1_000_000:
        raise HTTPException(status_code=400, detail="Minimum 1,000,000 TR")
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if user["coins"] < req.tr_amount:
            raise HTTPException(status_code=400, detail="Insufficient TR balance")
        ton_received = round((req.tr_amount / 1_000_000) * 0.15, 4)
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET coins = coins - $1, ton_balance = ton_balance + $2 WHERE id = $3",
                req.tr_amount, ton_received, user_id
            )
            await conn.execute(
                "INSERT INTO transactions (user_id, type, description, amount) VALUES ($1,'convert',$2,$3)",
                user_id, f"Converted {req.tr_amount:,} TR → {ton_received:.4f} TON", -req.tr_amount
            )
            await conn.execute(
                "INSERT INTO transactions (user_id, type, description, ton_amount) VALUES ($1,'convert',$2,$3)",
                user_id, f"Received {ton_received:.4f} TON from conversion", ton_received
            )
        updated = await get_user(conn, user_id)
        return {
            "success": True, "tr_spent": req.tr_amount, "ton_received": ton_received,
            "new_tr_balance": updated["coins"], "new_ton_balance": float(updated["ton_balance"])
        }


# ─── TON Check endpoints ──────────────────────────────────────────────────────
# Check links use the Mini App URL (not bot /start).
# Format: https://t.me/{BOT}/{APP}?startapp=chk_{check_id}

@app.post("/api/create-check")
async def create_check(req: CreateCheckRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    if req.amount < config.CHECK_MIN_AMOUNT:
        raise HTTPException(status_code=400, detail=f"Minimum {config.CHECK_MIN_AMOUNT} TON")
    if req.check_type not in ("personal", "multi"):
        raise HTTPException(status_code=400, detail="Invalid check type")

    recipients = 1 if req.check_type == "personal" else (req.recipients or 2)
    if req.check_type == "multi" and recipients < 2:
        raise HTTPException(status_code=400, detail="Multi check requires at least 2 recipients")

    cache_del(f"user:{user_id}")

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if float(user["ton_balance"]) < req.amount:
            raise HTTPException(status_code=400, detail="Insufficient TON balance")

        check_id = secrets.token_urlsafe(12)
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET ton_balance = ton_balance - $1 WHERE id = $2", req.amount, user_id
            )
            await conn.execute("""
                INSERT INTO ton_checks (id, creator_id, check_type, amount, recipients, status)
                VALUES ($1, $2, $3, $4, $5, 'active')
            """, check_id, user_id, req.check_type, req.amount, recipients)
            await conn.execute("""
                INSERT INTO transactions (user_id, type, description, ton_amount)
                VALUES ($1, 'check_create', $2, $3)
            """, user_id, f"Created {req.check_type} check: {req.amount} TON", -req.amount)

        updated = await get_user(conn, user_id)
        mini_app_name = getattr(config, "MINI_APP_SHORT_NAME", "TRewards")
        link = f"https://t.me/{config.BOT_USERNAME}/{mini_app_name}?startapp=chk_{check_id}"
        return {
            "success": True,
            "check_id": check_id,
            "link": link,
            "amount": req.amount,
            "check_type": req.check_type,
            "recipients": recipients,
            "new_ton_balance": float(updated["ton_balance"]),
        }


@app.get("/api/check/{check_id}")
async def get_check(check_id: str, init_data: str):
    """Get check details for the claim overlay."""
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        check = await conn.fetchrow("SELECT * FROM ton_checks WHERE id = $1", check_id)
        if not check:
            raise HTTPException(status_code=404, detail="Check not found")
        if check["status"] != "active":
            raise HTTPException(status_code=400, detail="This check has already been fully claimed")
        if check["creator_id"] == user_id:
            raise HTTPException(status_code=400, detail="You cannot claim your own check")
        if check["claimed_count"] >= check["recipients"]:
            raise HTTPException(status_code=400, detail="This check has been fully claimed")

        existing = await conn.fetchrow(
            "SELECT id FROM check_claims WHERE check_id = $1 AND claimer_id = $2", check_id, user_id
        )
        if existing:
            raise HTTPException(status_code=400, detail="You have already claimed this check")

        creator = await conn.fetchrow(
            "SELECT first_name, username FROM users WHERE id = $1", check["creator_id"]
        )
        creator_name = (creator["first_name"] or creator["username"] or "Unknown") if creator else "Unknown"

        amount_per_person = float(check["amount"]) / check["recipients"]
        return {
            "check_id": check_id,
            "check_type": check["check_type"],
            "amount": float(check["amount"]),
            "amount_per_person": round(amount_per_person, 4),
            "recipients": check["recipients"],
            "claimed_count": check["claimed_count"],
            "creator_name": creator_name,
            "creator_id": check["creator_id"],
        }


@app.post("/api/claim-check")
async def claim_check(req: ClaimCheckRequest):
    """
    Claim a TON check (webapp-based flow, no bot dependency).
    - TON credited to claimer's ton_balance immediately.
    - If claimer has no referrer → check creator becomes their referrer.
    - Weekly referral stats updated if new referral link is formed.
    """
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Lock check row
        check = await conn.fetchrow(
            "SELECT * FROM ton_checks WHERE id = $1 FOR UPDATE", req.check_id
        )
        if not check:
            raise HTTPException(status_code=404, detail="Check not found")
        if check["status"] != "active":
            raise HTTPException(status_code=400, detail="This check is no longer active")
        if check["creator_id"] == user_id:
            raise HTTPException(status_code=400, detail="You cannot claim your own check")
        if check["claimed_count"] >= check["recipients"]:
            raise HTTPException(status_code=400, detail="This check has been fully claimed")

        existing = await conn.fetchrow(
            "SELECT id FROM check_claims WHERE check_id = $1 AND claimer_id = $2",
            req.check_id, user_id
        )
        if existing:
            raise HTTPException(status_code=400, detail="You have already claimed this check")

        amount_per_person = round(float(check["amount"]) / check["recipients"], 8)
        new_claimed_count = check["claimed_count"] + 1
        fully_claimed = new_claimed_count >= check["recipients"]

        async with conn.transaction():
            # Credit TON to claimer
            await conn.execute(
                "UPDATE users SET ton_balance = ton_balance + $1 WHERE id = $2",
                amount_per_person, user_id
            )
            # Record the claim
            await conn.execute(
                "INSERT INTO check_claims (check_id, claimer_id, amount) VALUES ($1, $2, $3)",
                req.check_id, user_id, amount_per_person
            )
            # Update check status
            await conn.execute("""
                UPDATE ton_checks
                SET claimed_count = $1,
                    status = $2
                WHERE id = $3
            """, new_claimed_count, "claimed" if fully_claimed else "active", req.check_id)
            # Transaction record
            await conn.execute("""
                INSERT INTO transactions (user_id, type, description, ton_amount)
                VALUES ($1, 'check_claim', $2, $3)
            """, user_id, f"Claimed TON check from user {check['creator_id']}", amount_per_person)

            # Auto-referral: if claimer has no referrer, creator becomes referrer
            claimer = await conn.fetchrow(
                "SELECT referrer_id FROM users WHERE id = $1", user_id
            )
            referral_set = False
            if claimer and claimer["referrer_id"] is None and check["creator_id"] != user_id:
                result = await conn.execute(
                    "UPDATE users SET referrer_id = $1 WHERE id = $2 AND referrer_id IS NULL",
                    check["creator_id"], user_id
                )
                if result == "UPDATE 1":
                    referral_set = True
                    week_id = _sunday_week_id()
                    await conn.execute("""
                        INSERT INTO weekly_referral_stats (referrer_id, week_id, friend_count)
                        VALUES ($1, $2, 1)
                        ON CONFLICT (referrer_id, week_id)
                        DO UPDATE SET
                            friend_count = weekly_referral_stats.friend_count + 1,
                            updated_at = NOW()
                    """, check["creator_id"], week_id)
                    cache_del(f"friends:{check['creator_id']}")

        updated = await get_user(conn, user_id)
        return {
            "success": True,
            "amount_received": amount_per_person,
            "new_ton_balance": float(updated["ton_balance"]),
            "referral_set": referral_set,
            "creator_id": check["creator_id"],
        }


@app.get("/api/checks")
async def get_checks(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]

    pool = await get_pool()
    async with pool.acquire() as conn:
        mini_app_name = getattr(config, "MINI_APP_SHORT_NAME", "TRewards")
        my_checks, received = await asyncio.gather(
            conn.fetch("""
                SELECT
                    c.id,
                    c.check_type,
                    c.amount,
                    c.recipients,
                    c.claimed_count,
                    c.status,
                    c.created_at,
                    concat(
                        'https://t.me/', $2::text, '/', $3::text,
                        '?startapp=chk_', c.id
                    ) AS link
                FROM ton_checks c
                WHERE c.creator_id = $1
                ORDER BY c.created_at DESC
                LIMIT 10
            """, user_id, config.BOT_USERNAME, mini_app_name),
            conn.fetch("""
                SELECT
                    c.id,
                    c.check_type,
                    c.amount,
                    c.recipients,
                    c.claimed_count,
                    ROUND(c.amount / c.recipients, 4) AS amount_per_person,
                    u.first_name AS creator_name
                FROM ton_checks c
                JOIN users u ON u.id = c.creator_id
                WHERE c.status = 'active'
                  AND c.creator_id != $1
                  AND c.claimed_count < c.recipients
                  AND NOT EXISTS (
                      SELECT 1 FROM check_claims cc
                      WHERE cc.check_id = c.id AND cc.claimer_id = $1
                  )
                ORDER BY c.created_at DESC
                LIMIT 10
            """, user_id),
        )

        return {
            "my_checks": [dict(c) for c in my_checks],
            "received_checks": [dict(c) for c in received],
        }


# ─── Stars invoice creation ───────────────────────────────────────────────────

@app.post("/api/create-stars-invoice")
async def create_stars_invoice(req: StarsInvoiceRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    if req.stars_amount < config.MIN_TOPUP_STARS:
        raise HTTPException(status_code=400, detail=f"Minimum {config.MIN_TOPUP_STARS} Stars")

    ton_amount = round(req.stars_amount / config.STARS_PER_TON, 4)

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"https://api.telegram.org/bot{config.BOT_TOKEN}/createInvoiceLink",
            json={
                "title": "TRewards TON Top-Up",
                "description": f"Top up {ton_amount} TON to your TRewards balance.",
                "payload": json.dumps({"type": "stars_topup", "user_id": user_id, "stars": req.stars_amount}),
                "currency": "XTR",
                "prices": [{"label": f"{ton_amount} TON ({req.stars_amount} Stars)", "amount": req.stars_amount}],
            }
        )
        data = resp.json()

    if not data.get("ok"):
        raise HTTPException(status_code=500, detail=f"Telegram API error: {data.get('description', 'Unknown')}")

    return {
        "invoice_link": data["result"],
        "stars_amount": req.stars_amount,
        "ton_amount": ton_amount,
    }


# ─── POST /api/topup-stars ────────────────────────────────────────────────────

@app.post("/api/topup-stars")
async def topup_stars(req: StarsTopUpRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    if req.stars_amount < config.MIN_TOPUP_STARS:
        raise HTTPException(status_code=400, detail=f"Minimum {config.MIN_TOPUP_STARS} stars")
    ton_to_credit = round(req.stars_amount / config.STARS_PER_TON, 4)
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM stars_payments WHERE telegram_charge_id = $1",
            req.telegram_charge_id
        )
        if existing:
            return {"success": True, "already_credited": True}
        async with conn.transaction():
            await conn.execute("""
                INSERT INTO stars_payments (user_id, telegram_charge_id, stars_amount, ton_credited)
                VALUES ($1, $2, $3, $4)
            """, user_id, req.telegram_charge_id, req.stars_amount, ton_to_credit)
            await add_ton(conn, user_id, ton_to_credit, "topup_stars",
                          f"Stars top-up: {req.stars_amount} ⭐")
        updated = await get_user(conn, user_id)
        return {
            "success": True, "ton_credited": ton_to_credit,
            "new_ton_balance": float(updated["ton_balance"])
        }


# ─── POST /api/connect-wallet ─────────────────────────────────────────────────

@app.post("/api/connect-wallet")
async def connect_wallet(req: ConnectWalletRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    addr = req.wallet_address.strip()
    if not addr or len(addr) < 10:
        raise HTTPException(status_code=400, detail="Invalid wallet address")
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET ton_wallet_address = $1 WHERE id = $2", addr, user_id
        )
        return {"success": True, "wallet_address": addr}


@app.post("/api/disconnect-wallet")
async def disconnect_wallet(req: DisconnectWalletRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("UPDATE users SET ton_wallet_address = NULL WHERE id = $1", user_id)
        return {"success": True}


# ─── POST /api/create-topup ───────────────────────────────────────────────────

@app.post("/api/create-topup")
async def create_topup(req: TopUpRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]

    if req.method == "ton_wallet":
        if req.amount < config.MIN_TOPUP_TON:
            raise HTTPException(status_code=400, detail=f"Minimum top-up is {config.MIN_TOPUP_TON} TON")
        pool = await get_pool()
        async with pool.acquire() as conn:
            user = await get_user(conn, user_id)
            if not user:
                raise HTTPException(status_code=404, detail="User not found")
            comment_id = user["ton_comment_id"]
            await conn.execute("""
                INSERT INTO ton_topup_requests (user_id, comment_id, amount_ton, status)
                VALUES ($1, $2, $3, 'pending')
                ON CONFLICT (comment_id) DO NOTHING
            """, user_id, comment_id, req.amount)
            return {
                "method": "ton_wallet",
                "receiving_address": config.TON_WALLET_RECEIVE,
                "comment_id": comment_id,
                "amount": req.amount,
            }

    elif req.method == "stars":
        stars_needed = max(config.MIN_TOPUP_STARS, int(req.amount * config.STARS_PER_TON))
        return {
            "method": "stars",
            "stars_amount": stars_needed,
            "ton_equivalent": round(stars_needed / config.STARS_PER_TON, 4)
        }

    else:
        raise HTTPException(status_code=400, detail="Invalid payment method")


# ─── POST /payment-webhook/ton-topup ─────────────────────────────────────────

@app.post("/payment-webhook/ton-topup")
async def ton_topup_webhook(request: Request):
    secret = request.headers.get("X-Webhook-Secret", "")
    if config.TONAPI_WEBHOOK_SECRET and secret != config.TONAPI_WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="Invalid webhook secret")

    body = await request.json()
    comment_id = str(body.get("comment_id", "")).strip()
    amount_ton  = float(body.get("amount_ton", 0))
    tx_hash     = str(body.get("tx_hash", ""))

    if not comment_id or amount_ton < config.MIN_TOPUP_TON:
        return {"ok": True, "skipped": True}

    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await conn.fetchrow(
            "SELECT id FROM users WHERE ton_comment_id = $1", comment_id
        )
        if not user:
            return {"ok": True, "skipped": True}

        existing = await conn.fetchrow(
            "SELECT id FROM ton_topup_requests WHERE comment_id = $1 AND status = 'credited'",
            comment_id
        )
        if existing:
            return {"ok": True, "already_credited": True}

        user_id = user["id"]
        async with conn.transaction():
            await conn.execute("""
                INSERT INTO ton_topup_requests (user_id, comment_id, amount_ton, status, tx_hash, credited_at)
                VALUES ($1, $2, $3, 'credited', $4, NOW())
                ON CONFLICT (comment_id) DO UPDATE
                SET amount_ton = $3, status = 'credited', tx_hash = $4, credited_at = NOW()
            """, user_id, comment_id, amount_ton, tx_hash)
            await add_ton(conn, user_id, amount_ton, "topup_ton_wallet",
                          f"TON wallet top-up: {amount_ton} TON")

        cache_del(f"user:{user_id}")
        return {"ok": True, "user_id": user_id, "amount_credited": amount_ton}


# ─── GET /api/advertiser ──────────────────────────────────────────────────────

@app.get("/api/advertiser")
async def get_advertiser(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    user_id = tg_user["id"]
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        tasks = await conn.fetch(
            "SELECT * FROM tasks WHERE advertiser_id = $1 ORDER BY created_at DESC", user_id
        )
        return {"ad_balance": float(user["ton_balance"]), "tasks": [dict(t) for t in tasks]}


# ─── POST /api/create-task ────────────────────────────────────────────────────

@app.post("/api/create-task")
async def create_task(req: CreateTaskRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    if req.task_type not in ("visit", "channel", "group", "game", "daily"):
        raise HTTPException(status_code=400, detail="Invalid task type")
    if req.task_type == "daily":
        days = req.days_limit or 0
        if days < 1:
            raise HTTPException(status_code=400, detail="days_limit required for daily tasks")
        cost = days * config.DAILY_TASK_COST_PER_DAY
        completion_limit = None
    else:
        if req.completion_limit not in (500, 1000, 2000, 5000, 10000):
            raise HTTPException(status_code=400, detail="Invalid completion limit")
        cost = req.completion_limit * config.AD_COST_PER_COMPLETION
        completion_limit = req.completion_limit
        days = None
    reward_map = {
        "visit": config.TASK_REWARD_VISIT, "channel": config.TASK_REWARD_CHANNEL,
        "group": config.TASK_REWARD_GROUP, "game": config.TASK_REWARD_GAME,
        "daily": config.TASK_REWARD_VISIT
    }
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        user = await get_user(conn, user_id)
        if float(user["ton_balance"]) < cost:
            raise HTTPException(status_code=400, detail=f"Insufficient TON balance. Need {cost:.3f} TON")
        async with conn.transaction():
            await conn.execute(
                "UPDATE users SET ton_balance = ton_balance - $1 WHERE id = $2", cost, user_id
            )
            task_id = await conn.fetchval("""
                INSERT INTO tasks (advertiser_id, name, type, url, reward_coins,
                                   completion_limit, days_limit, cost_ton)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
            """, user_id, req.name, req.task_type, req.url,
                reward_map[req.task_type], completion_limit, days, cost)
        return {"success": True, "task_id": task_id, "cost": cost}


# ─── POST /api/set-language ───────────────────────────────────────────────────

@app.post("/api/set-language")
async def set_language(req: LanguageRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    user_id = tg_user["id"]
    if req.language not in ("en", "ru"):
        raise HTTPException(status_code=400, detail="Invalid language")
    cache_del(f"user:{user_id}")
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("UPDATE users SET language = $1 WHERE id = $2", req.language, user_id)
    return {"success": True}


# ─── Admin endpoints ──────────────────────────────────────────────────────────

@app.post("/api/admin/create-promo")
async def admin_create_promo(req: AdminPromoCreate):
    tg_user = verify_telegram_init_data(req.init_data)
    require_admin(tg_user["id"])
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            promo_id = await conn.fetchval("""
                INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by)
                VALUES ($1,$2,$3,$4,$5) RETURNING id
            """, req.code.upper(), req.reward_type, req.reward_amount,
                req.max_activations, tg_user["id"])
            return {"success": True, "promo_id": promo_id}
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))


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
        await conn.execute("UPDATE promo_codes SET is_active = FALSE WHERE id = $1", promo_id)
        return {"success": True}


@app.get("/api/admin/stats")
async def admin_stats(init_data: str):
    tg_user = verify_telegram_init_data(init_data)
    require_admin(tg_user["id"])
    pool = await get_pool()
    async with pool.acquire() as conn:
        total_users, total_payments, pending_withdrawals = await asyncio.gather(
            conn.fetchval("SELECT COUNT(*) FROM users"),
            conn.fetchval("SELECT COALESCE(SUM(amount_ton),0) FROM payments WHERE status='paid'"),
            conn.fetchval("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
        )
        return {
            "total_users": total_users,
            "total_payments_ton": float(total_payments),
            "pending_withdrawals": pending_withdrawals
        }


@app.post("/api/admin/broadcast")
async def admin_broadcast(req: BroadcastRequest):
    tg_user = verify_telegram_init_data(req.init_data)
    require_admin(tg_user["id"])
    if not req.message or not req.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT id FROM users ORDER BY id")
    user_ids = [r["id"] for r in rows]
    if not user_ids:
        return {"success": True, "total_users": 0}
    reply_markup = None
    if req.button_text and req.button_url:
        reply_markup = json.dumps(
            {"inline_keyboard": [[{"text": req.button_text, "url": req.button_url}]]}
        )
    asyncio.create_task(
        _broadcast_task(user_ids, req.message, req.parse_mode, reply_markup)
    )
    return {"success": True, "total_users": len(user_ids), "task": "running"}


async def _broadcast_task(user_ids, message, parse_mode, reply_markup):
    sent = 0; failed = 0
    async with httpx.AsyncClient(timeout=10) as client:
        for i in range(0, len(user_ids), config.BROADCAST_BATCH_SIZE):
            batch = user_ids[i:i + config.BROADCAST_BATCH_SIZE]
            results = await asyncio.gather(
                *[_send_one(client, uid, message, parse_mode, reply_markup) for uid in batch],
                return_exceptions=True
            )
            for r in results:
                if isinstance(r, Exception) or r is False:
                    failed += 1
                else:
                    sent += 1
            if i + config.BROADCAST_BATCH_SIZE < len(user_ids):
                await asyncio.sleep(config.BROADCAST_BATCH_DELAY)
    logger.info(f"Broadcast done: sent={sent}, failed={failed}")


async def _send_one(client, user_id, text, parse_mode, reply_markup):
    payload = {"chat_id": user_id, "text": text}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    if reply_markup:
        payload["reply_markup"] = reply_markup
    try:
        resp = await client.post(
            f"https://api.telegram.org/bot{config.BOT_TOKEN}/sendMessage", json=payload
        )
        return resp.json().get("ok", False)
    except Exception:
        return False


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)