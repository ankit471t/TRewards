/* ═══════════════════════════════════════
   TREWARDS — SERVER.JS
   Production Backend API
═══════════════════════════════════════ */

'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Pool } = require('pg');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 10000;

// ── DATABASE ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── BOT ───────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, {
  webHook: process.env.NODE_ENV === 'production',
});

if (process.env.NODE_ENV === 'production') {
  bot.setWebHook(`${process.env.WEBHOOK_URL}/bot${process.env.BOT_TOKEN}`);
}

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.static('frontend'));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
app.use('/api/', apiLimiter);

// Webhook path must NOT be rate limited
app.use('/payment-webhook', express.raw({ type: 'application/json' }));

// ── TELEGRAM INIT DATA VALIDATION ────────────────────────────────
function validateTgInitData(initData) {
  if (!initData || process.env.NODE_ENV !== 'production') return true;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();
    const expectedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');
    return expectedHash === hash;
  } catch {
    return false;
  }
}

// Auth middleware
function authMiddleware(req, res, next) {
  const { telegram_id, init_data } = req.body || req.query;
  if (!telegram_id) return res.status(401).json({ error: 'Unauthorized' });
  if (process.env.NODE_ENV === 'production' && !validateTgInitData(init_data)) {
    return res.status(401).json({ error: 'Invalid init data' });
  }
  req.telegram_id = parseInt(telegram_id);
  next();
}

// ── DB HELPERS ────────────────────────────────────────────────────
const db = {
  async getUser(telegram_id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    return rows[0] || null;
  },

  async createUser(data) {
    const { rows } = await pool.query(`
      INSERT INTO users (telegram_id, first_name, last_name, username, referrer_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (telegram_id) DO UPDATE
        SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, username = EXCLUDED.username
      RETURNING *
    `, [data.telegram_id, data.first_name, data.last_name, data.username, data.referrer_id || null]);
    return rows[0];
  },

  async updateCoins(telegram_id, delta, type, description) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'UPDATE users SET coins = coins + $1 WHERE telegram_id = $2 RETURNING coins',
        [delta, telegram_id]
      );
      await client.query(
        'INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
        [telegram_id, type, description, delta]
      );
      await client.query('COMMIT');
      return rows[0]?.coins;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async updateSpins(telegram_id, delta) {
    await pool.query('UPDATE users SET spins = GREATEST(0, spins + $1) WHERE telegram_id = $2', [delta, telegram_id]);
  },
};

// ── ROUTES ────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── USER ─────────────────────────────────────────────────────────
app.post('/api/user', authMiddleware, async (req, res) => {
  const { telegram_id, first_name, last_name, username } = req.body;
  try {
    let user = await db.getUser(telegram_id);
    if (!user) {
      user = await db.createUser({ telegram_id, first_name, last_name, username });
    }

    // Check daily reset
    const now = new Date();
    const lastReset = user.last_daily_reset ? new Date(user.last_daily_reset) : null;
    const sameDay = lastReset &&
      lastReset.getFullYear() === now.getFullYear() &&
      lastReset.getMonth() === now.getMonth() &&
      lastReset.getDate() === now.getDate();

    if (!sameDay) {
      await pool.query(`
        UPDATE users SET
          daily_checkin_claimed = false,
          daily_updates_claimed = false,
          daily_share_claimed = false,
          streak_claimed_today = false,
          last_daily_reset = NOW()
        WHERE telegram_id = $1
      `, [telegram_id]);
      user = await db.getUser(telegram_id);
    }

    res.json({ user });
  } catch (e) {
    console.error('User error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── STREAK ───────────────────────────────────────────────────────
app.post('/api/claim-streak', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  try {
    const user = await db.getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.streak_claimed_today) return res.status(400).json({ error: 'Already claimed today' });

    const reward = 10;
    await pool.query(`
      UPDATE users SET
        streak_claimed_today = true,
        streak_count = streak_count + 1,
        coins = coins + $1,
        spins = spins + 1
      WHERE telegram_id = $2
    `, [reward, telegram_id]);

    await pool.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'streak', 'Daily streak reward', reward]);

    res.json({ success: true, reward });
  } catch (e) {
    console.error('Streak error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── SPIN ─────────────────────────────────────────────────────────
const SPIN_VALUES = [10, 50, 80, 100, 300, 500];
const SPIN_WEIGHTS = [40, 25, 15, 12, 6, 2]; // percentages

function weightedRandom() {
  const total = SPIN_WEIGHTS.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
    rand -= SPIN_WEIGHTS[i];
    if (rand <= 0) return SPIN_VALUES[i];
  }
  return SPIN_VALUES[0];
}

app.post('/api/spin', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  try {
    const user = await db.getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.spins <= 0) return res.status(400).json({ error: 'No spins left' });

    const result = weightedRandom();

    await pool.query('UPDATE users SET spins = spins - 1, coins = coins + $1 WHERE telegram_id = $2', [result, telegram_id]);
    await pool.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'spin', `Spin reward`, result]);

    res.json({ success: true, result });
  } catch (e) {
    console.error('Spin error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PROMO CODE ───────────────────────────────────────────────────
app.post('/api/redeem-promo', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [promo] } = await client.query(
      'SELECT * FROM promo_codes WHERE code = $1 AND is_active = true FOR UPDATE',
      [code.toUpperCase()]
    );

    if (!promo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or expired promo code' });
    }

    if (promo.max_activations !== null && promo.activation_count >= promo.max_activations) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Promo code fully used' });
    }

    // Check if already used
    const { rows: [used] } = await client.query(
      'SELECT id FROM promo_activations WHERE promo_code_id = $1 AND telegram_id = $2',
      [promo.id, telegram_id]
    );
    if (used) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already used this code' });
    }

    // Apply reward
    if (promo.reward_type === 'ton') {
      await client.query('UPDATE users SET ton_balance = ton_balance + $1 WHERE telegram_id = $2', [promo.reward_amount, telegram_id]);
      await client.query('INSERT INTO transactions (telegram_id, type, description, amount, is_ton) VALUES ($1, $2, $3, $4, true)',
        [telegram_id, 'promo', `Promo: ${code}`, promo.reward_amount]);
    } else {
      await client.query('UPDATE users SET coins = coins + $1 WHERE telegram_id = $2', [promo.reward_amount, telegram_id]);
      await client.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
        [telegram_id, 'promo', `Promo: ${code}`, promo.reward_amount]);
    }

    await client.query('UPDATE promo_codes SET activation_count = activation_count + 1 WHERE id = $1', [promo.id]);
    await client.query('INSERT INTO promo_activations (promo_code_id, telegram_id) VALUES ($1, $2)', [promo.id, telegram_id]);

    if (promo.max_activations !== null && promo.activation_count + 1 >= promo.max_activations) {
      await client.query('UPDATE promo_codes SET is_active = false WHERE id = $1', [promo.id]);
    }

    await client.query('COMMIT');
    res.json({ success: true, reward: promo.reward_amount, reward_type: promo.reward_type });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Promo error:', e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── DAILY TASKS ──────────────────────────────────────────────────
const DAILY_TASK_REWARDS = { checkin: 10, updates: 50, share: 100 };

app.post('/api/claim-daily-task', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { task } = req.body;

  if (!DAILY_TASK_REWARDS[task]) return res.status(400).json({ error: 'Invalid task' });

  try {
    const user = await db.getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const field = `daily_${task}_claimed`;
    if (user[field]) return res.status(400).json({ error: 'Already claimed today' });

    const reward = DAILY_TASK_REWARDS[task];
    await pool.query(`UPDATE users SET ${field} = true, coins = coins + $1 WHERE telegram_id = $2`, [reward, telegram_id]);
    await pool.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'daily_task', `Daily task: ${task}`, reward]);

    res.json({ success: true, reward });
  } catch (e) {
    console.error('Daily task error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ADVERTISER TASKS ─────────────────────────────────────────────
app.get('/api/tasks', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  try {
    const { rows } = await pool.query(`
      SELECT t.*,
        EXISTS(
          SELECT 1 FROM task_completions tc
          WHERE tc.task_id = t.id AND tc.telegram_id = $1
        ) as user_completed
      FROM tasks t
      WHERE t.status = 'active' AND t.completed_count < t.completion_target
      ORDER BY t.created_at DESC
      LIMIT 50
    `, [telegram_id]);
    res.json({ tasks: rows });
  } catch (e) {
    console.error('Tasks error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/claim-task', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { task_id } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [task] } = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [task_id]);
    if (!task || task.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Task not available' });
    }

    const { rows: [existing] } = await client.query(
      'SELECT id FROM task_completions WHERE task_id = $1 AND telegram_id = $2',
      [task_id, telegram_id]
    );
    if (existing) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already completed' });
    }

    const reward = task.task_type === 'visit' ? 500 : 1000;

    await client.query('INSERT INTO task_completions (task_id, telegram_id) VALUES ($1, $2)', [task_id, telegram_id]);
    await client.query('UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1', [task_id]);
    await client.query('UPDATE users SET coins = coins + $1, spins = spins + 1 WHERE telegram_id = $2', [reward, telegram_id]);
    await client.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'task', `Task: ${task.task_name}`, reward]);

    // Check if task should be marked completed
    if (task.completed_count + 1 >= task.completion_target) {
      await client.query('UPDATE tasks SET status = $1 WHERE id = $2', ['completed', task_id]);
    }

    // Referral bonus
    await processReferralBonus(client, telegram_id, reward);

    await client.query('COMMIT');
    res.json({ success: true, reward });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Claim task error:', e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.post('/api/verify-join', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { task_id } = req.body;

  try {
    const { rows: [task] } = await pool.query('SELECT * FROM tasks WHERE id = $1', [task_id]);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Extract chat username from URL
    const urlMatch = task.target_url.match(/t\.me\/([^/?]+)/);
    if (!urlMatch) return res.status(400).json({ error: 'Invalid channel URL' });

    const chatId = '@' + urlMatch[1];

    // Check membership via Telegram API
    const isMember = await checkTelegramMembership(telegram_id, chatId);
    if (!isMember) return res.status(400).json({ error: 'Not a member yet. Please join first.' });

    // Forward to claim endpoint
    req.body.task_id = task_id;
    return require('./handlers').claimTask(req, res, pool, processReferralBonus);
  } catch (e) {
    console.error('Verify join error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

async function checkTelegramMembership(userId, chatId) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember`, {
      params: { chat_id: chatId, user_id: userId }
    });
    const status = response.data?.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch {
    return false;
  }
}

// ── REFERRAL ─────────────────────────────────────────────────────
async function processReferralBonus(client, telegram_id, coins_earned) {
  const { rows: [user] } = await client.query('SELECT referrer_id FROM users WHERE telegram_id = $1', [telegram_id]);
  if (!user?.referrer_id) return;

  const bonus = Math.floor(coins_earned * 0.3);
  await client.query('UPDATE users SET pending_referral = pending_referral + $1 WHERE telegram_id = $2', [bonus, user.referrer_id]);
}

app.get('/api/friends', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  try {
    const { rows: friends } = await pool.query(`
      SELECT
        u.telegram_id,
        CONCAT(u.first_name, ' ', COALESCE(u.last_name, '')) as name,
        u.coins,
        FLOOR(u.coins * 0.3) as your_share
      FROM users u
      WHERE u.referrer_id = $1
      ORDER BY u.coins DESC
      LIMIT 50
    `, [telegram_id]);

    const { rows: [stats] } = await pool.query(`
      SELECT
        COUNT(*) as total_friends,
        COALESCE(SUM(total_earned_from_referrals), 0) as total_earned
      FROM users
      WHERE referrer_id = $1
    `, [telegram_id]);

    const { rows: [user] } = await pool.query('SELECT pending_referral FROM users WHERE telegram_id = $1', [telegram_id]);

    res.json({
      friends,
      total_friends: parseInt(stats.total_friends),
      total_earned: parseInt(stats.total_earned),
      pending_earnings: user?.pending_referral || 0,
    });
  } catch (e) {
    console.error('Friends error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/claim-referral', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('SELECT pending_referral FROM users WHERE telegram_id = $1 FOR UPDATE', [telegram_id]);

    if (!user || user.pending_referral <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No pending earnings' });
    }

    const reward = user.pending_referral;
    await client.query(
      'UPDATE users SET coins = coins + $1, pending_referral = 0, total_earned_from_referrals = total_earned_from_referrals + $1 WHERE telegram_id = $2',
      [reward, telegram_id]
    );
    await client.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'referral', 'Referral bonus', reward]);

    await client.query('COMMIT');
    res.json({ success: true, reward });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Claim referral error:', e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── WITHDRAW ─────────────────────────────────────────────────────
const VALID_TIERS = [
  { coins: 250000, ton: 0.10, net: 0.05 },
  { coins: 500000, ton: 0.20, net: 0.15 },
  { coins: 750000, ton: 0.30, net: 0.25 },
  { coins: 1000000, ton: 0.40, net: 0.35 },
];

app.post('/api/withdraw', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { coins_amount, ton_amount, net_amount } = req.body;

  // Validate tier
  const tier = VALID_TIERS.find(t => t.coins === coins_amount && t.ton === ton_amount && t.net === net_amount);
  if (!tier) return res.status(400).json({ error: 'Invalid withdrawal tier' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('SELECT coins FROM users WHERE telegram_id = $1 FOR UPDATE', [telegram_id]);

    if (!user || user.coins < coins_amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient coins' });
    }

    await client.query('UPDATE users SET coins = coins - $1 WHERE telegram_id = $2', [coins_amount, telegram_id]);
    await client.query(`
      INSERT INTO withdrawals (telegram_id, coins_amount, ton_amount, net_ton_amount, status)
      VALUES ($1, $2, $3, $4, 'pending')
    `, [telegram_id, coins_amount, ton_amount, net_amount]);
    await client.query('INSERT INTO transactions (telegram_id, type, description, amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'withdrawal', `Withdrawal ${net_amount} TON`, -coins_amount]);

    await client.query('COMMIT');
    res.json({ success: true, message: 'Withdrawal queued. Processed within 24h.' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Withdraw error:', e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── TRANSACTIONS ─────────────────────────────────────────────────
app.get('/api/transactions', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM transactions WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 50',
      [telegram_id]
    );
    res.json({ transactions: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ADVERTISER ────────────────────────────────────────────────────
app.get('/api/advertiser', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  try {
    const { rows: [user] } = await pool.query('SELECT ad_balance FROM users WHERE telegram_id = $1', [telegram_id]);
    const { rows: tasks } = await pool.query(
      'SELECT * FROM tasks WHERE advertiser_id = $1 ORDER BY created_at DESC',
      [telegram_id]
    );
    res.json({ ad_balance: user?.ad_balance || 0, tasks });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/create-task', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { task_name, task_type, target_url, completion_target } = req.body;

  if (!task_name || !task_type || !target_url || !completion_target) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const validTypes = ['channel', 'group', 'game', 'visit'];
  if (!validTypes.includes(task_type)) return res.status(400).json({ error: 'Invalid task type' });

  const validTargets = [500, 1000, 2000, 5000, 10000];
  const target = parseInt(completion_target);
  if (!validTargets.includes(target)) return res.status(400).json({ error: 'Invalid target' });

  const cost = target * 0.001;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('SELECT ad_balance FROM users WHERE telegram_id = $1 FOR UPDATE', [telegram_id]);

    if (!user || user.ad_balance < cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient ad balance. Need ${cost} TON` });
    }

    await client.query('UPDATE users SET ad_balance = ad_balance - $1 WHERE telegram_id = $2', [cost, telegram_id]);
    await client.query(`
      INSERT INTO tasks (advertiser_id, task_name, task_type, target_url, completion_target, status)
      VALUES ($1, $2, $3, $4, $5, 'active')
    `, [telegram_id, task_name, task_type, target_url, target]);

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Create task error:', e);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── TOP UP / PAYMENT ─────────────────────────────────────────────
const { createXRocketInvoice, createCryptoPayInvoice, verifyXRocketWebhook, verifyCryptoPayWebhook } = require('./payments');

app.post('/api/create-topup', authMiddleware, async (req, res) => {
  const { telegram_id } = req;
  const { amount, method } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['xrocket', 'cryptopay'].includes(method)) return res.status(400).json({ error: 'Invalid method' });

  try {
    let payment_url, invoice_id;

    if (method === 'xrocket') {
      const result = await createXRocketInvoice(telegram_id, amount);
      payment_url = result.payment_url;
      invoice_id = result.invoice_id;
    } else {
      const result = await createCryptoPayInvoice(telegram_id, amount);
      payment_url = result.payment_url;
      invoice_id = result.invoice_id;
    }

    await pool.query(`
      INSERT INTO payments (invoice_id, telegram_id, amount, asset, provider, status)
      VALUES ($1, $2, $3, 'TON', $4, 'pending')
    `, [invoice_id, telegram_id, amount, method]);

    res.json({ success: true, payment_url, invoice_id });
  } catch (e) {
    console.error('Create topup error:', e);
    res.status(500).json({ error: 'Failed to create invoice: ' + e.message });
  }
});

// ── WEBHOOKS ─────────────────────────────────────────────────────
app.post('/payment-webhook/xrocket', express.json(), async (req, res) => {
  try {
    const isValid = verifyXRocketWebhook(req.body, req.headers['x-rocket-sign']);
    if (!isValid) return res.status(400).json({ error: 'Invalid signature' });

    const { invoice } = req.body;
    if (invoice?.status !== 'paid') return res.json({ ok: true });
    if (invoice?.payload?.asset !== 'TONCOIN' && invoice?.asset !== 'TONCOIN') return res.json({ ok: true });

    await processPayment(invoice.id, invoice.amount, 'xrocket');
    res.json({ ok: true });
  } catch (e) {
    console.error('xRocket webhook error:', e);
    res.status(500).json({ error: 'Webhook error' });
  }
});

app.post('/payment-webhook/cryptopay', express.json(), async (req, res) => {
  try {
    const isValid = verifyCryptoPayWebhook(req.body, req.headers['crypto-pay-api-signature']);
    if (!isValid) return res.status(400).json({ error: 'Invalid signature' });

    const { update_type, payload } = req.body;
    if (update_type !== 'invoice_paid') return res.json({ ok: true });
    if (payload?.asset !== 'TON') return res.json({ ok: true });

    await processPayment(String(payload.invoice_id), parseFloat(payload.amount), 'cryptopay');
    res.json({ ok: true });
  } catch (e) {
    console.error('CryptoPay webhook error:', e);
    res.status(500).json({ error: 'Webhook error' });
  }
});

async function processPayment(invoice_id, amount, provider) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [payment] } = await client.query(
      'SELECT * FROM payments WHERE invoice_id = $1 AND provider = $2 FOR UPDATE',
      [invoice_id, provider]
    );

    if (!payment) throw new Error('Payment not found');
    if (payment.status === 'paid') {
      await client.query('ROLLBACK');
      return; // Prevent double credit
    }

    await client.query('UPDATE payments SET status = $1, paid_at = NOW() WHERE invoice_id = $2', ['paid', invoice_id]);
    await client.query('UPDATE users SET ton_balance = ton_balance + $1 WHERE telegram_id = $2', [amount, payment.telegram_id]);
    await client.query('INSERT INTO transactions (telegram_id, type, description, amount, is_ton) VALUES ($1, $2, $3, $4, true)',
      [payment.telegram_id, 'topup', `Top-up via ${provider}`, amount]);

    await client.query('COMMIT');
    console.log(`✅ Payment ${invoice_id} processed: +${amount} TON for user ${payment.telegram_id}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Process payment error:', e);
    throw e;
  } finally {
    client.release();
  }
}

// ── TELEGRAM BOT ─────────────────────────────────────────────────
require('./bot')(bot, pool, db);

// ── BOT WEBHOOK ──────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// ── ERROR HANDLING ────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 TRewards server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;