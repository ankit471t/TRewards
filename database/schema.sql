-- ═══════════════════════════════════════
-- TREWARDS — SCHEMA.SQL
-- Complete PostgreSQL Database Schema
-- ═══════════════════════════════════════

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                        SERIAL PRIMARY KEY,
  telegram_id               BIGINT UNIQUE NOT NULL,
  first_name                VARCHAR(255),
  last_name                 VARCHAR(255),
  username                  VARCHAR(255),
  referrer_id               BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,

  -- Coins & Economy
  coins                     BIGINT DEFAULT 0 CHECK (coins >= 0),
  spins                     INTEGER DEFAULT 3 CHECK (spins >= 0),
  ton_balance               DECIMAL(18, 9) DEFAULT 0 CHECK (ton_balance >= 0),
  ad_balance                DECIMAL(18, 9) DEFAULT 0 CHECK (ad_balance >= 0),

  -- Referral
  pending_referral          BIGINT DEFAULT 0,
  total_earned_from_referrals BIGINT DEFAULT 0,

  -- Streak
  streak_count              INTEGER DEFAULT 0,
  streak_claimed_today      BOOLEAN DEFAULT FALSE,

  -- Daily Tasks
  daily_checkin_claimed     BOOLEAN DEFAULT FALSE,
  daily_updates_claimed     BOOLEAN DEFAULT FALSE,
  daily_share_claimed       BOOLEAN DEFAULT FALSE,
  last_daily_reset          TIMESTAMP WITH TIME ZONE,

  -- Metadata
  created_at                TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at                TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_referrer_id ON users(referrer_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── TRANSACTIONS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id            SERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  description   VARCHAR(500),
  amount        DECIMAL(18, 9) NOT NULL,
  is_ton        BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_telegram_id ON transactions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

-- ── TASKS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                  SERIAL PRIMARY KEY,
  advertiser_id       BIGINT NOT NULL REFERENCES users(telegram_id),
  task_name           VARCHAR(255) NOT NULL,
  task_type           VARCHAR(50) NOT NULL CHECK (task_type IN ('channel', 'group', 'game', 'visit')),
  target_url          TEXT NOT NULL,
  completion_target   INTEGER NOT NULL CHECK (completion_target IN (500, 1000, 2000, 5000, 10000)),
  completed_count     INTEGER DEFAULT 0,
  status              VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_advertiser_id ON tasks(advertiser_id);

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── TASK COMPLETIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_completions (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id),
  completed_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(task_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_task_completions_task_id ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_telegram_id ON task_completions(telegram_id);

-- ── PROMO CODES ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id                  SERIAL PRIMARY KEY,
  code                VARCHAR(50) UNIQUE NOT NULL,
  reward_amount       DECIMAL(18, 9) NOT NULL CHECK (reward_amount > 0),
  reward_type         VARCHAR(10) NOT NULL DEFAULT 'coins' CHECK (reward_type IN ('coins', 'ton')),
  max_activations     INTEGER,  -- NULL = unlimited
  activation_count    INTEGER DEFAULT 0,
  is_active           BOOLEAN DEFAULT TRUE,
  created_by          BIGINT,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active);

-- ── PROMO ACTIVATIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_activations (
  id              SERIAL PRIMARY KEY,
  promo_code_id   INTEGER NOT NULL REFERENCES promo_codes(id),
  telegram_id     BIGINT NOT NULL REFERENCES users(telegram_id),
  activated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(promo_code_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_activations_code_id ON promo_activations(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_activations_telegram_id ON promo_activations(telegram_id);

-- ── PAYMENTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  invoice_id    VARCHAR(255) UNIQUE NOT NULL,
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id),
  amount        DECIMAL(18, 9) NOT NULL CHECK (amount > 0),
  asset         VARCHAR(20) NOT NULL DEFAULT 'TON',
  provider      VARCHAR(20) NOT NULL CHECK (provider IN ('xrocket', 'cryptopay')),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  paid_at       TIMESTAMP WITH TIME ZONE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_telegram_id ON payments(telegram_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ── WITHDRAWALS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id                SERIAL PRIMARY KEY,
  telegram_id       BIGINT NOT NULL REFERENCES users(telegram_id),
  coins_amount      BIGINT NOT NULL,
  ton_amount        DECIMAL(18, 9) NOT NULL,
  net_ton_amount    DECIMAL(18, 9) NOT NULL,
  wallet_address    VARCHAR(255),
  status            VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  admin_note        TEXT,
  processed_at      TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id ON withdrawals(telegram_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- ── SPIN HISTORY ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_history (
  id            SERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id),
  result        INTEGER NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spin_history_telegram_id ON spin_history(telegram_id);

-- ═══════════════════════════════════════
-- SEED: Default admin promo codes
-- ═══════════════════════════════════════

INSERT INTO promo_codes (code, reward_amount, reward_type, max_activations, is_active)
VALUES
  ('WELCOME', 500, 'coins', 1000, true),
  ('LAUNCH2024', 1000, 'coins', 500, true),
  ('VIPBONUS', 0.1, 'ton', 100, true)
ON CONFLICT (code) DO NOTHING;