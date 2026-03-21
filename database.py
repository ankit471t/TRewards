import asyncpg
from config import DATABASE_URL
import logging

logger = logging.getLogger(__name__)

pool = None


async def get_pool():
    global pool
    if pool is None:
        pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=2,
            max_size=10,
            statement_cache_size=0,   # required for Supabase pooler (pgBouncer)
        )
    return pool


async def init_db():
    p = await get_pool()
    async with p.acquire() as conn:

        # ── Users ──────────────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                  BIGINT PRIMARY KEY,
                username            TEXT,
                first_name          TEXT,
                last_name           TEXT,
                coins               BIGINT          DEFAULT 0,
                spins               INTEGER         DEFAULT 0,
                streak              INTEGER         DEFAULT 0,
                last_streak_date    DATE,
                streak_started      DATE,
                referrer_id         BIGINT          REFERENCES users(id),
                referral_earnings   BIGINT          DEFAULT 0,
                unclaimed_referral  BIGINT          DEFAULT 0,
                ton_balance         NUMERIC(18,8)   DEFAULT 0,
                ad_balance          NUMERIC(18,8)   DEFAULT 0,
                language            TEXT            DEFAULT 'en',
                created_at          TIMESTAMPTZ     DEFAULT NOW()
            )
        """)

        # ── Transactions ───────────────────────────────────────────────────────
        # type values: streak | spin | task | daily_task | promo | referral |
        #              withdrawal | topup | watch_ad | convert
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id          SERIAL PRIMARY KEY,
                user_id     BIGINT          REFERENCES users(id),
                type        TEXT            NOT NULL,
                description TEXT,
                amount      BIGINT,          -- TR coins (positive = credit, negative = debit)
                ton_amount  NUMERIC(18,8),   -- TON amount (positive = credit, negative = debit)
                created_at  TIMESTAMPTZ     DEFAULT NOW()
            )
        """)

        # ── Tasks (advertiser tasks) ───────────────────────────────────────────
        # reward_coins updated values: visit=3000, channel/group/game=5000
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id               SERIAL PRIMARY KEY,
                advertiser_id    BIGINT          REFERENCES users(id),
                name             TEXT            NOT NULL,
                type             TEXT            NOT NULL
                                 CHECK (type IN ('visit','channel','group','game')),
                url              TEXT            NOT NULL,
                reward_coins     INTEGER         NOT NULL,
                completion_limit INTEGER         NOT NULL,
                completed_count  INTEGER         DEFAULT 0,
                cost_ton         NUMERIC(18,8)   NOT NULL,
                status           TEXT            DEFAULT 'active'
                                 CHECK (status IN ('active','paused','completed')),
                created_at       TIMESTAMPTZ     DEFAULT NOW()
            )
        """)

        # ── Task completions ───────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS task_completions (
                id           SERIAL PRIMARY KEY,
                task_id      INTEGER     REFERENCES tasks(id),
                user_id      BIGINT      REFERENCES users(id),
                completed_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(task_id, user_id)
            )
        """)

        # ── Daily task completions ─────────────────────────────────────────────
        # task_type: checkin | update | share
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS daily_task_completions (
                id             SERIAL PRIMARY KEY,
                user_id        BIGINT  REFERENCES users(id),
                task_type      TEXT    NOT NULL,
                completed_date DATE    NOT NULL DEFAULT CURRENT_DATE,
                UNIQUE(user_id, task_type, completed_date)
            )
        """)

        # ── Watch ad completions ───────────────────────────────────────────────
        # Tracks when a user last watched each ad slot so we can enforce
        # the 5-minute cooldown without scanning the transactions table.
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS watch_ad_completions (
                id          SERIAL PRIMARY KEY,
                user_id     BIGINT      REFERENCES users(id),
                ad_id       TEXT        NOT NULL,
                watched_at  TIMESTAMPTZ DEFAULT NOW(),
                coins_earned INTEGER    NOT NULL DEFAULT 0,
                UNIQUE(user_id, ad_id, watched_at)   -- allow multiple over time
            )
        """)
        # Separate index so the cooldown query is fast
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_watch_ad_user_adid
            ON watch_ad_completions(user_id, ad_id, watched_at DESC)
        """)

        # ── Promo codes ────────────────────────────────────────────────────────
        # reward_type: 'coins' (TR) or 'ton'
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes (
                id                  SERIAL PRIMARY KEY,
                code                TEXT            UNIQUE NOT NULL,
                reward_type         TEXT            NOT NULL
                                    CHECK (reward_type IN ('coins','ton')),
                reward_amount       NUMERIC(18,8)   NOT NULL,
                max_activations     INTEGER         NOT NULL,
                current_activations INTEGER         DEFAULT 0,
                created_by          BIGINT          REFERENCES users(id),
                is_active           BOOLEAN         DEFAULT TRUE,
                created_at          TIMESTAMPTZ     DEFAULT NOW()
            )
        """)

        # ── Promo activations ──────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS promo_activations (
                id           SERIAL PRIMARY KEY,
                promo_id     INTEGER     REFERENCES promo_codes(id),
                user_id      BIGINT      REFERENCES users(id),
                activated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(promo_id, user_id)
            )
        """)

        # ── Payments (ad balance top-up) ───────────────────────────────────────
        # provider: 'xrocket' | 'cryptopay'
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS payments (
                id          SERIAL PRIMARY KEY,
                user_id     BIGINT          REFERENCES users(id),
                provider    TEXT            NOT NULL,
                invoice_id  TEXT            UNIQUE NOT NULL,
                amount_ton  NUMERIC(18,8)   NOT NULL,
                status      TEXT            DEFAULT 'pending',
                payload     TEXT,
                created_at  TIMESTAMPTZ     DEFAULT NOW(),
                paid_at     TIMESTAMPTZ
            )
        """)

        # ── Withdrawals ────────────────────────────────────────────────────────
        # Updated tiers: 1M/2M/3M/10M TR, fee 0.03 TON (last tier free)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS withdrawals (
                id              SERIAL PRIMARY KEY,
                user_id         BIGINT          REFERENCES users(id),
                coins_deducted  BIGINT          NOT NULL,
                ton_amount      NUMERIC(18,8)   NOT NULL,
                net_ton         NUMERIC(18,8)   NOT NULL,
                fee_ton         NUMERIC(18,8)   NOT NULL DEFAULT 0.03,
                wallet_address  TEXT,
                status          TEXT            DEFAULT 'pending'
                                CHECK (status IN ('pending','processing','paid','failed')),
                created_at      TIMESTAMPTZ     DEFAULT NOW(),
                processed_at    TIMESTAMPTZ
            )
        """)

        # ── Spin history ───────────────────────────────────────────────────────
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS spin_history (
                id           SERIAL PRIMARY KEY,
                user_id      BIGINT  REFERENCES users(id),
                result_coins INTEGER NOT NULL,
                segment_index INTEGER,           -- 0-5, equal weight
                spun_at      TIMESTAMPTZ DEFAULT NOW()
            )
        """)

        # ── Convert history ────────────────────────────────────────────────────
        # Tracks TR → TON conversions (rate: 1,000,000 TR = 0.15 TON)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS convert_history (
                id           SERIAL PRIMARY KEY,
                user_id      BIGINT          REFERENCES users(id),
                tr_amount    BIGINT          NOT NULL,
                ton_received NUMERIC(18,8)   NOT NULL,
                rate         NUMERIC(18,8)   NOT NULL DEFAULT 0.00000015,
                created_at   TIMESTAMPTZ     DEFAULT NOW()
            )
        """)

        # ── Indexes ────────────────────────────────────────────────────────────
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_transactions_user    ON transactions(user_id, created_at DESC)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_transactions_type    ON transactions(type)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_task_comp_user       ON task_completions(user_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_task_comp_task       ON task_completions(task_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_daily_task_user      ON daily_task_completions(user_id, completed_date)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_invoice     ON payments(invoice_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_payments_user        ON payments(user_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_withdrawals_user     ON withdrawals(user_id, created_at DESC)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_withdrawals_status   ON withdrawals(status)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_spin_history_user    ON spin_history(user_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_convert_history_user ON convert_history(user_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_promo_act_user       ON promo_activations(user_id)")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_users_referrer       ON users(referrer_id)")

        # ── Run migrations for existing deployments ────────────────────────────
        await _run_migrations(conn)

        logger.info("Database initialized successfully")


async def _run_migrations(conn):
    """
    Safe ALTER TABLE migrations so existing live databases get new columns
    without needing a full wipe. Each statement is wrapped in its own
    try/except so one failure doesn't block the rest.
    """
    migrations = [
        # withdrawals: add fee_ton column if missing
        "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_ton NUMERIC(18,8) NOT NULL DEFAULT 0.03",
        # spin_history: add segment_index column if missing
        "ALTER TABLE spin_history ADD COLUMN IF NOT EXISTS segment_index INTEGER",
        # watch_ad_completions table (already handled above via CREATE IF NOT EXISTS)
        # convert_history table (already handled above via CREATE IF NOT EXISTS)
    ]
    for sql in migrations:
        try:
            await conn.execute(sql)
        except Exception as e:
            logger.warning(f"Migration skipped (probably already applied): {e}")


# ═══════════════════════════════════════════════════════════════
# CRUD HELPERS
# ═══════════════════════════════════════════════════════════════

async def get_user(conn, user_id: int):
    return await conn.fetchrow("SELECT * FROM users WHERE id = $1", user_id)


async def create_user(
    conn,
    user_id: int,
    username: str,
    first_name: str,
    last_name: str,
    referrer_id: int = None
):
    # Prevent self-referral
    if referrer_id == user_id:
        referrer_id = None

    # Verify referrer exists
    if referrer_id:
        ref = await conn.fetchrow("SELECT id FROM users WHERE id = $1", referrer_id)
        if not ref:
            referrer_id = None

    return await conn.fetchrow("""
        INSERT INTO users (id, username, first_name, last_name, referrer_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
            username   = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            last_name  = EXCLUDED.last_name
        RETURNING *
    """, user_id, username, first_name, last_name, referrer_id)


async def add_coins(conn, user_id: int, amount: int, tx_type: str, description: str):
    """
    Add `amount` TR coins to user and insert a transaction record.
    Automatically credits 30% referral commission to the referrer
    (stored in unclaimed_referral — claimed manually via /api/claim-referral).
    """
    await conn.execute(
        "UPDATE users SET coins = coins + $1 WHERE id = $2",
        amount, user_id
    )
    await conn.execute("""
        INSERT INTO transactions (user_id, type, description, amount)
        VALUES ($1, $2, $3, $4)
    """, user_id, tx_type, description, amount)

    # Referral commission — only on positive coin credits
    if amount > 0:
        user = await conn.fetchrow("SELECT referrer_id FROM users WHERE id = $1", user_id)
        if user and user["referrer_id"]:
            commission = int(amount * 0.30)   # 30%
            if commission > 0:
                await conn.execute("""
                    UPDATE users
                    SET unclaimed_referral  = unclaimed_referral  + $1,
                        referral_earnings   = referral_earnings   + $1
                    WHERE id = $2
                """, commission, user["referrer_id"])


async def add_spins(conn, user_id: int, amount: int):
    await conn.execute(
        "UPDATE users SET spins = spins + $1 WHERE id = $2",
        amount, user_id
    )