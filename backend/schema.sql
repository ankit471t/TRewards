-- TRewards Database Schema
-- Run this in Supabase SQL Editor

-- Users table
CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT PRIMARY KEY,
    first_name VARCHAR(100) DEFAULT '',
    last_name VARCHAR(100) DEFAULT '',
    username VARCHAR(100) DEFAULT '',
    balance BIGINT DEFAULT 0,
    spins INTEGER DEFAULT 3,
    streak INTEGER DEFAULT 0,
    last_streak_date DATE,
    referrer_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
    ad_balance DECIMAL(18,8) DEFAULT 0,
    ton_balance DECIMAL(18,8) DEFAULT 0,
    daily_tasks_completed JSONB DEFAULT '[]'::jsonb,
    daily_tasks_reset_date DATE,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Tasks (advertiser tasks)
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    advertiser_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('channel','group','game','website')),
    url TEXT NOT NULL,
    reward INTEGER DEFAULT 5000,
    completion_limit INTEGER DEFAULT 500,
    completed_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Task completions
CREATE TABLE IF NOT EXISTS task_completions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, task_id)
);

-- Promo codes
CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    reward_type VARCHAR(10) NOT NULL CHECK (reward_type IN ('tr','ton')),
    reward_amount DECIMAL(18,4) NOT NULL,
    max_activations INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    created_by BIGINT REFERENCES users(user_id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Promo activations
CREATE TABLE IF NOT EXISTS promo_activations (
    id SERIAL PRIMARY KEY,
    promo_id INTEGER REFERENCES promo_codes(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(promo_id, user_id)
);

-- Payments (top-up invoices)
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    invoice_id VARCHAR(100) UNIQUE NOT NULL,
    amount DECIMAL(18,8) NOT NULL,
    method VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','failed')),
    target VARCHAR(20) DEFAULT 'wallet',
    created_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP
);

-- Withdrawals
CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    tr_amount BIGINT NOT NULL,
    ton_gross DECIMAL(18,8) NOT NULL,
    ton_net DECIMAL(18,8) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','completed','declined')),
    type VARCHAR(20) DEFAULT 'withdraw',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Spin history
CREATE TABLE IF NOT EXISTS spin_history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    reward INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Transactions (unified log)
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    description TEXT DEFAULT '',
    amount DECIMAL(18,4) NOT NULL,
    currency VARCHAR(10) DEFAULT 'TR',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Referral earnings
CREATE TABLE IF NOT EXISTS referral_earnings (
    id SERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    from_user_id BIGINT REFERENCES users(user_id) ON DELETE CASCADE,
    pending_amount BIGINT DEFAULT 0,
    claimed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_advertiser ON tasks(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_completions_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_completions_task ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_ref_earnings_user ON referral_earnings(user_id, claimed);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);