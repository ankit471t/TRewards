/**
 * server.js
 * TRewards Express API + static file server
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const db = require('./database');
const { createBot, getBot } = require('./bot');

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from root directory
app.use(express.static(__dirname));

// ─── Telegram initData verification ──────────────────────────────────────────
function verifyTelegramData(initData) {
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    params.delete('hash');
    const checkArr = [];
    params.forEach((val, key) => checkArr.push(`${key}=${val}`));
    checkArr.sort();
    const checkString = checkArr.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(config.BOT_TOKEN)
      .digest();

    const computedHash = crypto.createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (computedHash !== hash) return null;

    const userData = params.get('user');
    return userData ? JSON.parse(userData) : null;
  } catch (e) {
    return null;
  }
}

// ─── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body.initData;

  // In development/demo mode, allow mock user
  if (!initData || initData === 'mock') {
    req.telegramUser = { id: req.body.userId || req.query.userId || 999999, first_name: 'Demo', last_name: 'User' };
    return next();
  }

  const user = verifyTelegramData(initData);
  if (!user) {
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }
  req.telegramUser = user;
  next();
}

// ─── Helper: weighted random spin ────────────────────────────────────────────
function getSpinResult() {
  const total = config.SPIN_SEGMENTS.reduce((sum, s) => sum + s.weight, 0);
  let rand = Math.random() * total;
  for (const seg of config.SPIN_SEGMENTS) {
    rand -= seg.weight;
    if (rand <= 0) return seg.value;
  }
  return config.SPIN_SEGMENTS[0].value;
}

// ─── Helper: today string ─────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/user - Get or create user
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    let user = await db.getUser(tgUser.id);
    if (!user) {
      const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ');
      user = await db.createUser(tgUser.id, name, null);
    }
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/spin
app.post('/api/spin', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.spins <= 0) {
      return res.status(400).json({ error: 'No spins available' });
    }

    const reward = getSpinResult();
    user.spins -= 1;
    user.coins += reward;
    user.lastSpin = new Date().toISOString();

    // Credit referrer 30% commission
    if (user.referredBy) {
      const referrer = await db.getUser(parseInt(user.referredBy));
      if (referrer) {
        const commission = Math.floor(reward * config.REFERRAL_PERCENT / 100);
        referrer.referralEarned += commission;
        referrer.pendingReferral += commission;
        await db.saveUser(referrer);
      }
    }

    await db.saveUser(user);
    res.json({ success: true, reward, coins: user.coins, spins: user.spins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/claim-streak
app.post('/api/claim-streak', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = todayStr();
    if (user.lastStreak === today) {
      return res.status(400).json({ error: 'Already claimed today' });
    }

    // Check if yesterday was claimed (streak continuation)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (user.lastStreak !== yesterdayStr && user.lastStreak !== '') {
      user.streak = 0; // reset streak
    }

    user.streak = Math.min(user.streak + 1, 7);
    user.lastStreak = today;
    user.coins += config.STREAK_COINS;
    user.spins += config.STREAK_SPINS;

    // Referral commission on streak reward
    if (user.referredBy) {
      const referrer = await db.getUser(parseInt(user.referredBy));
      if (referrer) {
        const commission = Math.floor(config.STREAK_COINS * config.REFERRAL_PERCENT / 100);
        referrer.referralEarned += commission;
        referrer.pendingReferral += commission;
        await db.saveUser(referrer);
      }
    }

    await db.saveUser(user);
    res.json({
      success: true,
      streak: user.streak,
      coins: user.coins,
      spins: user.spins,
      reward: { coins: config.STREAK_COINS, spins: config.STREAK_SPINS }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tasks - List advertiser tasks
app.get('/api/tasks', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    const tasks = await db.getAllTasks();

    const result = tasks.map(t => ({
      ...t,
      completed: user ? user.completedTasks.includes(t.taskId) : false,
      completedBy: undefined, // don't expose full list
    }));

    res.json({ success: true, tasks: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/complete-task
app.post('/api/complete-task', authMiddleware, async (req, res) => {
  try {
    const { taskId } = req.body;
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const task = await db.getTask(taskId);
    if (!task || !task.active) return res.status(404).json({ error: 'Task not found' });

    if (user.completedTasks.includes(taskId)) {
      return res.status(400).json({ error: 'Task already completed' });
    }

    if (task.completions >= task.target) {
      return res.status(400).json({ error: 'Task fully completed' });
    }

    user.completedTasks.push(taskId);
    user.coins += task.reward;

    // Referral commission
    if (user.referredBy) {
      const referrer = await db.getUser(parseInt(user.referredBy));
      if (referrer) {
        const commission = Math.floor(task.reward * config.REFERRAL_PERCENT / 100);
        referrer.referralEarned += commission;
        referrer.pendingReferral += commission;
        await db.saveUser(referrer);
      }
    }

    task.completions += 1;
    task.completedBy.push(String(tgUser.id));

    await db.saveUser(user);
    await db.saveTask(task);

    res.json({ success: true, reward: task.reward, coins: user.coins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/verify-join - Verify user joined a Telegram channel
app.post('/api/verify-join', authMiddleware, async (req, res) => {
  try {
    const { taskId, channelUsername } = req.body;
    const tgUser = req.telegramUser;
    const bot = getBot();

    if (!bot) {
      return res.status(500).json({ error: 'Bot not available' });
    }

    try {
      const member = await bot.getChatMember(`@${channelUsername.replace('@', '')}`, tgUser.id);
      const validStatuses = ['member', 'administrator', 'creator'];
      if (!validStatuses.includes(member.status)) {
        return res.status(400).json({ error: 'Not a member', joined: false });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Could not verify membership', joined: false });
    }

    // Complete the task
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.completedTasks.includes(taskId)) {
      return res.json({ success: true, joined: true, alreadyCompleted: true, coins: user.coins });
    }

    const task = await db.getTask(taskId);
    if (task && task.active && task.completions < task.target) {
      user.completedTasks.push(taskId);
      user.coins += task.reward;
      task.completions += 1;
      task.completedBy.push(String(tgUser.id));
      await db.saveUser(user);
      await db.saveTask(task);
    }

    res.json({ success: true, joined: true, reward: task ? task.reward : 0, coins: user.coins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/claim-daily - Claim daily tasks (checkin, updates, share)
app.post('/api/claim-daily', authMiddleware, async (req, res) => {
  try {
    const { taskType } = req.body;
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = todayStr();
    const dailyKey = `${taskType}_${today}`;

    if (!user.completedTasks) user.completedTasks = [];

    if (user.completedTasks.includes(dailyKey)) {
      return res.status(400).json({ error: 'Already claimed today' });
    }

    const reward = config.TASK_REWARDS[taskType] || 10;
    user.completedTasks.push(dailyKey);
    user.coins += reward;

    if (taskType === 'daily_checkin') {
      user.streak = (user.streak || 0) + 1;
    }

    await db.saveUser(user);
    res.json({ success: true, reward, coins: user.coins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/redeem-promo
app.post('/api/redeem-promo', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const promo = await db.getPromo(code);
    if (!promo || !promo.active) {
      return res.status(400).json({ error: 'Invalid or expired promo code' });
    }

    if (promo.usedBy.includes(String(tgUser.id))) {
      return res.status(400).json({ error: 'Promo code already used' });
    }

    if (promo.uses >= promo.maxUses) {
      return res.status(400).json({ error: 'Promo code exhausted' });
    }

    user.coins += promo.reward;
    promo.uses += 1;
    promo.usedBy.push(String(tgUser.id));

    await db.saveUser(user);
    await db.savePromo(promo);

    res.json({ success: true, reward: promo.reward, coins: user.coins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/claim-referral
app.post('/api/claim-referral', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.pendingReferral <= 0) {
      return res.status(400).json({ error: 'No pending referral earnings' });
    }

    const claimed = user.pendingReferral;
    user.coins += claimed;
    user.pendingReferral = 0;

    await db.saveUser(user);
    res.json({ success: true, claimed, coins: user.coins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/friends
app.get('/api/friends', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const referralLink = `https://t.me/${config.BOT_USERNAME}?start=${tgUser.id}`;
    res.json({
      success: true,
      friends: user.friends,
      referralEarned: user.referralEarned,
      pendingReferral: user.pendingReferral,
      referralLink,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/withdraw
app.post('/api/withdraw', authMiddleware, async (req, res) => {
  try {
    const { coins, walletAddress } = req.body;
    const tgUser = req.telegramUser;
    const user = await db.getUser(tgUser.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const tier = config.WITHDRAWAL_TIERS.find(t => t.coins === parseInt(coins));
    if (!tier) return res.status(400).json({ error: 'Invalid withdrawal tier' });

    if (user.coins < tier.coins) {
      return res.status(400).json({ error: 'Insufficient coins' });
    }

    if (!walletAddress || walletAddress.length < 10) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    user.coins -= tier.coins;
    user.walletAddress = walletAddress;
    await db.saveUser(user);

    const withdrawal = await db.createWithdrawal(tgUser.id, tier.coins, tier.ton, walletAddress);

    // Notify admin
    const bot = getBot();
    if (bot && config.ADMIN_ID) {
      bot.sendMessage(config.ADMIN_ID,
        `💸 *New Withdrawal Request*\n\n` +
        `User: ${user.name} (${tgUser.id})\n` +
        `Amount: ${tier.ton} TON\n` +
        `Coins: ${tier.coins.toLocaleString()} TR\n` +
        `Wallet: \`${walletAddress}\`\n` +
        `ID: ${withdrawal.withdrawId}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }

    res.json({ success: true, withdrawal, coins: user.coins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/create-task (advertiser)
app.post('/api/create-task', authMiddleware, async (req, res) => {
  try {
    const { name, type, url, target } = req.body;
    const tgUser = req.telegramUser;

    if (!name || !type || !url || !target) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const validTypes = ['join_channel', 'join_group', 'play_game', 'visit_website'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid task type' });
    }

    const reward = config.TASK_REWARDS[type] || 500;
    const task = await db.createTask(tgUser.id, name, type, url, parseInt(target), reward);

    res.json({ success: true, task, cost: parseInt(target) * config.TASK_COST_PER_COMPLETION });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/advertiser-tasks - My tasks
app.get('/api/advertiser-tasks', authMiddleware, async (req, res) => {
  try {
    const tgUser = req.telegramUser;
    const tasks = await db.getTasksByAdvertiser(tgUser.id);
    res.json({ success: true, tasks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config - Public config for frontend
app.get('/api/config', (req, res) => {
  res.json({
    botUsername: config.BOT_USERNAME,
    withdrawalTiers: config.WITHDRAWAL_TIERS,
    withdrawalFee: config.WITHDRAWAL_FEE,
    tonPerCoin: config.TON_PER_COIN,
    spinSegments: config.SPIN_SEGMENTS.map(s => s.value),
    taskCostPerCompletion: config.TASK_COST_PER_COMPLETION,
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
async function start() {
  try {
    // Init bot first
    createBot();

    // Init DB
    await db.init();

    // Start HTTP server
    app.listen(config.PORT, () => {
      console.log(`[Server] TRewards running on http://localhost:${config.PORT}`);
    });
  } catch (e) {
    console.error('[Server] Fatal error:', e);
    process.exit(1);
  }
}

start();