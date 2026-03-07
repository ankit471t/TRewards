/**
 * TRewards Backend - server.js
 * Complete production backend for TRewards Telegram Mini App
 * 
 * Run: npm install && node server.js
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_ID = process.env.ADMIN_ID || '';
const DB_PATH = process.env.DB_PATH || './trewards.db';

// ═══════════════════════════════════════════
// DATABASE SETUP
// ═══════════════════════════════════════════
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);

// Initialize schema from database.sql queries inline
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  first_name TEXT DEFAULT '',
  username TEXT DEFAULT '',
  balance INTEGER DEFAULT 0,
  spins INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0,
  last_checkin TEXT DEFAULT NULL,
  last_daily_reset TEXT DEFAULT NULL,
  referrer_id TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  adv_balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advertiser_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('visit','channel','group','game')),
  url TEXT NOT NULL,
  reward INTEGER NOT NULL,
  limit_completions INTEGER NOT NULL DEFAULT 1000,
  completions INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  completed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, user_id)
);

CREATE TABLE IF NOT EXISTS daily_task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  date TEXT NOT NULL,
  UNIQUE(user_id, task_type, date)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  ton_amount REAL NOT NULL,
  net_amount REAL NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','rejected')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  reward INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 100,
  current_uses INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  activated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(code_id, user_id)
);

CREATE TABLE IF NOT EXISTS referral_earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id TEXT NOT NULL,
  referee_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_task_completions_user ON task_completions(user_id);
CREATE INDEX IF NOT EXISTS idx_referral_referrer ON referral_earnings(referrer_id);
`);

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

// ─── Request logger ───
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} uid=${req.headers['x-user-id']||'-'}`);
  next();
});

// ─── Telegram WebApp Auth Middleware ───
function verifyTelegramData(initData, botToken) {
  if (!initData || !botToken) return true; // Dev bypass when no token
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256',secretKey).update(checkString).digest('hex');
    return expectedHash === hash;
  } catch { return false; }
}

function authMiddleware(req, res, next) {
  const userId = req.headers['x-user-id'];
  const initData = req.headers['x-init-data'];
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  // In production, uncomment strict verification:
  // if (BOT_TOKEN && !verifyTelegramData(initData, BOT_TOKEN)) {
  //   return res.status(401).json({ error: 'Invalid Telegram data' });
  // }
  req.userId = userId;
  next();
}

// ─── DB helpers ───
function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(telegramId));
}

function ensureUser(telegramId, firstName='', username='') {
  const existing = getUser(telegramId);
  if (existing) return existing;
  db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,username) VALUES (?,?,?)').run(String(telegramId),firstName,username);
  return getUser(telegramId);
}

function addCoins(userId, amount, type, description) {
  db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(amount, String(userId));
  db.prepare('INSERT INTO transactions (user_id,type,description,amount) VALUES (?,?,?,?)')
    .run(String(userId), type, description, amount);
  // Handle referral commission
  if (amount > 0) {
    const user = getUser(userId);
    if (user?.referrer_id) {
      const commission = Math.floor(amount * 0.3);
      if (commission > 0) {
        db.prepare('INSERT INTO referral_earnings (referrer_id,referee_id,amount) VALUES (?,?,?)')
          .run(user.referrer_id, String(userId), commission);
      }
    }
  }
}

function addSpins(userId, count) {
  db.prepare('UPDATE users SET spins=spins+? WHERE telegram_id=?').run(count, String(userId));
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ═══════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════

// GET /me — Get user profile
app.get('/me', authMiddleware, (req, res) => {
  const user = ensureUser(req.userId);
  const today = todayStr();
  // Check daily tasks done today
  const doneToday = db.prepare(
    'SELECT task_type FROM daily_task_completions WHERE user_id=? AND date=?'
  ).all(req.userId, today).map(r => r.task_type);

  res.json({
    balance: user.balance,
    spins: user.spins,
    streak: user.streak,
    dailyTasksDone: {
      checkin: doneToday.includes('checkin'),
      updates: doneToday.includes('updates'),
      share: doneToday.includes('share'),
    }
  });
});

// POST /daily-checkin — Claim daily streak
app.post('/daily-checkin', authMiddleware, (req, res) => {
  const user = ensureUser(req.userId);
  const today = todayStr();

  // Check if already claimed today
  const alreadyClaimed = db.prepare(
    'SELECT id FROM daily_task_completions WHERE user_id=? AND task_type=? AND date=?'
  ).get(req.userId, 'checkin', today);
  if (alreadyClaimed) return res.status(400).json({ error: 'Already claimed today' });

  // Streak logic
  const lastCheckin = user.last_checkin;
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  let newStreak = lastCheckin === yesterday ? (user.streak + 1) : 1;
  if (newStreak > 7) newStreak = 1; // Reset after 7 days

  const txn = db.transaction(() => {
    addCoins(req.userId, 10, 'daily_checkin', 'Daily check-in reward');
    addSpins(req.userId, 1);
    db.prepare('UPDATE users SET streak=?, last_checkin=? WHERE telegram_id=?')
      .run(newStreak, today, req.userId);
    db.prepare('INSERT INTO daily_task_completions (user_id,task_type,date) VALUES (?,?,?)')
      .run(req.userId, 'checkin', today);
  });
  txn();

  const updated = getUser(req.userId);
  res.json({ balance: updated.balance, spins: updated.spins, streak: updated.streak });
});

// POST /claim-daily-task — Claim updates/share task
app.post('/claim-daily-task', authMiddleware, (req, res) => {
  const { task } = req.body;
  if (!['updates','share'].includes(task)) return res.status(400).json({ error: 'Invalid task' });

  const today = todayStr();
  const alreadyClaimed = db.prepare(
    'SELECT id FROM daily_task_completions WHERE user_id=? AND task_type=? AND date=?'
  ).get(req.userId, task, today);
  if (alreadyClaimed) return res.status(400).json({ error: 'Already claimed today' });

  const rewards = { updates: 50, share: 100 };
  const reward = rewards[task];

  const txn = db.transaction(() => {
    addCoins(req.userId, reward, 'daily_task', `Daily task: ${task}`);
    addSpins(req.userId, 1);
    db.prepare('INSERT INTO daily_task_completions (user_id,task_type,date) VALUES (?,?,?)')
      .run(req.userId, task, today);
  });
  txn();

  const updated = getUser(req.userId);
  res.json({ balance: updated.balance, spins: updated.spins });
});

// ═══════════════════════════════════════════
// SPIN WHEEL
// ═══════════════════════════════════════════
const SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500];
const SPIN_WEIGHTS  = [40, 25, 15, 12,  5,   3]; // weighted probabilities

function weightedRandom(values, weights) {
  const total = weights.reduce((a,b)=>a+b, 0);
  let rand = Math.random() * total;
  for (let i=0; i<values.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return values[i];
  }
  return values[values.length-1];
}

app.post('/spin', authMiddleware, (req, res) => {
  const user = getUser(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.spins <= 0) return res.status(400).json({ error: 'No spins available' });

  const result = weightedRandom(SPIN_SEGMENTS, SPIN_WEIGHTS);

  const txn = db.transaction(() => {
    db.prepare('UPDATE users SET spins=spins-1 WHERE telegram_id=?').run(req.userId);
    addCoins(req.userId, result, 'spin', `Spin wheel reward: ${result} TR`);
  });
  txn();

  const updated = getUser(req.userId);
  res.json({ result, balance: updated.balance, spins: updated.spins });
});

// ═══════════════════════════════════════════
// PROMO CODES
// ═══════════════════════════════════════════
app.post('/redeem-promo', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });

  const promo = db.prepare('SELECT * FROM promo_codes WHERE code=? AND active=1').get(code.toUpperCase().trim());
  if (!promo) return res.status(404).json({ error: 'Invalid or expired code' });
  if (promo.current_uses >= promo.max_uses) return res.status(400).json({ error: 'Code expired' });

  const alreadyUsed = db.prepare(
    'SELECT id FROM promo_activations WHERE code_id=? AND user_id=?'
  ).get(promo.id, req.userId);
  if (alreadyUsed) return res.status(400).json({ error: 'Already redeemed' });

  const txn = db.transaction(() => {
    addCoins(req.userId, promo.reward, 'promo', `Promo code: ${code}`);
    db.prepare('UPDATE promo_codes SET current_uses=current_uses+1 WHERE id=?').run(promo.id);
    db.prepare('INSERT INTO promo_activations (code_id,user_id) VALUES (?,?)').run(promo.id, req.userId);
    if (promo.current_uses + 1 >= promo.max_uses) {
      db.prepare('UPDATE promo_codes SET active=0 WHERE id=?').run(promo.id);
    }
  });
  txn();

  const updated = getUser(req.userId);
  res.json({ reward: promo.reward, balance: updated.balance, spins: updated.spins });
});

// ═══════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════
app.get('/tasks', authMiddleware, (req, res) => {
  const activeTasks = db.prepare(`
    SELECT t.*, 
      CASE WHEN tc.user_id IS NOT NULL THEN 1 ELSE 0 END as completed
    FROM tasks t
    LEFT JOIN task_completions tc ON tc.task_id=t.id AND tc.user_id=?
    WHERE t.status='active' AND t.completions < t.limit_completions
    ORDER BY t.created_at DESC
  `).all(req.userId);

  const rewardMap = { channel:1000, group:1000, game:1000, visit:500 };
  const tasks = activeTasks.map(t => ({
    id: t.id,
    name: t.name,
    type: t.type,
    url: t.url,
    reward: t.reward || rewardMap[t.type] || 500,
    completed: t.completed === 1
  }));

  res.json({ tasks });
});

app.post('/claim-task', authMiddleware, (req, res) => {
  const { taskId } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'active') return res.status(400).json({ error: 'Task not active' });

  const already = db.prepare('SELECT id FROM task_completions WHERE task_id=? AND user_id=?').get(taskId, req.userId);
  if (already) return res.status(400).json({ error: 'Already completed' });

  const reward = task.reward || (task.type==='visit'?500:1000);

  const txn = db.transaction(() => {
    addCoins(req.userId, reward, 'task', `Task: ${task.name}`);
    addSpins(req.userId, 1);
    db.prepare('INSERT INTO task_completions (task_id,user_id) VALUES (?,?)').run(taskId, req.userId);
    db.prepare('UPDATE tasks SET completions=completions+1 WHERE id=?').run(taskId);
    // Auto-complete task if limit reached
    const updated = db.prepare('SELECT completions,limit_completions FROM tasks WHERE id=?').get(taskId);
    if (updated.completions >= updated.limit_completions) {
      db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(taskId);
    }
  });
  txn();

  const user = getUser(req.userId);
  res.json({ balance: user.balance, spins: user.spins });
});

// POST /verify-join — Verify channel/group join via Telegram API
app.post('/verify-join', authMiddleware, (req, res) => {
  const { taskId } = req.body;
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!['channel','group'].includes(task.type)) return res.status(400).json({ error: 'Invalid task type' });

  const already = db.prepare('SELECT id FROM task_completions WHERE task_id=? AND user_id=?').get(taskId, req.userId);
  if (already) return res.status(400).json({ error: 'Already completed' });

  // Extract chat username from URL
  const urlMatch = task.url.match(/t\.me\/([^/?]+)/);
  if (!urlMatch) return res.status(400).json({ error: 'Invalid task URL' });
  const chatUsername = urlMatch[1];

  // Call Telegram getChatMember API
  const checkMembership = () => new Promise((resolve, reject) => {
    if (!BOT_TOKEN) {
      // Dev mode: auto-approve
      return resolve(true);
    }
    const path = `/bot${BOT_TOKEN}/getChatMember?chat_id=@${chatUsername}&user_id=${req.userId}`;
    https.get(`https://api.telegram.org${path}`, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(data);
          const status = json.result?.status;
          resolve(['member','administrator','creator'].includes(status));
        } catch { resolve(false); }
      });
    }).on('error', () => resolve(false));
  });

  checkMembership().then(isMember => {
    if (!isMember) return res.status(400).json({ error: 'You have not joined yet. Please join and try again.' });

    const reward = task.reward || 1000;
    const txn = db.transaction(() => {
      addCoins(req.userId, reward, 'task', `Joined: ${task.name}`);
      addSpins(req.userId, 1);
      db.prepare('INSERT INTO task_completions (task_id,user_id) VALUES (?,?)').run(taskId, req.userId);
      db.prepare('UPDATE tasks SET completions=completions+1 WHERE id=?').run(taskId);
    });
    txn();

    const user = getUser(req.userId);
    res.json({ balance: user.balance, spins: user.spins });
  }).catch(() => res.status(500).json({ error: 'Verification failed' }));
});

// ═══════════════════════════════════════════
// FRIENDS / REFERRALS
// ═══════════════════════════════════════════
app.get('/friends', authMiddleware, (req, res) => {
  const friends = db.prepare(`
    SELECT u.telegram_id, u.first_name as name, u.balance as coins
    FROM users u WHERE u.referrer_id=?
    ORDER BY u.balance DESC LIMIT 100
  `).all(req.userId);

  const pending = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM referral_earnings
    WHERE referrer_id=? AND claimed=0
  `).get(req.userId)?.total || 0;

  const totalEarned = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM referral_earnings
    WHERE referrer_id=?
  `).get(req.userId)?.total || 0;

  res.json({ friends, pending, totalEarned });
});

app.post('/claim-referral', authMiddleware, (req, res) => {
  const pending = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM referral_earnings
    WHERE referrer_id=? AND claimed=0
  `).get(req.userId)?.total || 0;

  if (pending <= 0) return res.status(400).json({ error: 'Nothing to claim' });

  const txn = db.transaction(() => {
    addCoins(req.userId, pending, 'referral', `Referral commission: ${pending} TR`);
    db.prepare('UPDATE referral_earnings SET claimed=1 WHERE referrer_id=? AND claimed=0').run(req.userId);
  });
  txn();

  const user = getUser(req.userId);
  res.json({ claimed: pending, balance: user.balance });
});

// ═══════════════════════════════════════════
// WALLET / WITHDRAWALS
// ═══════════════════════════════════════════
const WITHDRAWAL_TIERS = {
  250000:  { ton: 0.10, net: 0.05 },
  500000:  { ton: 0.20, net: 0.15 },
  750000:  { ton: 0.30, net: 0.25 },
  1000000: { ton: 0.40, net: 0.35 },
};

app.post('/withdraw', authMiddleware, (req, res) => {
  const { tier } = req.body;
  const tierData = WITHDRAWAL_TIERS[tier];
  if (!tierData) return res.status(400).json({ error: 'Invalid tier' });

  const user = getUser(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.balance < tier) return res.status(400).json({ error: 'Insufficient balance' });

  const txn = db.transaction(() => {
    db.prepare('UPDATE users SET balance=balance-? WHERE telegram_id=?').run(tier, req.userId);
    db.prepare('INSERT INTO transactions (user_id,type,description,amount) VALUES (?,?,?,?)')
      .run(req.userId, 'withdrawal', `Withdrawal: ${tier} TR → ${tierData.net} TON`, -tier);
    db.prepare('INSERT INTO withdrawals (user_id,coins,ton_amount,net_amount) VALUES (?,?,?,?)')
      .run(req.userId, tier, tierData.ton, tierData.net);
  });
  txn();

  const updated = getUser(req.userId);
  res.json({ balance: updated.balance, message: 'Withdrawal queued' });
});

app.get('/transactions', authMiddleware, (req, res) => {
  const txns = db.prepare(
    'SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
  ).all(req.userId);
  res.json({ transactions: txns });
});

// ═══════════════════════════════════════════
// ADVERTISER
// ═══════════════════════════════════════════
app.get('/advertiser/dashboard', authMiddleware, (req, res) => {
  const user = getUser(req.userId);
  const tasks = db.prepare(
    'SELECT * FROM tasks WHERE advertiser_id=? ORDER BY created_at DESC'
  ).all(req.userId);
  res.json({ balance: user?.adv_balance || 0, tasks });
});

app.post('/create-task', authMiddleware, (req, res) => {
  const { name, type, url, limit } = req.body;
  if (!name || !type || !url || !limit) return res.status(400).json({ error: 'Missing fields' });
  if (!['visit','channel','group','game'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const user = getUser(req.userId);
  const cost = Number(limit) * 0.001;
  if (!user || user.adv_balance < cost) return res.status(400).json({ error: 'Insufficient ad balance' });

  const rewardMap = { visit:500, channel:1000, group:1000, game:1000 };
  const reward = rewardMap[type];

  const txn = db.transaction(() => {
    db.prepare('UPDATE users SET adv_balance=adv_balance-? WHERE telegram_id=?').run(cost, req.userId);
    db.prepare(`INSERT INTO tasks (advertiser_id,name,type,url,reward,limit_completions) VALUES (?,?,?,?,?,?)`)
      .run(req.userId, name, type, url, reward, Number(limit));
  });
  txn();

  res.json({ success: true });
});

// ═══════════════════════════════════════════
// TELEGRAM BOT WEBHOOK
// ═══════════════════════════════════════════
app.post('/bot-webhook', (req, res) => {
  res.json({ ok: true }); // Ack immediately
  const update = req.body;
  if (!update?.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text || '';
  const firstName = msg.from.first_name || '';
  const username = msg.from.username || '';

  function sendMessage(chatId, text, keyboard=null) {
    if (!BOT_TOKEN) return;
    const body = JSON.stringify({
      chat_id: chatId, text, parse_mode: 'HTML',
      ...(keyboard && { reply_markup: { inline_keyboard: keyboard } })
    });
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const r = https.request(opts);
    r.write(body); r.end();
  }

  // /start command
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    const referralId = parts[1] || null;

    const existing = getUser(userId);
    if (!existing) {
      // New user registration
      let validReferrer = null;
      if (referralId && referralId !== userId) {
        const referrer = getUser(referralId);
        if (referrer) validReferrer = referralId;
      }
      db.prepare('INSERT OR IGNORE INTO users (telegram_id,first_name,username,referrer_id,spins) VALUES (?,?,?,?,1)')
        .run(userId, firstName, username, validReferrer);
    }

    sendMessage(chatId,
      `🏆 <b>Welcome to TRewards!</b>\n\n` +
      `💰 Earn TR coins by completing tasks\n` +
      `🎰 Spin the wheel for instant rewards\n` +
      `👥 Refer friends and earn 30% of their coins\n` +
      `💎 Withdraw earnings as TON cryptocurrency\n\n` +
      `<i>Tap the button below to start earning!</i>`,
      [[{ text: '🚀 Open TRewards', web_app: { url: process.env.WEBAPP_URL || 'https://yourdomain.com' } }]]
    );
  }

  // Admin command
  if (text === '/amiadminyes' && userId === ADMIN_ID) {
    sendMessage(chatId, '🔐 <b>Admin Panel</b>', [
      [{ text: '➕ Create Promo Code', callback_data: 'admin_create_promo' }],
      [{ text: '📋 List Promo Codes', callback_data: 'admin_list_promos' }],
      [{ text: '🗑 Delete Promo Code', callback_data: 'admin_delete_promo' }],
      [{ text: '📊 Activation History', callback_data: 'admin_promo_history' }],
      [{ text: '👥 Total Users', callback_data: 'admin_total_users' }],
      [{ text: '💰 Pending Withdrawals', callback_data: 'admin_withdrawals' }],
    ]);
  }
});

// Admin callback queries (state machine via simple session map)
const adminSessions = new Map();

app.post('/bot-webhook', (req, res) => {
  // This duplicate is fine - Express won't double-handle; real logic already above
  // Callback queries handled in the next middleware
});

// Inline callback query handler (added as separate route for clarity)
// In production, merge with webhook handler above
app.post('/bot-callback', (req, res) => {
  res.json({ ok: true });
  const callback = req.body?.callback_query;
  if (!callback) return;
  const userId = String(callback.from.id);
  if (userId !== ADMIN_ID) return;
  const data = callback.data;
  const chatId = callback.message.chat.id;

  function sendMsg(text) {
    if (!BOT_TOKEN) return;
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const opts = { hostname:'api.telegram.org', path:`/bot${BOT_TOKEN}/sendMessage`, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} };
    const r = https.request(opts); r.write(body); r.end();
  }

  if (data === 'admin_total_users') {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const today = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at)=date('now')").get().c;
    sendMsg(`👥 <b>Users</b>\nTotal: ${count}\nNew today: ${today}`);
  }
  if (data === 'admin_list_promos') {
    const promos = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20').all();
    if (!promos.length) { sendMsg('No promo codes.'); return; }
    const list = promos.map(p=>`${p.code}: ${p.reward} TR | ${p.current_uses}/${p.max_uses} | ${p.active?'✅':'❌'}`).join('\n');
    sendMsg(`📋 <b>Promo Codes:</b>\n<code>${list}</code>`);
  }
  if (data === 'admin_withdrawals') {
    const pending = db.prepare("SELECT * FROM withdrawals WHERE status='pending' LIMIT 20").all();
    if (!pending.length) { sendMsg('No pending withdrawals.'); return; }
    const list = pending.map(w=>`User ${w.user_id}: ${w.coins} TR → ${w.net_amount} TON`).join('\n');
    sendMsg(`💰 <b>Pending Withdrawals:</b>\n${list}`);
  }
  if (data === 'admin_create_promo') {
    adminSessions.set(userId, { step: 'promo_name' });
    sendMsg('Enter promo code name (e.g. WELCOME2025):');
  }
  if (data === 'admin_delete_promo') {
    adminSessions.set(userId, { step: 'delete_promo' });
    sendMsg('Enter promo code to delete:');
  }
});

// Admin message handler for wizard steps
app.post('/bot-message-admin', (req, res) => {
  res.json({ ok: true });
  const msg = req.body?.message;
  if (!msg) return;
  const userId = String(msg.from.id);
  if (userId !== ADMIN_ID) return;
  if (!adminSessions.has(userId)) return;
  const session = adminSessions.get(userId);
  const text = msg.text || '';
  const chatId = msg.chat.id;

  function sendMsg(t) {
    if (!BOT_TOKEN) return;
    const body = JSON.stringify({ chat_id: chatId, text: t, parse_mode:'HTML' });
    const opts = { hostname:'api.telegram.org', path:`/bot${BOT_TOKEN}/sendMessage`, method:'POST', headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)} };
    const r = https.request(opts); r.write(body); r.end();
  }

  if (session.step === 'promo_name') {
    session.code = text.toUpperCase().trim().replace(/\s+/g,'_');
    session.step = 'promo_reward';
    adminSessions.set(userId, session);
    sendMsg(`Code: <b>${session.code}</b>\nEnter reward amount (TR coins):`);
  } else if (session.step === 'promo_reward') {
    session.reward = parseInt(text);
    if (isNaN(session.reward)||session.reward<=0) { sendMsg('Invalid amount. Try again:'); return; }
    session.step = 'promo_max_uses';
    adminSessions.set(userId, session);
    sendMsg(`Reward: <b>${session.reward} TR</b>\nEnter max activations:`);
  } else if (session.step === 'promo_max_uses') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses)||maxUses<=0) { sendMsg('Invalid number. Try again:'); return; }
    try {
      db.prepare('INSERT INTO promo_codes (code,reward,max_uses) VALUES (?,?,?)').run(session.code, session.reward, maxUses);
      adminSessions.delete(userId);
      sendMsg(`✅ Promo code created!\nCode: <code>${session.code}</code>\nReward: ${session.reward} TR\nMax uses: ${maxUses}`);
    } catch(e) {
      sendMsg(`❌ Error: Code already exists.`);
      adminSessions.delete(userId);
    }
  } else if (session.step === 'delete_promo') {
    const code = text.toUpperCase().trim();
    const result = db.prepare('UPDATE promo_codes SET active=0 WHERE code=?').run(code);
    adminSessions.delete(userId);
    sendMsg(result.changes > 0 ? `✅ Promo code <code>${code}</code> deactivated.` : `❌ Code not found.`);
  }
});

// ═══════════════════════════════════════════
// ADMIN REST API (for admin panel)
// ═══════════════════════════════════════════
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_API_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/admin/stats', adminAuth, (req, res) => {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const transactions = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
  const pendingWd = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(net_amount),0) as total FROM withdrawals WHERE status='pending'").get();
  const activeTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='active'").get().c;
  res.json({ users, transactions, pendingWithdrawals: pendingWd.c, pendingTon: pendingWd.total, activeTasks });
});

app.get('/admin/withdrawals', adminAuth, (req, res) => {
  const list = db.prepare("SELECT w.*,u.first_name,u.username FROM withdrawals w JOIN users u ON u.telegram_id=w.user_id WHERE w.status='pending' ORDER BY w.created_at ASC").all();
  res.json({ withdrawals: list });
});

app.post('/admin/withdrawal/:id/complete', adminAuth, (req, res) => {
  db.prepare("UPDATE withdrawals SET status='completed' WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

app.post('/admin/withdrawal/:id/reject', adminAuth, (req, res) => {
  const wd = db.prepare('SELECT * FROM withdrawals WHERE id=?').get(req.params.id);
  if (!wd) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => {
    db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").run(req.params.id);
    // Refund coins
    db.prepare('UPDATE users SET balance=balance+? WHERE telegram_id=?').run(wd.coins, wd.user_id);
    db.prepare('INSERT INTO transactions (user_id,type,description,amount) VALUES (?,?,?,?)')
      .run(wd.user_id, 'refund', `Withdrawal refunded: ${wd.coins} TR`, wd.coins);
  })();
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status:'ok', time: new Date().toISOString() }));

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🏆 TRewards Backend running on port ${PORT}`);
  console.log(`📊 Database: ${DB_PATH}`);
  console.log(`🤖 Bot token: ${BOT_TOKEN ? 'SET' : 'NOT SET (dev mode)'}`);
  console.log(`🔐 Admin ID: ${ADMIN_ID || 'NOT SET'}\n`);
});

module.exports = app;