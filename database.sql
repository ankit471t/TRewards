-- ═══════════════════════════════════════════════════════════
-- TRewards Database Schema - database.sql
-- SQLite database for TRewards Telegram Mini App
-- Compatible with better-sqlite3
-- ═══════════════════════════════════════════════════════════

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;

-- ─── USERS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id    TEXT    UNIQUE NOT NULL,
  first_name     TEXT    NOT NULL DEFAULT '',
  username       TEXT    NOT NULL DEFAULT '',
  balance        INTEGER NOT NULL DEFAULT 0,
  spins          INTEGER NOT NULL DEFAULT 1,        -- Start with 1 free spin
  streak         INTEGER NOT NULL DEFAULT 0,
  last_checkin   TEXT    DEFAULT NULL,              -- ISO date string YYYY-MM-DD
  last_daily_reset TEXT  DEFAULT NULL,
  referrer_id    TEXT    DEFAULT NULL,              -- telegram_id of referrer
  adv_balance    REAL    NOT NULL DEFAULT 0,        -- TON balance for advertisers
  is_banned      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);

-- ─── TRANSACTIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  type        TEXT    NOT NULL,    -- spin, task, daily_checkin, referral, promo, withdrawal, refund
  description TEXT    NOT NULL DEFAULT '',
  amount      INTEGER NOT NULL,   -- positive=credit, negative=debit
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);

-- ─── TASKS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  advertiser_id     TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL CHECK(type IN ('visit','channel','group','game')),
  url               TEXT    NOT NULL,
  reward            INTEGER NOT NULL DEFAULT 500,
  limit_completions INTEGER NOT NULL DEFAULT 1000,
  completions       INTEGER NOT NULL DEFAULT 0,
  status            TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (advertiser_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_advertiser ON tasks(advertiser_id);

-- ─── TASK COMPLETIONS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_completions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL,
  user_id      TEXT    NOT NULL,
  completed_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(task_id, user_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_task_completions_task ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);

-- ─── DAILY TASK COMPLETIONS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_task_completions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  task_type  TEXT NOT NULL,              -- checkin, updates, share
  date       TEXT NOT NULL,             -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, task_type, date),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_completions_user_date ON daily_task_completions(user_id, date);

-- ─── WITHDRAWALS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  coins       INTEGER NOT NULL,
  ton_amount  REAL    NOT NULL,           -- gross TON amount
  net_amount  REAL    NOT NULL,           -- after 0.05 TON fee
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','rejected')),
  tx_hash     TEXT    DEFAULT NULL,       -- TON blockchain transaction hash
  notes       TEXT    DEFAULT '',         -- Admin notes
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- ─── PROMO CODES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    UNIQUE NOT NULL COLLATE NOCASE,
  reward       INTEGER NOT NULL,
  max_uses     INTEGER NOT NULL DEFAULT 100,
  current_uses INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,   -- 0=disabled
  created_by   TEXT    DEFAULT NULL,          -- admin telegram_id
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);

-- ─── PROMO ACTIVATIONS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_activations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id      INTEGER NOT NULL,
  user_id      TEXT    NOT NULL,
  activated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(code_id, user_id),
  FOREIGN KEY (code_id) REFERENCES promo_codes(id),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_promo_activations_code ON promo_activations(code_id);
CREATE INDEX IF NOT EXISTS idx_promo_activations_user ON promo_activations(user_id);

-- ─── REFERRAL EARNINGS ───────────────────────────────────────
-- Tracks 30% commissions earned from referred users
CREATE TABLE IF NOT EXISTS referral_earnings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id TEXT    NOT NULL,   -- telegram_id of the referrer
  referee_id  TEXT    NOT NULL,   -- telegram_id of the person who earned coins
  amount      INTEGER NOT NULL,   -- 30% of what referee earned
  claimed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (referrer_id) REFERENCES users(telegram_id),
  FOREIGN KEY (referee_id)  REFERENCES users(telegram_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_earnings(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referral_unclaimed ON referral_earnings(referrer_id, claimed);

-- ─── ADVERTISER TOP-UP HISTORY ───────────────────────────────
CREATE TABLE IF NOT EXISTS adv_topups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL,
  ton_amount  REAL    NOT NULL,
  tx_hash     TEXT    DEFAULT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(telegram_id)
);

-- ─── ADMIN SESSIONS (for bot wizard steps) ───────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
  admin_id   TEXT PRIMARY KEY,
  step       TEXT NOT NULL,
  data       TEXT DEFAULT '{}',  -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── USEFUL VIEWS ────────────────────────────────────────────

-- User leaderboard
CREATE VIEW IF NOT EXISTS user_leaderboard AS
  SELECT telegram_id, first_name, username, balance
  FROM users
  WHERE is_banned=0
  ORDER BY balance DESC
  LIMIT 100;

-- Active tasks with completion stats
CREATE VIEW IF NOT EXISTS active_tasks_view AS
  SELECT t.*,
    ROUND(CAST(t.completions AS FLOAT)/t.limit_completions*100, 1) as pct_complete,
    u.first_name as advertiser_name
  FROM tasks t
  JOIN users u ON u.telegram_id=t.advertiser_id
  WHERE t.status='active';

-- Pending withdrawals summary
CREATE VIEW IF NOT EXISTS pending_withdrawals_view AS
  SELECT w.*, u.first_name, u.username
  FROM withdrawals w
  JOIN users u ON u.telegram_id=w.user_id
  WHERE w.status='pending'
  ORDER BY w.created_at ASC;

-- ─── TRIGGERS ────────────────────────────────────────────────

-- Update users.updated_at on row change
CREATE TRIGGER IF NOT EXISTS trg_users_updated_at
  AFTER UPDATE ON users
  BEGIN
    UPDATE users SET updated_at=datetime('now') WHERE telegram_id=NEW.telegram_id;
  END;

-- Auto-complete tasks when limit reached
CREATE TRIGGER IF NOT EXISTS trg_task_auto_complete
  AFTER UPDATE ON tasks
  WHEN NEW.completions >= NEW.limit_completions AND NEW.status='active'
  BEGIN
    UPDATE tasks SET status='completed' WHERE id=NEW.id;
  END;

-- ─── SEED DATA (optional, for testing) ──────────────────────
-- INSERT OR IGNORE INTO promo_codes (code, reward, max_uses) VALUES ('WELCOME', 100, 10000);
-- INSERT OR IGNORE INTO promo_codes (code, reward, max_uses) VALUES ('LAUNCH100', 500, 500);