'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result;
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      first_name TEXT DEFAULT '',
      last_name TEXT DEFAULT '',
      username TEXT DEFAULT '',
      coins BIGINT DEFAULT 0,
      spins INTEGER DEFAULT 0,
      streak_count INTEGER DEFAULT 0,
      last_streak_date DATE,
      referred_by BIGINT,
      ton_balance NUMERIC(18,6) DEFAULT 0,
      ad_balance NUMERIC(18,6) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS daily_claims (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      task TEXT NOT NULL,
      claimed_date DATE NOT NULL DEFAULT CURRENT_DATE,
      UNIQUE (telegram_id, task, claimed_date)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      task_name TEXT NOT NULL,
      task_type TEXT NOT NULL,
      target_url TEXT NOT NULL,
      completion_target INTEGER DEFAULT 500,
      completed_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_by BIGINT,
      reward INTEGER DEFAULT 1000,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS task_completions (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      task_id BIGINT NOT NULL,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (telegram_id, task_id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id BIGSERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      reward_type TEXT DEFAULT 'coins',
      reward NUMERIC(18,6) NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS promo_uses (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      telegram_id BIGINT NOT NULL,
      used_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (code, telegram_id)
    );

    CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      coins_amount BIGINT NOT NULL,
      ton_amount NUMERIC(18,6) NOT NULL,
      net_amount NUMERIC(18,6) NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS topup_orders (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      amount NUMERIC(18,6) NOT NULL,
      method TEXT NOT NULL,
      payment_url TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ DB schema ready');
}

module.exports = { query, initSchema };