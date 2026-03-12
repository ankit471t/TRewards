'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { query, initSchema } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── TELEGRAM INIT DATA VALIDATION ───────────────────────────────
function validateInitData(initData) {
  if (!BOT_TOKEN || !initData) return true; // skip in dev
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return expectedHash === hash;
  } catch {
    return true; // skip validation on error in dev
  }
}

// ── MIDDLEWARE ───────────────────────────────────────────────────
function requireUser(req, res, next) {
  const telegram_id = req.body?.telegram_id || req.query?.telegram_id;
  if (!telegram_id) return res.status(400).json({ message: 'Missing telegram_id' });
  req.telegram_id = BigInt(telegram_id);
  next();
}

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'TRewards API' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── USER ─────────────────────────────────────────────────────────
app.post('/api/user', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { first_name = '', last_name = '', username = '' } = req.body;

  // Check for referral param (start param passed from bot)
  const referred_by = req.body.referred_by ? BigInt(req.body.referred_by) : null;

  try {
    // Upsert user
    await query(`
      INSERT INTO users (telegram_id, first_name, last_name, username, referred_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (telegram_id) DO UPDATE SET
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        username = EXCLUDED.username
    `, [telegram_id, first_name, last_name, username, referred_by]);

    const userRes = await query('SELECT * FROM users WHERE telegram_id = $1', [telegram_id]);
    const user = userRes.rows[0];

    // Check what daily tasks claimed today
    const today = new Date().toISOString().split('T')[0];
    const claimsRes = await query(
      'SELECT task FROM daily_claims WHERE telegram_id = $1 AND claimed_date = $2',
      [telegram_id, today]
    );
    const claimed = claimsRes.rows.map(r => r.task);

    const streakClaimedToday = claimed.includes('streak');

    res.json({
      user: {
        ...user,
        coins: Number(user.coins),
        spins: Number(user.spins),
        streak_count: Number(user.streak_count),
        daily_checkin_claimed: claimed.includes('checkin'),
        daily_updates_claimed: claimed.includes('updates'),
        daily_share_claimed: claimed.includes('share'),
        streak_claimed_today: streakClaimedToday,
      }
    });
  } catch (e) {
    console.error('POST /api/user error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── CLAIM STREAK ──────────────────────────────────────────────────
app.post('/api/claim-streak', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const today = new Date().toISOString().split('T')[0];

  try {
    // Check if already claimed today
    const existing = await query(
      'SELECT id FROM daily_claims WHERE telegram_id = $1 AND task = $2 AND claimed_date = $3',
      [telegram_id, 'streak', today]
    );
    if (existing.rows.length > 0) return res.status(400).json({ message: 'Already claimed today' });

    await query(
      'INSERT INTO daily_claims (telegram_id, task, claimed_date) VALUES ($1, $2, $3)',
      [telegram_id, 'streak', today]
    );

    // Check if yesterday was claimed for streak continuity
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const yestRes = await query(
      'SELECT id FROM daily_claims WHERE telegram_id = $1 AND task = $2 AND claimed_date = $3',
      [telegram_id, 'streak', yesterday]
    );

    const userRes = await query('SELECT streak_count FROM users WHERE telegram_id = $1', [telegram_id]);
    const currentStreak = Number(userRes.rows[0]?.streak_count || 0);
    const newStreak = yestRes.rows.length > 0 ? currentStreak + 1 : 1;

    const reward = 10;
    await query(
      'UPDATE users SET coins = coins + $1, spins = spins + 1, streak_count = $2, last_streak_date = $3 WHERE telegram_id = $4',
      [reward, newStreak, today, telegram_id]
    );
    await query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'streak', reward, `Day ${newStreak} streak bonus`]
    );

    res.json({ reward, streak: newStreak });
  } catch (e) {
    console.error('POST /api/claim-streak error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── SPIN ─────────────────────────────────────────────────────────
const SPIN_VALUES = [10, 50, 80, 100, 300, 500];
const SPIN_WEIGHTS = [40, 25, 15, 12, 6, 2]; // weighted probabilities

function weightedRandom() {
  const total = SPIN_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
    r -= SPIN_WEIGHTS[i];
    if (r <= 0) return SPIN_VALUES[i];
  }
  return SPIN_VALUES[0];
}

app.post('/api/spin', requireUser, async (req, res) => {
  const { telegram_id } = req;
  try {
    const userRes = await query('SELECT spins, coins FROM users WHERE telegram_id = $1', [telegram_id]);
    const user = userRes.rows[0];
    if (!user || Number(user.spins) <= 0) return res.status(400).json({ message: 'No spins left' });

    const result = weightedRandom();
    await query(
      'UPDATE users SET spins = spins - 1, coins = coins + $1 WHERE telegram_id = $2',
      [result, telegram_id]
    );
    await query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'spin', result, 'Spin wheel reward']
    );

    res.json({ result, new_coins: Number(user.coins) + result });
  } catch (e) {
    console.error('POST /api/spin error:', e.message);
    res.status(500).json({ message: 'Spin failed' });
  }
});

// ── DAILY TASKS ───────────────────────────────────────────────────
const DAILY_TASK_REWARDS = { checkin: 10, updates: 50, share: 100 };
const DAILY_TASK_SPINS = { checkin: 1, updates: 0, share: 0 };

app.post('/api/claim-daily-task', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { task } = req.body;
  const today = new Date().toISOString().split('T')[0];

  if (!DAILY_TASK_REWARDS[task]) return res.status(400).json({ message: 'Invalid task' });

  try {
    const existing = await query(
      'SELECT id FROM daily_claims WHERE telegram_id = $1 AND task = $2 AND claimed_date = $3',
      [telegram_id, task, today]
    );
    if (existing.rows.length > 0) return res.status(400).json({ message: 'Already claimed today' });

    await query(
      'INSERT INTO daily_claims (telegram_id, task, claimed_date) VALUES ($1, $2, $3)',
      [telegram_id, task, today]
    );

    const reward = DAILY_TASK_REWARDS[task];
    const spins = DAILY_TASK_SPINS[task] || 0;
    await query(
      'UPDATE users SET coins = coins + $1, spins = spins + $2 WHERE telegram_id = $3',
      [reward, spins, telegram_id]
    );
    await query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'daily_task', reward, `Daily task: ${task}`]
    );

    res.json({ reward, spins });
  } catch (e) {
    console.error('POST /api/claim-daily-task error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── TASKS ─────────────────────────────────────────────────────────
app.get('/api/tasks', requireUser, async (req, res) => {
  const { telegram_id } = req;
  try {
    const tasksRes = await query(
      `SELECT t.*, 
        EXISTS(SELECT 1 FROM task_completions tc WHERE tc.task_id = t.id AND tc.telegram_id = $1) as user_completed
       FROM tasks t WHERE t.status = 'active' ORDER BY t.created_at DESC`,
      [telegram_id]
    );
    res.json({ tasks: tasksRes.rows });
  } catch (e) {
    console.error('GET /api/tasks error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── CLAIM TASK (visit/game - timer based) ─────────────────────────
app.post('/api/claim-task', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { task_id } = req.body;

  try {
    const taskRes = await query('SELECT * FROM tasks WHERE id = $1 AND status = $2', [task_id, 'active']);
    if (!taskRes.rows.length) return res.status(404).json({ message: 'Task not found' });

    const existing = await query(
      'SELECT id FROM task_completions WHERE telegram_id = $1 AND task_id = $2',
      [telegram_id, task_id]
    );
    if (existing.rows.length) return res.status(400).json({ message: 'Task already completed' });

    const task = taskRes.rows[0];
    const reward = Number(task.reward);

    await query(
      'INSERT INTO task_completions (telegram_id, task_id) VALUES ($1, $2)',
      [telegram_id, task_id]
    );
    await query(
      'UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1',
      [task_id]
    );
    await query(
      'UPDATE users SET coins = coins + $1, spins = spins + 1 WHERE telegram_id = $2',
      [reward, telegram_id]
    );
    await query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'task', reward, `Task: ${task.task_name}`]
    );

    // Give 30% referral commission
    const userRes = await query('SELECT referred_by FROM users WHERE telegram_id = $1', [telegram_id]);
    const referrer = userRes.rows[0]?.referred_by;
    if (referrer) {
      const commission = Math.floor(reward * 0.30);
      await query('UPDATE users SET coins = coins + $1 WHERE telegram_id = $2', [commission, referrer]);
      await query(
        'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
        [referrer, 'referral_commission', commission, `Commission from ${telegram_id}`]
      );
    }

    res.json({ reward, spins: 1 });
  } catch (e) {
    console.error('POST /api/claim-task error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── VERIFY JOIN (channel/group) ───────────────────────────────────
app.post('/api/verify-join', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { task_id } = req.body;

  try {
    const taskRes = await query('SELECT * FROM tasks WHERE id = $1 AND status = $2', [task_id, 'active']);
    if (!taskRes.rows.length) return res.status(404).json({ message: 'Task not found' });

    const existing = await query(
      'SELECT id FROM task_completions WHERE telegram_id = $1 AND task_id = $2',
      [telegram_id, task_id]
    );
    if (existing.rows.length) return res.status(400).json({ message: 'Task already completed' });

    // NOTE: Real implementation would check Telegram Bot API getChatMember
    // For now we trust the user (they clicked "I've Joined")
    const task = taskRes.rows[0];
    const reward = Number(task.reward);

    await query(
      'INSERT INTO task_completions (telegram_id, task_id) VALUES ($1, $2)',
      [telegram_id, task_id]
    );
    await query('UPDATE tasks SET completed_count = completed_count + 1 WHERE id = $1', [task_id]);
    await query(
      'UPDATE users SET coins = coins + $1, spins = spins + 1 WHERE telegram_id = $2',
      [reward, telegram_id]
    );
    await query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'task', reward, `Joined: ${task.task_name}`]
    );

    // Referral commission
    const userRes = await query('SELECT referred_by FROM users WHERE telegram_id = $1', [telegram_id]);
    const referrer = userRes.rows[0]?.referred_by;
    if (referrer) {
      const commission = Math.floor(reward * 0.30);
      await query('UPDATE users SET coins = coins + $1 WHERE telegram_id = $2', [commission, referrer]);
    }

    res.json({ reward, spins: 1 });
  } catch (e) {
    console.error('POST /api/verify-join error:', e.message);
    res.status(500).json({ message: 'Verification failed' });
  }
});

// ── FRIENDS ───────────────────────────────────────────────────────
app.get('/api/friends', requireUser, async (req, res) => {
  const { telegram_id } = req;
  try {
    const friendsRes = await query(
      `SELECT u.telegram_id, u.first_name, u.last_name, u.username, u.coins,
        COALESCE((
          SELECT SUM(t.amount) FROM transactions t
          WHERE t.telegram_id = $1 AND t.type = 'referral_commission'
          AND t.description LIKE '%' || u.telegram_id::text || '%'
        ), 0) as your_share
       FROM users u WHERE u.referred_by = $1 ORDER BY u.coins DESC LIMIT 50`,
      [telegram_id]
    );

    // Pending = unclaimed commissions accrued (simplified: sum all referral commissions)
    const pendingRes = await query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM transactions WHERE telegram_id = $1 AND type = 'referral_commission'`,
      [telegram_id]
    );

    res.json({
      friends: friendsRes.rows.map(f => ({
        name: [f.first_name, f.last_name].filter(Boolean).join(' ') || f.username || 'User',
        coins: Number(f.coins),
        your_share: Number(f.your_share),
      })),
      total_friends: friendsRes.rows.length,
      pending_earnings: 0, // commissions are auto-credited, not pending
      total_earned: Number(pendingRes.rows[0]?.total || 0),
    });
  } catch (e) {
    console.error('GET /api/friends error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── CLAIM REFERRAL ────────────────────────────────────────────────
app.post('/api/claim-referral', requireUser, async (req, res) => {
  // Commissions are auto-credited, nothing to claim
  res.status(400).json({ message: 'Commissions are credited automatically' });
});

// ── TRANSACTIONS ──────────────────────────────────────────────────
app.get('/api/transactions', requireUser, async (req, res) => {
  const { telegram_id } = req;
  try {
    const txRes = await query(
      'SELECT * FROM transactions WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 50',
      [telegram_id]
    );
    res.json({
      transactions: txRes.rows.map(t => ({
        ...t,
        amount: Number(t.amount),
      }))
    });
  } catch (e) {
    console.error('GET /api/transactions error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── WITHDRAW ──────────────────────────────────────────────────────
app.post('/api/withdraw', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { coins_amount, ton_amount, net_amount } = req.body;

  if (!coins_amount || !ton_amount || !net_amount) return res.status(400).json({ message: 'Invalid request' });

  try {
    const userRes = await query('SELECT coins FROM users WHERE telegram_id = $1', [telegram_id]);
    const user = userRes.rows[0];
    if (!user || Number(user.coins) < coins_amount) return res.status(400).json({ message: 'Insufficient balance' });

    await query('UPDATE users SET coins = coins - $1 WHERE telegram_id = $2', [coins_amount, telegram_id]);
    await query(
      'INSERT INTO withdrawal_requests (telegram_id, coins_amount, ton_amount, net_amount) VALUES ($1, $2, $3, $4)',
      [telegram_id, coins_amount, ton_amount, net_amount]
    );
    await query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
      [telegram_id, 'withdrawal', -coins_amount, `Withdraw ${net_amount} TON`]
    );

    res.json({ message: 'Withdrawal queued', net_amount });
  } catch (e) {
    console.error('POST /api/withdraw error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── PROMO CODE ────────────────────────────────────────────────────
app.post('/api/redeem-promo', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { code } = req.body;

  if (!code) return res.status(400).json({ message: 'No code provided' });

  try {
    const promoRes = await query(
      `SELECT * FROM promo_codes WHERE code = $1 
       AND (expires_at IS NULL OR expires_at > NOW())
       AND used_count < max_uses`,
      [code.toUpperCase()]
    );
    if (!promoRes.rows.length) return res.status(400).json({ message: 'Invalid or expired code' });

    const promo = promoRes.rows[0];

    const useRes = await query(
      'SELECT id FROM promo_uses WHERE code = $1 AND telegram_id = $2',
      [promo.code, telegram_id]
    );
    if (useRes.rows.length) return res.status(400).json({ message: 'Already used this code' });

    await query(
      'INSERT INTO promo_uses (code, telegram_id) VALUES ($1, $2)',
      [promo.code, telegram_id]
    );
    await query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);

    const reward = Number(promo.reward);
    if (promo.reward_type === 'ton') {
      await query('UPDATE users SET ton_balance = ton_balance + $1 WHERE telegram_id = $2', [reward, telegram_id]);
    } else {
      await query('UPDATE users SET coins = coins + $1 WHERE telegram_id = $2', [reward, telegram_id]);
      await query(
        'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1, $2, $3, $4)',
        [telegram_id, 'promo', reward, `Promo code: ${promo.code}`]
      );
    }

    res.json({ reward, reward_type: promo.reward_type });
  } catch (e) {
    console.error('POST /api/redeem-promo error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── TOP UP ────────────────────────────────────────────────────────
app.post('/api/create-topup', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { amount, method } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });

  try {
    // In production: call xRocket or CryptoPay API to create invoice
    // For now return a placeholder URL
    const orderRes = await query(
      'INSERT INTO topup_orders (telegram_id, amount, method) VALUES ($1, $2, $3) RETURNING id',
      [telegram_id, amount, method]
    );
    const orderId = orderRes.rows[0].id;

    // TODO: integrate real payment API
    // Example xRocket: POST https://pay.xrocket.tg/tg-invoices with Bearer token
    // Example CryptoPay: POST https://pay.crypt.bot/api/createInvoice
    const payment_url = method === 'xrocket'
      ? `https://t.me/xrocket?start=invoice_${orderId}`
      : `https://t.me/CryptoBot?start=invoice_${orderId}`;

    await query('UPDATE topup_orders SET payment_url = $1 WHERE id = $2', [payment_url, orderId]);

    res.json({ payment_url, order_id: orderId });
  } catch (e) {
    console.error('POST /api/create-topup error:', e.message);
    res.status(500).json({ message: 'Failed to create order' });
  }
});

// ── ADVERTISER ────────────────────────────────────────────────────
app.get('/api/advertiser', requireUser, async (req, res) => {
  const { telegram_id } = req;
  try {
    const userRes = await query('SELECT ad_balance FROM users WHERE telegram_id = $1', [telegram_id]);
    const tasksRes = await query(
      'SELECT * FROM tasks WHERE created_by = $1 ORDER BY created_at DESC',
      [telegram_id]
    );
    res.json({
      ad_balance: Number(userRes.rows[0]?.ad_balance || 0),
      tasks: tasksRes.rows,
    });
  } catch (e) {
    console.error('GET /api/advertiser error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/create-task', requireUser, async (req, res) => {
  const { telegram_id } = req;
  const { task_name, task_type, target_url, completion_target } = req.body;

  if (!task_name || !task_type || !target_url || !completion_target) {
    return res.status(400).json({ message: 'Missing fields' });
  }

  const cost = completion_target * 0.001;

  try {
    const userRes = await query('SELECT ad_balance FROM users WHERE telegram_id = $1', [telegram_id]);
    const balance = Number(userRes.rows[0]?.ad_balance || 0);
    if (balance < cost) return res.status(400).json({ message: `Insufficient ad balance. Need ${cost} TON` });

    const reward = task_type === 'visit' ? 500 : 1000;

    await query(
      `INSERT INTO tasks (task_name, task_type, target_url, completion_target, reward, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [task_name, task_type, target_url, completion_target, reward, telegram_id]
    );
    await query(
      'UPDATE users SET ad_balance = ad_balance - $1 WHERE telegram_id = $2',
      [cost, telegram_id]
    );

    res.json({ message: 'Task published' });
  } catch (e) {
    console.error('POST /api/create-task error:', e.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── START SERVER ──────────────────────────────────────────────────
initSchema()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 TRewards API running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to init DB schema:', err.message);
    process.exit(1);
  });