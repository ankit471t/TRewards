require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Database ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || '@trewards_tonfirst';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function validateTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return hash === expectedHash;
  } catch { return false; }
}

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  if (!initData) return res.status(401).json({ error: 'Missing auth' });
  if (process.env.NODE_ENV !== 'development' && !validateTelegramInitData(initData)) {
    return res.status(401).json({ error: 'Invalid auth' });
  }
  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get('user') || '{}');
  req.userId = user.id;
  req.user = user;
  next();
}

async function getUser(telegramId) {
  const r = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return r.rows[0] || null;
}

async function addCoins(telegramId, amount, type, description) {
  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE users SET coins = coins + $1 WHERE telegram_id = $2', [amount, telegramId]);
    await pool.query(
      'INSERT INTO transactions (telegram_id, type, amount, description) VALUES ($1,$2,$3,$4)',
      [telegramId, type, amount, description]
    );
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}

// ─── INIT DB ──────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      coins BIGINT DEFAULT 0,
      spins INT DEFAULT 0,
      streak INT DEFAULT 0,
      last_streak_claim DATE,
      last_checkin DATE,
      referrer_id BIGINT,
      ton_balance NUMERIC(18,9) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      reward_coins BIGINT DEFAULT 0,
      reward_ton NUMERIC(18,9) DEFAULT 0,
      max_uses INT NOT NULL,
      uses INT DEFAULT 0,
      created_by BIGINT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_uses (
      id SERIAL PRIMARY KEY,
      code_id INT NOT NULL,
      telegram_id BIGINT NOT NULL,
      claimed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(code_id, telegram_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      advertiser_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('visit','channel','group','game')),
      url TEXT NOT NULL,
      reward INT NOT NULL,
      completion_limit INT NOT NULL,
      completions INT DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS task_completions (
      id SERIAL PRIMARY KEY,
      task_id INT NOT NULL,
      telegram_id BIGINT NOT NULL,
      completed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(task_id, telegram_id)
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      coins BIGINT NOT NULL,
      ton_amount NUMERIC(18,9) NOT NULL,
      net_amount NUMERIC(18,9) NOT NULL,
      status TEXT DEFAULT 'pending',
      wallet_address TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      invoice_id TEXT UNIQUE NOT NULL,
      telegram_id BIGINT NOT NULL,
      amount NUMERIC(18,9) NOT NULL,
      asset TEXT DEFAULT 'TON',
      provider TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ad_balances (
      telegram_id BIGINT PRIMARY KEY,
      ton_balance NUMERIC(18,9) DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS spin_results (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      reward INT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS daily_tasks (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      task_key TEXT NOT NULL,
      claimed_date DATE NOT NULL,
      UNIQUE(telegram_id, task_key, claimed_date)
    );
  `);
  console.log('✅ DB initialized');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const param = (match[1] || '').trim();
  const referrerId = param && param !== '' ? parseInt(param) : null;

  let user = await getUser(userId);
  if (!user) {
    const ref = (referrerId && referrerId !== userId) ? referrerId : null;
    await pool.query(
      'INSERT INTO users (telegram_id, username, first_name, spins, referrer_id) VALUES ($1,$2,$3,3,$4) ON CONFLICT DO NOTHING',
      [userId, msg.from.username || '', msg.from.first_name || '', ref]
    );
    user = await getUser(userId);
  }

  const webAppUrl = `${process.env.WEBAPP_URL}`;
  bot.sendMessage(chatId, 
    `🪙 *Welcome to TRewards!*\n\nEarn TR coins by completing tasks, spinning the wheel, and referring friends!\n\nConvert your coins to TON cryptocurrency! 🚀`, 
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 Open TRewards', web_app: { url: webAppUrl } }]]
      }
    }
  );
});

// Admin panel
const adminSessions = {};

bot.onText(/\/amiadminyes/, async (msg) => {
  const userId = msg.from.id;
  if (!ADMIN_IDS.includes(userId)) return;
  showAdminPanel(msg.chat.id, userId);
});

async function showAdminPanel(chatId, userId, messageId) {
  const totalUsers = await pool.query('SELECT COUNT(*) FROM users');
  const pendingWithdrawals = await pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'");
  
  const text = `🔐 *Admin Panel*\n\n👥 Total Users: ${totalUsers.rows[0].count}\n⏳ Pending Withdrawals: ${pendingWithdrawals.rows[0].count}`;
  const keyboard = {
    inline_keyboard: [
      [{ text: '🎟 Create Promo Code', callback_data: 'admin_create_promo' }],
      [{ text: '📋 List Promo Codes', callback_data: 'admin_list_promos' }],
      [{ text: '🗑 Delete Promo Code', callback_data: 'admin_delete_promo' }],
      [{ text: '📊 Activation History', callback_data: 'admin_activations' }],
      [{ text: '💳 Payment History', callback_data: 'admin_payments' }],
      [{ text: '👥 Total Users', callback_data: 'admin_users' }],
      [{ text: '💸 Pending Withdrawals', callback_data: 'admin_withdrawals' }],
    ]
  };
  
  if (messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: keyboard });
  } else {
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;

  if (!ADMIN_IDS.includes(userId)) { bot.answerCallbackQuery(query.id, { text: 'Unauthorized' }); return; }
  bot.answerCallbackQuery(query.id);

  if (data === 'admin_create_promo') {
    adminSessions[userId] = { step: 'promo_name' };
    bot.sendMessage(chatId, '📝 Enter promo code name:');
  } else if (data === 'admin_list_promos') {
    const promos = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20');
    const text = promos.rows.length === 0 ? 'No promo codes.' :
      promos.rows.map(p => `*${p.code}*\n💰 ${p.reward_coins > 0 ? p.reward_coins + ' TR' : ''} ${p.reward_ton > 0 ? p.reward_ton + ' TON' : ''} | Uses: ${p.uses}/${p.max_uses}`).join('\n\n');
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'admin_delete_promo') {
    adminSessions[userId] = { step: 'delete_promo' };
    bot.sendMessage(chatId, '🗑 Enter promo code to delete:');
  } else if (data === 'admin_activations') {
    const acts = await pool.query('SELECT pu.*, pc.code FROM promo_uses pu JOIN promo_codes pc ON pu.code_id=pc.id ORDER BY pu.claimed_at DESC LIMIT 20');
    const text = acts.rows.length === 0 ? 'No activations.' :
      acts.rows.map(a => `Code: *${a.code}* | User: ${a.telegram_id} | ${new Date(a.claimed_at).toLocaleDateString()}`).join('\n');
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'admin_payments') {
    const pays = await pool.query('SELECT * FROM payments ORDER BY created_at DESC LIMIT 20');
    const text = pays.rows.length === 0 ? 'No payments.' :
      pays.rows.map(p => `${p.provider} | ${p.amount} TON | User: ${p.telegram_id} | *${p.status}*`).join('\n');
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } else if (data === 'admin_users') {
    const users = await pool.query('SELECT COUNT(*) as total, COUNT(referrer_id) as referred FROM users');
    bot.sendMessage(chatId, `👥 Total: ${users.rows[0].total}\n🔗 Referred: ${users.rows[0].referred}`);
  } else if (data === 'admin_withdrawals') {
    const w = await pool.query("SELECT * FROM withdrawals WHERE status='pending' ORDER BY created_at DESC LIMIT 10");
    const text = w.rows.length === 0 ? 'No pending withdrawals.' :
      w.rows.map(x => `ID: ${x.id} | User: ${x.telegram_id} | ${x.net_amount} TON`).join('\n');
    bot.sendMessage(chatId, text);
  } else if (data === 'admin_back') {
    showAdminPanel(chatId, userId, msgId);
  }
});

// Multi-step promo creation via bot messages
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(userId)) return;
  const session = adminSessions[userId];
  if (!session) return;
  const text = msg.text;

  if (session.step === 'promo_name') {
    session.code = text.toUpperCase().trim();
    session.step = 'promo_type';
    adminSessions[userId] = session;
    bot.sendMessage(chatId, '💰 Reward type?\n1 - TR Coins\n2 - TON');
  } else if (session.step === 'promo_type') {
    session.rewardType = text.trim() === '2' ? 'ton' : 'coins';
    session.step = 'promo_amount';
    bot.sendMessage(chatId, `Enter reward amount (${session.rewardType === 'ton' ? 'TON' : 'TR Coins'}):`);
  } else if (session.step === 'promo_amount') {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) { bot.sendMessage(chatId, '❌ Invalid amount'); return; }
    session.amount = amount;
    session.step = 'promo_maxuses';
    bot.sendMessage(chatId, '🔢 Max uses:');
  } else if (session.step === 'promo_maxuses') {
    const maxUses = parseInt(text.trim());
    if (isNaN(maxUses) || maxUses <= 0) { bot.sendMessage(chatId, '❌ Invalid number'); return; }
    const rewardCoins = session.rewardType === 'coins' ? Math.floor(session.amount) : 0;
    const rewardTon = session.rewardType === 'ton' ? session.amount : 0;
    await pool.query(
      'INSERT INTO promo_codes (code, reward_coins, reward_ton, max_uses, created_by) VALUES ($1,$2,$3,$4,$5)',
      [session.code, rewardCoins, rewardTon, maxUses, userId]
    );
    delete adminSessions[userId];
    bot.sendMessage(chatId, `✅ Promo *${session.code}* created!\n💰 ${rewardCoins > 0 ? rewardCoins + ' TR Coins' : rewardTon + ' TON'} | Max uses: ${maxUses}`, { parse_mode: 'Markdown' });
  } else if (session.step === 'delete_promo') {
    const code = text.toUpperCase().trim();
    const r = await pool.query('DELETE FROM promo_codes WHERE code=$1 RETURNING *', [code]);
    delete adminSessions[userId];
    if (r.rowCount > 0) bot.sendMessage(chatId, `✅ Deleted promo: *${code}*`, { parse_mode: 'Markdown' });
    else bot.sendMessage(chatId, `❌ Promo not found: ${code}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Get User ─────────────────────────────────────────────────────────────────
app.get('/user', authMiddleware, async (req, res) => {
  try {
    let user = await getUser(req.userId);
    if (!user) {
      await pool.query(
        'INSERT INTO users (telegram_id, username, first_name, spins) VALUES ($1,$2,$3,3) ON CONFLICT DO NOTHING',
        [req.userId, req.user.username || '', req.user.first_name || '']
      );
      user = await getUser(req.userId);
    }
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Daily Streak ─────────────────────────────────────────────────────────────
app.post('/claim-streak', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const today = new Date().toISOString().split('T')[0];
    if (user.last_streak_claim === today) return res.status(400).json({ error: 'Already claimed today' });

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const newStreak = user.last_streak_claim === yesterday ? Math.min((user.streak || 0) + 1, 7) : 1;
    const reset = newStreak === 7 ? 0 : newStreak;
    const finalStreak = newStreak >= 7 ? 0 : newStreak;

    await pool.query(
      'UPDATE users SET coins=coins+10, spins=spins+1, streak=$1, last_streak_claim=$2 WHERE telegram_id=$3',
      [finalStreak, today, req.userId]
    );
    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'streak', 10, `Day ${newStreak} streak bonus`]);
    
    res.json({ success: true, streak: newStreak, coins: 10, spins: 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Spin Wheel ───────────────────────────────────────────────────────────────
const SPIN_REWARDS = [10, 50, 80, 100, 300, 500];
const SPIN_WEIGHTS = [40, 25, 15, 10, 7, 3]; // % chance

app.post('/spin', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user.spins || 0) < 1) return res.status(400).json({ error: 'No spins available' });

    // Weighted random
    const total = SPIN_WEIGHTS.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    let segmentIndex = 0;
    for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
      rand -= SPIN_WEIGHTS[i];
      if (rand <= 0) { segmentIndex = i; break; }
    }
    const reward = SPIN_REWARDS[segmentIndex];

    await pool.query('UPDATE users SET coins=coins+$1, spins=spins-1 WHERE telegram_id=$2', [reward, req.userId]);
    await pool.query('INSERT INTO spin_results (telegram_id,reward) VALUES ($1,$2)', [req.userId, reward]);
    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'spin', reward, 'Spin wheel reward']);

    res.json({ success: true, reward, segmentIndex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Daily Tasks ──────────────────────────────────────────────────────────────
app.post('/claim-daily-task', authMiddleware, async (req, res) => {
  try {
    const { task_key } = req.body; // 'checkin', 'updates', 'share'
    const today = new Date().toISOString().split('T')[0];
    
    const existing = await pool.query(
      'SELECT * FROM daily_tasks WHERE telegram_id=$1 AND task_key=$2 AND claimed_date=$3',
      [req.userId, task_key, today]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Already claimed today' });

    await pool.query(
      'INSERT INTO daily_tasks (telegram_id, task_key, claimed_date) VALUES ($1,$2,$3)',
      [req.userId, task_key, today]
    );

    const rewards = { checkin: { coins: 10, spins: 1 }, updates: { coins: 10, spins: 1 }, share: { coins: 10, spins: 0 } };
    const r = rewards[task_key] || { coins: 10, spins: 0 };

    await pool.query('UPDATE users SET coins=coins+$1, spins=spins+$2 WHERE telegram_id=$3',
      [r.coins, r.spins, req.userId]);
    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'daily_task', r.coins, `Daily task: ${task_key}`]);

    // Handle last_checkin for daily check-in task
    if (task_key === 'checkin') {
      await pool.query('UPDATE users SET last_checkin=$1 WHERE telegram_id=$2', [today, req.userId]);
    }

    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/daily-task-status', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(
      'SELECT task_key FROM daily_tasks WHERE telegram_id=$1 AND claimed_date=$2',
      [req.userId, today]
    );
    const claimed = r.rows.map(x => x.task_key);
    res.json({ claimed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Promo Codes ──────────────────────────────────────────────────────────────
app.post('/redeem-promo', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const promo = await pool.query('SELECT * FROM promo_codes WHERE code=$1', [code.toUpperCase().trim()]);
    if (promo.rows.length === 0) return res.status(404).json({ error: 'Invalid promo code' });
    const p = promo.rows[0];
    if (p.uses >= p.max_uses) return res.status(400).json({ error: 'Promo code expired' });

    const used = await pool.query('SELECT * FROM promo_uses WHERE code_id=$1 AND telegram_id=$2', [p.id, req.userId]);
    if (used.rows.length > 0) return res.status(400).json({ error: 'Already used this promo' });

    await pool.query('BEGIN');
    await pool.query('INSERT INTO promo_uses (code_id, telegram_id) VALUES ($1,$2)', [p.id, req.userId]);
    await pool.query('UPDATE promo_codes SET uses=uses+1 WHERE id=$1', [p.id]);
    if (p.reward_coins > 0) {
      await pool.query('UPDATE users SET coins=coins+$1 WHERE telegram_id=$2', [p.reward_coins, req.userId]);
      await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
        [req.userId, 'promo', p.reward_coins, `Promo code: ${p.code}`]);
    }
    if (p.reward_ton > 0) {
      await pool.query('UPDATE users SET ton_balance=ton_balance+$1 WHERE telegram_id=$2', [p.reward_ton, req.userId]);
      await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
        [req.userId, 'promo_ton', Math.floor(p.reward_ton * 1000000), `Promo TON reward: ${p.code}`]);
    }
    await pool.query('COMMIT');

    res.json({ success: true, reward_coins: p.reward_coins, reward_ton: p.reward_ton });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

// ─── Tasks ────────────────────────────────────────────────────────────────────
app.get('/tasks', authMiddleware, async (req, res) => {
  try {
    const tasks = await pool.query(`
      SELECT t.*, 
        CASE WHEN tc.telegram_id IS NOT NULL THEN true ELSE false END as completed
      FROM tasks t
      LEFT JOIN task_completions tc ON t.id=tc.task_id AND tc.telegram_id=$1
      WHERE t.status='active' AND t.completions < t.completion_limit
      ORDER BY t.created_at DESC
    `, [req.userId]);
    res.json(tasks.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/claim-task', authMiddleware, async (req, res) => {
  try {
    const { task_id } = req.body;
    const task = await pool.query('SELECT * FROM tasks WHERE id=$1', [task_id]);
    if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const t = task.rows[0];
    if (t.status !== 'active') return res.status(400).json({ error: 'Task not active' });
    if (t.completions >= t.completion_limit) return res.status(400).json({ error: 'Task limit reached' });

    const done = await pool.query('SELECT * FROM task_completions WHERE task_id=$1 AND telegram_id=$2', [task_id, req.userId]);
    if (done.rows.length > 0) return res.status(400).json({ error: 'Already completed' });

    if (t.type === 'visit' || t.type === 'game') {
      // Timer-based: trust client (timer shown on frontend)
    } else if (t.type === 'channel' || t.type === 'group') {
      return res.status(400).json({ error: 'Use /verify-join for channel/group tasks' });
    }

    await pool.query('BEGIN');
    await pool.query('INSERT INTO task_completions (task_id, telegram_id) VALUES ($1,$2)', [task_id, req.userId]);
    await pool.query('UPDATE tasks SET completions=completions+1 WHERE id=$1', [task_id]);
    if (t.completions + 1 >= t.completion_limit) {
      await pool.query("UPDATE tasks SET status='completed' WHERE id=$1", [task_id]);
    }
    await pool.query('UPDATE users SET coins=coins+$1, spins=spins+1 WHERE telegram_id=$2', [t.reward, req.userId]);
    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'task', t.reward, `Task: ${t.name}`]);
    
    // Referral commission
    const user = await pool.query('SELECT referrer_id FROM users WHERE telegram_id=$1', [req.userId]);
    if (user.rows[0]?.referrer_id) {
      const commission = Math.floor(t.reward * 0.30);
      await pool.query('UPDATE users SET coins=coins+$1 WHERE telegram_id=$2', [commission, user.rows[0].referrer_id]);
      await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
        [user.rows[0].referrer_id, 'referral_commission', commission, `Commission from ${req.userId}`]);
    }
    
    await pool.query('COMMIT');
    res.json({ success: true, reward: t.reward, spins: 1 });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.post('/verify-join', authMiddleware, async (req, res) => {
  try {
    const { task_id } = req.body;
    const task = await pool.query('SELECT * FROM tasks WHERE id=$1', [task_id]);
    if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const t = task.rows[0];

    const done = await pool.query('SELECT * FROM task_completions WHERE task_id=$1 AND telegram_id=$2', [task_id, req.userId]);
    if (done.rows.length > 0) return res.status(400).json({ error: 'Already completed' });

    // Extract channel username from URL
    const urlParts = t.url.split('/');
    const channelUsername = urlParts[urlParts.length - 1];
    
    try {
      const member = await bot.getChatMember('@' + channelUsername, req.userId);
      const validStatuses = ['member', 'administrator', 'creator'];
      if (!validStatuses.includes(member.status)) {
        return res.status(400).json({ error: 'Not a member yet. Please join first.' });
      }
    } catch (botErr) {
      return res.status(400).json({ error: 'Could not verify membership. Please try again.' });
    }

    await pool.query('BEGIN');
    await pool.query('INSERT INTO task_completions (task_id, telegram_id) VALUES ($1,$2)', [task_id, req.userId]);
    await pool.query('UPDATE tasks SET completions=completions+1 WHERE id=$1', [task_id]);
    if (t.completions + 1 >= t.completion_limit) {
      await pool.query("UPDATE tasks SET status='completed' WHERE id=$1", [task_id]);
    }
    await pool.query('UPDATE users SET coins=coins+$1, spins=spins+1 WHERE telegram_id=$2', [t.reward, req.userId]);
    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'task', t.reward, `Task: ${t.name}`]);
    
    const user = await pool.query('SELECT referrer_id FROM users WHERE telegram_id=$1', [req.userId]);
    if (user.rows[0]?.referrer_id) {
      const commission = Math.floor(t.reward * 0.30);
      await pool.query('UPDATE users SET coins=coins+$1 WHERE telegram_id=$2', [commission, user.rows[0].referrer_id]);
    }
    
    await pool.query('COMMIT');
    res.json({ success: true, reward: t.reward });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

// ─── Friends / Referrals ──────────────────────────────────────────────────────
app.get('/friends', authMiddleware, async (req, res) => {
  try {
    const friends = await pool.query(`
      SELECT u.telegram_id, u.first_name, u.username, u.coins,
        COALESCE((SELECT SUM(t.amount) FROM transactions t 
          WHERE t.telegram_id=$1 AND t.description LIKE $2 AND t.type='referral_commission'), 0) as my_share
      FROM users u WHERE u.referrer_id=$1
    `, [req.userId, `%${req.userId}%`]);

    const pending = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as pending FROM transactions WHERE telegram_id=$1 AND type='referral_commission' AND created_at > COALESCE((SELECT MAX(created_at) FROM transactions WHERE telegram_id=$1 AND type='referral_claim'),NOW()-INTERVAL '100 years')",
      [req.userId]
    );

    res.json({ friends: friends.rows, pendingEarnings: pending.rows[0].pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/claim-referral', authMiddleware, async (req, res) => {
  try {
    const pending = await pool.query(
      "SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE telegram_id=$1 AND type='referral_commission' AND created_at > COALESCE((SELECT MAX(created_at) FROM transactions WHERE telegram_id=$1 AND type='referral_claim'),NOW()-INTERVAL '100 years')",
      [req.userId]
    );
    const amount = parseInt(pending.rows[0].total);
    if (amount <= 0) return res.status(400).json({ error: 'Nothing to claim' });

    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'referral_claim', amount, 'Referral earnings claimed']);
    
    res.json({ success: true, amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Withdrawals ──────────────────────────────────────────────────────────────
const WITHDRAWAL_TIERS = [
  { coins: 250000, ton: 0.10, net: 0.05 },
  { coins: 500000, ton: 0.20, net: 0.15 },
  { coins: 750000, ton: 0.30, net: 0.25 },
  { coins: 1000000, ton: 0.40, net: 0.35 },
];

app.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const { tier_index, wallet_address } = req.body;
    if (!wallet_address) return res.status(400).json({ error: 'Wallet address required' });
    const tier = WITHDRAWAL_TIERS[tier_index];
    if (!tier) return res.status(400).json({ error: 'Invalid tier' });

    const user = await getUser(req.userId);
    if (!user || user.coins < tier.coins) return res.status(400).json({ error: 'Insufficient coins' });

    await pool.query('BEGIN');
    await pool.query('UPDATE users SET coins=coins-$1 WHERE telegram_id=$2', [tier.coins, req.userId]);
    await pool.query(
      'INSERT INTO withdrawals (telegram_id, coins, ton_amount, net_amount, wallet_address) VALUES ($1,$2,$3,$4,$5)',
      [req.userId, tier.coins, tier.ton, tier.net, wallet_address]
    );
    await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
      [req.userId, 'withdrawal', -tier.coins, `Withdrawal: ${tier.net} TON`]);
    await pool.query('COMMIT');

    res.json({ success: true, net_ton: tier.net, status: 'pending' });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const txs = await pool.query(
      'SELECT * FROM transactions WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
    );
    res.json(txs.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Advertiser Dashboard ─────────────────────────────────────────────────────
app.get('/ad-balance', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT ton_balance FROM ad_balances WHERE telegram_id=$1', [req.userId]);
    res.json({ balance: r.rows[0]?.ton_balance || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/create-task', authMiddleware, async (req, res) => {
  try {
    const { name, type, url, completion_limit } = req.body;
    const validLimits = [500, 1000, 2000, 5000, 10000];
    if (!validLimits.includes(completion_limit)) return res.status(400).json({ error: 'Invalid completion limit' });
    const cost = completion_limit * 0.001;
    const reward = type === 'visit' ? 500 : 1000;

    const bal = await pool.query('SELECT ton_balance FROM ad_balances WHERE telegram_id=$1', [req.userId]);
    const balance = parseFloat(bal.rows[0]?.ton_balance || 0);
    if (balance < cost) return res.status(400).json({ error: `Insufficient ad balance. Need ${cost} TON` });

    await pool.query('BEGIN');
    await pool.query('UPDATE ad_balances SET ton_balance=ton_balance-$1 WHERE telegram_id=$2', [cost, req.userId]);
    await pool.query(
      'INSERT INTO tasks (advertiser_id, name, type, url, reward, completion_limit) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.userId, name, type, url, reward, completion_limit]
    );
    await pool.query('COMMIT');
    res.json({ success: true, cost });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.get('/my-tasks', authMiddleware, async (req, res) => {
  try {
    const tasks = await pool.query(
      'SELECT * FROM tasks WHERE advertiser_id=$1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(tasks.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TON TOP-UP SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// ─── xRocket Invoice ──────────────────────────────────────────────────────────
async function createXRocketInvoice(userId, amount) {
  const res = await axios.post(
    'https://pay.xrocket.tg/tg-invoices',
    {
      currency: 'TON',
      amount,
      description: `TRewards top-up for user ${userId}`,
      payload: JSON.stringify({ userId, provider: 'xrocket' }),
      callbackUrl: `${process.env.WEBHOOK_URL}/payment-webhook`,
      expiredIn: 3600,
    },
    { headers: { 'Rocket-Pay-Key': process.env.XROCKET_API_KEY, 'Content-Type': 'application/json' } }
  );
  return { invoice_id: res.data.data.id, pay_url: res.data.data.link };
}

// ─── CryptoPay Invoice ────────────────────────────────────────────────────────
async function createCryptoPayInvoice(userId, amount) {
  const res = await axios.post(
    `${process.env.CRYPTOPAY_API_URL || 'https://pay.crypt.bot'}/api/createInvoice`,
    {
      asset: 'TON',
      amount: amount.toString(),
      description: `TRewards top-up`,
      payload: JSON.stringify({ userId, provider: 'cryptopay' }),
      allow_comments: false,
      allow_anonymous: false,
      expires_in: 3600,
    },
    { headers: { 'Crypto-Pay-API-Token': process.env.CRYPTOPAY_API_KEY, 'Content-Type': 'application/json' } }
  );
  return { invoice_id: res.data.result.invoice_id, pay_url: res.data.result.pay_url };
}

app.post('/create-topup', authMiddleware, async (req, res) => {
  try {
    const { amount, method, for_ads } = req.body; // for_ads=true tops up ad balance
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!['xrocket', 'cryptopay'].includes(method)) return res.status(400).json({ error: 'Invalid method' });

    let invoice;
    try {
      if (method === 'xrocket') {
        invoice = await createXRocketInvoice(req.userId, amount);
      } else {
        invoice = await createCryptoPayInvoice(req.userId, amount);
      }
    } catch (apiErr) {
      console.error('Payment API error:', apiErr.response?.data || apiErr.message);
      return res.status(502).json({ error: 'Payment provider error. Please try again.' });
    }

    await pool.query(
      'INSERT INTO payments (invoice_id, telegram_id, amount, provider, status) VALUES ($1,$2,$3,$4,$5)',
      [invoice.invoice_id.toString(), req.userId, amount, method, 'pending']
    );

    // Store extra meta for webhook to know if it's ad balance
    if (for_ads) {
      await pool.query(
        "UPDATE payments SET asset=$1 WHERE invoice_id=$2",
        [for_ads ? 'TON_AD' : 'TON', invoice.invoice_id.toString()]
      );
    }

    res.json({ pay_url: invoice.pay_url, invoice_id: invoice.invoice_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── xRocket Webhook ──────────────────────────────────────────────────────────
function verifyXRocketSignature(body, signature) {
  const secret = process.env.XROCKET_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured
  const hash = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  return hash === signature;
}

// ─── CryptoPay Webhook verification ──────────────────────────────────────────
function verifyCryptoPaySignature(body, signature) {
  const token = process.env.CRYPTOPAY_API_KEY;
  const secret = crypto.createHash('sha256').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  return hash === signature;
}

app.post('/payment-webhook', express.json(), async (req, res) => {
  try {
    const body = req.body;
    const signature = req.headers['rocket-pay-signature'] || req.headers['crypto-pay-api-token-signature'];
    
    // Determine provider
    let provider, invoice_id, amount, asset, status, userId;

    if (req.headers['rocket-pay-signature']) {
      // xRocket
      if (!verifyXRocketSignature(body, req.headers['rocket-pay-signature'])) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      if (body.type !== 'invoice.paid') return res.json({ ok: true });
      const inv = body.data;
      provider = 'xrocket';
      invoice_id = inv.id.toString();
      amount = parseFloat(inv.amount);
      asset = inv.currency;
      status = 'paid';
      const payload = JSON.parse(inv.payload || '{}');
      userId = payload.userId;
    } else if (req.headers['crypto-pay-api-token-signature']) {
      // CryptoPay
      if (!verifyCryptoPaySignature(body, req.headers['crypto-pay-api-token-signature'])) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      if (body.update_type !== 'invoice_paid') return res.json({ ok: true });
      const inv = body.payload;
      provider = 'cryptopay';
      invoice_id = inv.invoice_id.toString();
      amount = parseFloat(inv.amount);
      asset = inv.asset;
      status = 'paid';
      const payload = JSON.parse(inv.payload || '{}');
      userId = payload.userId;
    } else {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    if (asset !== 'TON') return res.json({ ok: true }); // Only TON

    // Duplicate check
    const existing = await pool.query("SELECT * FROM payments WHERE invoice_id=$1 AND status='paid'", [invoice_id]);
    if (existing.rows.length > 0) return res.json({ ok: true }); // Already processed

    const payment = await pool.query('SELECT * FROM payments WHERE invoice_id=$1', [invoice_id]);
    if (payment.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

    const p = payment.rows[0];
    const isAd = p.asset === 'TON_AD';

    await pool.query('BEGIN');
    await pool.query("UPDATE payments SET status='paid' WHERE invoice_id=$1", [invoice_id]);
    
    if (isAd) {
      await pool.query(
        'INSERT INTO ad_balances (telegram_id, ton_balance) VALUES ($1,$2) ON CONFLICT (telegram_id) DO UPDATE SET ton_balance=ad_balances.ton_balance+$2',
        [p.telegram_id, amount]
      );
    } else {
      await pool.query('UPDATE users SET ton_balance=ton_balance+$1 WHERE telegram_id=$2', [amount, p.telegram_id]);
      await pool.query('INSERT INTO transactions (telegram_id,type,amount,description) VALUES ($1,$2,$3,$4)',
        [p.telegram_id, 'topup', Math.floor(amount * 1000000), `TON top-up: ${amount} TON`]);
    }
    await pool.query('COMMIT');

    console.log(`✅ Payment credited: ${amount} TON → user ${p.telegram_id} (${isAd ? 'ad balance' : 'user balance'})`);
    res.json({ ok: true });
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('Webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 TRewards backend running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});