-- ============================================================
-- TRewards — Complete Database Schema
-- Host: Supabase PostgreSQL
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  user_id       BIGINT PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  referrer_id   BIGINT,              -- NULL if no referrer
  coins         INTEGER     DEFAULT 0,
  spins         INTEGER     DEFAULT 1,
  streak        INTEGER     DEFAULT 1,
  last_seen     TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  created_at    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT no_self_referral CHECK (referrer_id IS NULL OR referrer_id <> user_id)
);

-- ─────────────────────────────────────────────────────────────
-- ADVERTISER BALANCE
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advertiser_balance (
  user_id       BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  balance_ton   DECIMAL(12,4) DEFAULT 0,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- PAYMENTS  (CryptoBot / xRocket)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount_ton    DECIMAL(10,4) NOT NULL,
  provider      TEXT        NOT NULL CHECK (provider IN ('cryptobot','xrocket')),
  invoice_id    TEXT        NOT NULL UNIQUE,   -- provider's invoice/payment ID
  status        TEXT        DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  created_at    TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  paid_at       TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_user    ON payments(user_id);

-- ─────────────────────────────────────────────────────────────
-- TASKS  (advertiser-created)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id               SERIAL PRIMARY KEY,
  title            TEXT        NOT NULL,
  description      TEXT,
  type             TEXT        NOT NULL CHECK (type IN ('visit','channel','group','game')),
  url              TEXT        NOT NULL,
  reward           INTEGER     NOT NULL DEFAULT 500,
  advertiser_id    BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  total_limit      INTEGER     NOT NULL DEFAULT 1000,
  completed_count  INTEGER     DEFAULT 0,
  status           TEXT        DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
  created_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_advertiser ON tasks(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);

-- ─────────────────────────────────────────────────────────────
-- TASK COMPLETIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_completions (
  id            SERIAL PRIMARY KEY,
  user_id       BIGINT    NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  task_id       INTEGER   NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reward        INTEGER   NOT NULL,
  status        TEXT      DEFAULT 'completed',
  completed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, task_id)   -- one completion per user per task
);
CREATE INDEX IF NOT EXISTS idx_tc_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_tc_task ON task_completions(task_id);

-- ─────────────────────────────────────────────────────────────
-- REFERRAL REWARDS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referral_rewards (
  id              SERIAL PRIMARY KEY,
  referrer_id     BIGINT    NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  referred_user   BIGINT    NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reward          INTEGER   NOT NULL,
  claimed         BOOLEAN   DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rr_referrer ON referral_rewards(referrer_id);

-- ─────────────────────────────────────────────────────────────
-- PROMO CODES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  code              TEXT    PRIMARY KEY,
  reward            INTEGER NOT NULL,
  activation_limit  INTEGER NOT NULL DEFAULT 1,   -- 0 = unlimited
  activations_used  INTEGER DEFAULT 0,
  created_by        BIGINT  REFERENCES users(user_id),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────
-- PROMO REDEMPTIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  code        TEXT    NOT NULL REFERENCES promo_codes(code),
  reward      INTEGER NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, code)    -- one redemption per user per code
);

-- ─────────────────────────────────────────────────────────────
-- SPIN HISTORY
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_history (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reward      INTEGER NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_spin_user ON spin_history(user_id);

-- ─────────────────────────────────────────────────────────────
-- WITHDRAWALS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id              SERIAL PRIMARY KEY,
  user_id         BIGINT          NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  coins_spent     INTEGER         NOT NULL,
  ton_amount      DECIMAL(10,4)   NOT NULL,
  wallet_address  TEXT,           -- user's TON wallet (filled when implemented)
  status          TEXT            DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wd_user ON withdrawals(user_id);

-- ─────────────────────────────────────────────────────────────
-- TRANSACTIONS  (general ledger)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL  PRIMARY KEY,
  user_id     BIGINT  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,   -- earn_task / earn_spin / earn_referral / earn_promo / withdraw / streak
  amount      INTEGER NOT NULL,   -- positive = credit, negative = debit
  description TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);

-- ─────────────────────────────────────────────────────────────
-- DAILY TASKS TRACKING
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_tasks (
  id          SERIAL PRIMARY KEY,
  user_id     BIGINT  NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  task_name   TEXT    NOT NULL,   -- checkin / visit_channel / share
  completed   BOOLEAN DEFAULT FALSE,
  date        DATE    NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (user_id, task_name, date)
);
CREATE INDEX IF NOT EXISTS idx_dt_user_date ON daily_tasks(user_id, date);

-- ─────────────────────────────────────────────────────────────
-- HELPER: auto-update advertiser_balance.updated_at
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_advertiser_ts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_advertiser_balance_ts ON advertiser_balance;
CREATE TRIGGER trg_advertiser_balance_ts
  BEFORE UPDATE ON advertiser_balance
  FOR EACH ROW EXECUTE FUNCTION update_advertiser_ts();

-- ─────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (Supabase)
-- Enable RLS so only your backend service_role key bypasses it.
-- The backend always uses the service_role key — safe.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE advertiser_balance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks               ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_completions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_rewards    ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_codes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_redemptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE spin_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_tasks         ENABLE ROW LEVEL SECURITY;

-- Allow full access to service_role (your backend)
-- All other roles are denied by default (RLS blocks them)
-- No public anon access needed since the Mini App talks to your backend only.

-- ─────────────────────────────────────────────────────────────
-- VERIFY SETUP
-- ─────────────────────────────────────────────────────────────
-- Run this to confirm all tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' ORDER BY table_name;