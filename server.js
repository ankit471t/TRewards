/**
 * TRewards Backend API
 * ====================
 * Host: Render (Web Service)
 * Runtime: Node.js 18+
 * Database: Supabase PostgreSQL
 *
 * FILL IN THE FOLLOWING BEFORE DEPLOYING:
 *   BOT_TOKEN           — Your Telegram Bot token from @BotFather
 *   CRYPTOBOT_TOKEN     — Your CryptoBot API token from @CryptoBot → My Apps
 *   CRYPTOBOT_WEBHOOK_SECRET — Any random string you choose (min 20 chars)
 *   SUPABASE_URL        — Your Supabase project URL  (Settings → API)
 *   SUPABASE_SERVICE_KEY— Your Supabase service_role key (Settings → API)
 *   ADMIN_IDS           — Comma-separated Telegram user IDs who are admins
 *   FRONTEND_URL        — Your Render frontend URL (e.g. https://trewards.onrender.com)
 *
 * DEPLOY STEPS ON RENDER:
 *   1. Create a new Web Service → connect your GitHub repo
 *   2. Build command:  npm install
 *   3. Start command:  node server.js
 *   4. Add all env vars in Render → Environment tab
 *   5. After deploy, register webhook:
 *      curl -X POST https://api.telegram.org/bot<BOT_TOKEN>/setWebhook \
 *           -d "url=https://your-backend.onrender.com/telegram-webhook"
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto');
const https    = require('https');
const { Pool } = require('pg');

// ─── ENV ─────────────────────────────────────────────────────────────────────
// FILL IN: Set these in Render → Environment Variables
const BOT_TOKEN              = process.env.BOT_TOKEN              || 'FILL_YOUR_BOT_TOKEN_HERE';
const CRYPTOBOT_TOKEN        = process.env.CRYPTOBOT_TOKEN        || 'FILL_YOUR_CRYPTOBOT_TOKEN_HERE';
const CRYPTOBOT_WEBHOOK_SECRET = process.env.CRYPTOBOT_WEBHOOK_SECRET || 'FILL_ANY_RANDOM_SECRET_STRING';
const SUPABASE_URL           = process.env.SUPABASE_URL           || 'FILL_YOUR_SUPABASE_URL';           // e.g. https://xxxx.supabase.co
const SUPABASE_SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY   || 'FILL_YOUR_SUPABASE_SERVICE_ROLE_KEY';
const FRONTEND_URL           = process.env.FRONTEND_URL           || 'FILL_YOUR_FRONTEND_URL';           // e.g. https://trewards.onrender.com
const ADMIN_IDS              = (process.env.ADMIN_IDS || 'FILL_YOUR_TELEGRAM_USER_ID').split(',').map(Number);
const PORT                   = process.env.PORT || 3000;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// Supabase provides a PostgreSQL connection string.
// Go to Supabase → Settings → Database → Connection String → URI
// FILL IN: Add DATABASE_URL env var in Render with the Supabase connection URI
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'FILL_YOUR_SUPABASE_DATABASE_URI',
  ssl: { rejectUnauthorized: false },  // Required for Supabase
  max: 10,
  idleTimeoutMillis: 30000,
});

async function db(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

// ─── APP ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(cors({
  origin: [FRONTEND_URL, 'https://web.telegram.org'],
  credentials: true,
}));

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** Validate Telegram initData signature */
function validateTelegramInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (hash !== expectedHash) return null;
  return Object.fromEntries(params.entries());
}

/** Extract and validate user from request */
function getUser(req) {
  const initData = req.headers['x-telegram-init-data'] || req.body?.initData;
  if (!initData) return null;
  const data = validateTelegramInitData(initData);
  if (!data || !data.user) return null;
  return JSON.parse(data.user);
}

/** Call Telegram Bot API */
async function tgApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Call CryptoBot API */
async function cryptobotApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: 'pay.crypt.bot',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Crypto-Pay-API-Token': CRYPTOBOT_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Generate xRocket payment URL */
function xRocketUrl(userId, amountTon) {
  // FILL IN: Replace 'YOUR_XROCKET_BOT_USERNAME' with your xRocket bot username
  // Get it from https://t.me/xRocketBot → Create Cheque / Invoice
  // xRocket does not have a public invoice API yet; use their deep link format:
  // https://t.me/xrocket?start=inv_BOTUSERNAME_USERID_AMOUNT
  // OR use their cheque system. Replace below with whatever xRocket provides you.
  const xRocketBotUsername = process.env.XROCKET_BOT_USERNAME || 'FILL_YOUR_XROCKET_BOT_USERNAME';
  return `https://t.me/${xRocketBotUsername}?start=topup_${userId}_${amountTon}`;
}

/** Record a transaction */
async function logTransaction(userId, type, amount, description) {
  await db(
    `INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,$2,$3,$4)`,
    [userId, type, amount, description]
  );
}

/** Credit coins to user and notify referrer */
async function creditCoins(userId, coins, type, description) {
  // Credit user
  await db(`UPDATE users SET coins = coins + $1 WHERE user_id = $2`, [coins, userId]);
  await logTransaction(userId, type, coins, description);

  // 30% referral reward
  const ref = await db(`SELECT referrer_id FROM users WHERE user_id = $1`, [userId]);
  if (ref.rows[0]?.referrer_id) {
    const referrerId = ref.rows[0].referrer_id;
    const bonus = Math.floor(coins * 0.3);
    if (bonus > 0) {
      await db(
        `INSERT INTO referral_rewards (referrer_id, referred_user, reward) VALUES ($1,$2,$3)`,
        [referrerId, userId, bonus]
      );
    }
  }
}

/** Ensure user row exists */
async function ensureUser(userId, firstName, username) {
  await db(
    `INSERT INTO users (user_id, first_name, username) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET first_name=$2, username=$3, last_seen=NOW()`,
    [userId, firstName || 'User', username || null]
  );
  // Ensure advertiser_balance row
  await db(
    `INSERT INTO advertiser_balance (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ──────────────────────────────────────────────────────────────────────────────
// TELEGRAM BOT WEBHOOK
// ──────────────────────────────────────────────────────────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);  // always ack first
  const update = req.body;
  if (!update?.message) return;

  const msg    = update.message;
  const userId = msg.from.id;
  const text   = msg.text || '';

  // /start [referral_id]
  if (text.startsWith('/start')) {
    const parts     = text.split(' ');
    const referrerId = parts[1] ? parseInt(parts[1]) : null;

    // Check if user already exists
    const existing = await db(`SELECT user_id FROM users WHERE user_id=$1`, [userId]);
    const isNew    = existing.rows.length === 0;

    // Self-referral guard
    const validRef = referrerId && referrerId !== userId ? referrerId : null;

    if (isNew) {
      await db(
        `INSERT INTO users (user_id, first_name, username, referrer_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [userId, msg.from.first_name, msg.from.username || null, validRef]
      );
      await db(
        `INSERT INTO advertiser_balance (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId]
      );
    } else {
      await db(
        `UPDATE users SET last_seen=NOW(), first_name=$2, username=$3 WHERE user_id=$1`,
        [userId, msg.from.first_name, msg.from.username || null]
      );
    }

    // FILL IN: Replace 'YOUR_MINI_APP_URL' with your actual Telegram Mini App URL
    // It looks like https://t.me/trewards_ton_bot/app (set via BotFather → Menu Button)
    const miniAppUrl = process.env.MINI_APP_URL || 'FILL_YOUR_MINI_APP_URL';

    await tgApi('sendMessage', {
      chat_id: userId,
      text: `👋 Welcome to *TRewards*, ${msg.from.first_name}!\n\n🪙 Earn TR coins by completing tasks\n🎡 Spin the wheel for bonuses\n👥 Invite friends & earn 30% of their rewards\n\n🚀 Open the app to get started!`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Open TRewards', web_app: { url: miniAppUrl } }
        ]]
      }
    });
  }

  // /amiadminyes — admin panel
  if (text === '/amiadminyes') {
    if (!ADMIN_IDS.includes(userId)) {
      await tgApi('sendMessage', { chat_id: userId, text: '⛔ Access denied.' });
      return;
    }
    const usersCount  = (await db(`SELECT COUNT(*) FROM users`)).rows[0].count;
    const promoCount  = (await db(`SELECT COUNT(*) FROM promo_codes`)).rows[0].count;
    const tasksCount  = (await db(`SELECT COUNT(*) FROM tasks WHERE status='active'`)).rows[0].count;
    const paymentsSum = (await db(`SELECT COALESCE(SUM(amount_ton),0) as s FROM payments WHERE status='paid'`)).rows[0].s;
    await tgApi('sendMessage', {
      chat_id: userId,
      text: `🛡 *TRewards Admin Panel*\n\n👥 Users: \`${usersCount}\`\n✅ Active Tasks: \`${tasksCount}\`\n🎟 Promo Codes: \`${promoCount}\`\n💰 Total Paid: \`${paymentsSum} TON\`\n\nSelect an action:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Create Promo Code', callback_data: 'admin_create_promo' }],
          [{ text: '📋 List Promo Codes',  callback_data: 'admin_list_promos'  }],
          [{ text: '🗑 Delete Promo Code', callback_data: 'admin_delete_promo' }],
          [{ text: '📜 Activation History',callback_data: 'admin_history'      }],
          [{ text: '📊 Payment History',   callback_data: 'admin_payments'     }],
          [{ text: '👥 Total Users',       callback_data: 'admin_users'        }],
        ]
      }
    });
  }
});

// Admin callback queries handled separately
app.post('/telegram-webhook', async (req, res) => {
  // Already handled above — this is intentional duplicate block for callbacks
});

// ──────────────────────────────────────────────────────────────────────────────
// USER PROFILE  GET /me
// ──────────────────────────────────────────────────────────────────────────────
app.get('/me', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  await ensureUser(tgUser.id, tgUser.first_name, tgUser.username);

  const user = (await db(`SELECT * FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
  const adBal = (await db(`SELECT balance_ton FROM advertiser_balance WHERE user_id=$1`, [tgUser.id])).rows[0];
  const claimable = (await db(`SELECT COALESCE(SUM(reward),0) as s FROM referral_rewards WHERE referrer_id=$1 AND claimed=FALSE`, [tgUser.id])).rows[0].s;

  res.json({
    user_id:       user.user_id,
    first_name:    user.first_name,
    username:      user.username,
    coins:         user.coins,
    spins:         user.spins,
    streak:        user.streak,
    ad_balance:    parseFloat(adBal?.balance_ton || 0),
    claimable_ref: parseInt(claimable),
    referral_link: `https://t.me/trewards_ton_bot?start=${user.user_id}`,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// DAILY TASKS  POST /daily-task
// ──────────────────────────────────────────────────────────────────────────────
app.post('/daily-task', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const { task_name } = req.body;
  const validTasks = ['checkin', 'visit_channel', 'share'];
  if (!validTasks.includes(task_name)) return res.status(400).json({ error: 'Invalid task' });

  try {
    // One per day per task
    await db(
      `INSERT INTO daily_tasks (user_id, task_name, completed, date) VALUES ($1,$2,TRUE,CURRENT_DATE)`,
      [tgUser.id, task_name]
    );
    await creditCoins(tgUser.id, 10, 'earn_task', `Daily task: ${task_name}`);
    await db(`UPDATE users SET spins=spins+1 WHERE user_id=$1`, [tgUser.id]);
    return res.json({ ok: true, coins: 10, spins: 1 });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Already completed today' });
    throw e;
  }
});

// Check which daily tasks done today
app.get('/daily-tasks-status', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const rows = await db(
    `SELECT task_name FROM daily_tasks WHERE user_id=$1 AND date=CURRENT_DATE`,
    [tgUser.id]
  );
  const done = rows.rows.map(r => r.task_name);
  res.json({ done });
});

// ──────────────────────────────────────────────────────────────────────────────
// STREAK  POST /claim-streak
// ──────────────────────────────────────────────────────────────────────────────
app.post('/claim-streak', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  // Use daily_tasks 'streak' to prevent double claim
  try {
    await db(
      `INSERT INTO daily_tasks (user_id, task_name, completed, date) VALUES ($1,'streak',TRUE,CURRENT_DATE)`,
      [tgUser.id]
    );
    // Increment streak counter
    await db(
      `UPDATE users SET streak=CASE WHEN streak<7 THEN streak+1 ELSE 1 END, spins=spins+1 WHERE user_id=$1`,
      [tgUser.id]
    );
    await creditCoins(tgUser.id, 10, 'streak', 'Daily streak reward');
    const user = (await db(`SELECT coins, spins, streak FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
    return res.json({ ok: true, coins: user.coins, spins: user.spins, streak: user.streak });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Already claimed today' });
    throw e;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// TASKS  GET /tasks
// ──────────────────────────────────────────────────────────────────────────────
app.get('/tasks', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const tasks = await db(
    `SELECT t.*, u.first_name as advertiser_name
     FROM tasks t
     JOIN users u ON t.advertiser_id = u.user_id
     WHERE t.status='active' AND t.completed_count < t.total_limit
     ORDER BY t.created_at DESC`,
    []
  );

  // Which ones has this user already completed?
  const completed = await db(
    `SELECT task_id FROM task_completions WHERE user_id=$1`,
    [tgUser.id]
  );
  const completedIds = new Set(completed.rows.map(r => r.task_id));

  const result = tasks.rows.map(t => ({
    ...t,
    user_status: completedIds.has(t.id) ? 'done' : 'pending',
  }));
  res.json(result);
});

// ──────────────────────────────────────────────────────────────────────────────
// VERIFY JOIN (channel/group membership)  POST /verify-join
// ──────────────────────────────────────────────────────────────────────────────
app.post('/verify-join', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const { task_id, chat_id } = req.body;
  if (!task_id || !chat_id) return res.status(400).json({ error: 'task_id and chat_id required' });

  // Check membership via Telegram API
  const tgRes = await tgApi('getChatMember', { chat_id, user_id: tgUser.id });
  if (!tgRes.ok) return res.json({ joined: false, reason: tgRes.description || 'API error' });

  const status = tgRes.result?.status;
  const joined = ['member', 'administrator', 'creator'].includes(status);
  if (!joined) return res.json({ joined: false, reason: 'Not a member' });

  // Award coins
  try {
    const task = (await db(`SELECT * FROM tasks WHERE id=$1 AND status='active'`, [task_id])).rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });

    await db(
      `INSERT INTO task_completions (user_id, task_id, reward) VALUES ($1,$2,$3)`,
      [tgUser.id, task_id, task.reward]
    );
    await db(`UPDATE tasks SET completed_count=completed_count+1 WHERE id=$1`, [task_id]);
    await creditCoins(tgUser.id, task.reward, 'earn_task', `Task: ${task.title}`);
    await db(`UPDATE users SET spins=spins+1 WHERE user_id=$1`, [tgUser.id]);

    const user = (await db(`SELECT coins, spins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
    return res.json({ joined: true, reward: task.reward, coins: user.coins, spins: user.spins });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Already completed' });
    throw e;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CLAIM TASK (visit/game — timer-based)  POST /claim-task
// ──────────────────────────────────────────────────────────────────────────────
app.post('/claim-task', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const { task_id } = req.body;

  try {
    const task = (await db(`SELECT * FROM tasks WHERE id=$1 AND status='active'`, [task_id])).rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!['visit','game'].includes(task.type)) return res.status(400).json({ error: 'Wrong task type' });

    await db(
      `INSERT INTO task_completions (user_id, task_id, reward) VALUES ($1,$2,$3)`,
      [tgUser.id, task_id, task.reward]
    );
    await db(`UPDATE tasks SET completed_count=completed_count+1 WHERE id=$1`, [task_id]);
    await creditCoins(tgUser.id, task.reward, 'earn_task', `Task: ${task.title}`);
    await db(`UPDATE users SET spins=spins+1 WHERE user_id=$1`, [tgUser.id]);

    const user = (await db(`SELECT coins, spins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
    return res.json({ ok: true, reward: task.reward, coins: user.coins, spins: user.spins });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Already completed' });
    throw e;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CREATE TASK (advertiser)  POST /create-task
// ──────────────────────────────────────────────────────────────────────────────
app.post('/create-task', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const { title, description, type, url, total_limit } = req.body;
  if (!title || !type || !url || !total_limit) return res.status(400).json({ error: 'Missing fields' });

  const VALID_TYPES = ['visit','channel','group','game'];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const reward = type === 'visit' ? 500 : 1000;
  const cost   = parseFloat(total_limit) * 0.001;

  // Deduct ad balance
  const bal = (await db(
    `UPDATE advertiser_balance SET balance_ton=balance_ton-$1
     WHERE user_id=$2 AND balance_ton>=$1 RETURNING balance_ton`,
    [cost, tgUser.id]
  )).rows[0];
  if (!bal) return res.status(402).json({ error: 'Insufficient ad balance' });

  const task = (await db(
    `INSERT INTO tasks (title, description, type, url, reward, advertiser_id, total_limit)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [title, description || '', type, url, reward, tgUser.id, total_limit]
  )).rows[0];

  res.json(task);
});

// GET advertiser's tasks
app.get('/my-tasks', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const tasks = await db(
    `SELECT * FROM tasks WHERE advertiser_id=$1 ORDER BY created_at DESC`,
    [tgUser.id]
  );
  res.json(tasks.rows);
});

// ──────────────────────────────────────────────────────────────────────────────
// PAYMENTS  POST /create-payment
// ──────────────────────────────────────────────────────────────────────────────
app.post('/create-payment', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const amount = parseFloat(req.body.amount);
  if (!amount || amount < 0.1 || amount > 1000) {
    return res.status(400).json({ error: 'Invalid amount (min 0.1 TON)' });
  }

  await ensureUser(tgUser.id, tgUser.first_name, tgUser.username);

  // 1. Create CryptoBot invoice
  const cbRes = await cryptobotApi('createInvoice', {
    asset: 'TON',
    amount: amount.toFixed(4),
    description: `TRewards Ad Balance Top-Up — ${amount} TON`,
    hidden_message: `User ${tgUser.id} top-up`,
    payload: JSON.stringify({ user_id: tgUser.id, amount }),
    paid_btn_name: 'callback',
    paid_btn_url: `${process.env.BACKEND_URL || 'https://your-backend.onrender.com'}/cryptobot-paid`,
    allow_anonymous: false,
    expires_in: 3600,
  });

  if (!cbRes.ok) {
    console.error('CryptoBot error:', cbRes);
    return res.status(500).json({ error: 'CryptoBot invoice creation failed' });
  }

  const invoiceId  = String(cbRes.result.invoice_id);
  const invoiceUrl = cbRes.result.pay_url;

  // 2. Store in DB
  await db(
    `INSERT INTO payments (user_id, amount_ton, provider, invoice_id, status)
     VALUES ($1,$2,'cryptobot',$3,'pending')`,
    [tgUser.id, amount, invoiceId]
  );

  // 3. xRocket URL (no invoice needed — deep link)
  const xrocketUrl = xRocketUrl(tgUser.id, amount);

  // Store xRocket pending too
  await db(
    `INSERT INTO payments (user_id, amount_ton, provider, invoice_id, status)
     VALUES ($1,$2,'xrocket',$3,'pending')`,
    [tgUser.id, amount, `xr_${tgUser.id}_${Date.now()}`]
  );

  res.json({
    cryptobot: invoiceUrl,
    xrocket:   xrocketUrl,
    amount,
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// CRYPTOBOT WEBHOOK  POST /payment-webhook
// ──────────────────────────────────────────────────────────────────────────────
app.post('/payment-webhook', async (req, res) => {
  // Verify CryptoBot signature
  // FILL IN: CryptoBot sends a header 'crypto-pay-api-signature'
  // Verify: HMAC-SHA256 of JSON body using your CRYPTOBOT_WEBHOOK_SECRET
  const signature = req.headers['crypto-pay-api-signature'];
  const body      = JSON.stringify(req.body);
  const expected  = crypto.createHmac('sha256', CRYPTOBOT_WEBHOOK_SECRET).update(body).digest('hex');
  if (signature !== expected) {
    console.warn('Invalid webhook signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  res.sendStatus(200); // ack immediately

  const { update_type, payload } = req.body;
  if (update_type !== 'invoice_paid') return;

  const invoiceId = String(payload.invoice_id);
  const amountTon = parseFloat(payload.amount);

  // Idempotency — find pending payment
  const payment = (await db(
    `SELECT * FROM payments WHERE invoice_id=$1 AND status='pending'`,
    [invoiceId]
  )).rows[0];

  if (!payment) {
    console.warn(`No pending payment for invoice ${invoiceId}`);
    return;
  }

  // Validate amount matches
  if (Math.abs(payment.amount_ton - amountTon) > 0.001) {
    console.warn(`Amount mismatch: expected ${payment.amount_ton}, got ${amountTon}`);
    await db(`UPDATE payments SET status='failed' WHERE id=$1`, [payment.id]);
    return;
  }

  // Mark paid
  await db(
    `UPDATE payments SET status='paid', paid_at=NOW() WHERE id=$1`,
    [payment.id]
  );

  // Credit advertiser balance
  await db(
    `INSERT INTO advertiser_balance (user_id, balance_ton) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance_ton=advertiser_balance.balance_ton+$2, updated_at=NOW()`,
    [payment.user_id, amountTon]
  );

  await logTransaction(payment.user_id, 'ad_topup', 0, `Ad top-up ${amountTon} TON via CryptoBot`);
  console.log(`✅ Payment credited: user=${payment.user_id} amount=${amountTon} TON`);
});

// ──────────────────────────────────────────────────────────────────────────────
// XROCKET WEBHOOK  POST /xrocket-webhook
// Note: xRocket webhook setup — FILL IN when you get xRocket API access.
// ──────────────────────────────────────────────────────────────────────────────
app.post('/xrocket-webhook', async (req, res) => {
  // FILL IN: Implement xRocket webhook verification according to their docs.
  // xRocket sends payment confirmation here when user pays.
  // Pattern is the same as CryptoBot above.
  res.sendStatus(200);
  const { user_id, amount } = req.body; // FILL IN: parse xRocket's actual payload structure
  if (!user_id || !amount) return;

  const userId = parseInt(user_id);
  const amountTon = parseFloat(amount);

  await db(
    `INSERT INTO advertiser_balance (user_id, balance_ton) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET balance_ton=advertiser_balance.balance_ton+$2, updated_at=NOW()`,
    [userId, amountTon]
  );
  await logTransaction(userId, 'ad_topup', 0, `Ad top-up ${amountTon} TON via xRocket`);
  console.log(`✅ xRocket payment: user=${userId} amount=${amountTon} TON`);
});

// ──────────────────────────────────────────────────────────────────────────────
// AD BALANCE  GET /ad-balance
// ──────────────────────────────────────────────────────────────────────────────
app.get('/ad-balance', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const row = (await db(`SELECT balance_ton FROM advertiser_balance WHERE user_id=$1`, [tgUser.id])).rows[0];
  res.json({ balance_ton: parseFloat(row?.balance_ton || 0) });
});

// ──────────────────────────────────────────────────────────────────────────────
// SPIN WHEEL  POST /spin
// ──────────────────────────────────────────────────────────────────────────────
app.post('/spin', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const user = (await db(`SELECT spins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
  if (!user || user.spins <= 0) return res.status(400).json({ error: 'No spins available' });

  const SEGMENTS = [10, 50, 80, 100, 300, 500];
  const reward   = SEGMENTS[Math.floor(Math.random() * SEGMENTS.length)];

  await db(`UPDATE users SET spins=spins-1 WHERE user_id=$1`, [tgUser.id]);
  await creditCoins(tgUser.id, reward, 'earn_spin', `Spin wheel reward`);
  await db(`INSERT INTO spin_history (user_id, reward) VALUES ($1,$2)`, [tgUser.id, reward]);

  const updated = (await db(`SELECT coins, spins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
  res.json({ reward, coins: updated.coins, spins: updated.spins });
});

// ──────────────────────────────────────────────────────────────────────────────
// PROMO CODE  POST /redeem-promo
// ──────────────────────────────────────────────────────────────────────────────
app.post('/redeem-promo', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const promo = (await db(`SELECT * FROM promo_codes WHERE code=$1`, [code.toUpperCase()])).rows[0];
  if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
  if (promo.activation_limit > 0 && promo.activations_used >= promo.activation_limit) {
    return res.status(400).json({ error: 'Promo code expired' });
  }

  try {
    await db(
      `INSERT INTO promo_redemptions (user_id, code, reward) VALUES ($1,$2,$3)`,
      [tgUser.id, code.toUpperCase(), promo.reward]
    );
    await db(`UPDATE promo_codes SET activations_used=activations_used+1 WHERE code=$1`, [code.toUpperCase()]);
    await creditCoins(tgUser.id, promo.reward, 'earn_promo', `Promo code: ${code}`);

    const user = (await db(`SELECT coins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
    res.json({ ok: true, reward: promo.reward, coins: user.coins });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Code already used' });
    throw e;
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// REFERRALS  GET /referrals
// ──────────────────────────────────────────────────────────────────────────────
app.get('/referrals', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const friends = await db(
    `SELECT u.user_id, u.first_name, u.coins,
            COALESCE(SUM(rr.reward),0) as my_share
     FROM users u
     LEFT JOIN referral_rewards rr ON rr.referred_user=u.user_id AND rr.referrer_id=$1
     WHERE u.referrer_id=$1
     GROUP BY u.user_id, u.first_name, u.coins`,
    [tgUser.id]
  );
  const claimable = (await db(
    `SELECT COALESCE(SUM(reward),0) as s FROM referral_rewards WHERE referrer_id=$1 AND claimed=FALSE`,
    [tgUser.id]
  )).rows[0].s;

  res.json({ friends: friends.rows, claimable: parseInt(claimable) });
});

// POST /claim-referral
app.post('/claim-referral', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const unclaimed = await db(
    `SELECT COALESCE(SUM(reward),0) as s FROM referral_rewards WHERE referrer_id=$1 AND claimed=FALSE`,
    [tgUser.id]
  );
  const amount = parseInt(unclaimed.rows[0].s);
  if (amount <= 0) return res.status(400).json({ error: 'Nothing to claim' });

  await db(`UPDATE referral_rewards SET claimed=TRUE WHERE referrer_id=$1 AND claimed=FALSE`, [tgUser.id]);
  await db(`UPDATE users SET coins=coins+$1 WHERE user_id=$2`, [amount, tgUser.id]);
  await logTransaction(tgUser.id, 'earn_referral', amount, 'Referral earnings claimed');

  const user = (await db(`SELECT coins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
  res.json({ ok: true, claimed: amount, coins: user.coins });
});

// ──────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS  GET /transactions
// ──────────────────────────────────────────────────────────────────────────────
app.get('/transactions', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const rows = await db(
    `SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [tgUser.id]
  );
  res.json(rows.rows);
});

// ──────────────────────────────────────────────────────────────────────────────
// WITHDRAWAL  POST /withdraw
// ──────────────────────────────────────────────────────────────────────────────
app.post('/withdraw', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  const { coins_option } = req.body;
  const OPTIONS = {
    250000:  0.10,
    500000:  0.20,
    750000:  0.30,
    1000000: 0.40,
  };
  const tonAmount = OPTIONS[coins_option];
  if (!tonAmount) return res.status(400).json({ error: 'Invalid withdrawal option' });

  const user = (await db(`SELECT coins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
  if (!user || user.coins < coins_option) return res.status(400).json({ error: 'Insufficient coins' });

  await db(`UPDATE users SET coins=coins-$1 WHERE user_id=$2`, [coins_option, tgUser.id]);
  await logTransaction(tgUser.id, 'withdraw', -coins_option, `Withdrawal: ${tonAmount} TON`);

  const wd = (await db(
    `INSERT INTO withdrawals (user_id, coins_spent, ton_amount, status) VALUES ($1,$2,$3,'pending') RETURNING id`,
    [tgUser.id, coins_option, tonAmount - 0.05]
  )).rows[0];

  // FILL IN: Integrate a TON wallet payout API here to auto-send TON.
  // Options: TON Center API, mytonwallet API, or manual review + send.
  // For now, withdrawals are queued as 'pending' for manual processing.

  const updated = (await db(`SELECT coins FROM users WHERE user_id=$1`, [tgUser.id])).rows[0];
  res.json({ ok: true, withdrawal_id: wd.id, net_ton: tonAmount - 0.05, coins: updated.coins });
});

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN — CREATE PROMO  POST /admin/promo
// ──────────────────────────────────────────────────────────────────────────────
app.post('/admin/promo', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser || !ADMIN_IDS.includes(tgUser.id)) return res.status(403).json({ error: 'Forbidden' });

  const { code, reward, activation_limit } = req.body;
  if (!code || !reward) return res.status(400).json({ error: 'code and reward required' });

  await db(
    `INSERT INTO promo_codes (code, reward, activation_limit, created_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`,
    [code.toUpperCase(), reward, activation_limit || 1, tgUser.id]
  );
  res.json({ ok: true });
});

// GET /admin/promos
app.get('/admin/promos', async (req, res) => {
  const tgUser = getUser(req);
  if (!tgUser || !ADMIN_IDS.includes(tgUser.id)) return res.status(403).json({ error: 'Forbidden' });
  const rows = await db(`SELECT * FROM promo_codes ORDER BY created_at DESC`);
  res.json(rows.rows);
});

// ──────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ──────────────────────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`✅ TRewards backend running on port ${PORT}`));

// ─── package.json dependencies (add to your package.json) ────────────────────
// {
//   "name": "trewards-backend",
//   "version": "1.0.0",
//   "main": "server.js",
//   "scripts": { "start": "node server.js" },
//   "dependencies": {
//     "express": "^4.18.2",
//     "cors": "^2.8.5",
//     "pg": "^8.11.3"
//   }
// }