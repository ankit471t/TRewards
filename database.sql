-- ═══════════════════════════════════════════════════════════
-- TRewards Database Schema — Supabase PostgreSQL
-- HOW TO USE:
-- 1. Go to Supabase → SQL Editor → New Query
-- 2. Paste this entire file
-- 3. Click Run
-- ═══════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════
-- STEP 1: DROP ALL EXISTING TABLES
-- ═══════════════════════════════════════════
DROP TABLE IF EXISTS adv_topups              CASCADE;
DROP TABLE IF EXISTS referral_earnings       CASCADE;
DROP TABLE IF EXISTS promo_activations       CASCADE;
DROP TABLE IF EXISTS promo_codes             CASCADE;
DROP TABLE IF EXISTS withdrawals             CASCADE;
DROP TABLE IF EXISTS daily_task_completions  CASCADE;
DROP TABLE IF EXISTS task_completions        CASCADE;
DROP TABLE IF EXISTS tasks                   CASCADE;
DROP TABLE IF EXISTS transactions            CASCADE;
DROP TABLE IF EXISTS users                   CASCADE;


-- ═══════════════════════════════════════════
-- STEP 2: CREATE ALL TABLES
-- ═══════════════════════════════════════════

CREATE TABLE users (
  id            BIGSERIAL    PRIMARY KEY,
  telegram_id   TEXT         UNIQUE NOT NULL,
  first_name    TEXT         NOT NULL DEFAULT '',
  username      TEXT         NOT NULL DEFAULT '',
  balance       INTEGER      NOT NULL DEFAULT 0,
  spins         INTEGER      NOT NULL DEFAULT 1,
  streak        INTEGER      NOT NULL DEFAULT 0,
  last_checkin  TEXT         DEFAULT NULL,
  referrer_id   TEXT         DEFAULT NULL,
  adv_balance   NUMERIC      NOT NULL DEFAULT 0,
  is_banned     INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE transactions (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  type        TEXT         NOT NULL,
  description TEXT         NOT NULL DEFAULT '',
  amount      INTEGER      NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks (
  id                BIGSERIAL    PRIMARY KEY,
  advertiser_id     TEXT         NOT NULL,
  name              TEXT         NOT NULL,
  type              TEXT         NOT NULL CHECK(type IN ('visit','channel','group','game')),
  url               TEXT         NOT NULL,
  reward            INTEGER      NOT NULL DEFAULT 500,
  limit_completions INTEGER      NOT NULL DEFAULT 1000,
  completions       INTEGER      NOT NULL DEFAULT 0,
  status            TEXT         NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE task_completions (
  id           BIGSERIAL    PRIMARY KEY,
  task_id      INTEGER      NOT NULL,
  user_id      TEXT         NOT NULL,
  completed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, user_id)
);

CREATE TABLE daily_task_completions (
  id         BIGSERIAL    PRIMARY KEY,
  user_id    TEXT         NOT NULL,
  task_type  TEXT         NOT NULL,
  date       TEXT         NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, task_type, date)
);

CREATE TABLE withdrawals (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  coins       INTEGER      NOT NULL,
  ton_amount  NUMERIC      NOT NULL,
  net_amount  NUMERIC      NOT NULL,
  status      TEXT         NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','rejected')),
  tx_hash     TEXT         DEFAULT NULL,
  notes       TEXT         NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE promo_codes (
  id           BIGSERIAL    PRIMARY KEY,
  code         TEXT         UNIQUE NOT NULL,
  reward       INTEGER      NOT NULL,
  max_uses     INTEGER      NOT NULL DEFAULT 100,
  current_uses INTEGER      NOT NULL DEFAULT 0,
  active       INTEGER      NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE promo_activations (
  id           BIGSERIAL    PRIMARY KEY,
  code_id      INTEGER      NOT NULL,
  user_id      TEXT         NOT NULL,
  activated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(code_id, user_id)
);

CREATE TABLE referral_earnings (
  id          BIGSERIAL    PRIMARY KEY,
  referrer_id TEXT         NOT NULL,
  referee_id  TEXT         NOT NULL,
  amount      INTEGER      NOT NULL,
  claimed     INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE adv_topups (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     TEXT         NOT NULL,
  ton_amount  NUMERIC      NOT NULL,
  tx_hash     TEXT         DEFAULT NULL,
  status      TEXT         NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);


-- ═══════════════════════════════════════════
-- STEP 3: INDEXES
-- ═══════════════════════════════════════════
CREATE INDEX idx_users_telegram_id       ON users(telegram_id);
CREATE INDEX idx_users_referrer          ON users(referrer_id);
CREATE INDEX idx_transactions_user       ON transactions(user_id);
CREATE INDEX idx_transactions_created    ON transactions(created_at);
CREATE INDEX idx_tasks_status            ON tasks(status);
CREATE INDEX idx_tasks_advertiser        ON tasks(advertiser_id);
CREATE INDEX idx_task_completions_user   ON task_completions(user_id);
CREATE INDEX idx_task_completions_task   ON task_completions(task_id);
CREATE INDEX idx_daily_completions       ON daily_task_completions(user_id, date);
CREATE INDEX idx_withdrawals_user        ON withdrawals(user_id);
CREATE INDEX idx_withdrawals_status      ON withdrawals(status);
CREATE INDEX idx_promo_codes_code        ON promo_codes(code);
CREATE INDEX idx_promo_activations_code  ON promo_activations(code_id);
CREATE INDEX idx_promo_activations_user  ON promo_activations(user_id);
CREATE INDEX idx_referral_referrer       ON referral_earnings(referrer_id);
CREATE INDEX idx_referral_unclaimed      ON referral_earnings(referrer_id, claimed);


-- ═══════════════════════════════════════════
-- STEP 4: AUTO UPDATE TRIGGER
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_withdrawals_updated_at
  BEFORE UPDATE ON withdrawals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ═══════════════════════════════════════════
-- STEP 5: DISABLE ROW LEVEL SECURITY
-- This is required so your backend can
-- read and write all rows without being blocked
-- ═══════════════════════════════════════════
ALTER TABLE users                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions           DISABLE ROW LEVEL SECURITY;
ALTER TABLE tasks                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE task_completions       DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_task_completions DISABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals            DISABLE ROW LEVEL SECURITY;
ALTER TABLE promo_codes            DISABLE ROW LEVEL SECURITY;
ALTER TABLE promo_activations      DISABLE ROW LEVEL SECURITY;
ALTER TABLE referral_earnings      DISABLE ROW LEVEL SECURITY;
ALTER TABLE adv_topups             DISABLE ROW LEVEL SECURITY;


-- ═══════════════════════════════════════════
-- OPTIONAL: SEED PROMO CODES FOR TESTING
-- Uncomment lines below to add starter codes
-- ═══════════════════════════════════════════
-- INSERT INTO promo_codes (code, reward, max_uses)
-- VALUES ('WELCOME', 100, 10000);

-- INSERT INTO promo_codes (code, reward, max_uses)
-- VALUES ('LAUNCH500', 500, 1000);


-- ═══════════════════════════════════════════
-- DONE! You should see "Success" below.
-- Go to Table Editor to verify all 10 tables.
-- ═══════════════════════════════════════════