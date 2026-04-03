import asyncpg
import asyncio
import logging
import random
from datetime import date, timedelta
from config import DATABASE_URL, REFERRAL_COMMISSION, BOT_USERNAME, MINI_APP_SHORT_NAME

logger = logging.getLogger(__name__)

_pool = None


async def get_pool():
    global _pool
    if _pool is None:
        for attempt in range(5):
            try:
                _pool = await asyncpg.create_pool(
                    DATABASE_URL,
                    min_size=3,
                    max_size=20,
                    command_timeout=30,
                    max_inactive_connection_lifetime=300,
                    statement_cache_size=0,
                )
                logger.info("Database pool created successfully")
                break
            except Exception as e:
                logger.warning(f"DB connect attempt {attempt + 1}/5 failed: {e}")
                if attempt < 4:
                    wait = 3 * (attempt + 1)
                    logger.info(f"Retrying in {wait}s...")
                    await asyncio.sleep(wait)
                else:
                    logger.error("All DB connection attempts failed")
                    raise
    return _pool


async def init_db():
    p = await get_pool()
    async with p.acquire() as conn:

        # ── users ─────────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                       BIGINT PRIMARY KEY,
                username                 TEXT,
                first_name               TEXT,
                last_name                TEXT,
                coins                    BIGINT DEFAULT 0,
                spins                    INTEGER DEFAULT 0,
                streak                   INTEGER DEFAULT 0,
                last_streak_date         DATE,
                streak_started           DATE,
                referrer_id              BIGINT REFERENCES users(id),

                referral_link            TEXT,
                total_friends            BIGINT DEFAULT 0,
                weekly_friends           INTEGER DEFAULT 0,
                weekly_friends_reset_at  DATE,
                tr_earned_from_refs      BIGINT DEFAULT 0,
                referral_earnings        BIGINT DEFAULT 0,
                unclaimed_referral       BIGINT DEFAULT 0,

                ton_balance              NUMERIC(18,8) DEFAULT 0,
                language                 TEXT DEFAULT 'en',
                ton_wallet_address       TEXT,
                ton_comment_id           TEXT UNIQUE,
                created_at               TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        migrations = [
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS ton_wallet_address TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS ton_comment_id TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en'",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_link TEXT",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS total_friends BIGINT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_friends INTEGER DEFAULT 0",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_friends_reset_at DATE",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS tr_earned_from_refs BIGINT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_earnings BIGINT DEFAULT 0",
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS unclaimed_referral BIGINT DEFAULT 0",
        ]
        for sql in migrations:
            try:
                await conn.execute(sql)
            except Exception:
                pass

        # Back-fill referral_link for existing users
        await conn.execute("""
            UPDATE users
            SET referral_link = concat(
                'https://t.me/', $1::text, '/', $2::text,
                '?startapp=ref_', id::text
            )
            WHERE referral_link IS NULL
        """, BOT_USERNAME, MINI_APP_SHORT_NAME)

        # Back-fill tr_earned_from_refs from referral_earnings
        await conn.execute("""
            UPDATE users
            SET tr_earned_from_refs = referral_earnings
            WHERE tr_earned_from_refs = 0 AND referral_earnings > 0
        """)

        # Back-fill total_friends from actual referral rows
        await conn.execute("""
            UPDATE users u
            SET total_friends = (
                SELECT COUNT(*) FROM users WHERE referrer_id = u.id
            )
            WHERE total_friends = 0
              AND EXISTS (SELECT 1 FROM users WHERE referrer_id = u.id)
        """)

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
                created_at       TIMESTAMPTZ DEFAULT NOW(),
                extended_count   INTEGER DEFAULT 0
            )
        """)

        try:
            await conn.execute(
                "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS extended_count INTEGER DEFAULT 0"
            )
        except Exception:
            pass

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

        # ── daily_task_completions ────────────────────────────────────────────
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

        # ── payments ──────────────────────────────────────────────────────────
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

        # ── ton_topup_requests ────────────────────────────────────────────────
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
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS weekly_referral_stats (
                id           SERIAL PRIMARY KEY,
                referrer_id  BIGINT REFERENCES users(id),
                week_id      TEXT NOT NULL,
                friend_count INTEGER DEFAULT 0,
                updated_at   TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(referrer_id, week_id)
            )
        """)

        # ── referral_commissions ──────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS referral_commissions (
                id           SERIAL PRIMARY KEY,
                referrer_id  BIGINT REFERENCES users(id),
                friend_id    BIGINT REFERENCES users(id),
                coins_earned BIGINT DEFAULT 0,
                updated_at   TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(referrer_id, friend_id)
            )
        """)

        # ── task_extensions ───────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS task_extensions (
                id                 SERIAL PRIMARY KEY,
                task_id            INTEGER REFERENCES tasks(id),
                advertiser_id      BIGINT REFERENCES users(id),
                additional_limit   INTEGER NOT NULL,
                cost_ton           NUMERIC(18,8) NOT NULL,
                extended_at        TIMESTAMPTZ DEFAULT NOW()
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
            "CREATE INDEX IF NOT EXISTS idx_ref_commissions_ref     ON referral_commissions(referrer_id)",
            "CREATE INDEX IF NOT EXISTS idx_ref_commissions_friend  ON referral_commissions(friend_id)",
            "CREATE INDEX IF NOT EXISTS idx_task_extensions_task    ON task_extensions(task_id)",
            "CREATE INDEX IF NOT EXISTS idx_task_extensions_adv     ON task_extensions(advertiser_id)",
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
    if referrer_id == user_id:
        referrer_id = None
    if referrer_id:
        ref = await conn.fetchrow("SELECT id FROM users WHERE id = $1", referrer_id)
        if not ref:
            referrer_id = None

    comment_id = str(random.randint(100000, 999999))
    while True:
        existing = await conn.fetchrow(
            "SELECT id FROM users WHERE ton_comment_id = $1", comment_id
        )
        if not existing:
            break
        comment_id = str(random.randint(100000, 999999))

    ref_link = (
        f"https://t.me/{BOT_USERNAME}/{MINI_APP_SHORT_NAME}"
        f"?startapp=ref_{user_id}"
    )

    user = await conn.fetchrow("""
        INSERT INTO users (
            id, username, first_name, last_name,
            referrer_id, ton_comment_id, referral_link
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
            username      = EXCLUDED.username,
            first_name    = EXCLUDED.first_name,
            last_name     = EXCLUDED.last_name,
            referral_link = COALESCE(users.referral_link, EXCLUDED.referral_link)
        RETURNING *, (xmax = 0) AS is_new_insert
    """, user_id, username, first_name, last_name, referrer_id, comment_id, ref_link)

    is_new = user["is_new_insert"]
    actual_referrer = user["referrer_id"]

    if is_new and actual_referrer:
        await _credit_new_referral(conn, actual_referrer)

    return user


async def _credit_new_referral(conn, referrer_id: int):
    week_id    = _current_week_id()
    week_start = _current_week_start()

    await conn.execute("""
        UPDATE users
        SET
            total_friends           = total_friends + 1,
            weekly_friends          = CASE
                WHEN weekly_friends_reset_at IS NULL
                  OR weekly_friends_reset_at < $2
                THEN 1
                ELSE weekly_friends + 1
            END,
            weekly_friends_reset_at = $2
        WHERE id = $1
    """, referrer_id, week_start)

    await conn.execute("""
        INSERT INTO weekly_referral_stats (referrer_id, week_id, friend_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (referrer_id, week_id)
        DO UPDATE SET
            friend_count = weekly_referral_stats.friend_count + 1,
            updated_at   = NOW()
    """, referrer_id, week_id)


async def add_coins(conn, user_id: int, amount: int, tx_type: str, description: str):
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
                referrer_id = user["referrer_id"]

                await conn.execute("""
                    UPDATE users
                    SET
                        unclaimed_referral  = unclaimed_referral  + $1,
                        tr_earned_from_refs = tr_earned_from_refs + $1,
                        referral_earnings   = referral_earnings   + $1
                    WHERE id = $2
                """, commission, referrer_id)

                await conn.execute("""
                    INSERT INTO referral_commissions (referrer_id, friend_id, coins_earned)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (referrer_id, friend_id)
                    DO UPDATE SET
                        coins_earned = referral_commissions.coins_earned + $3,
                        updated_at   = NOW()
                """, referrer_id, user_id, commission)


async def add_spins(conn, user_id: int, amount: int):
    await conn.execute(
        "UPDATE users SET spins = spins + $1 WHERE id = $2", amount, user_id
    )


async def add_ton(conn, user_id: int, amount: float, tx_type: str, description: str):
    await conn.execute(
        "UPDATE users SET ton_balance = ton_balance + $1 WHERE id = $2", amount, user_id
    )
    await conn.execute("""
        INSERT INTO transactions (user_id, type, description, ton_amount)
        VALUES ($1, $2, $3, $4)
    """, user_id, tx_type, description, amount)


async def ensure_weekly_friends_reset(conn, user_id: int):
    week_start = _current_week_start()
    await conn.execute("""
        UPDATE users
        SET
            weekly_friends          = 0,
            weekly_friends_reset_at = $2
        WHERE id = $1
          AND (
              weekly_friends_reset_at IS NULL
              OR weekly_friends_reset_at < $2
          )
    """, user_id, week_start)
    return await get_user(conn, user_id)


# ─── Friends page helpers ─────────────────────────────────────────────────────

async def get_friends_page_data(conn, user_id: int, curr_week: str, prev_week: str):
    friends_rows, lb_rows, prev_rows = await conn.fetch("""
        SELECT
            u.id,
            u.first_name,
            u.username,
            u.coins,
            COALESCE(rc.coins_earned, 0) AS your_share
        FROM users u
        LEFT JOIN referral_commissions rc
               ON rc.referrer_id = $1 AND rc.friend_id = u.id
        WHERE u.referrer_id = $1
        ORDER BY u.created_at DESC
        LIMIT 10
    """, user_id), await conn.fetch("""
        SELECT w.referrer_id, u.first_name, u.username, w.friend_count
        FROM weekly_referral_stats w
        JOIN users u ON u.id = w.referrer_id
        WHERE w.week_id = $1
        ORDER BY w.friend_count DESC
        LIMIT 20
    """, curr_week), await conn.fetch("""
        SELECT w.referrer_id, u.first_name, u.username, w.friend_count
        FROM weekly_referral_stats w
        JOIN users u ON u.id = w.referrer_id
        WHERE w.week_id = $1
        ORDER BY w.friend_count DESC
        LIMIT 20
    """, prev_week)

    return friends_rows, lb_rows, prev_rows


# ─── Week helpers (Sunday → Saturday) ────────────────────────────────────────

def _sunday_week_id(d: date) -> str:
    days_since_sunday = (d.weekday() + 1) % 7
    week_start = d - timedelta(days=days_since_sunday)
    year = week_start.year
    jan1 = date(year, 1, 1)
    week_num = (week_start - jan1).days // 7 + 1
    return f"{year}-W{week_num:02d}"


def _current_week_start() -> date:
    d = date.today()
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _current_week_id() -> str:
    return _sunday_week_id(date.today())


def _prev_week_id() -> str:
    return _sunday_week_id(date.today() - timedelta(days=7))