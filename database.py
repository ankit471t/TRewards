import asyncpg
import logging
import random
from datetime import date, timedelta
from config import DATABASE_URL, REFERRAL_COMMISSION

logger = logging.getLogger(__name__)

_pool = None


async def get_pool():
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=3,
            max_size=20,
            command_timeout=30,
            max_inactive_connection_lifetime=300,
            statement_cache_size=0,  # required for Supabase pgBouncer
        )
    return _pool


async def init_db():
    p = await get_pool()
    async with p.acquire() as conn:

        # ── users ─────────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                  BIGINT PRIMARY KEY,
                username            TEXT,
                first_name          TEXT,
                last_name           TEXT,
                coins               BIGINT DEFAULT 0,
                spins               INTEGER DEFAULT 0,
                streak              INTEGER DEFAULT 0,
                last_streak_date    DATE,
                streak_started      DATE,
                referrer_id         BIGINT REFERENCES users(id),
                referral_earnings   BIGINT DEFAULT 0,
                unclaimed_referral  BIGINT DEFAULT 0,
                ton_balance         NUMERIC(18,8) DEFAULT 0,
                language            TEXT DEFAULT 'en',
                ton_wallet_address  TEXT,
                ton_comment_id      TEXT UNIQUE,
                created_at          TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # Add columns if missing (safe migration)
        migrations = [
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS ton_wallet_address TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS ton_comment_id TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'",
        ]
        for sql in migrations:
            try:
                await conn.execute(sql)
            except Exception:
                pass

        # ── transactions ──────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id          SERIAL PRIMARY KEY,
                user_id     BIGINT REFERENCES users(id),
                type        TEXT NOT NULL,
                description TEXT,
                amount      BIGINT DEFAULT 0,
                ton_amount  NUMERIC(18,8) DEFAULT 0,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── tasks ─────────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id               SERIAL PRIMARY KEY,
                advertiser_id    BIGINT REFERENCES users(id),
                name             TEXT NOT NULL,
                type             TEXT NOT NULL,
                url              TEXT NOT NULL,
                reward_coins     INTEGER NOT NULL,
                completion_limit INTEGER,
                days_limit       INTEGER,
                completed_count  INTEGER DEFAULT 0,
                cost_ton         NUMERIC(18,8) NOT NULL,
                status           TEXT DEFAULT 'active',
                created_at       TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── task_completions ──────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS task_completions (
                id           SERIAL PRIMARY KEY,
                task_id      INTEGER REFERENCES tasks(id),
                user_id      BIGINT REFERENCES users(id),
                completed_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(task_id, user_id)
            )
        """)

        # ── daily_task_completions ─────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS daily_task_completions (
                id             SERIAL PRIMARY KEY,
                user_id        BIGINT REFERENCES users(id),
                task_type      TEXT NOT NULL,
                completed_date DATE NOT NULL DEFAULT CURRENT_DATE,
                UNIQUE(user_id, task_type, completed_date)
            )
        """)

        # ── promo_codes ───────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes (
                id                   SERIAL PRIMARY KEY,
                code                 TEXT UNIQUE NOT NULL,
                reward_type          TEXT NOT NULL,
                reward_amount        NUMERIC(18,8) NOT NULL,
                max_activations      INTEGER NOT NULL,
                current_activations  INTEGER DEFAULT 0,
                created_by           BIGINT REFERENCES users(id),
                is_active            BOOLEAN DEFAULT TRUE,
                created_at           TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── promo_activations ─────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS promo_activations (
                id            SERIAL PRIMARY KEY,
                promo_id      INTEGER REFERENCES promo_codes(id),
                user_id       BIGINT REFERENCES users(id),
                activated_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(promo_id, user_id)
            )
        """)

        # ── payments (xRocket) ────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS payments (
                id         SERIAL PRIMARY KEY,
                user_id    BIGINT REFERENCES users(id),
                provider   TEXT NOT NULL,
                invoice_id TEXT UNIQUE NOT NULL,
                amount_ton NUMERIC(18,8) NOT NULL,
                status     TEXT DEFAULT 'pending',
                payload    TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                paid_at    TIMESTAMPTZ
            )
        """)

        # ── ton_topup_requests (direct wallet top-up via comment ID) ──────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS ton_topup_requests (
                id             SERIAL PRIMARY KEY,
                user_id        BIGINT REFERENCES users(id),
                comment_id     TEXT NOT NULL UNIQUE,
                amount_ton     NUMERIC(18,8),
                status         TEXT DEFAULT 'pending',
                tx_hash        TEXT,
                created_at     TIMESTAMPTZ DEFAULT NOW(),
                credited_at    TIMESTAMPTZ
            )
        """)

        # ── stars_payments ────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS stars_payments (
                id                 SERIAL PRIMARY KEY,
                user_id            BIGINT REFERENCES users(id),
                telegram_charge_id TEXT UNIQUE NOT NULL,
                stars_amount       INTEGER NOT NULL,
                ton_credited       NUMERIC(18,8) NOT NULL,
                created_at         TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── withdrawals ───────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS withdrawals (
                id              SERIAL PRIMARY KEY,
                user_id         BIGINT REFERENCES users(id),
                coins_deducted  BIGINT NOT NULL,
                ton_amount      NUMERIC(18,8) NOT NULL,
                net_ton         NUMERIC(18,8) NOT NULL,
                fee_ton         NUMERIC(18,8) DEFAULT 0,
                wallet_address  TEXT,
                status          TEXT DEFAULT 'pending',
                created_at      TIMESTAMPTZ DEFAULT NOW(),
                processed_at    TIMESTAMPTZ
            )
        """)

        # ── spin_history ──────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS spin_history (
                id           SERIAL PRIMARY KEY,
                user_id      BIGINT REFERENCES users(id),
                result_coins INTEGER NOT NULL,
                spun_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── ton_checks ────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS ton_checks (
                id            TEXT PRIMARY KEY,
                creator_id    BIGINT REFERENCES users(id),
                check_type    TEXT NOT NULL,
                amount        NUMERIC(18,8) NOT NULL,
                recipients    INTEGER NOT NULL DEFAULT 1,
                claimed_count INTEGER DEFAULT 0,
                status        TEXT DEFAULT 'active',
                created_at    TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── check_claims ──────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS check_claims (
                id         SERIAL PRIMARY KEY,
                check_id   TEXT REFERENCES ton_checks(id),
                claimer_id BIGINT REFERENCES users(id),
                amount     NUMERIC(18,8) NOT NULL,
                claimed_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(check_id, claimer_id)
            )
        """)

        # ── weekly_referral_stats ─────────────────────────────────────────────
        # week_id uses Sunday-based weeks (YYYY-WNN) matching:
        #   frontend getSundayWeekId() and main.py _sunday_week_id()
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS weekly_referral_stats (
                id          SERIAL PRIMARY KEY,
                referrer_id BIGINT REFERENCES users(id),
                week_id     TEXT NOT NULL,
                friend_count INTEGER DEFAULT 0,
                updated_at  TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(referrer_id, week_id)
            )
        """)

        # ── Indexes ───────────────────────────────────────────────────────────
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_transactions_user      ON transactions(user_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_task_completions_user   ON task_completions(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_task_completions_task   ON task_completions(task_id)",
            "CREATE INDEX IF NOT EXISTS idx_payments_invoice        ON payments(invoice_id)",
            "CREATE INDEX IF NOT EXISTS idx_withdrawals_user        ON withdrawals(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_checks_creator          ON ton_checks(creator_id)",
            "CREATE INDEX IF NOT EXISTS idx_check_claims_check      ON check_claims(check_id)",
            "CREATE INDEX IF NOT EXISTS idx_weekly_ref_week         ON weekly_referral_stats(week_id)",
            "CREATE INDEX IF NOT EXISTS idx_users_referrer          ON users(referrer_id)",
            "CREATE INDEX IF NOT EXISTS idx_daily_task_user_date    ON daily_task_completions(user_id, completed_date)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_status            ON tasks(status)",
            "CREATE INDEX IF NOT EXISTS idx_ton_topup_comment       ON ton_topup_requests(comment_id)",
            "CREATE INDEX IF NOT EXISTS idx_ton_topup_user          ON ton_topup_requests(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_users_comment_id        ON users(ton_comment_id)",
            "CREATE INDEX IF NOT EXISTS idx_users_created_at        ON users(created_at DESC)",
            "CREATE INDEX IF NOT EXISTS idx_stars_charge            ON stars_payments(telegram_charge_id)",
        ]
        for idx in indexes:
            try:
                await conn.execute(idx)
            except Exception:
                pass

        logger.info("Database initialized successfully")


# ─── Core helpers ─────────────────────────────────────────────────────────────

async def get_user(conn, user_id: int):
    return await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)


async def create_user(conn, user_id: int, username: str, first_name: str,
                      last_name: str, referrer_id: int = None):
    """
    Upsert user, handle referral, generate unique comment ID.

    Weekly referral stats use _current_week_id() (Sunday-based), matching
    main.py _sunday_week_id() and the frontend getSundayWeekId().
    """
    if referrer_id == user_id:
        referrer_id = None
    if referrer_id:
        ref = await conn.fetchrow("SELECT id FROM users WHERE id = $1", referrer_id)
        if not ref:
            referrer_id = None

    # Generate unique 6-digit numeric comment ID
    comment_id = str(random.randint(100000, 999999))
    while True:
        existing = await conn.fetchrow(
            "SELECT id FROM users WHERE ton_comment_id = $1", comment_id
        )
        if not existing:
            break
        comment_id = str(random.randint(100000, 999999))

    user = await conn.fetchrow("""
        INSERT INTO users (id, username, first_name, last_name, referrer_id, ton_comment_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
            username   = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            last_name  = EXCLUDED.last_name
        RETURNING *
    """, user_id, username, first_name, last_name, referrer_id, comment_id)

    # Update weekly referral stats only on first-time referral.
    # Uses Sunday-based week ID to stay consistent across all three layers.
    if referrer_id and user["referrer_id"] == referrer_id:
        week_id = _current_week_id()
        await conn.execute("""
            INSERT INTO weekly_referral_stats (referrer_id, week_id, friend_count)
            VALUES ($1, $2, 1)
            ON CONFLICT (referrer_id, week_id)
            DO UPDATE SET friend_count = weekly_referral_stats.friend_count + 1,
                          updated_at = NOW()
        """, referrer_id, week_id)

    return user


async def add_coins(conn, user_id: int, amount: int, tx_type: str, description: str):
    """
    Add coins and record transaction.
    Credits REFERRAL_COMMISSION to referrer's unclaimed balance.
    Rate is read from config.py (REFERRAL_COMMISSION = 0.30) rather than
    hardcoded, so a single config change propagates everywhere.
    """
    await conn.execute(
        "UPDATE users SET coins = coins + $1 WHERE id = $2", amount, user_id
    )
    await conn.execute("""
        INSERT INTO transactions (user_id, type, description, amount)
        VALUES ($1, $2, $3, $4)
    """, user_id, tx_type, description, amount)

    if amount > 0:
        user = await conn.fetchrow("SELECT referrer_id FROM users WHERE id = $1", user_id)
        if user and user["referrer_id"]:
            commission = int(amount * REFERRAL_COMMISSION)
            if commission > 0:
                await conn.execute("""
                    UPDATE users
                    SET unclaimed_referral = unclaimed_referral + $1,
                        referral_earnings  = referral_earnings  + $1
                    WHERE id = $2
                """, commission, user["referrer_id"])


async def add_spins(conn, user_id: int, amount: int):
    await conn.execute(
        "UPDATE users SET spins = spins + $1 WHERE id = $2", amount, user_id
    )


async def add_ton(conn, user_id: int, amount: float, tx_type: str, description: str):
    """Add TON balance (= ad balance) and record transaction."""
    await conn.execute(
        "UPDATE users SET ton_balance = ton_balance + $1 WHERE id = $2", amount, user_id
    )
    await conn.execute("""
        INSERT INTO transactions (user_id, type, description, ton_amount)
        VALUES ($1, $2, $3, $4)
    """, user_id, tx_type, description, amount)


# ─── Week helpers (Sunday→Saturday) ──────────────────────────────────────────
#
# All three layers must agree on which "week" a referral belongs to:
#
#   Frontend (JS):  getSundayWeekId(d)  →  days_since_sunday = d.getDay()
#   main.py:        _sunday_week_id(d)  →  days_since_sunday = (weekday+1) % 7
#   database.py:    _sunday_week_id(d)  →  same formula (this file)
#
# Old database.py used  day_of_year // 7 + 1  which is NOT Sunday-aligned and
# drifts from the other two implementations. Replaced below.
#
# Formula:
#   days_since_sunday = (d.weekday() + 1) % 7   # 0 on Sun, 1 on Mon … 6 on Sat
#   week_start = d - timedelta(days=days_since_sunday)
#   year = week_start.isocalendar()[0]           # handles Jan 1 edge cases
#   week_num = (week_start - date(year,1,1)).days // 7 + 1
#   return f"{year}-W{week_num:02d}"

def _sunday_week_id(d: date) -> str:
    """
    Return the Sunday-based week ID for an arbitrary date, e.g. '2025-W22'.
    Mirrors frontend getSundayWeekId() and main.py _sunday_week_id() exactly.
    """
    days_since_sunday = (d.weekday() + 1) % 7   # 0 if d is Sunday
    week_start = d - timedelta(days=days_since_sunday)
    year = week_start.isocalendar()[0]
    jan1 = date(year, 1, 1)
    week_num = (week_start - jan1).days // 7 + 1
    return f"{year}-W{week_num:02d}"


def _current_week_id() -> str:
    """Sunday-based week ID for today."""
    return _sunday_week_id(date.today())


def _prev_week_id() -> str:
    """Sunday-based week ID for last week."""
    return _sunday_week_id(date.today() - timedelta(days=7))