import os
import random
import threading
import time
import json
import hmac
import hashlib
import logging
from datetime import date, datetime, timezone
from typing import Optional

import psycopg2
import psycopg2.extras
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("trewards")

# ─── CONFIG ────────────────────────────────────────────────────────────────────

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
DATABASE_URL = os.environ.get("DATABASE_URL", "")
ADMIN_IDS = [int(x.strip()) for x in os.environ.get("ADMIN_IDS", "").split(",") if x.strip()]
WEBAPP_URL = os.environ.get("WEBAPP_URL", "")
BACKEND_URL = os.environ.get("BACKEND_URL", "")
WITHDRAWAL_CHANNEL_ID = os.environ.get("WITHDRAWAL_CHANNEL_ID", "")
XROCKET_API_KEY = os.environ.get("XROCKET_API_KEY", "")
CRYPTOPAY_API_KEY = os.environ.get("CRYPTOPAY_API_KEY", "")
BOT_USERNAME = os.environ.get("BOT_USERNAME", "trewards_ton_bot")

# ─── DB ────────────────────────────────────────────────────────────────────────

def get_db_url():
    url = DATABASE_URL
    # Strip ?ssl= suffix
    if "?" in url:
        url = url.split("?")[0]
    return url

def get_conn():
    url = get_db_url()
    # Parse postgresql://user:pass@host:port/db
    return psycopg2.connect(url, sslmode="require", connect_timeout=10)

def db_exec(sql, params=None, fetch=None):
    conn = None
    cur = None
    try:
        conn = get_conn()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(sql, params)
        result = None
        if fetch == "one":
            result = cur.fetchone()
        elif fetch == "all":
            result = cur.fetchall()
        conn.commit()
        return result
    except Exception as e:
        logger.error(f"DB error: {e}")
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        raise
    finally:
        if cur:
            cur.close()
        if conn:
            conn.close()

def db_fetch(sql, params=None):
    return db_exec(sql, params, fetch="all")

def db_fetchone(sql, params=None):
    return db_exec(sql, params, fetch="one")

# ─── SCHEMA INIT ───────────────────────────────────────────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT PRIMARY KEY,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    username VARCHAR(255),
    balance BIGINT DEFAULT 0,
    spins INTEGER DEFAULT 3,
    streak INTEGER DEFAULT 0,
    last_streak_date DATE,
    referrer_id BIGINT DEFAULT NULL,
    ad_balance NUMERIC(18,6) DEFAULT 0,
    ton_balance NUMERIC(18,6) DEFAULT 0,
    daily_tasks_completed JSONB DEFAULT '[]',
    daily_tasks_reset_date DATE,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id SERIAL PRIMARY KEY,
    user_id BIGINT,
    task_name VARCHAR(500),
    task_type VARCHAR(50),
    target_url TEXT,
    max_completions INTEGER DEFAULT 500,
    completed_count INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'active',
    cost_ton NUMERIC(18,6) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_completions (
    id SERIAL PRIMARY KEY,
    task_id INTEGER,
    user_id BIGINT,
    completed_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(task_id, user_id)
);

CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(255) UNIQUE,
    reward_type VARCHAR(50),
    reward_amount NUMERIC(18,6),
    max_activations INTEGER DEFAULT 100,
    activations INTEGER DEFAULT 0,
    created_by BIGINT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_activations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(255),
    user_id BIGINT,
    activated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(code, user_id)
);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    provider VARCHAR(50),
    invoice_id VARCHAR(500),
    amount_ton NUMERIC(18,6),
    target VARCHAR(50) DEFAULT 'wallet',
    status VARCHAR(50) DEFAULT 'pending',
    credited BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    tr_amount BIGINT,
    gross_ton NUMERIC(18,6),
    fee_ton NUMERIC(18,6),
    net_ton NUMERIC(18,6),
    status VARCHAR(50) DEFAULT 'pending',
    tx_type VARCHAR(50) DEFAULT 'withdraw',
    message_id BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spin_history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    reward INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    tx_type VARCHAR(100),
    amount BIGINT,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_earnings (
    id SERIAL PRIMARY KEY,
    referrer_id BIGINT,
    earner_id BIGINT,
    amount BIGINT,
    claimed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);
"""

def init_schema():
    try:
        for stmt in SCHEMA_SQL.strip().split(";"):
            stmt = stmt.strip()
            if not stmt:
                continue
            try:
                db_exec(stmt + ";")
            except Exception as e:
                logger.warning(f"Schema stmt skipped: {e}")
        logger.info("Schema initialized")
    except Exception as e:
        logger.error(f"Schema init error: {e}")


# ─── HELPERS ───────────────────────────────────────────────────────────────────

def get_user(user_id: int):
    return db_fetchone("SELECT * FROM users WHERE user_id = %s", (user_id,))

def user_response(user_id: int):
    u = get_user(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(u)

def log_tx(user_id: int, tx_type: str, amount: int, description: str):
    db_exec(
        "INSERT INTO transactions (user_id, tx_type, amount, description) VALUES (%s, %s, %s, %s)",
        (user_id, tx_type, amount, description)
    )

def add_referral_commission(earner_id: int, amount: int):
    """Add 30% commission to referrer's pending earnings"""
    try:
        u = db_fetchone("SELECT referrer_id FROM users WHERE user_id = %s", (earner_id,))
        if u and u["referrer_id"]:
            commission = int(amount * 0.30)
            if commission > 0:
                db_exec(
                    "INSERT INTO referral_earnings (referrer_id, earner_id, amount, claimed) VALUES (%s, %s, %s, false)",
                    (u["referrer_id"], earner_id, commission)
                )
    except Exception as e:
        logger.error(f"Referral commission error: {e}")

def send_bot_message(chat_id, text, reply_markup=None, parse_mode="HTML"):
    if not BOT_TOKEN:
        return None
    payload = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    if reply_markup:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json=payload, timeout=10
        )
        return r.json()
    except Exception as e:
        logger.error(f"Bot send error: {e}")
        return None

def edit_bot_message(chat_id, message_id, text, reply_markup=None, parse_mode="HTML"):
    if not BOT_TOKEN:
        return None
    payload = {"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": parse_mode}
    if reply_markup is not None:
        payload["reply_markup"] = json.dumps(reply_markup)
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/editMessageText",
            json=payload, timeout=10
        )
        return r.json()
    except Exception as e:
        logger.error(f"Bot edit error: {e}")
        return None

def edit_message_reply_markup(chat_id, message_id, reply_markup):
    if not BOT_TOKEN:
        return None
    payload = {"chat_id": chat_id, "message_id": message_id, "reply_markup": json.dumps(reply_markup)}
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/editMessageReplyMarkup",
            json=payload, timeout=10
        )
        return r.json()
    except Exception as e:
        logger.error(f"Bot edit markup error: {e}")
        return None

# ─── BOT ───────────────────────────────────────────────────────────────────────

# Admin wizard state: {chat_id: {step, data}}
admin_wizard = {}

def bot_get_updates(offset=0):
    try:
        r = requests.get(
            f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates",
            params={"timeout": 30, "offset": offset},
            timeout=40
        )
        return r.json().get("result", [])
    except Exception as e:
        logger.error(f"getUpdates error: {e}")
        return []

def bot_answer_callback(callback_query_id, text=""):
    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/answerCallbackQuery",
            json={"callback_query_id": callback_query_id, "text": text},
            timeout=5
        )
    except Exception:
        pass

def handle_start(message):
    chat_id = message["chat"]["id"]
    from_user = message.get("from", {})
    user_id = from_user.get("id", chat_id)
    first_name = from_user.get("first_name", "")
    last_name = from_user.get("last_name", "")
    username = from_user.get("username", "")

    # Register user
    try:
        u = get_user(user_id)
        if not u:
            db_exec(
                "INSERT INTO users (user_id, first_name, last_name, username, balance, spins) VALUES (%s, %s, %s, %s, 100, 3) ON CONFLICT DO NOTHING",
                (user_id, first_name, last_name, username)
            )
            log_tx(user_id, "earn", 100, "Welcome bonus")
        else:
            db_exec(
                "UPDATE users SET first_name=%s, last_name=%s, username=%s, updated_at=NOW() WHERE user_id=%s",
                (first_name, last_name, username, user_id)
            )
    except Exception as e:
        logger.error(f"Start register error: {e}")

    # Handle referral
    parts = message.get("text", "").split()
    if len(parts) > 1:
        try:
            ref_id = int(parts[1])
            if ref_id != user_id:
                existing = db_fetchone("SELECT referrer_id FROM users WHERE user_id=%s", (user_id,))
                if existing and not existing["referrer_id"]:
                    db_exec("UPDATE users SET referrer_id=%s WHERE user_id=%s", (ref_id, user_id))
        except Exception:
            pass

    keyboard = {
        "inline_keyboard": [
            [{"text": "🚀 Open TRewards", "web_app": {"url": WEBAPP_URL}}],
            [{"text": "📢 TRewards Channel", "url": "https://t.me/trewards_ton"}]
        ]
    }
    welcome = (
        f"👋 <b>Welcome to TRewards, {first_name}!</b>\n\n"
        "🏆 Earn TR coins by completing tasks, spinning the wheel, and referring friends.\n"
        "💸 Withdraw your earnings as <b>TON cryptocurrency</b>.\n\n"
        "🎁 <b>Welcome bonus:</b> 100 TR + 3 Spins\n\n"
        "Tap the button below to start earning!"
    )
    send_bot_message(chat_id, welcome, reply_markup=keyboard)

def handle_admin_command(message):
    chat_id = message["chat"]["id"]
    user_id = message["from"]["id"]
    if user_id not in ADMIN_IDS:
        send_bot_message(chat_id, "❌ Unauthorized")
        return
    keyboard = {
        "inline_keyboard": [
            [{"text": "🎁 Create Promo", "callback_data": "admin_create_promo"},
             {"text": "📋 List Promos", "callback_data": "admin_list_promos"}],
            [{"text": "🗑 Delete Promo", "callback_data": "admin_delete_promo"},
             {"text": "📈 History", "callback_data": "admin_promo_history"}],
            [{"text": "💸 Payments", "callback_data": "admin_payments"},
             {"text": "👥 Stats", "callback_data": "admin_stats"}]
        ]
    }
    send_bot_message(chat_id, "🛡 <b>Admin Panel</b>", reply_markup=keyboard)

def handle_callback(callback_query):
    cq_id = callback_query["id"]
    data = callback_query.get("data", "")
    from_user = callback_query.get("from", {})
    user_id = from_user.get("id")
    chat_id = callback_query.get("message", {}).get("chat", {}).get("id")
    message_id = callback_query.get("message", {}).get("message_id")

    bot_answer_callback(cq_id)

    # Withdrawal actions
    if data.startswith("wd_approve_"):
        wd_id = int(data.split("_")[2])
        if user_id not in ADMIN_IDS:
            return
        db_exec("UPDATE withdrawals SET status='approved', updated_at=NOW() WHERE id=%s", (wd_id,))
        wd = db_fetchone("SELECT * FROM withdrawals WHERE id=%s", (wd_id,))
        if wd:
            # Remove approve, keep decline + complete
            new_kb = {"inline_keyboard": [[
                {"text": "❌ Decline", "callback_data": f"wd_decline_{wd_id}"},
                {"text": "💸 Complete", "callback_data": f"wd_complete_{wd_id}"}
            ]]}
            edit_message_reply_markup(chat_id, message_id, new_kb)
        return

    if data.startswith("wd_decline_"):
        wd_id = int(data.split("_")[2])
        if user_id not in ADMIN_IDS:
            return
        wd = db_fetchone("SELECT * FROM withdrawals WHERE id=%s", (wd_id,))
        if wd and wd["status"] not in ("declined",):
            db_exec("UPDATE withdrawals SET status='declined', updated_at=NOW() WHERE id=%s", (wd_id,))
            # Refund TR
            db_exec("UPDATE users SET balance=balance+%s WHERE user_id=%s", (wd["tr_amount"], wd["user_id"]))
            log_tx(wd["user_id"], "earn", wd["tr_amount"], "Withdrawal declined - refunded")
            send_bot_message(wd["user_id"], "❌ Your withdrawal request was declined. Your TR coins have been refunded.")
            edit_message_reply_markup(chat_id, message_id, {"inline_keyboard": []})
        return

    if data.startswith("wd_complete_"):
        wd_id = int(data.split("_")[2])
        if user_id not in ADMIN_IDS:
            return
        wd = db_fetchone("SELECT * FROM withdrawals WHERE id=%s", (wd_id,))
        if wd:
            db_exec("UPDATE withdrawals SET status='completed', updated_at=NOW() WHERE id=%s", (wd_id,))
            send_bot_message(wd["user_id"], "✅ <b>Payment Sent!</b>\n\nPlease check your wallet. Your TON has been transferred.")
            edit_message_reply_markup(chat_id, message_id, {"inline_keyboard": []})
        return

    # Admin panel callbacks
    if user_id not in ADMIN_IDS:
        return

    if data == "admin_create_promo":
        admin_wizard[chat_id] = {"step": "code", "data": {}}
        send_bot_message(chat_id, "🎁 <b>Create Promo Code</b>\n\nStep 1/4: Enter the promo code name:")
        return

    if data == "admin_list_promos":
        promos = db_fetch("SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20")
        if not promos:
            send_bot_message(chat_id, "No promo codes found.")
            return
        text = "📋 <b>Promo Codes:</b>\n\n"
        for p in promos:
            text += f"• <code>{p['code']}</code> — {p['reward_type']} {p['reward_amount']} ({p['activations']}/{p['max_activations']})\n"
        send_bot_message(chat_id, text)
        return

    if data == "admin_delete_promo":
        send_bot_message(chat_id, "🗑 Send the promo code to delete:")
        admin_wizard[chat_id] = {"step": "delete_promo", "data": {}}
        return

    if data == "admin_promo_history":
        acts = db_fetch("SELECT pa.*, u.first_name FROM promo_activations pa LEFT JOIN users u ON pa.user_id=u.user_id ORDER BY pa.activated_at DESC LIMIT 20")
        if not acts:
            send_bot_message(chat_id, "No activations yet.")
            return
        text = "📈 <b>Recent Activations:</b>\n\n"
        for a in acts:
            text += f"• {a['first_name'] or a['user_id']} used <code>{a['code']}</code>\n"
        send_bot_message(chat_id, text)
        return

    if data == "admin_payments":
        pays = db_fetch("SELECT * FROM payments ORDER BY created_at DESC LIMIT 20")
        if not pays:
            send_bot_message(chat_id, "No payments yet.")
            return
        text = "💸 <b>Recent Payments:</b>\n\n"
        for p in pays:
            text += f"• {p['user_id']} — {p['amount_ton']} TON via {p['provider']} [{p['status']}]\n"
        send_bot_message(chat_id, text)
        return

    if data == "admin_stats":
        try:
            users_count = db_fetchone("SELECT COUNT(*) as c FROM users")
            total_balance = db_fetchone("SELECT SUM(balance) as s FROM users")
            total_tasks = db_fetchone("SELECT COUNT(*) as c FROM tasks")
            total_tx = db_fetchone("SELECT COUNT(*) as c FROM transactions")
            text = (
                f"📊 <b>Stats:</b>\n\n"
                f"👥 Total Users: {users_count['c']}\n"
                f"💰 Total TR in circulation: {total_balance['s'] or 0}\n"
                f"📋 Total Tasks: {total_tasks['c']}\n"
                f"📈 Total Transactions: {total_tx['c']}\n"
            )
            send_bot_message(chat_id, text)
        except Exception as e:
            send_bot_message(chat_id, f"Error: {e}")
        return

    if data in ("reward_tr", "reward_ton"):
        if chat_id in admin_wizard and admin_wizard[chat_id].get("step") == "reward_type":
            admin_wizard[chat_id]["data"]["reward_type"] = "tr" if data == "reward_tr" else "ton"
            admin_wizard[chat_id]["step"] = "reward_amount"
            send_bot_message(chat_id, "Step 3/4: Enter the reward amount:")
        return

def handle_wizard_message(chat_id, user_id, text):
    if chat_id not in admin_wizard:
        return False
    wizard = admin_wizard[chat_id]
    step = wizard["step"]

    if step == "code":
        wizard["data"]["code"] = text.strip().upper()
        wizard["step"] = "reward_type"
        kb = {"inline_keyboard": [[
            {"text": "🏆 TR Coins", "callback_data": "reward_tr"},
            {"text": "💎 TON", "callback_data": "reward_ton"}
        ]]}
        send_bot_message(chat_id, "Step 2/4: Select reward type:", reply_markup=kb)
        return True

    if step == "reward_amount":
        try:
            wizard["data"]["reward_amount"] = float(text.strip())
            wizard["step"] = "max_activations"
            send_bot_message(chat_id, "Step 4/4: Enter max activations (e.g. 100):")
        except ValueError:
            send_bot_message(chat_id, "❌ Invalid amount. Enter a number:")
        return True

    if step == "max_activations":
        try:
            max_act = int(text.strip())
            d = wizard["data"]
            db_exec(
                "INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by) VALUES (%s, %s, %s, %s, %s) ON CONFLICT(code) DO NOTHING",
                (d["code"], d["reward_type"], d["reward_amount"], max_act, user_id)
            )
            send_bot_message(chat_id, f"✅ Promo code <code>{d['code']}</code> created!\nReward: {d['reward_type'].upper()} {d['reward_amount']}\nMax activations: {max_act}")
            del admin_wizard[chat_id]
        except Exception as e:
            send_bot_message(chat_id, f"❌ Error: {e}")
        return True

    if step == "delete_promo":
        code = text.strip().upper()
        db_exec("DELETE FROM promo_codes WHERE code=%s", (code,))
        send_bot_message(chat_id, f"✅ Promo code {code} deleted (if existed).")
        del admin_wizard[chat_id]
        return True

    return False

def bot_loop():
    if not BOT_TOKEN:
        logger.warning("No BOT_TOKEN, bot disabled")
        return
    logger.info("Bot polling started")
    offset = 0
    while True:
        try:
            updates = bot_get_updates(offset)
            for update in updates:
                offset = update["update_id"] + 1
                try:
                    if "message" in update:
                        msg = update["message"]
                        text = msg.get("text", "")
                        chat_id = msg["chat"]["id"]
                        user_id = msg.get("from", {}).get("id")
                        if text.startswith("/start"):
                            handle_start(msg)
                        elif text == "/amiadminyes":
                            handle_admin_command(msg)
                        elif user_id in ADMIN_IDS:
                            handle_wizard_message(chat_id, user_id, text)
                    elif "callback_query" in update:
                        handle_callback(update["callback_query"])
                except Exception as e:
                    logger.error(f"Update handler error: {e}")
        except Exception as e:
            logger.error(f"Bot loop error: {e}")
            time.sleep(5)

# ─── APP ───────────────────────────────────────────────────────────────────────

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
    init_schema()
    t = threading.Thread(target=bot_loop, daemon=True)
    t.start()
    logger.info("TRewards backend started")

# ─── MODELS ────────────────────────────────────────────────────────────────────

class UserIn(BaseModel):
    user_id: int
    first_name: str = ""
    last_name: str = ""
    username: str = ""

class UserIdIn(BaseModel):
    user_id: int

class SetReferrerIn(BaseModel):
    user_id: int
    referrer_id: int

class SpinIn(BaseModel):
    user_id: int

class PromoIn(BaseModel):
    user_id: int
    code: str

class DailyTaskIn(BaseModel):
    user_id: int
    task_id: str

class ClaimTaskIn(BaseModel):
    user_id: int
    task_id: int

class VerifyJoinIn(BaseModel):
    user_id: int
    task_id: int

class WithdrawIn(BaseModel):
    user_id: int
    tr_amount: int
    gross_ton: float
    fee_ton: float
    net_ton: float

class ConvertIn(BaseModel):
    user_id: int
    tr_amount: int

class TopupIn(BaseModel):
    user_id: int
    amount: float
    provider: str
    target: str = "wallet"

class CreateTaskIn(BaseModel):
    user_id: int
    task_name: str
    task_type: str
    target_url: str
    max_completions: int = 500

class WithdrawalActionIn(BaseModel):
    wd_id: int
    action: str
    admin_id: int

class CreatePromoIn(BaseModel):
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int = 100
    admin_id: int

# ─── ENDPOINTS ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    try:
        db_fetchone("SELECT 1")
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "error", "db": str(e)}

@app.get("/api/debug")
def debug():
    return {
        "BOT_TOKEN": "set" if BOT_TOKEN else "missing",
        "DATABASE_URL": "set" if DATABASE_URL else "missing",
        "ADMIN_IDS": ADMIN_IDS,
        "WEBAPP_URL": WEBAPP_URL,
        "WITHDRAWAL_CHANNEL_ID": WITHDRAWAL_CHANNEL_ID,
        "XROCKET_API_KEY": "set" if XROCKET_API_KEY else "missing",
        "CRYPTOPAY_API_KEY": "set" if CRYPTOPAY_API_KEY else "missing",
    }

@app.post("/api/user")
def upsert_user(body: UserIn):
    u = get_user(body.user_id)
    if not u:
        db_exec(
            "INSERT INTO users (user_id, first_name, last_name, username, balance, spins) VALUES (%s,%s,%s,%s,100,3)",
            (body.user_id, body.first_name, body.last_name, body.username)
        )
        log_tx(body.user_id, "earn", 100, "Welcome bonus")
    else:
        db_exec(
            "UPDATE users SET first_name=%s, last_name=%s, username=%s, updated_at=NOW() WHERE user_id=%s",
            (body.first_name, body.last_name, body.username, body.user_id)
        )
    return user_response(body.user_id)

@app.post("/api/set-referrer")
def set_referrer(body: SetReferrerIn):
    if body.user_id == body.referrer_id:
        raise HTTPException(400, "Cannot refer yourself")
    u = db_fetchone("SELECT referrer_id FROM users WHERE user_id=%s", (body.user_id,))
    if not u:
        raise HTTPException(404, "User not found")
    if u["referrer_id"]:
        return {"status": "already_set"}
    ref = get_user(body.referrer_id)
    if not ref:
        raise HTTPException(404, "Referrer not found")
    db_exec("UPDATE users SET referrer_id=%s WHERE user_id=%s", (body.referrer_id, body.user_id))
    return {"status": "ok"}

@app.post("/api/claim-streak")
def claim_streak(body: UserIdIn):
    u = get_user(body.user_id)
    if not u:
        raise HTTPException(404, "User not found")
    today = date.today()
    last = u["last_streak_date"]
    if last and last == today:
        raise HTTPException(400, "Already claimed today")
    yesterday = date.fromordinal(today.toordinal() - 1)
    if last and last == yesterday:
        new_streak = min((u["streak"] or 0) + 1, 7)
    else:
        new_streak = 1
    if new_streak > 7:
        new_streak = 1
    db_exec(
        "UPDATE users SET balance=balance+10, spins=spins+1, streak=%s, last_streak_date=%s, updated_at=NOW() WHERE user_id=%s",
        (new_streak, today, body.user_id)
    )
    log_tx(body.user_id, "streak", 10, f"Daily streak day {new_streak}")
    add_referral_commission(body.user_id, 10)
    return user_response(body.user_id)

@app.post("/api/spin")
def do_spin(body: UserIdIn):
    u = get_user(body.user_id)
    if not u:
        raise HTTPException(404, "User not found")
    if (u["spins"] or 0) <= 0:
        raise HTTPException(400, "No spins available")
    reward = random.choice([10, 50, 80, 100, 300, 500])
    db_exec(
        "UPDATE users SET spins=spins-1, balance=balance+%s, updated_at=NOW() WHERE user_id=%s",
        (reward, body.user_id)
    )
    db_exec("INSERT INTO spin_history (user_id, reward) VALUES (%s,%s)", (body.user_id, reward))
    log_tx(body.user_id, "spin", reward, f"Spin wheel reward")
    add_referral_commission(body.user_id, reward)
    result = user_response(body.user_id)
    result["reward"] = reward
    return result

@app.post("/api/redeem-promo")
def redeem_promo(body: PromoIn):
    code = body.code.strip().upper()
    promo = db_fetchone("SELECT * FROM promo_codes WHERE UPPER(code)=%s", (code,))
    if not promo:
        raise HTTPException(400, "Invalid promo code")
    if promo["activations"] >= promo["max_activations"]:
        raise HTTPException(400, "Promo code expired")
    existing = db_fetchone("SELECT id FROM promo_activations WHERE UPPER(code)=%s AND user_id=%s", (code, body.user_id))
    if existing:
        raise HTTPException(400, "Already used this code")
    db_exec("INSERT INTO promo_activations (code, user_id) VALUES (%s,%s)", (code, body.user_id))
    db_exec("UPDATE promo_codes SET activations=activations+1 WHERE UPPER(code)=%s", (code,))
    reward_info = {}
    if promo["reward_type"] == "tr":
        amount = int(promo["reward_amount"])
        db_exec("UPDATE users SET balance=balance+%s WHERE user_id=%s", (amount, body.user_id))
        log_tx(body.user_id, "promo", amount, f"Promo code: {code}")
        reward_info = {"type": "tr", "amount": amount}
    else:
        amount = float(promo["reward_amount"])
        db_exec("UPDATE users SET ton_balance=ton_balance+%s WHERE user_id=%s", (amount, body.user_id))
        reward_info = {"type": "ton", "amount": amount}
    result = user_response(body.user_id)
    result["reward"] = reward_info
    return result

@app.post("/api/claim-daily-task")
def claim_daily_task(body: DailyTaskIn):
    u = get_user(body.user_id)
    if not u:
        raise HTTPException(404, "User not found")
    today = date.today()
    reset_date = u["daily_tasks_reset_date"]
    completed = u["daily_tasks_completed"] or []
    if isinstance(completed, str):
        completed = json.loads(completed)
    if reset_date != today:
        completed = []
        db_exec("UPDATE users SET daily_tasks_reset_date=%s, daily_tasks_completed='[]' WHERE user_id=%s", (today, body.user_id))
    if body.task_id in completed:
        raise HTTPException(400, "Already completed today")
    completed.append(body.task_id)
    REWARD = 500 if body.task_id != "watchad" else 2500
    db_exec(
        "UPDATE users SET balance=balance+%s, spins=spins+1, daily_tasks_completed=%s, updated_at=NOW() WHERE user_id=%s",
        (REWARD, json.dumps(completed), body.user_id)
    )
    log_tx(body.user_id, "task", REWARD, f"Daily task: {body.task_id}")
    add_referral_commission(body.user_id, REWARD)
    return user_response(body.user_id)

@app.get("/api/tasks")
def get_tasks(user_id: int):
    tasks = db_fetch(
        "SELECT t.*, CASE WHEN tc.user_id IS NOT NULL THEN true ELSE false END as completed_by_user "
        "FROM tasks t LEFT JOIN task_completions tc ON t.task_id=tc.task_id AND tc.user_id=%s "
        "WHERE t.status='active' ORDER BY t.created_at DESC",
        (user_id,)
    )
    return [dict(t) for t in tasks] if tasks else []

@app.post("/api/claim-task")
def claim_task(body: ClaimTaskIn):
    task = db_fetchone("SELECT * FROM tasks WHERE task_id=%s AND status='active'", (body.task_id,))
    if not task:
        raise HTTPException(404, "Task not found or inactive")
    existing = db_fetchone("SELECT id FROM task_completions WHERE task_id=%s AND user_id=%s", (body.task_id, body.user_id))
    if existing:
        raise HTTPException(400, "Already completed")
    reward = 5000 if task["task_type"] in ("channel","group","game") else 3000
    db_exec("INSERT INTO task_completions (task_id, user_id) VALUES (%s,%s)", (body.task_id, body.user_id))
    db_exec("UPDATE tasks SET completed_count=completed_count+1 WHERE task_id=%s", (body.task_id,))
    db_exec("UPDATE users SET balance=balance+%s, spins=spins+1, updated_at=NOW() WHERE user_id=%s", (reward, body.user_id))
    log_tx(body.user_id, "task", reward, f"Task: {task['task_name']}")
    add_referral_commission(body.user_id, reward)
    # Deduct advertiser
    db_exec("UPDATE users SET ad_balance=ad_balance-0.001 WHERE user_id=%s", (task["user_id"],))
    # Mark completed if limit reached
    updated = db_fetchone("SELECT completed_count FROM tasks WHERE task_id=%s", (body.task_id,))
    if updated and updated["completed_count"] >= task["max_completions"]:
        db_exec("UPDATE tasks SET status='completed' WHERE task_id=%s", (body.task_id,))
    return user_response(body.user_id)

@app.post("/api/verify-join")
def verify_join(body: VerifyJoinIn):
    task = db_fetchone("SELECT * FROM tasks WHERE task_id=%s AND status='active'", (body.task_id,))
    if not task:
        raise HTTPException(404, "Task not found")
    existing = db_fetchone("SELECT id FROM task_completions WHERE task_id=%s AND user_id=%s", (body.task_id, body.user_id))
    if existing:
        raise HTTPException(400, "Already completed")
    # Extract username from URL
    url = task["target_url"]
    username = url.split("t.me/")[-1].strip("/").split("?")[0] if "t.me/" in url else None
    verified = False
    if username and BOT_TOKEN:
        try:
            r = requests.get(
                f"https://api.telegram.org/bot{BOT_TOKEN}/getChatMember",
                params={"chat_id": "@" + username, "user_id": body.user_id},
                timeout=5
            )
            data = r.json()
            if data.get("ok"):
                status = data["result"]["status"]
                if status in ("member", "administrator", "creator"):
                    verified = True
                elif status in ("left", "kicked"):
                    raise HTTPException(400, "You have not joined yet")
            else:
                # Bot not in channel — allow anyway
                verified = True
        except HTTPException:
            raise
        except Exception:
            verified = True
    else:
        verified = True

    if not verified:
        raise HTTPException(400, "Not a member")

    reward = 5000
    db_exec("INSERT INTO task_completions (task_id, user_id) VALUES (%s,%s)", (body.task_id, body.user_id))
    db_exec("UPDATE tasks SET completed_count=completed_count+1 WHERE task_id=%s", (body.task_id,))
    db_exec("UPDATE users SET balance=balance+%s, spins=spins+1, updated_at=NOW() WHERE user_id=%s", (reward, body.user_id))
    log_tx(body.user_id, "task", reward, f"Joined: {task['task_name']}")
    add_referral_commission(body.user_id, reward)
    db_exec("UPDATE users SET ad_balance=ad_balance-0.001 WHERE user_id=%s", (task["user_id"],))
    return user_response(body.user_id)

@app.get("/api/friends")
def get_friends(user_id: int):
    friends = db_fetch(
        "SELECT u.user_id, u.first_name, u.last_name, u.balance FROM users u WHERE u.referrer_id=%s ORDER BY u.created_at DESC LIMIT 10",
        (user_id,)
    )
    pending = db_fetchone(
        "SELECT COALESCE(SUM(amount),0) as total FROM referral_earnings WHERE referrer_id=%s AND claimed=false",
        (user_id,)
    )
    total_earned = db_fetchone(
        "SELECT COALESCE(SUM(amount),0) as total FROM referral_earnings WHERE referrer_id=%s",
        (user_id,)
    )
    return {
        "friends": [dict(f) for f in (friends or [])],
        "total_friends": len(friends) if friends else 0,
        "pending_earnings": int(pending["total"]) if pending else 0,
        "total_earned": int(total_earned["total"]) if total_earned else 0
    }

@app.post("/api/claim-referral")
def claim_referral(body: UserIdIn):
    pending = db_fetchone(
        "SELECT COALESCE(SUM(amount),0) as total FROM referral_earnings WHERE referrer_id=%s AND claimed=false",
        (body.user_id,)
    )
    amount = int(pending["total"]) if pending else 0
    if amount <= 0:
        raise HTTPException(400, "No pending referral rewards")
    db_exec("UPDATE referral_earnings SET claimed=true WHERE referrer_id=%s AND claimed=false", (body.user_id,))
    db_exec("UPDATE users SET balance=balance+%s, updated_at=NOW() WHERE user_id=%s", (amount, body.user_id))
    log_tx(body.user_id, "referral", amount, "Referral commission claimed")
    return user_response(body.user_id)

@app.get("/api/transactions")
def get_transactions(user_id: int):
    txs = db_fetch(
        "SELECT * FROM transactions WHERE user_id=%s ORDER BY created_at DESC LIMIT 20",
        (user_id,)
    )
    return [dict(t) for t in (txs or [])]

@app.post("/api/withdraw")
def withdraw(body: WithdrawIn):
    u = get_user(body.user_id)
    if not u:
        raise HTTPException(404, "User not found")
    if (u["balance"] or 0) < body.tr_amount:
        raise HTTPException(400, "Insufficient balance")
    db_exec(
        "UPDATE users SET balance=balance-%s, updated_at=NOW() WHERE user_id=%s",
        (body.tr_amount, body.user_id)
    )
    res = db_fetchone(
        "INSERT INTO withdrawals (user_id, tr_amount, gross_ton, fee_ton, net_ton, status, tx_type) VALUES (%s,%s,%s,%s,%s,'pending','withdraw') RETURNING id",
        (body.user_id, body.tr_amount, body.gross_ton, body.fee_ton, body.net_ton)
    )
    wd_id = res["id"] if res else 0
    log_tx(body.user_id, "withdraw", -body.tr_amount, f"Withdrawal {body.net_ton} TON")
    # Notify withdrawal channel
    if WITHDRAWAL_CHANNEL_ID:
        u_full = get_user(body.user_id)
        name = f"{u_full['first_name'] or ''} {u_full['last_name'] or ''}".strip() if u_full else str(body.user_id)
        uname = f"@{u_full['username']}" if u_full and u_full.get("username") else str(body.user_id)
        text = (
            f"💸 <b>Withdrawal Request #{wd_id}</b>\n\n"
            f"👤 User: {name} ({uname})\n"
            f"🆔 ID: <code>{body.user_id}</code>\n\n"
            f"📊 TR Deducted: <b>{body.tr_amount:,}</b>\n"
            f"💰 Gross: <b>{body.gross_ton} TON</b>\n"
            f"⛽ Fee: <b>{body.fee_ton} TON</b>\n"
            f"✅ Net: <b>{body.net_ton} TON</b>"
        )
        kb = {"inline_keyboard": [[
            {"text": "✅ Approve", "callback_data": f"wd_approve_{wd_id}"},
            {"text": "❌ Decline", "callback_data": f"wd_decline_{wd_id}"},
            {"text": "💸 Complete", "callback_data": f"wd_complete_{wd_id}"}
        ]]}
        msg = send_bot_message(WITHDRAWAL_CHANNEL_ID, text, reply_markup=kb)
        if msg and msg.get("result"):
            db_exec("UPDATE withdrawals SET message_id=%s WHERE id=%s", (msg["result"]["message_id"], wd_id))
    return {"success": True, "wd_id": wd_id}

@app.post("/api/convert")
def convert_tr(body: ConvertIn):
    if body.tr_amount < 1000000:
        raise HTTPException(400, "Minimum 1,000,000 TR")
    u = get_user(body.user_id)
    if not u:
        raise HTTPException(404, "User not found")
    if (u["balance"] or 0) < body.tr_amount:
        raise HTTPException(400, "Insufficient balance")
    ton_amount = (body.tr_amount / 1000000) * 0.15
    db_exec("UPDATE users SET balance=balance-%s, ton_balance=ton_balance+%s WHERE user_id=%s",
            (body.tr_amount, ton_amount, body.user_id))
    db_exec(
        "INSERT INTO withdrawals (user_id, tr_amount, gross_ton, fee_ton, net_ton, status, tx_type) VALUES (%s,%s,%s,0,%s,'pending','convert')",
        (body.user_id, body.tr_amount, ton_amount, ton_amount)
    )
    log_tx(body.user_id, "convert", -body.tr_amount, f"Convert {body.tr_amount:,} TR → {ton_amount:.6f} TON")
    return user_response(body.user_id)

def create_xrocket_invoice(amount_ton: float, description: str) -> Optional[str]:
    if not XROCKET_API_KEY:
        return None
    try:
        r = requests.post(
            "https://pay.xrocket.tg/tg-invoices",
            headers={"Rocket-Pay-Key": XROCKET_API_KEY, "Content-Type": "application/json"},
            json={"amount": str(amount_ton), "currency": "TONCOIN", "description": description, "numPayments": 1},
            timeout=10
        )
        data = r.json()
        return data.get("data", {}).get("link")
    except Exception as e:
        logger.error(f"xRocket invoice error: {e}")
        return None

def create_cryptopay_invoice(amount_ton: float, description: str) -> Optional[str]:
    if not CRYPTOPAY_API_KEY:
        return None
    try:
        r = requests.post(
            "https://pay.crypt.bot/api/createInvoice",
            headers={"Crypto-Pay-API-Token": CRYPTOPAY_API_KEY, "Content-Type": "application/json"},
            json={"asset": "TON", "amount": str(amount_ton), "description": description},
            timeout=10
        )
        data = r.json()
        return data.get("result", {}).get("bot_invoice_url") or data.get("result", {}).get("mini_app_invoice_url")
    except Exception as e:
        logger.error(f"CryptoPay invoice error: {e}")
        return None

@app.post("/api/create-topup")
def create_topup(body: TopupIn):
    description = f"TRewards top-up {body.amount} TON (user {body.user_id})"
    url = None
    if body.provider == "xrocket":
        url = create_xrocket_invoice(body.amount, description)
    elif body.provider == "cryptopay":
        url = create_cryptopay_invoice(body.amount, description)
    if not url:
        # Fallback invoice URL for testing
        url = f"https://t.me/{BOT_USERNAME}"
    db_exec(
        "INSERT INTO payments (user_id, provider, amount_ton, target, status) VALUES (%s,%s,%s,%s,'pending')",
        (body.user_id, body.provider, body.amount, body.target)
    )
    return {"invoice_url": url}

@app.get("/api/advertiser")
def get_advertiser(user_id: int):
    u = get_user(user_id)
    if not u:
        raise HTTPException(404, "User not found")
    tasks = db_fetch("SELECT * FROM tasks WHERE user_id=%s ORDER BY created_at DESC", (user_id,))
    return {
        "ad_balance": float(u["ad_balance"] or 0),
        "tasks": [dict(t) for t in (tasks or [])]
    }

@app.post("/api/create-task")
def create_task(body: CreateTaskIn):
    u = get_user(body.user_id)
    if not u:
        raise HTTPException(404, "User not found")
    cost = body.max_completions * 0.001
    if float(u["ad_balance"] or 0) < cost:
        raise HTTPException(400, f"Insufficient ad balance. Need {cost:.3f} TON")
    res = db_fetchone(
        "INSERT INTO tasks (user_id, task_name, task_type, target_url, max_completions, cost_ton) VALUES (%s,%s,%s,%s,%s,%s) RETURNING task_id",
        (body.user_id, body.task_name, body.task_type, body.target_url, body.max_completions, cost)
    )
    db_exec("UPDATE users SET ad_balance=ad_balance-%s WHERE user_id=%s", (cost, body.user_id))
    return {"task_id": res["task_id"] if res else None, "status": "created"}

# ─── PAYMENT WEBHOOKS ──────────────────────────────────────────────────────────

@app.post("/payment-webhook/xrocket")
async def xrocket_webhook(request: Request):
    try:
        body = await request.json()
        payment = body.get("payment", {})
        invoice_id = str(payment.get("id", ""))
        status = payment.get("status", "")
        if status != "paid":
            return {"ok": True}
        # Find payment record by invoice_id
        rec = db_fetchone("SELECT * FROM payments WHERE invoice_id=%s AND credited=false", (invoice_id,))
        if rec:
            user_id = rec["user_id"]
            amount = float(rec["amount_ton"])
            target = rec["target"]
            if target == "ad_balance":
                db_exec("UPDATE users SET ad_balance=ad_balance+%s WHERE user_id=%s", (amount, user_id))
            else:
                db_exec("UPDATE users SET ton_balance=ton_balance+%s WHERE user_id=%s", (amount, user_id))
            db_exec("UPDATE payments SET status='paid', credited=true WHERE invoice_id=%s", (invoice_id,))
            send_bot_message(user_id, f"✅ Payment of <b>{amount} TON</b> received via xRocket!")
        return {"ok": True}
    except Exception as e:
        logger.error(f"xRocket webhook error: {e}")
        return {"ok": True}

@app.post("/payment-webhook/cryptopay")
async def cryptopay_webhook(request: Request):
    try:
        body = await request.json()
        invoice = body.get("payload", {})
        invoice_id = str(invoice.get("invoice_id", ""))
        status = invoice.get("status", "")
        if status != "paid":
            return {"ok": True}
        rec = db_fetchone("SELECT * FROM payments WHERE invoice_id=%s AND credited=false", (invoice_id,))
        if rec:
            user_id = rec["user_id"]
            amount = float(rec["amount_ton"])
            target = rec["target"]
            if target == "ad_balance":
                db_exec("UPDATE users SET ad_balance=ad_balance+%s WHERE user_id=%s", (amount, user_id))
            else:
                db_exec("UPDATE users SET ton_balance=ton_balance+%s WHERE user_id=%s", (amount, user_id))
            db_exec("UPDATE payments SET status='paid', credited=true WHERE invoice_id=%s", (invoice_id,))
            send_bot_message(user_id, f"✅ Payment of <b>{amount} TON</b> received via Crypto Pay!")
        return {"ok": True}
    except Exception as e:
        logger.error(f"CryptoPay webhook error: {e}")
        return {"ok": True}

# ─── ADMIN ENDPOINTS ───────────────────────────────────────────────────────────

@app.post("/api/admin/create-promo")
def admin_create_promo(body: CreatePromoIn):
    if body.admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    db_exec(
        "INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by) VALUES (%s,%s,%s,%s,%s)",
        (body.code.upper(), body.reward_type, body.reward_amount, body.max_activations, body.admin_id)
    )
    return {"status": "created"}

@app.get("/api/admin/promo-codes")
def admin_list_promos(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    promos = db_fetch("SELECT * FROM promo_codes ORDER BY created_at DESC")
    return [dict(p) for p in (promos or [])]

@app.delete("/api/admin/promo-codes/{code}")
def admin_delete_promo(code: str, admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    db_exec("DELETE FROM promo_codes WHERE UPPER(code)=%s", (code.upper(),))
    return {"status": "deleted"}

@app.get("/api/admin/promo-history")
def admin_promo_history(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    acts = db_fetch(
        "SELECT pa.*, u.first_name, u.username FROM promo_activations pa LEFT JOIN users u ON pa.user_id=u.user_id ORDER BY pa.activated_at DESC LIMIT 100"
    )
    return [dict(a) for a in (acts or [])]

@app.get("/api/admin/payments")
def admin_payments(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    pays = db_fetch("SELECT * FROM payments ORDER BY created_at DESC LIMIT 100")
    return [dict(p) for p in (pays or [])]

@app.get("/api/admin/stats")
def admin_stats(admin_id: int):
    if admin_id not in ADMIN_IDS:
        raise HTTPException(403, "Unauthorized")
    users_count = db_fetchone("SELECT COUNT(*) as c FROM users")
    total_balance = db_fetchone("SELECT COALESCE(SUM(balance),0) as s FROM users")
    total_tasks = db_fetchone("SELECT COUNT(*) as c FROM tasks")
    total_tx = db_fetchone("SELECT COUNT(*) as c FROM transactions")
    total_wd = db_fetchone("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'")
    return {
        "total_users": users_count["c"] if users_count else 0,
        "total_balance": int(total_balance["s"]) if total_balance else 0,
        "total_tasks": total_tasks["c"] if total_tasks else 0,
        "total_transactions": total_tx["c"] if total_tx else 0,
        "pending_withdrawals": total_wd["c"] if total_wd else 0,
    }