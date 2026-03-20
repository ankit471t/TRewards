CREATE TABLE IF NOT EXISTS users (
    user_id BIGINT PRIMARY KEY,
    first_name VARCHAR(100) DEFAULT '',
    last_name VARCHAR(100) DEFAULT '',
    username VARCHAR(100) DEFAULT '',
    balance BIGINT DEFAULT 0,
    spins INTEGER DEFAULT 3,
    streak INTEGER DEFAULT 0,
    last_streak_date DATE,
    referrer_id BIGINT DEFAULT NULL,
    ad_balance NUMERIC DEFAULT 0,
    ton_balance NUMERIC DEFAULT 0,
    daily_tasks_completed JSONB DEFAULT '[]',
    daily_tasks_reset_date DATE,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    advertiser_id BIGINT,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL,
    url TEXT NOT NULL,
    reward INTEGER DEFAULT 5000,
    completion_limit INTEGER DEFAULT 500,
    completed_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_completions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    task_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    reward_type VARCHAR(10) NOT NULL,
    reward_amount NUMERIC DEFAULT 0,
    max_activations INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    created_by BIGINT DEFAULT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promo_activations (
    id SERIAL PRIMARY KEY,
    promo_id INTEGER NOT NULL,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (promo_id, user_id)
);

CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    invoice_id VARCHAR(100) UNIQUE NOT NULL,
    amount NUMERIC DEFAULT 0,
    method VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    target VARCHAR(20) DEFAULT 'wallet',
    created_at TIMESTAMP DEFAULT NOW(),
    paid_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    tr_amount BIGINT NOT NULL,
    ton_gross NUMERIC DEFAULT 0,
    ton_net NUMERIC DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    type VARCHAR(20) DEFAULT 'withdraw',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spin_history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    reward INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    type VARCHAR(30) NOT NULL,
    description TEXT DEFAULT '',
    amount NUMERIC DEFAULT 0,
    currency VARCHAR(10) DEFAULT 'TR',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_earnings (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    from_user_id BIGINT NOT NULL,
    pending_amount BIGINT DEFAULT 0,
    claimed BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_completions_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);