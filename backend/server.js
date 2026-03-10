const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public')); // serves frontend

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHANNEL_POST_ID = process.env.CHANNEL_POST_ID || ''; // private channel post id for user data
const DATA_CHANNEL_ID = process.env.DATA_CHANNEL_ID || ''; // e.g. -1001234567890
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500];
const SPIN_WEIGHTS  = [40, 25, 15, 10,  6,   4]; // weighted random
const TR_TO_TON = 0.0000004;

// ===== IN-MEMORY DB (Telegram channel is source of truth) =====
// Users stored in memory, persisted to Telegram channel on every change
const db = {
  users: {},       // telegramId → user object
  tasks: {},       // taskId → task object
  promos: {},      // code → promo object
  advertiserBalances: {}, // telegramId → TON balance
};

// ===== TELEGRAM API HELPERS =====
async function tgApi(method, params = {}) {
  try {
    const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, params);
    return r.data;
  } catch (e) {
    console.error(`TG API ${method}:`, e.response?.data || e.message);
    throw e;
  }
}

// Save user data to Telegram channel
async function saveUserToChannel(user) {
  const text = formatUserData(user);
  try {
    if (user.channelMessageId) {
      // Edit existing message
      await tgApi('editMessageText', {
        chat_id: DATA_CHANNEL_ID,
        message_id: user.channelMessageId,
        text,
        parse_mode: 'HTML',
      });
    } else {
      // Post new message
      const r = await tgApi('sendMessage', {
        chat_id: DATA_CHANNEL_ID,
        text,
        parse_mode: 'HTML',
      });
      user.channelMessageId = r.result.message_id;
    }
  } catch (e) {
    console.error('Failed to save user to channel:', e.message);
  }
}

function formatUserData(user) {
  return `<b>👤 TRewards User</b>
<b>ID:</b> <code>${user.telegramId}</code>
<b>Name:</b> ${user.name || 'Unknown'}
<b>Username:</b> @${user.username || 'none'}
<b>Balance:</b> ${user.balance} TR
<b>TON:</b> ${(user.balance * TR_TO_TON).toFixed(6)} TON
<b>Streak:</b> ${user.streak} days
<b>Spins:</b> ${user.spins}
<b>Referrer:</b> ${user.referrerId || 'none'}
<b>Referrals:</b> ${(user.referrals || []).length}
<b>Referral Pending:</b> ${user.pendingReferral || 0} TR
<b>Total Ref Earned:</b> ${user.totalReferralEarned || 0} TR
<b>Joined:</b> ${user.createdAt}
<b>Last Active:</b> ${new Date().toISOString()}
<b>Transactions:</b> ${(user.transactions || []).length}
<b>Claimed Tasks:</b> ${Object.keys(user.claimedTasks || {}).join(', ') || 'none'}`;
}

// ===== AUTH MIDDLEWARE =====
function validateTgData(initData) {
  if (!initData || initData === 'dev') return { id: 0, first_name: 'Dev' };
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');
    const sorted = Array.from(urlParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== hash) return null;
    const userStr = urlParams.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch (e) {
    return null;
  }
}

async function auth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || '';
  const tgUser = validateTgData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });

  let user = db.users[tgUser.id];
  if (!user) {
    // Auto-create user if first visit via API (normally done via bot /start)
    user = createUser(tgUser);
  }

  user.lastSeen = new Date().toISOString();
  req.tgUser = tgUser;
  req.user = user;
  next();
}

function createUser(tgUser, referrerId = null) {
  const user = {
    telegramId: tgUser.id,
    name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(),
    username: tgUser.username || '',
    balance: 0,
    spins: 1,
    streak: 0,
    streakDays: Array(7).fill({ claimed: false }),
    lastStreakClaim: null,
    lastDailyReset: null,
    dailyTasksClaimed: {},
    referrerId: referrerId,
    referrals: [],
    pendingReferral: 0,
    totalReferralEarned: 0,
    transactions: [],
    claimedTasks: {},
    channelMessageId: null,
    createdAt: new Date().toISOString(),
  };
  db.users[tgUser.id] = user;
  return user;
}

// ===== DAILY RESET CHECK =====
function checkDailyReset(user) {
  const now = new Date();
  const today = now.toDateString();
  if (user.lastDailyReset !== today) {
    user.lastDailyReset = today;
    user.dailyTasksClaimed = {};
    user.streakClaimed = false;
  }
}

// ===== ADD TRANSACTION =====
function addTransaction(user, type, desc, amount) {
  user.transactions = user.transactions || [];
  user.transactions.unshift({ id: uuidv4(), type, desc, amount, date: new Date().toISOString() });
  if (user.transactions.length > 100) user.transactions = user.transactions.slice(0, 100);
}

// ===== WEIGHTED RANDOM =====
function weightedRandom(segments, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < segments.length; i++) {
    rand -= weights[i];
    if (rand <= 0) return segments[i];
  }
  return segments[0];
}

// ===== ROUTES =====

// GET /me
app.get('/me', auth, (req, res) => {
  checkDailyReset(req.user);
  const u = req.user;
  res.json({
    telegramId: u.telegramId,
    name: u.name,
    balance: u.balance,
    spins: u.spins,
    streak: u.streak,
    streakDays: u.streakDays,
    streakClaimed: u.streakClaimed || false,
    dailyTasksClaimed: u.dailyTasksClaimed,
  });
});

// POST /spin
app.post('/spin', auth, async (req, res) => {
  const u = req.user;
  if (u.spins <= 0) return res.status(400).json({ error: 'No spins available' });

  const prize = weightedRandom(SPIN_SEGMENTS, SPIN_WEIGHTS);
  u.spins--;
  u.balance += prize;
  addTransaction(u, 'Spin', `Wheel spin reward`, prize);

  // Referral 30% credit to referrer
  if (u.referrerId && db.users[u.referrerId]) {
    const ref = db.users[u.referrerId];
    const share = Math.floor(prize * 0.3);
    ref.pendingReferral = (ref.pendingReferral || 0) + share;
    ref.totalReferralEarned = (ref.totalReferralEarned || 0) + share;
    await saveUserToChannel(ref);
  }

  await saveUserToChannel(u);
  res.json({ prize, balance: u.balance, spins: u.spins });
});

// POST /claim-streak
app.post('/claim-streak', auth, async (req, res) => {
  checkDailyReset(req.user);
  const u = req.user;
  if (u.streakClaimed) return res.status(400).json({ error: 'Already claimed today' });

  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now - 86400000).toDateString();

  if (u.lastStreakClaim === today) return res.status(400).json({ error: 'Already claimed today' });

  // Check if streak continues
  if (u.lastStreakClaim !== yesterday) {
    // Reset streak
    u.streak = 0;
    u.streakDays = Array(7).fill({ claimed: false });
  }

  u.streak = (u.streak % 7) + 1;
  const dayIdx = u.streak - 1;
  if (!Array.isArray(u.streakDays)) u.streakDays = Array(7).fill({ claimed: false });
  u.streakDays[dayIdx] = { claimed: true };
  if (u.streak === 7) {
    u.streakDays = Array(7).fill({ claimed: false });
  }

  u.lastStreakClaim = today;
  u.streakClaimed = true;
  u.balance += 10;
  u.spins += 1;
  addTransaction(u, 'Streak', `Day ${u.streak} streak reward`, 10);

  await saveUserToChannel(u);
  res.json({ balance: u.balance, spins: u.spins, streak: u.streak, streakDays: u.streakDays });
});

// POST /claim-daily-task
app.post('/claim-daily-task', auth, async (req, res) => {
  checkDailyReset(req.user);
  const u = req.user;
  const { taskId } = req.body;
  const rewards = { checkin: 10, updates: 50, share: 30 };
  if (!rewards[taskId]) return res.status(400).json({ error: 'Invalid task' });
  if (u.dailyTasksClaimed[taskId]) return res.status(400).json({ error: 'Already claimed today' });

  const reward = rewards[taskId];
  u.dailyTasksClaimed[taskId] = true;
  u.balance += reward;
  if (taskId === 'checkin') u.spins += 1;
  addTransaction(u, 'Daily Task', `Daily task: ${taskId}`, reward);

  await saveUserToChannel(u);
  res.json({ balance: u.balance, spins: u.spins });
});

// POST /redeem-promo
app.post('/redeem-promo', auth, async (req, res) => {
  const { code } = req.body;
  const promo = db.promos[code?.toUpperCase()];
  if (!promo) return res.status(400).json({ error: 'Invalid promo code' });
  if (promo.activations >= promo.maxActivations) return res.status(400).json({ error: 'Promo code expired' });
  if (promo.usedBy?.includes(req.user.telegramId)) return res.status(400).json({ error: 'Already used this code' });

  promo.activations++;
  promo.usedBy = promo.usedBy || [];
  promo.usedBy.push(req.user.telegramId);

  req.user.balance += promo.reward;
  addTransaction(req.user, 'Promo', `Promo code: ${code}`, promo.reward);
  await saveUserToChannel(req.user);

  // Post activation to channel
  try {
    await tgApi('sendMessage', {
      chat_id: DATA_CHANNEL_ID,
      text: `🎟 <b>Promo Redeemed</b>\nCode: <code>${code}</code>\nUser: ${req.user.name} (${req.user.telegramId})\nReward: +${promo.reward} TR\nActivations: ${promo.activations}/${promo.maxActivations}`,
      parse_mode: 'HTML',
    });
  } catch (_) {}

  res.json({ balance: req.user.balance, reward: promo.reward });
});

// GET /tasks
app.get('/tasks', auth, (req, res) => {
  const u = req.user;
  const tasks = Object.values(db.tasks)
    .filter(t => t.status === 'active' && t.completedCount < t.limit)
    .map(t => ({
      ...t,
      claimedByUser: !!u.claimedTasks[t.id],
    }));
  res.json({ tasks });
});

// POST /claim-task
app.post('/claim-task', auth, async (req, res) => {
  const { taskId } = req.body;
  const task = db.tasks[taskId];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status !== 'active') return res.status(400).json({ error: 'Task not active' });
  if (req.user.claimedTasks[taskId]) return res.status(400).json({ error: 'Task already claimed' });
  if (task.completedCount >= task.limit) return res.status(400).json({ error: 'Task limit reached' });

  const reward = ['channel', 'group', 'game'].includes(task.type) ? 1000 : 500;
  req.user.claimedTasks[taskId] = true;
  req.user.balance += reward;
  req.user.spins += 1;
  task.completedCount++;
  if (task.completedCount >= task.limit) task.status = 'completed';

  addTransaction(req.user, 'Task', task.name, reward);

  // 30% referral
  if (req.user.referrerId && db.users[req.user.referrerId]) {
    const ref = db.users[req.user.referrerId];
    const share = Math.floor(reward * 0.3);
    ref.pendingReferral = (ref.pendingReferral || 0) + share;
    ref.totalReferralEarned = (ref.totalReferralEarned || 0) + share;
    await saveUserToChannel(ref);
  }

  await saveUserToChannel(req.user);
  res.json({ balance: req.user.balance, spins: req.user.spins, reward });
});

// POST /verify-join — for channel/group tasks
app.post('/verify-join', auth, async (req, res) => {
  const { taskId } = req.body;
  const task = db.tasks[taskId];
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (req.user.claimedTasks[taskId]) return res.status(400).json({ error: 'Already claimed' });

  // Extract channel username from URL
  let chatId = task.url;
  const match = chatId.match(/t\.me\/([^/?]+)/);
  if (match) chatId = '@' + match[1];

  try {
    const r = await tgApi('getChatMember', { chat_id: chatId, user_id: req.user.telegramId });
    const status = r.result?.status;
    const isMember = ['member', 'administrator', 'creator', 'restricted'].includes(status);
    if (!isMember) return res.status(400).json({ error: 'You have not joined yet. Please join first.' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not verify membership. Make sure the bot is admin in the channel.' });
  }

  // Award
  const reward = 1000;
  req.user.claimedTasks[taskId] = true;
  req.user.balance += reward;
  req.user.spins += 1;
  task.completedCount++;
  if (task.completedCount >= task.limit) task.status = 'completed';
  addTransaction(req.user, 'Task', task.name, reward);

  if (req.user.referrerId && db.users[req.user.referrerId]) {
    const ref = db.users[req.user.referrerId];
    const share = Math.floor(reward * 0.3);
    ref.pendingReferral = (ref.pendingReferral || 0) + share;
    ref.totalReferralEarned = (ref.totalReferralEarned || 0) + share;
    await saveUserToChannel(ref);
  }

  await saveUserToChannel(req.user);
  res.json({ balance: req.user.balance, spins: req.user.spins, reward });
});

// GET /friends
app.get('/friends', auth, (req, res) => {
  const u = req.user;
  const friends = (u.referrals || []).map(refId => {
    const ref = db.users[refId];
    if (!ref) return null;
    return {
      id: ref.telegramId,
      name: ref.name,
      coins: ref.balance,
      yourShare: Math.floor(ref.balance * 0.3),
    };
  }).filter(Boolean);

  res.json({
    friends,
    pendingReferral: u.pendingReferral || 0,
    totalReferralEarned: u.totalReferralEarned || 0,
  });
});

// POST /claim-referral
app.post('/claim-referral', auth, async (req, res) => {
  const u = req.user;
  const amount = u.pendingReferral || 0;
  if (amount <= 0) return res.status(400).json({ error: 'No pending referral earnings' });

  u.balance += amount;
  u.pendingReferral = 0;
  addTransaction(u, 'Referral', 'Referral earnings claimed', amount);
  await saveUserToChannel(u);
  res.json({ balance: u.balance, claimed: amount });
});

// GET /transactions
app.get('/transactions', auth, (req, res) => {
  res.json({ transactions: (req.user.transactions || []).slice(0, 50) });
});

// POST /withdraw
app.post('/withdraw', auth, async (req, res) => {
  const { tr, ton, net } = req.body;
  const u = req.user;

  const validTiers = [
    { tr: 250000, ton: 0.10, net: 0.05 },
    { tr: 500000, ton: 0.20, net: 0.15 },
    { tr: 750000, ton: 0.30, net: 0.25 },
    { tr: 1000000, ton: 0.40, net: 0.35 },
  ];
  const tier = validTiers.find(t => t.tr === tr && t.ton === ton && t.net === net);
  if (!tier) return res.status(400).json({ error: 'Invalid withdrawal tier' });
  if (u.balance < tr) return res.status(400).json({ error: 'Insufficient balance' });

  u.balance -= tr;
  addTransaction(u, 'Withdraw', `Withdrawal: ${net} TON pending`, -tr);

  // Post withdrawal to channel for manual processing
  try {
    await tgApi('sendMessage', {
      chat_id: DATA_CHANNEL_ID,
      text: `💸 <b>WITHDRAWAL REQUEST</b>\nUser: ${u.name} (${u.telegramId})\n@${u.username || 'none'}\nTR Spent: ${tr.toLocaleString()}\nTON Gross: ${ton}\nNetwork Fee: 0.05\nNet TON: <b>${net}</b>\nTime: ${new Date().toISOString()}`,
      parse_mode: 'HTML',
    });
  } catch (_) {}

  await saveUserToChannel(u);
  res.json({ balance: u.balance });
});

// ===== ADVERTISER ROUTES =====

// GET /advertiser
app.get('/advertiser', auth, (req, res) => {
  const balance = db.advertiserBalances[req.user.telegramId] || 0;
  const tasks = Object.values(db.tasks).filter(t => t.advertiserId === req.user.telegramId);
  res.json({ balance, tasks });
});

// POST /create-task
app.post('/create-task', auth, async (req, res) => {
  const { name, type, url, limit } = req.body;
  const validTypes = ['visit', 'channel', 'group', 'game'];
  const validLimits = [500, 1000, 2000, 5000, 10000];

  if (!name || !type || !url || !limit) return res.status(400).json({ error: 'Missing fields' });
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid task type' });
  if (!validLimits.includes(parseInt(limit))) return res.status(400).json({ error: 'Invalid limit' });

  const cost = limit * 0.001;
  const adBal = db.advertiserBalances[req.user.telegramId] || 0;
  if (adBal < cost) return res.status(400).json({ error: `Insufficient ad balance. Need ${cost} TON` });

  db.advertiserBalances[req.user.telegramId] = adBal - cost;
  const taskId = uuidv4();
  db.tasks[taskId] = {
    id: taskId,
    advertiserId: req.user.telegramId,
    name,
    type,
    url,
    limit: parseInt(limit),
    completedCount: 0,
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  // Post to channel
  try {
    await tgApi('sendMessage', {
      chat_id: DATA_CHANNEL_ID,
      text: `📢 <b>NEW TASK PUBLISHED</b>\nBy: ${req.user.name} (${req.user.telegramId})\nTask: ${name}\nType: ${type}\nURL: ${url}\nLimit: ${limit}\nCost: ${cost} TON`,
      parse_mode: 'HTML',
    });
  } catch (_) {}

  res.json({ taskId, adBalance: db.advertiserBalances[req.user.telegramId] });
});

// ===== ADMIN ROUTES (used by bot) =====

// POST /admin/create-promo — called by bot
app.post('/admin/create-promo', (req, res) => {
  const { adminKey, code, reward, maxActivations } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const key = code.toUpperCase();
  db.promos[key] = { code: key, reward: parseInt(reward), maxActivations: parseInt(maxActivations), activations: 0, usedBy: [] };
  res.json({ ok: true });
});

// POST /admin/list-promos
app.post('/admin/list-promos', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  res.json(Object.values(db.promos));
});

// POST /admin/delete-promo
app.post('/admin/delete-promo', (req, res) => {
  const { adminKey, code } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  delete db.promos[code.toUpperCase()];
  res.json({ ok: true });
});

// POST /admin/stats
app.post('/admin/stats', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    totalUsers: Object.keys(db.users).length,
    totalTasks: Object.keys(db.tasks).length,
    totalPromos: Object.keys(db.promos).length,
  });
});

// POST /admin/add-ad-balance — manually credit advertiser
app.post('/admin/add-ad-balance', (req, res) => {
  const { adminKey, telegramId, amount } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  db.advertiserBalances[telegramId] = (db.advertiserBalances[telegramId] || 0) + parseFloat(amount);
  res.json({ ok: true, balance: db.advertiserBalances[telegramId] });
});

// ===== BOT WEBHOOK =====
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond fast
  const update = req.body;

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text || '';

    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const referrerId = parts[1] || null;

      let user = db.users[userId];
      if (!user) {
        user = createUser(msg.from, referrerId && referrerId != userId ? referrerId : null);
        // Add to referrer's list
        if (user.referrerId && db.users[user.referrerId]) {
          const ref = db.users[user.referrerId];
          ref.referrals = ref.referrals || [];
          if (!ref.referrals.includes(userId)) ref.referrals.push(userId);
          await saveUserToChannel(ref);
        }
        await saveUserToChannel(user);
      }

      const webAppUrl = process.env.WEBAPP_URL || 'https://trewards-frontend.onrender.com';
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `🏆 <b>Welcome to TRewards!</b>\n\nEarn TR coins by completing tasks, spinning the wheel, and inviting friends.\n\n💰 Your Balance: <b>${user.balance} TR</b>\n🎰 Spins: <b>${user.spins}</b>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Open TRewards', web_app: { url: webAppUrl } }]],
        },
      });
    }

    // Admin panel
    if (text === '/amiadminyes') {
      if (!ADMIN_IDS.includes(String(userId))) {
        await tgApi('sendMessage', { chat_id: chatId, text: '❌ Access denied.' });
        return;
      }
      const stats = {
        totalUsers: Object.keys(db.users).length,
        totalTasks: Object.keys(db.tasks).length,
        totalPromos: Object.keys(db.promos).length,
      };
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `⚙️ <b>Admin Panel</b>\n\n👥 Users: ${stats.totalUsers}\n📋 Tasks: ${stats.totalTasks}\n🎟 Promos: ${stats.totalPromos}`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎟 Create Promo', callback_data: 'admin_create_promo' }],
            [{ text: '📋 List Promos', callback_data: 'admin_list_promos' }],
            [{ text: '🗑 Delete Promo', callback_data: 'admin_delete_promo' }],
            [{ text: '📊 Total Users', callback_data: 'admin_stats' }],
          ],
        },
      });
    }
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const userId = cq.from.id;
    const chatId = cq.message.chat.id;
    const data = cq.data;

    if (!ADMIN_IDS.includes(String(userId))) {
      await tgApi('answerCallbackQuery', { callback_query_id: cq.id, text: 'No access' });
      return;
    }

    await tgApi('answerCallbackQuery', { callback_query_id: cq.id });

    if (data === 'admin_list_promos') {
      const promos = Object.values(db.promos);
      const text = promos.length
        ? promos.map(p => `• <code>${p.code}</code> — ${p.reward} TR — ${p.activations}/${p.maxActivations}`).join('\n')
        : 'No promo codes';
      await tgApi('sendMessage', { chat_id: chatId, text: `<b>Promo Codes:</b>\n${text}`, parse_mode: 'HTML' });
    }

    if (data === 'admin_stats') {
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `📊 <b>Stats</b>\nUsers: ${Object.keys(db.users).length}\nTasks: ${Object.keys(db.tasks).length}\nPromos: ${Object.keys(db.promos).length}`,
        parse_mode: 'HTML',
      });
    }

    if (data === 'admin_create_promo') {
      db._adminState = db._adminState || {};
      db._adminState[userId] = { step: 'promo_name' };
      await tgApi('sendMessage', { chat_id: chatId, text: '📝 Enter promo code name:' });
    }

    if (data === 'admin_delete_promo') {
      db._adminState = db._adminState || {};
      db._adminState[userId] = { step: 'promo_delete' };
      await tgApi('sendMessage', { chat_id: chatId, text: '🗑 Enter promo code to delete:' });
    }
  }

  // Admin conversation state
  if (update.message && db._adminState?.[update.message.from.id]) {
    const userId = update.message.from.id;
    const chatId = update.message.chat.id;
    const text = update.message.text || '';
    const s = db._adminState[userId];

    if (s.step === 'promo_name') {
      s.code = text.toUpperCase().replace(/\s/g, '');
      s.step = 'promo_reward';
      await tgApi('sendMessage', { chat_id: chatId, text: '💰 Enter reward amount (TR):' });
      return;
    }
    if (s.step === 'promo_reward') {
      s.reward = parseInt(text);
      if (isNaN(s.reward)) { await tgApi('sendMessage', { chat_id: chatId, text: 'Invalid number' }); return; }
      s.step = 'promo_max';
      await tgApi('sendMessage', { chat_id: chatId, text: '🔢 Enter max activations:' });
      return;
    }
    if (s.step === 'promo_max') {
      s.maxActivations = parseInt(text);
      if (isNaN(s.maxActivations)) { await tgApi('sendMessage', { chat_id: chatId, text: 'Invalid number' }); return; }
      db.promos[s.code] = { code: s.code, reward: s.reward, maxActivations: s.maxActivations, activations: 0, usedBy: [] };
      delete db._adminState[userId];
      await tgApi('sendMessage', { chat_id: chatId, text: `✅ Promo <code>${s.code}</code> created!\nReward: ${s.reward} TR\nMax activations: ${s.maxActivations}`, parse_mode: 'HTML' });
      return;
    }
    if (s.step === 'promo_delete') {
      const code = text.toUpperCase();
      if (db.promos[code]) {
        delete db.promos[code];
        await tgApi('sendMessage', { chat_id: chatId, text: `✅ Promo <code>${code}</code> deleted.`, parse_mode: 'HTML' });
      } else {
        await tgApi('sendMessage', { chat_id: chatId, text: '❌ Promo not found.' });
      }
      delete db._adminState[userId];
    }
  }
});

// ===== SET WEBHOOK =====
app.get('/set-webhook', async (req, res) => {
  const url = `${process.env.BACKEND_URL}/webhook`;
  const r = await tgApi('setWebhook', { url });
  res.json(r);
});

// ===== HEALTH =====
app.get('/health', (req, res) => res.json({ ok: true, users: Object.keys(db.users).length }));

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TRewards backend running on port ${PORT}`));