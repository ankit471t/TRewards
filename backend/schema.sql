-- TRewards Database Schema
-- Safe to run multiple times. Uses IF NOT EXISTS everywhere.
-- Run this in Supabase SQL editor before first deploy.

-- ─── TABLES ────────────────────────────────────────────────────────────────────

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

-- ─── INDEXES ──────────────────────────────────────────────────────────────────
-- Run each line below ONE AT A TIME in Supabase SQL editor if you want indexes.
-- They are optional — the app works without them. FastAPI startup skips them safely.
--
-- CREATE INDEX IF NOT EXISTS idx_transactions_user     ON transactions(user_id);
-- CREATE INDEX IF NOT EXISTS idx_transactions_created  ON transactions(created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_tasks_status          ON tasks(status);
-- CREATE INDEX IF NOT EXISTS idx_tasks_user            ON tasks(user_id);
-- CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);
-- CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id);
-- CREATE INDEX IF NOT EXISTS idx_withdrawals_user      ON withdrawals(user_id);
-- CREATE INDEX IF NOT EXISTS idx_withdrawals_status    ON withdrawals(status);
-- CREATE INDEX IF NOT EXISTS idx_referral_referrer     ON referral_earnings(referrer_id);
-- CREATE INDEX IF NOT EXISTS idx_referral_claimed      ON referral_earnings(claimed);
-- CREATE INDEX IF NOT EXISTS idx_payments_invoice      ON payments(invoice_id);
-- CREATE INDEX IF NOT EXISTS idx_payments_user         ON payments(user_id);