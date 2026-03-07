/**
 * TRewards Backend - server.js
 * Complete production backend for TRewards Telegram Mini App
 * Database: Supabase PostgreSQL via Connection Pooler (port 6543)
 *
 * Run: npm install && node server.js
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const https    = require('https');
const { Pool } = require('pg');

const app      = express();
const PORT     = process.env.PORT     || 3000;
const BOT_TOKEN= process.env.BOT_TOKEN|| '';
const ADMIN_ID = process.env.ADMIN_ID || '';

// ═══════════════════════════════════════════
// DATABASE — Supabase Connection Pooler
// Use port 6543 (pooler) NOT 5432 (direct)
// This fixes ENETUNREACH on Render free tier
// ═══════════════════════════════════════════
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Test connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
    console.error('   Check DATABASE_URL uses pooler port 6543');
  } else {
    release();
    console.log('✅ Connected to Supabase PostgreSQL');
  }
});

// ─── DB Helpers with retry logic ────────────
async function query(text, params = []) {
  let retries = 3;
  while (retries > 0) {
    let client;
    try {
      client = await pool.connect();
      const res = await client.query(text, params);
      return res;
    } catch (e) {
      retries--;
      console.error(`DB error (attempt ${4 - retries}/3):`, e.message);
      if (retries === 0) throw e;
      await new Promise(r => setTimeout(r, 1000));
    } finally {
      if (client) client.release();
    }
  }
}

async function queryOne(text, params = []) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

async function queryAll(text, params = []) {
  const res = await query(text, params);
  return res.rows;
}

// ─── User Helpers ────────────────────────────
async function getUser(telegramId) {
  return await queryOne(
    'SELECT * FROM users WHERE telegram_id=$1',
    [String(telegramId)]
  );
}

async function ensureUser(telegramId, firstName = '', username = '') {
  await query(
    `INSERT INTO users (telegram_id, first_name, username)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [String(telegramId), firstName, username]
  );
  return await getUser(telegramId);
}

async function addCoins(userId, amount, type, description) {
  await query(
    'UPDATE users SET balance=balance+$1 WHERE telegram_id=$2',
    [amount, String(userId)]
  );
  await query(
    'INSERT INTO transactions (user_id, type, description, amount) VALUES ($1,$2,$3,$4)',
    [String(userId), type, description, amount]
  );
  // 30% referral commission
  if (amount > 0) {
    const user = await getUser(userId);
    if (user?.referrer_id) {
      const commission = Math.floor(amount * 0.3);
      if (commission > 0) {
        await query(
          'INSERT INTO referral_earnings (referrer_id, referee_id, amount) VALUES ($1,$2,$3)',
          [user.referrer_id, String(userId), commission]
        );
      }
    }
  }
}

async function addSpins(userId, count) {
  await query(
    'UPDATE users SET spins=spins+$1 WHERE telegram_id=$2',
    [count, String(userId)]
  );
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ═══════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','X-User-Id','X-Init-Data','Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} uid=${req.headers['x-user-id']||'-'}`);
  next();
});

// Telegram auth
function verifyTelegramData(initData, botToken) {
  if (!initData || !botToken) return true;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
    const expected  = crypto.createHmac('sha256',secretKey).update(checkString).digest('hex');
    return expected === hash;
  } catch { return false; }
}

function authMiddleware(req, res, next) {
  const userId = req.headers['x-user-id'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  // Uncomment for strict production verification:
  // const initData = req.headers['x-init-data'];
  // if (BOT_TOKEN && !verifyTelegramData(initData, BOT_TOKEN)) {
  //   return res.status(401).json({ error: 'Invalid Telegram data' });
  // }
  req.userId = userId;
  next();
}

// ═══════════════════════════════════════════
// ROUTES — USER
// ═══════════════════════════════════════════

// GET /me
app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user  = await ensureUser(req.userId);
    const today = todayStr();
    const rows  = await queryAll(
      'SELECT task_type FROM daily_task_completions WHERE user_id=$1 AND date=$2',
      [req.userId, today]
    );
    const done = rows.map(r => r.task_type);
    res.json({
      balance: user.balance,
      spins:   user.spins,
      streak:  user.streak,
      dailyTasksDone: {
        checkin: done.includes('checkin'),
        updates: done.includes('updates'),
        share:   done.includes('share'),
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /daily-checkin
app.post('/daily-checkin', authMiddleware, async (req, res) => {
  try {
    const user  = await ensureUser(req.userId);
    const today = todayStr();

    const already = await queryOne(
      'SELECT id FROM daily_task_completions WHERE user_id=$1 AND task_type=$2 AND date=$3',
      [req.userId, 'checkin', today]
    );
    if (already) return res.status(400).json({ error: 'Already claimed today' });

    const yesterday = new Date(Date.now()-86400000).toISOString().split('T')[0];
    let newStreak = user.last_checkin === yesterday ? (user.streak+1) : 1;
    if (newStreak > 7) newStreak = 1;

    await addCoins(req.userId, 10, 'daily_checkin', 'Daily check-in reward');
    await addSpins(req.userId, 1);
    await query(
      'UPDATE users SET streak=$1, last_checkin=$2 WHERE telegram_id=$3',
      [newStreak, today, req.userId]
    );
    await query(
      `INSERT INTO daily_task_completions (user_id,task_type,date)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [req.userId, 'checkin', today]
    );

    const updated = await getUser(req.userId);
    res.json({ balance: updated.balance, spins: updated.spins, streak: updated.streak });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /claim-daily-task
app.post('/claim-daily-task', authMiddleware, async (req, res) => {
  try {
    const { task } = req.body;
    if (!['updates','share'].includes(task))
      return res.status(400).json({ error: 'Invalid task' });

    const today   = todayStr();
    const already = await queryOne(
      'SELECT id FROM daily_task_completions WHERE user_id=$1 AND task_type=$2 AND date=$3',
      [req.userId, task, today]
    );
    if (already) return res.status(400).json({ error: 'Already claimed today' });

    const rewards = { updates:50, share:100 };
    await addCoins(req.userId, rewards[task], 'daily_task', `Daily task: ${task}`);
    await addSpins(req.userId, 1);
    await query(
      `INSERT INTO daily_task_completions (user_id,task_type,date)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [req.userId, task, today]
    );

    const updated = await getUser(req.userId);
    res.json({ balance: updated.balance, spins: updated.spins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ROUTES — SPIN WHEEL
// ═══════════════════════════════════════════
const SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500];
const SPIN_WEIGHTS  = [40, 25, 15,  12,   5,   3];

function weightedRandom(values, weights) {
  const total = weights.reduce((a,b) => a+b, 0);
  let rand = Math.random() * total;
  for (let i=0; i<values.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return values[i];
  }
  return values[values.length-1];
}

app.post('/spin', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user)          return res.status(404).json({ error: 'User not found' });
    if (user.spins <= 0) return res.status(400).json({ error: 'No spins available' });

    const result = weightedRandom(SPIN_SEGMENTS, SPIN_WEIGHTS);
    await query('UPDATE users SET spins=spins-1 WHERE telegram_id=$1', [req.userId]);
    await addCoins(req.userId, result, 'spin', `Spin wheel: ${result} TR`);

    const updated = await getUser(req.userId);
    res.json({ result, balance: updated.balance, spins: updated.spins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ROUTES — PROMO CODES
// ═══════════════════════════════════════════
app.post('/redeem-promo', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });

    const promo = await queryOne(
      'SELECT * FROM promo_codes WHERE UPPER(code)=UPPER($1) AND active=1',
      [code.trim()]
    );
    if (!promo) return res.status(404).json({ error: 'Invalid or expired code' });
    if (promo.current_uses >= promo.max_uses)
      return res.status(400).json({ error: 'Code has reached maximum uses' });

    const used = await queryOne(
      'SELECT id FROM promo_activations WHERE code_id=$1 AND user_id=$2',
      [promo.id, req.userId]
    );
    if (used) return res.status(400).json({ error: 'Already redeemed this code' });

    await addCoins(req.userId, promo.reward, 'promo', `Promo code: ${code}`);
    await query('UPDATE promo_codes SET current_uses=current_uses+1 WHERE id=$1', [promo.id]);
    await query('INSERT INTO promo_activations (code_id,user_id) VALUES ($1,$2)', [promo.id, req.userId]);
    if (promo.current_uses+1 >= promo.max_uses)
      await query('UPDATE promo_codes SET active=0 WHERE id=$1', [promo.id]);

    const updated = await getUser(req.userId);
    res.json({ reward: promo.reward, balance: updated.balance, spins: updated.spins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ROUTES — TASKS
// ═══════════════════════════════════════════
app.get('/tasks', authMiddleware, async (req, res) => {
  try {
    const tasks = await queryAll(
      `SELECT t.*,
         CASE WHEN tc.user_id IS NOT NULL THEN true ELSE false END AS completed
       FROM tasks t
       LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.user_id=$1
       WHERE t.status='active' AND t.completions < t.limit_completions
       ORDER BY t.created_at DESC`,
      [req.userId]
    );
    const rewardMap = { channel:1000, group:1000, game:1000, visit:500 };
    res.json({
      tasks: tasks.map(t => ({
        id:        t.id,
        name:      t.name,
        type:      t.type,
        url:       t.url,
        reward:    t.reward || rewardMap[t.type] || 500,
        completed: t.completed === true,
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/claim-task', authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.body;
    const task = await queryOne('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (!task)                  return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'active') return res.status(400).json({ error: 'Task not active' });

    const already = await queryOne(
      'SELECT id FROM task_completions WHERE task_id=$1 AND user_id=$2',
      [taskId, req.userId]
    );
    if (already) return res.status(400).json({ error: 'Already completed this task' });

    const reward = task.reward || (task.type==='visit' ? 500 : 1000);
    await addCoins(req.userId, reward, 'task', `Task: ${task.name}`);
    await addSpins(req.userId, 1);
    await query('INSERT INTO task_completions (task_id,user_id) VALUES ($1,$2)', [taskId, req.userId]);
    await query('UPDATE tasks SET completions=completions+1 WHERE id=$1', [taskId]);
    await query(
      `UPDATE tasks SET status='completed' WHERE id=$1 AND completions >= limit_completions`,
      [taskId]
    );

    const user = await getUser(req.userId);
    res.json({ balance: user.balance, spins: user.spins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /verify-join — verify channel/group membership
app.post('/verify-join', authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.body;
    const task = await queryOne('SELECT * FROM tasks WHERE id=$1', [taskId]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!['channel','group'].includes(task.type))
      return res.status(400).json({ error: 'Invalid task type' });

    const already = await queryOne(
      'SELECT id FROM task_completions WHERE task_id=$1 AND user_id=$2',
      [taskId, req.userId]
    );
    if (already) return res.status(400).json({ error: 'Already completed' });

    const urlMatch = task.url.match(/t\.me\/([^/?]+)/);
    if (!urlMatch) return res.status(400).json({ error: 'Invalid task URL' });
    const chatUsername = urlMatch[1];

    const checkMembership = () => new Promise((resolve) => {
      if (!BOT_TOKEN) return resolve(true); // Dev: auto-approve
      const path = `/bot${BOT_TOKEN}/getChatMember?chat_id=@${chatUsername}&user_id=${req.userId}`;
      https.get(`https://api.telegram.org${path}`, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try {
            const json   = JSON.parse(data);
            const status = json.result?.status;
            resolve(['member','administrator','creator'].includes(status));
          } catch { resolve(false); }
        });
      }).on('error', () => resolve(false));
    });

    const isMember = await checkMembership();
    if (!isMember)
      return res.status(400).json({ error: 'You have not joined yet. Please join and try again.' });

    const reward = task.reward || 1000;
    await addCoins(req.userId, reward, 'task', `Joined: ${task.name}`);
    await addSpins(req.userId, 1);
    await query('INSERT INTO task_completions (task_id,user_id) VALUES ($1,$2)', [taskId, req.userId]);
    await query('UPDATE tasks SET completions=completions+1 WHERE id=$1', [taskId]);

    const user = await getUser(req.userId);
    res.json({ balance: user.balance, spins: user.spins });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ROUTES — FRIENDS / REFERRALS
// ═══════════════════════════════════════════
app.get('/friends', authMiddleware, async (req, res) => {
  try {
    const friends = await queryAll(
      `SELECT telegram_id, first_name AS name, balance AS coins
       FROM users WHERE referrer_id=$1 ORDER BY balance DESC LIMIT 100`,
      [req.userId]
    );
    const pendingRow = await queryOne(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM referral_earnings WHERE referrer_id=$1 AND claimed=0`,
      [req.userId]
    );
    const totalRow = await queryOne(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM referral_earnings WHERE referrer_id=$1`,
      [req.userId]
    );
    res.json({
      friends,
      pending:     parseInt(pendingRow?.total || 0),
      totalEarned: parseInt(totalRow?.total   || 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/claim-referral', authMiddleware, async (req, res) => {
  try {
    const row = await queryOne(
      `SELECT COALESCE(SUM(amount),0) AS total
       FROM referral_earnings WHERE referrer_id=$1 AND claimed=0`,
      [req.userId]
    );
    const pending = parseInt(row?.total || 0);
    if (pending <= 0) return res.status(400).json({ error: 'Nothing to claim' });

    await addCoins(req.userId, pending, 'referral', `Referral commission: ${pending} TR`);
    await query(
      'UPDATE referral_earnings SET claimed=1 WHERE referrer_id=$1 AND claimed=0',
      [req.userId]
    );

    const user = await getUser(req.userId);
    res.json({ claimed: pending, balance: user.balance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ROUTES — WALLET / WITHDRAWALS
// ═══════════════════════════════════════════
const WITHDRAWAL_TIERS = {
  250000:  { ton:0.10, net:0.05 },
  500000:  { ton:0.20, net:0.15 },
  750000:  { ton:0.30, net:0.25 },
  1000000: { ton:0.40, net:0.35 },
};

app.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const { tier } = req.body;
    const tierData  = WITHDRAWAL_TIERS[tier];
    if (!tierData) return res.status(400).json({ error: 'Invalid tier' });

    const user = await getUser(req.userId);
    if (!user)               return res.status(404).json({ error: 'User not found' });
    if (user.balance < tier) return res.status(400).json({ error: 'Insufficient balance' });

    await query('UPDATE users SET balance=balance-$1 WHERE telegram_id=$2', [tier, req.userId]);
    await query(
      'INSERT INTO transactions (user_id,type,description,amount) VALUES ($1,$2,$3,$4)',
      [req.userId, 'withdrawal', `Withdrawal: ${tier} TR → ${tierData.net} TON`, -tier]
    );
    await query(
      'INSERT INTO withdrawals (user_id,coins,ton_amount,net_amount) VALUES ($1,$2,$3,$4)',
      [req.userId, tier, tierData.ton, tierData.net]
    );

    const updated = await getUser(req.userId);
    res.json({ balance: updated.balance, message: 'Withdrawal queued. Processed within 24 hours.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const txns = await queryAll(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json({ transactions: txns });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// ROUTES — ADVERTISER
// ═══════════════════════════════════════════
app.get('/advertiser/dashboard', authMiddleware, async (req, res) => {
  try {
    const user  = await getUser(req.userId);
    const tasks = await queryAll(
      'SELECT * FROM tasks WHERE advertiser_id=$1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ balance: user?.adv_balance || 0, tasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/create-task', authMiddleware, async (req, res) => {
  try {
    const { name, type, url, limit } = req.body;
    if (!name || !type || !url || !limit)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!['visit','channel','group','game'].includes(type))
      return res.status(400).json({ error: 'Invalid task type' });

    const user = await getUser(req.userId);
    const cost = Number(limit) * 0.001;
    if (!user || user.adv_balance < cost)
      return res.status(400).json({ error: 'Insufficient ad balance' });

    const rewardMap = { visit:500, channel:1000, group:1000, game:1000 };
    await query('UPDATE users SET adv_balance=adv_balance-$1 WHERE telegram_id=$2', [cost, req.userId]);
    await query(
      `INSERT INTO tasks (advertiser_id,name,type,url,reward,limit_completions)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.userId, name, type, url, rewardMap[type], Number(limit)]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// TELEGRAM BOT WEBHOOK
// ═══════════════════════════════════════════
const adminSessions = new Map();

app.post('/bot-webhook', async (req, res) => {
  res.json({ ok: true }); // Acknowledge immediately
  const update = req.body;
  if (!update) return;

  try {
    // Callback queries (admin panel buttons)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg || !msg.from) return;

    const chatId    = msg.chat.id;
    const userId    = String(msg.from.id);
    const text      = msg.text || '';
    const firstName = msg.from.first_name || '';
    const username  = msg.from.username   || '';

    // Admin wizard in progress
    if (adminSessions.has(userId) && userId === ADMIN_ID) {
      await handleAdminSession(userId, chatId, text);
      return;
    }

    // ── /start ──────────────────────────────
    if (text.startsWith('/start')) {
      const parts      = text.split(' ');
      const referralId = parts[1] || null;
      const existing   = await getUser(userId);
      let validReferrer = null;

      if (!existing) {
        if (referralId && referralId !== userId) {
          const referrer = await getUser(referralId);
          if (referrer) validReferrer = referralId;
        }
        await query(
          `INSERT INTO users (telegram_id,first_name,username,referrer_id,spins)
           VALUES ($1,$2,$3,$4,1) ON CONFLICT (telegram_id) DO NOTHING`,
          [userId, firstName, username, validReferrer]
        );
      }

      const isNew      = !existing;
      const welcomeMsg = isNew
        ? `🎉 <b>Welcome to TRewards, ${firstName}!</b>\n\n` +
          `You've joined the #1 Telegram rewards platform.\n\n` +
          `🪙 Complete tasks to earn <b>TR coins</b>\n` +
          `🎰 Spin the wheel for instant rewards\n` +
          `👥 Invite friends & earn <b>30%</b> of their coins\n` +
          `💎 Withdraw earnings as <b>TON cryptocurrency</b>\n\n` +
          `<b>You start with 1 free spin! 🎁</b>`
        : `👋 <b>Welcome back, ${firstName}!</b>\n\nYour rewards are waiting for you.`;

      await sendMessage(chatId, welcomeMsg, {
        reply_markup: {
          inline_keyboard: [[
            { text: '🚀 Open TRewards', web_app: { url: process.env.WEBAPP_URL || 'https://yourdomain.com' } }
          ]]
        }
      });

      // Notify referrer
      if (isNew && validReferrer) {
        try {
          await sendMessage(validReferrer,
            `🎉 <b>New referral!</b>\n${firstName} joined using your link!\nYou'll earn 30% of their coins automatically.`
          );
        } catch {}
      }
      return;
    }

    // ── /amiadminyes ─────────────────────────
    if (text === '/amiadminyes') {
      if (userId !== ADMIN_ID) { await sendMessage(chatId, '❌ Unauthorized'); return; }
      const usersRow = await queryOne('SELECT COUNT(*) AS c FROM users');
      const txRow    = await queryOne('SELECT COUNT(*) AS c FROM transactions');
      const wdRow    = await queryOne(`SELECT COUNT(*) AS c, COALESCE(SUM(net_amount),0) AS total FROM withdrawals WHERE status='pending'`);
      const tkRow    = await queryOne(`SELECT COUNT(*) AS c FROM tasks WHERE status='active'`);
      await sendMessage(chatId,
        `🔐 <b>TRewards Admin Panel</b>\n\n` +
        `👥 Total users: <b>${usersRow?.c||0}</b>\n` +
        `📊 Transactions: <b>${txRow?.c||0}</b>\n` +
        `⏳ Pending withdrawals: <b>${wdRow?.c||0}</b> (${parseFloat(wdRow?.total||0).toFixed(4)} TON)\n` +
        `✅ Active tasks: <b>${tkRow?.c||0}</b>`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text:'➕ Create Promo Code',  callback_data:'admin_create_promo'  }],
              [{ text:'📋 List Promo Codes',    callback_data:'admin_list_promos'   }],
              [{ text:'🗑 Delete Promo Code',   callback_data:'admin_delete_promo'  }],
              [{ text:'📊 Activation History',  callback_data:'admin_promo_history' }],
              [{ text:'💰 Pending Withdrawals', callback_data:'admin_withdrawals'   }],
              [{ text:'👥 Total Users',         callback_data:'admin_total_users'   }],
            ]
          }
        }
      );
      return;
    }

    // ── /balance ─────────────────────────────
    if (text === '/balance') {
      const user = await getUser(userId);
      if (!user) { await sendMessage(chatId, '❌ Send /start first.'); return; }
      await sendMessage(chatId,
        `💰 <b>Your Balance</b>\n\n` +
        `TR Coins: <b>${Number(user.balance).toLocaleString()}</b>\n` +
        `TON equiv: <b>${(user.balance * 0.0000004).toFixed(8)}</b>\n` +
        `Spins: <b>${user.spins}</b>\n` +
        `Streak: <b>${user.streak} days</b>`
      );
      return;
    }

    // ── /help ────────────────────────────────
    if (text === '/help') {
      await sendMessage(chatId,
        `ℹ️ <b>TRewards Commands</b>\n\n` +
        `/start - Open TRewards app\n` +
        `/balance - Check your balance\n` +
        `/help - Show this message`,
        { reply_markup: { inline_keyboard: [[{ text:'🚀 Open TRewards', web_app:{ url: process.env.WEBAPP_URL||'' } }]] } }
      );
      return;
    }

  } catch (e) {
    console.error('Webhook handler error:', e.message);
  }
});

// ─── Callback Query Handler ──────────────────
async function handleCallbackQuery(callback) {
  const userId = String(callback.from.id);
  const chatId = callback.message.chat.id;
  const data   = callback.data;

  await tgRequest('answerCallbackQuery', { callback_query_id: callback.id });
  if (userId !== ADMIN_ID) return;

  if (data === 'admin_total_users') {
    const total = await queryOne('SELECT COUNT(*) AS c FROM users');
    const today = await queryOne("SELECT COUNT(*) AS c FROM users WHERE DATE(created_at)=CURRENT_DATE");
    const week  = await queryOne("SELECT COUNT(*) AS c FROM users WHERE created_at >= NOW() - INTERVAL '7 days'");
    await sendMessage(chatId,
      `👥 <b>User Statistics</b>\n\n` +
      `Total: <b>${total?.c||0}</b>\n` +
      `New today: <b>${today?.c||0}</b>\n` +
      `New this week: <b>${week?.c||0}</b>`
    );
  }
  else if (data === 'admin_list_promos') {
    const promos = await queryAll('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20');
    if (!promos.length) { await sendMessage(chatId, '📭 No promo codes found.'); return; }
    const list = promos.map(p =>
      `• <code>${p.code}</code>: <b>${p.reward} TR</b> | ${p.current_uses}/${p.max_uses} | ${p.active?'✅':'❌'}`
    ).join('\n');
    await sendMessage(chatId, `📋 <b>Promo Codes:</b>\n\n${list}`);
  }
  else if (data === 'admin_promo_history') {
    const rows = await queryAll(`
      SELECT pa.*, pc.code, pc.reward, u.first_name
      FROM promo_activations pa
      JOIN promo_codes pc ON pc.id=pa.code_id
      JOIN users u ON u.telegram_id=pa.user_id
      ORDER BY pa.activated_at DESC LIMIT 20
    `);
    if (!rows.length) { await sendMessage(chatId, '📭 No activations yet.'); return; }
    const list = rows.map(a => `• ${a.first_name} used <code>${a.code}</code> (+${a.reward} TR)`).join('\n');
    await sendMessage(chatId, `📊 <b>Recent Activations:</b>\n\n${list}`);
  }
  else if (data === 'admin_withdrawals') {
    const rows = await queryAll(`
      SELECT w.*, u.first_name, u.username
      FROM withdrawals w JOIN users u ON u.telegram_id=w.user_id
      WHERE w.status='pending' ORDER BY w.created_at ASC LIMIT 15
    `);
    if (!rows.length) { await sendMessage(chatId, '✅ No pending withdrawals.'); return; }
    const list = rows.map(w =>
      `• ${w.first_name} (@${w.username||'-'})\n  ${Number(w.coins).toLocaleString()} TR → ${w.net_amount} TON | ID: #${w.id}`
    ).join('\n\n');
    await sendMessage(chatId, `💰 <b>Pending Withdrawals (${rows.length}):</b>\n\n${list}`);
  }
  else if (data === 'admin_create_promo') {
    adminSessions.set(userId, { step:'promo_name' });
    await sendMessage(chatId,
      '➕ <b>Create Promo Code</b>\n\nStep 1/3: Enter the promo code name\n<i>(e.g. WELCOME2025)</i>'
    );
  }
  else if (data === 'admin_delete_promo') {
    adminSessions.set(userId, { step:'delete_promo' });
    await sendMessage(chatId, '🗑 Enter the promo code to deactivate:');
  }
}

// ─── Admin Promo Wizard ───────────────────────
async function handleAdminSession(userId, chatId, text) {
  const session = adminSessions.get(userId);
  if (!session) return;

  if (session.step === 'promo_name') {
    const code = text.toUpperCase().trim().replace(/\s+/g,'_').replace(/[^A-Z0-9_]/g,'');
    if (!code || code.length < 3) {
      await sendMessage(chatId, '❌ Invalid. Use letters/numbers/underscores, min 3 chars:');
      return;
    }
    session.code = code;
    session.step = 'promo_reward';
    adminSessions.set(userId, session);
    await sendMessage(chatId, `Code: <code>${code}</code>\n\nStep 2/3: Enter reward amount (TR coins):`);
  }
  else if (session.step === 'promo_reward') {
    const reward = parseInt(text);
    if (isNaN(reward) || reward <= 0 || reward > 1000000) {
      await sendMessage(chatId, '❌ Invalid. Enter a number between 1 and 1,000,000:');
      return;
    }
    session.reward = reward;
    session.step   = 'promo_max_uses';
    adminSessions.set(userId, session);
    await sendMessage(chatId, `Reward: <b>${reward} TR</b>\n\nStep 3/3: Enter maximum activations:`);
  }
  else if (session.step === 'promo_max_uses') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses) || maxUses <= 0 || maxUses > 1000000) {
      await sendMessage(chatId, '❌ Invalid. Enter between 1 and 1,000,000:');
      return;
    }
    try {
      await query(
        'INSERT INTO promo_codes (code,reward,max_uses) VALUES ($1,$2,$3)',
        [session.code, session.reward, maxUses]
      );
      adminSessions.delete(userId);
      await sendMessage(chatId,
        `✅ <b>Promo Code Created!</b>\n\n` +
        `Code: <code>${session.code}</code>\n` +
        `Reward: <b>${session.reward} TR</b>\n` +
        `Max uses: <b>${maxUses}</b>`
      );
    } catch {
      adminSessions.delete(userId);
      await sendMessage(chatId, `❌ Code <code>${session.code}</code> already exists.`);
    }
  }
  else if (session.step === 'delete_promo') {
    const code   = text.toUpperCase().trim();
    const result = await query('UPDATE promo_codes SET active=0 WHERE UPPER(code)=$1', [code]);
    adminSessions.delete(userId);
    await sendMessage(chatId,
      result.rowCount > 0
        ? `✅ Promo code <code>${code}</code> deactivated.`
        : `❌ Code <code>${code}</code> not found.`
    );
  }
}

// ─── Telegram API Helper ─────────────────────
function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!BOT_TOKEN) return resolve({ ok:true });
    const body    = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Telegram')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgRequest('sendMessage', { chat_id:chatId, text, parse_mode:'HTML', ...extra });
}

// ═══════════════════════════════════════════
// ADMIN REST API
// ═══════════════════════════════════════════
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY)
    return res.status(403).json({ error:'Forbidden' });
  next();
}

app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const users     = await queryOne('SELECT COUNT(*) AS c FROM users');
    const txns      = await queryOne('SELECT COUNT(*) AS c FROM transactions');
    const pendingWd = await queryOne(`SELECT COUNT(*) AS c, COALESCE(SUM(net_amount),0) AS total FROM withdrawals WHERE status='pending'`);
    const tasks     = await queryOne(`SELECT COUNT(*) AS c FROM tasks WHERE status='active'`);
    res.json({
      users:               users?.c     || 0,
      transactions:        txns?.c      || 0,
      pendingWithdrawals:  pendingWd?.c || 0,
      pendingTon:          parseFloat(pendingWd?.total||0).toFixed(4),
      activeTasks:         tasks?.c     || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const list = await queryAll(`
      SELECT w.*, u.first_name, u.username
      FROM withdrawals w JOIN users u ON u.telegram_id=w.user_id
      WHERE w.status='pending' ORDER BY w.created_at ASC
    `);
    res.json({ withdrawals: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/withdrawal/:id/complete', adminAuth, async (req, res) => {
  try {
    await query(`UPDATE withdrawals SET status='completed' WHERE id=$1`, [req.params.id]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/withdrawal/:id/reject', adminAuth, async (req, res) => {
  try {
    const wd = await queryOne('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
    if (!wd) return res.status(404).json({ error:'Not found' });
    await query(`UPDATE withdrawals SET status='rejected' WHERE id=$1`, [req.params.id]);
    await query('UPDATE users SET balance=balance+$1 WHERE telegram_id=$2', [wd.coins, wd.user_id]);
    await query(
      'INSERT INTO transactions (user_id,type,description,amount) VALUES ($1,$2,$3,$4)',
      [wd.user_id, 'refund', `Withdrawal refunded: ${wd.coins} TR`, wd.coins]
    );
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════
app.get('/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status:'ok', db:'connected', time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status:'error', db:'disconnected', error: e.message });
  }
});

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🏆 TRewards Backend running on port ${PORT}`);
  console.log(`🗄️  Database : Supabase PostgreSQL (pooler)`);
  console.log(`🤖 Bot token: ${BOT_TOKEN ? 'SET ✅' : 'NOT SET ⚠️'}`);
  console.log(`🔐 Admin ID : ${ADMIN_ID  || 'NOT SET ⚠️'}\n`);
});

module.exports = app;