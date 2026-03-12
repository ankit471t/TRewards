DROP TABLE IF EXISTS spin_history CASCADE;
DROP TABLE IF EXISTS withdrawals CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS promo_activations CASCADE;
DROP TABLE IF EXISTS promo_codes CASCADE;
DROP TABLE IF EXISTS task_completions CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;
CREATE TABLE users (
  id                          SERIAL PRIMARY KEY,
  telegram_id                 BIGINT UNIQUE NOT NULL,
  first_name                  VARCHAR(255),
  last_name                   VARCHAR(255),
  username                    VARCHAR(255),
  referrer_id                 BIGINT,
  coins                       BIGINT DEFAULT 0,
  spins                       INTEGER DEFAULT 3,
  ton_balance                 DECIMAL(18,9) DEFAULT 0,
  ad_balance                  DECIMAL(18,9) DEFAULT 0,
  pending_referral            BIGINT DEFAULT 0,
  total_earned_from_referrals BIGINT DEFAULT 0,
  streak_count                INTEGER DEFAULT 0,
  streak_claimed_today        BOOLEAN DEFAULT FALSE,
  daily_checkin_claimed       BOOLEAN DEFAULT FALSE,
  daily_updates_claimed       BOOLEAN DEFAULT FALSE,
  daily_share_claimed         BOOLEAN DEFAULT FALSE,
  last_daily_reset            TIMESTAMP WITH TIME ZONE,
  created_at                  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at                  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE transactions (
  id            SERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  type          VARCHAR(50) NOT NULL,
  description   VARCHAR(500),
  amount        DECIMAL(18,9) NOT NULL,
  is_ton        BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE tasks (
  id                  SERIAL PRIMARY KEY,
  advertiser_id       BIGINT NOT NULL,
  task_name           VARCHAR(255) NOT NULL,
  task_type           VARCHAR(50) NOT NULL,
  target_url          TEXT NOT NULL,
  completion_target   INTEGER NOT NULL,
  completed_count     INTEGER DEFAULT 0,
  status              VARCHAR(20) DEFAULT 'active',
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE task_completions (
  id            SERIAL PRIMARY KEY,
  task_id       INTEGER NOT NULL,
  telegram_id   BIGINT NOT NULL,
  completed_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(task_id, telegram_id)
);

CREATE TABLE promo_codes (
  id                  SERIAL PRIMARY KEY,
  code                VARCHAR(50) UNIQUE NOT NULL,
  reward_amount       DECIMAL(18,9) NOT NULL,
  reward_type         VARCHAR(10) DEFAULT 'coins',
  max_activations     INTEGER,
  activation_count    INTEGER DEFAULT 0,
  is_active           BOOLEAN DEFAULT TRUE,
  created_by          BIGINT,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE promo_activations (
  id              SERIAL PRIMARY KEY,
  promo_code_id   INTEGER NOT NULL,
  telegram_id     BIGINT NOT NULL,
  activated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(promo_code_id, telegram_id)
);

CREATE TABLE payments (
  id            SERIAL PRIMARY KEY,
  invoice_id    VARCHAR(255) UNIQUE NOT NULL,
  telegram_id   BIGINT NOT NULL,
  amount        DECIMAL(18,9) NOT NULL,
  asset         VARCHAR(20) DEFAULT 'TON',
  provider      VARCHAR(20) NOT NULL,
  status        VARCHAR(20) DEFAULT 'pending',
  paid_at       TIMESTAMP WITH TIME ZONE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE withdrawals (
  id                SERIAL PRIMARY KEY,
  telegram_id       BIGINT NOT NULL,
  coins_amount      BIGINT NOT NULL,
  ton_amount        DECIMAL(18,9) NOT NULL,
  net_ton_amount    DECIMAL(18,9) NOT NULL,
  wallet_address    VARCHAR(255),
  status            VARCHAR(20) DEFAULT 'pending',
  admin_note        TEXT,
  processed_at      TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE spin_history (
  id            SERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL,
  result        INTEGER NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO promo_codes (code, reward_amount, reward_type, max_activations, is_active)
VALUES
  ('WELCOME', 500, 'coins', 1000, true),
  ('LAUNCH2024', 1000, 'coins', 500, true),
  ('VIPBONUS', 0.1, 'ton', 100, true);