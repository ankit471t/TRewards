/**
 * database.js
 * Uses a private Telegram channel as a database.
 * Each user = 1 message. Updates edit the same message.
 * Promo codes, tasks, withdrawals stored in pinned/dedicated messages.
 */

const config = require('./config');

let bot = null; // will be set after bot init

function setBot(botInstance) {
  bot = botInstance;
}

// ─── Message format helpers ───────────────────────────────────────────────────

function serializeUser(user) {
  return [
    `User: ${user.id}`,
    `Name: ${user.name}`,
    `Coins: ${user.coins}`,
    `Spins: ${user.spins}`,
    `Friends: ${user.friends}`,
    `ReferralEarned: ${user.referralEarned}`,
    `PendingReferral: ${user.pendingReferral}`,
    `Streak: ${user.streak}`,
    `LastStreak: ${user.lastStreak || ''}`,
    `LastSpin: ${user.lastSpin || ''}`,
    `ReferredBy: ${user.referredBy || ''}`,
    `MessageId: ${user.messageId || ''}`,
    `CompletedTasks: ${(user.completedTasks || []).join(',')}`,
    `DailyTasks: ${user.dailyTasks || ''}`,
    `WalletAddress: ${user.walletAddress || ''}`,
    `Joined: ${user.joined || new Date().toISOString()}`,
    `LastSeen: ${new Date().toISOString()}`,
  ].join('\n');
}

function parseUser(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const get = (key) => {
    const line = lines.find(l => l.startsWith(key + ': '));
    return line ? line.slice(key.length + 2).trim() : '';
  };
  return {
    id: parseInt(get('User')) || 0,
    name: get('Name'),
    coins: parseInt(get('Coins')) || 0,
    spins: parseInt(get('Spins')) || 0,
    friends: parseInt(get('Friends')) || 0,
    referralEarned: parseInt(get('ReferralEarned')) || 0,
    pendingReferral: parseInt(get('PendingReferral')) || 0,
    streak: parseInt(get('Streak')) || 0,
    lastStreak: get('LastStreak'),
    lastSpin: get('LastSpin'),
    referredBy: get('ReferredBy'),
    messageId: parseInt(get('MessageId')) || 0,
    completedTasks: get('CompletedTasks') ? get('CompletedTasks').split(',').filter(Boolean) : [],
    dailyTasks: get('DailyTasks'),
    walletAddress: get('WalletAddress'),
    joined: get('Joined'),
  };
}

function serializePromo(promo) {
  return [
    `PROMO_CODE`,
    `Code: ${promo.code}`,
    `Reward: ${promo.reward}`,
    `MaxUses: ${promo.maxUses}`,
    `Uses: ${promo.uses}`,
    `UsedBy: ${(promo.usedBy || []).join(',')}`,
    `MessageId: ${promo.messageId || ''}`,
    `Created: ${promo.created || new Date().toISOString()}`,
    `Active: ${promo.active !== false}`,
  ].join('\n');
}

function parsePromo(text) {
  if (!text || !text.startsWith('PROMO_CODE')) return null;
  const lines = text.split('\n');
  const get = (key) => {
    const line = lines.find(l => l.startsWith(key + ': '));
    return line ? line.slice(key.length + 2).trim() : '';
  };
  return {
    code: get('Code'),
    reward: parseInt(get('Reward')) || 0,
    maxUses: parseInt(get('MaxUses')) || 0,
    uses: parseInt(get('Uses')) || 0,
    usedBy: get('UsedBy') ? get('UsedBy').split(',').filter(Boolean) : [],
    messageId: parseInt(get('MessageId')) || 0,
    created: get('Created'),
    active: get('Active') !== 'false',
  };
}

function serializeTask(task) {
  return [
    `AD_TASK`,
    `TaskId: ${task.taskId}`,
    `AdvertiserId: ${task.advertiserId}`,
    `Name: ${task.name}`,
    `Type: ${task.type}`,
    `Url: ${task.url}`,
    `Target: ${task.target}`,
    `Completions: ${task.completions}`,
    `Reward: ${task.reward}`,
    `Active: ${task.active !== false}`,
    `MessageId: ${task.messageId || ''}`,
    `Created: ${task.created || new Date().toISOString()}`,
    `CompletedBy: ${(task.completedBy || []).join(',')}`,
  ].join('\n');
}

function parseTask(text) {
  if (!text || !text.startsWith('AD_TASK')) return null;
  const lines = text.split('\n');
  const get = (key) => {
    const line = lines.find(l => l.startsWith(key + ': '));
    return line ? line.slice(key.length + 2).trim() : '';
  };
  return {
    taskId: get('TaskId'),
    advertiserId: parseInt(get('AdvertiserId')) || 0,
    name: get('Name'),
    type: get('Type'),
    url: get('Url'),
    target: parseInt(get('Target')) || 0,
    completions: parseInt(get('Completions')) || 0,
    reward: parseInt(get('Reward')) || 0,
    active: get('Active') !== 'false',
    messageId: parseInt(get('MessageId')) || 0,
    created: get('Created'),
    completedBy: get('CompletedBy') ? get('CompletedBy').split(',').filter(Boolean) : [],
  };
}

function serializeWithdrawal(w) {
  return [
    `WITHDRAWAL`,
    `WithdrawId: ${w.withdrawId}`,
    `UserId: ${w.userId}`,
    `Coins: ${w.coins}`,
    `Ton: ${w.ton}`,
    `Wallet: ${w.wallet}`,
    `Status: ${w.status}`,
    `MessageId: ${w.messageId || ''}`,
    `Created: ${w.created || new Date().toISOString()}`,
  ].join('\n');
}

// ─── In-memory index (messageId lookup by userId, promoCode, etc.) ────────────
// We cache message IDs to avoid scanning entire channel
const userIndex = new Map();    // userId -> messageId
const promoIndex = new Map();   // code -> messageId
const taskIndex = new Map();    // taskId -> messageId

// ─── Channel operations ───────────────────────────────────────────────────────

async function sendToChannel(text) {
  try {
    const msg = await bot.sendMessage(config.DATA_CHANNEL_ID, text);
    return msg.message_id;
  } catch (e) {
    console.error('[DB] sendToChannel error:', e.message);
    return null;
  }
}

async function editInChannel(messageId, text) {
  try {
    await bot.editMessageText(text, {
      chat_id: config.DATA_CHANNEL_ID,
      message_id: messageId,
    });
    return true;
  } catch (e) {
    // "message is not modified" is fine
    if (!e.message.includes('not modified')) {
      console.error('[DB] editInChannel error:', e.message);
    }
    return true;
  }
}

async function getMessageText(messageId) {
  try {
    // Telegram doesn't have getMessageText; we forward and read
    // Instead we use the forwardMessage trick or store locally
    // Better: use copyMessage to a temp place — but simplest is store in memory cache
    // We'll re-fetch using getChat / getChatHistory which isn't standard
    // SOLUTION: store text in memory cache alongside messageId
    return null; // handled by in-memory cache
  } catch (e) {
    return null;
  }
}

// ─── User cache (in-memory for performance) ───────────────────────────────────
const userCache = new Map(); // userId -> user object

// ─── User CRUD ────────────────────────────────────────────────────────────────

async function getUser(userId) {
  if (userCache.has(userId)) {
    return userCache.get(userId);
  }
  return null;
}

async function saveUser(user) {
  const text = serializeUser(user);

  if (user.messageId) {
    await editInChannel(user.messageId, text);
  } else {
    const msgId = await sendToChannel(text);
    if (!msgId) return false;
    user.messageId = msgId;
    // Update the message with messageId included
    await editInChannel(msgId, serializeUser(user));
  }

  userCache.set(user.id, user);
  userIndex.set(user.id, user.messageId);
  return true;
}

async function createUser(userId, name, referredBy) {
  const existing = await getUser(userId);
  if (existing) return existing;

  const user = {
    id: userId,
    name: name || 'User',
    coins: 0,
    spins: 1,
    friends: 0,
    referralEarned: 0,
    pendingReferral: 0,
    streak: 0,
    lastStreak: '',
    lastSpin: '',
    referredBy: referredBy ? String(referredBy) : '',
    messageId: 0,
    completedTasks: [],
    dailyTasks: '',
    walletAddress: '',
    joined: new Date().toISOString(),
  };

  await saveUser(user);
  return user;
}

// ─── Promo cache ───────────────────────────────────────────────────────────────
const promoCache = new Map(); // code -> promo object

async function getPromo(code) {
  return promoCache.get(code.toUpperCase()) || null;
}

async function savePromo(promo) {
  promo.code = promo.code.toUpperCase();
  const text = serializePromo(promo);

  if (promo.messageId) {
    await editInChannel(promo.messageId, text);
  } else {
    const msgId = await sendToChannel(text);
    if (!msgId) return false;
    promo.messageId = msgId;
    await editInChannel(msgId, serializePromo(promo));
  }

  promoCache.set(promo.code, promo);
  return true;
}

async function getAllPromos() {
  return Array.from(promoCache.values());
}

async function deletePromo(code) {
  const promo = promoCache.get(code.toUpperCase());
  if (!promo) return false;
  promo.active = false;
  await savePromo(promo);
  promoCache.delete(code.toUpperCase());
  return true;
}

// ─── Task cache ───────────────────────────────────────────────────────────────
const taskCache = new Map(); // taskId -> task object
let taskCounter = 1;

async function getTask(taskId) {
  return taskCache.get(taskId) || null;
}

async function saveTask(task) {
  const text = serializeTask(task);

  if (task.messageId) {
    await editInChannel(task.messageId, text);
  } else {
    const msgId = await sendToChannel(text);
    if (!msgId) return false;
    task.messageId = msgId;
    await editInChannel(msgId, serializeTask(task));
  }

  taskCache.set(task.taskId, task);
  return true;
}

async function getAllTasks() {
  return Array.from(taskCache.values()).filter(t => t.active !== false);
}

async function getTasksByAdvertiser(advertiserId) {
  return Array.from(taskCache.values()).filter(t => t.advertiserId === advertiserId);
}

async function createTask(advertiserId, name, type, url, target, reward) {
  const taskId = `task_${Date.now()}_${taskCounter++}`;
  const task = {
    taskId,
    advertiserId,
    name,
    type,
    url,
    target,
    completions: 0,
    reward,
    active: true,
    messageId: 0,
    created: new Date().toISOString(),
    completedBy: [],
  };
  await saveTask(task);
  return task;
}

// ─── Withdrawal ───────────────────────────────────────────────────────────────
const withdrawalCache = new Map();
let withdrawCounter = 1;

async function createWithdrawal(userId, coins, ton, wallet) {
  const withdrawId = `wd_${Date.now()}_${withdrawCounter++}`;
  const w = {
    withdrawId,
    userId,
    coins,
    ton,
    wallet,
    status: 'pending',
    messageId: 0,
    created: new Date().toISOString(),
  };
  const text = serializeWithdrawal(w);
  const msgId = await sendToChannel(text);
  if (msgId) {
    w.messageId = msgId;
    await editInChannel(msgId, serializeWithdrawal(w));
  }
  withdrawalCache.set(withdrawId, w);
  return w;
}

// ─── Seed default promo codes ─────────────────────────────────────────────────
async function seedDefaultPromos() {
  const defaults = [
    { code: 'WELCOME',   reward: 500,  maxUses: 9999 },
    { code: 'BONUS100',  reward: 100,  maxUses: 9999 },
    { code: 'TREWARDS',  reward: 250,  maxUses: 9999 },
  ];
  for (const p of defaults) {
    if (!promoCache.has(p.code)) {
      await savePromo({ ...p, uses: 0, usedBy: [], messageId: 0, active: true });
    }
  }
}

// ─── Seed default advertiser tasks ────────────────────────────────────────────
async function seedDefaultTasks() {
  if (taskCache.size === 0) {
    await createTask(0, 'Join TRewards Channel', 'join_channel', 'https://t.me/trewards_ton', 1000, 1000);
    await createTask(0, 'Join TRewards Group',   'join_group',   'https://t.me/trewards_ton', 1000, 1000);
    await createTask(0, 'Play TRewards Game Bot','play_game',    'https://t.me/trewards_ton_bot', 1000, 1000);
    await createTask(0, 'Visit TRewards Website','visit_website','https://t.me/trewards_ton', 1000, 500);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  console.log('[DB] Initializing (Telegram channel storage)...');
  await seedDefaultPromos();
  await seedDefaultTasks();
  console.log('[DB] Ready.');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function getStats() {
  return {
    totalUsers: userCache.size,
    totalPromos: promoCache.size,
    totalTasks: taskCache.size,
    totalWithdrawals: withdrawalCache.size,
  };
}

module.exports = {
  setBot, init,
  getUser, saveUser, createUser,
  getPromo, savePromo, getAllPromos, deletePromo,
  getTask, saveTask, getAllTasks, getTasksByAdvertiser, createTask,
  createWithdrawal,
  getStats,
  userCache, promoCache, taskCache,
};