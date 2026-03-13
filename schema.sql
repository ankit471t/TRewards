-- ============================================================
-- TRewards — Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id                    BIGSERIAL PRIMARY KEY,
  telegram_id           BIGINT UNIQUE NOT NULL,
  username              TEXT DEFAULT '',
  first_name            TEXT DEFAULT '',
  last_name             TEXT DEFAULT '',
  coins                 BIGINT DEFAULT 0,
  spins                 INT DEFAULT 1,
  streak_days           INT DEFAULT 0,
  streak_claimed_today  BOOLEAN DEFAULT FALSE,
  last_streak_date      DATE,
  referrer_id           BIGINT REFERENCES users(telegram_id),
  pending_referral_coins BIGINT DEFAULT 0,
  ad_balance            NUMERIC(12,6) DEFAULT 0,
  daily_tasks_claimed   JSONB DEFAULT '[]',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  type        TEXT NOT NULL,   -- spin|task|streak|referral|promo|withdraw|topup|daily
  amount      NUMERIC(14,6) NOT NULL,
  currency    TEXT DEFAULT 'TR',
  description TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(telegram_id, created_at DESC);

-- TASKS (advertiser tasks)
CREATE TABLE IF NOT EXISTS tasks (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  task_type        TEXT NOT NULL,  -- channel|group|game|website
  target_url       TEXT NOT NULL,
  completion_limit INT DEFAULT 500,
  completions      INT DEFAULT 0,
  status           TEXT DEFAULT 'active',  -- active|paused|completed
  created_by       BIGINT REFERENCES users(telegram_id),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- TASK COMPLETIONS
CREATE TABLE IF NOT EXISTS task_completions (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  task_id     BIGINT NOT NULL REFERENCES tasks(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(telegram_id, task_id)
);

-- PROMO CODES
CREATE TABLE IF NOT EXISTS promo_codes (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  reward_type     TEXT NOT NULL,   -- coins|ton
  reward_amount   NUMERIC(14,6) NOT NULL,
  max_activations INT DEFAULT 100,
  activations     INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- PROMO ACTIVATIONS
CREATE TABLE IF NOT EXISTS promo_activations (
  id          BIGSERIAL PRIMARY KEY,
  promo_id    BIGINT NOT NULL REFERENCES promo_codes(id),
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(promo_id, telegram_id)
);

-- PAYMENTS (top-ups)
CREATE TABLE IF NOT EXISTS payments (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  amount      NUMERIC(12,6) NOT NULL,
  method      TEXT NOT NULL,   -- xrocket|cryptopay
  status      TEXT DEFAULT 'pending',  -- pending|paid|failed
  invoice_id  TEXT,
  description TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id) WHERE invoice_id IS NOT NULL;

-- WITHDRAWALS
CREATE TABLE IF NOT EXISTS withdrawals (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  coins_spent BIGINT NOT NULL,
  ton_gross   NUMERIC(12,6) NOT NULL,
  ton_net     NUMERIC(12,6) NOT NULL,
  status      TEXT DEFAULT 'pending',  -- pending|processing|paid|failed
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- SPIN HISTORY
CREATE TABLE IF NOT EXISTS spin_history (
  id          BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  coins_won   INT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security (disable for server-side access via service key)
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE task_completions DISABLE ROW LEVEL SECURITY;
ALTER TABLE promo_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE promo_activations DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals DISABLE ROW LEVEL SECURITY;
ALTER TABLE spin_history DISABLE ROW LEVEL SECURITY;