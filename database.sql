-- USERS
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  first_name TEXT DEFAULT '',
  username TEXT DEFAULT '',
  balance INTEGER DEFAULT 0,
  spins INTEGER DEFAULT 1,
  streak INTEGER DEFAULT 0,
  last_checkin TEXT DEFAULT NULL,
  referrer_id TEXT DEFAULT NULL,
  adv_balance NUMERIC DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- TRANSACTIONS
CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TASKS
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  advertiser_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('visit','channel','group','game')),
  url TEXT NOT NULL,
  reward INTEGER DEFAULT 500,
  limit_completions INTEGER DEFAULT 1000,
  completions INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- TASK COMPLETIONS
CREATE TABLE IF NOT EXISTS task_completions (
  id BIGSERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, user_id)
);

-- DAILY TASK COMPLETIONS
CREATE TABLE IF NOT EXISTS daily_task_completions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, task_type, date)
);

-- WITHDRAWALS
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  ton_amount NUMERIC NOT NULL,
  net_amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','rejected')),
  tx_hash TEXT DEFAULT NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- PROMO CODES
CREATE TABLE IF NOT EXISTS promo_codes (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reward INTEGER NOT NULL,
  max_uses INTEGER DEFAULT 100,
  current_uses INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- PROMO ACTIVATIONS
CREATE TABLE IF NOT EXISTS promo_activations (
  id BIGSERIAL PRIMARY KEY,
  code_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  activated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(code_id, user_id)
);

-- REFERRAL EARNINGS
CREATE TABLE IF NOT EXISTS referral_earnings (
  id BIGSERIAL PRIMARY KEY,
  referrer_id TEXT NOT NULL,
  referee_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ADVERTISER TOPUPS
CREATE TABLE IF NOT EXISTS adv_topups (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  ton_amount NUMERIC NOT NULL,
  tx_hash TEXT DEFAULT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_earnings(referrer_id);
CREATE INDEX IF NOT EXISTS idx_daily_completions ON daily_task_completions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_advertiser ON tasks(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);

-- AUTO UPDATE updated_at TRIGGER
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