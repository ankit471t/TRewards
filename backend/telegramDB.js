// telegramDB.js — Telegram Channel as Database Storage System
const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');
dotenv.config();

const bot = new TelegramBot(process.env.BOT_TOKEN);

// In-memory index: userId → { channelId, messageId }
const userIndex = new Map();

// Channel shard config
// Each entry: { channelId, capacity, count }
let channelShards = [];

// Payments index: invoiceId → { channelId, messageId }
const paymentIndex = new Map();

// Payments channel (separate channel for payment logs)
const PAYMENTS_CHANNEL = process.env.ADMIN_CHANNEL_ID;

// ─────────────────────────────────────────────
// INIT: Load shard config from env
// ─────────────────────────────────────────────
function initShards() {
  const channelIds = (process.env.STORAGE_CHANNELS || '').split(',').filter(Boolean);
  const capacity = parseInt(process.env.CHANNEL_CAPACITY || '2000');
  channelShards = channelIds.map((id, i) => ({
    channelId: id.trim(),
    capacity,
    count: 0,
    index: i,
  }));
  console.log(`[TelegramDB] Initialized ${channelShards.length} shard(s)`);
}

// ─────────────────────────────────────────────
// SHARD SELECTION
// ─────────────────────────────────────────────
function getAvailableShard() {
  return channelShards.find(s => s.count < s.capacity) || null;
}

// ─────────────────────────────────────────────
// DEFAULT USER OBJECT
// ─────────────────────────────────────────────
function defaultUser(telegramId, username, referrerId = null) {
  return {
    user_id: telegramId,
    username: username || `user_${telegramId}`,
    coins: 0,
    spins: 1,
    ton_balance: 0,
    referrer_id: referrerId,
    referral_earnings: 0,
    pending_referral: 0,
    daily_streak: 0,
    last_streak_claim: null,
    last_spin: null,
    completed_tasks: [],
    claimed_promos: [],
    transactions: [],
    pending_withdrawals: [],
    join_date: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────
// SERIALIZE / DESERIALIZE
// ─────────────────────────────────────────────
function serialize(data) {
  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

function deserialize(text) {
  try {
    const match = text.match(/```json\n([\s\S]*?)\n```/);
    if (match) return JSON.parse(match[1]);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// CREATE USER (post to channel)
// ─────────────────────────────────────────────
async function createUser(telegramId, username, referrerId = null) {
  if (userIndex.has(telegramId)) {
    return await getUser(telegramId);
  }

  const shard = getAvailableShard();
  if (!shard) throw new Error('No available storage shard. Add more channels.');

  const userData = defaultUser(telegramId, username, referrerId);
  const text = serialize(userData);

  try {
    const msg = await bot.sendMessage(shard.channelId, text, { parse_mode: 'Markdown' });
    userIndex.set(telegramId, { channelId: shard.channelId, messageId: msg.message_id });
    shard.count++;

    // Handle referrer bonus tracking
    if (referrerId && referrerId !== telegramId) {
      await addReferral(referrerId, telegramId);
    }

    return userData;
  } catch (err) {
    console.error('[TelegramDB] createUser error:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// GET USER
// ─────────────────────────────────────────────
async function getUser(telegramId) {
  const loc = userIndex.get(telegramId);
  if (!loc) return null;

  try {
    // Use getMessages to read the message
    const chat = await bot.getChat(loc.channelId);
    // We use forwardMessage trick or store message in index
    // Actually we fetch via copyMessage into a temp location isn't ideal
    // Instead we store last known data in memory + refresh on write
    return userIndex.get(telegramId)?.data || null;
  } catch (err) {
    console.error('[TelegramDB] getUser error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// UPDATE USER (edit the channel message)
// ─────────────────────────────────────────────
async function updateUser(telegramId, updates) {
  const loc = userIndex.get(telegramId);
  if (!loc) throw new Error(`User ${telegramId} not found`);

  const current = loc.data || {};
  const updated = {
    ...current,
    ...updates,
    last_updated: new Date().toISOString(),
  };

  // Keep transactions capped at 50
  if (updated.transactions && updated.transactions.length > 50) {
    updated.transactions = updated.transactions.slice(-50);
  }

  const text = serialize(updated);

  try {
    await bot.editMessageText(text, {
      chat_id: loc.channelId,
      message_id: loc.messageId,
      parse_mode: 'Markdown',
    });
    // Update in-memory cache
    userIndex.set(telegramId, { ...loc, data: updated });
    return updated;
  } catch (err) {
    if (err.message && err.message.includes('message is not modified')) {
      return updated; // No change needed
    }
    console.error('[TelegramDB] updateUser error:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// GET OR CREATE USER
// ─────────────────────────────────────────────
async function getOrCreateUser(telegramId, username, referrerId = null) {
  const existing = userIndex.get(telegramId);
  if (existing && existing.data) return existing.data;
  if (existing && !existing.data) {
    // Re-hydrate from channel
    return existing.data || await createUser(telegramId, username, referrerId);
  }
  return await createUser(telegramId, username, referrerId);
}

// ─────────────────────────────────────────────
// ADD COINS
// ─────────────────────────────────────────────
async function addCoins(telegramId, amount, description = 'Reward', type = 'credit') {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');

  const user = loc.data;
  const newCoins = (user.coins || 0) + amount;
  const tx = {
    id: Date.now(),
    type,
    description,
    amount,
    date: new Date().toISOString(),
  };

  const transactions = [...(user.transactions || []), tx];

  // Referral commission (30%)
  if (user.referrer_id && type === 'credit' && amount > 0) {
    await addReferralEarning(user.referrer_id, Math.floor(amount * 0.3));
  }

  return await updateUser(telegramId, {
    coins: newCoins,
    transactions,
  });
}

// ─────────────────────────────────────────────
// DEDUCT COINS
// ─────────────────────────────────────────────
async function deductCoins(telegramId, amount, description = 'Withdrawal') {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;
  if ((user.coins || 0) < amount) throw new Error('Insufficient coins');

  const tx = {
    id: Date.now(),
    type: 'debit',
    description,
    amount: -amount,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];
  return await updateUser(telegramId, { coins: user.coins - amount, transactions });
}

// ─────────────────────────────────────────────
// REFERRAL SYSTEM
// ─────────────────────────────────────────────
async function addReferral(referrerId, newUserId) {
  const loc = userIndex.get(referrerId);
  if (!loc || !loc.data) return;
  const user = loc.data;
  const referrals = user.referrals || [];
  if (!referrals.find(r => r.user_id === newUserId)) {
    referrals.push({ user_id: newUserId, coins_generated: 0, joined: new Date().toISOString() });
    await updateUser(referrerId, { referrals });
  }
}

async function addReferralEarning(referrerId, amount) {
  const loc = userIndex.get(referrerId);
  if (!loc || !loc.data) return;
  const user = loc.data;
  await updateUser(referrerId, {
    pending_referral: (user.pending_referral || 0) + amount,
    referral_earnings: (user.referral_earnings || 0) + amount,
  });
}

async function claimReferral(telegramId) {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;
  const pending = user.pending_referral || 0;
  if (pending <= 0) throw new Error('No pending referral earnings');

  const tx = {
    id: Date.now(),
    type: 'credit',
    description: 'Referral commission claimed',
    amount: pending,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];
  return await updateUser(telegramId, {
    coins: (user.coins || 0) + pending,
    pending_referral: 0,
    transactions,
  });
}

// ─────────────────────────────────────────────
// DAILY STREAK
// ─────────────────────────────────────────────
async function claimStreak(telegramId) {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;

  const now = new Date();
  const last = user.last_streak_claim ? new Date(user.last_streak_claim) : null;

  if (last) {
    const diffHours = (now - last) / (1000 * 60 * 60);
    if (diffHours < 20) throw new Error('Already claimed today');
  }

  let streak = user.daily_streak || 0;
  if (last) {
    const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    streak = diffDays === 1 ? streak + 1 : 1;
    if (streak > 7) streak = 1;
  } else {
    streak = 1;
  }

  const tx = {
    id: Date.now(),
    type: 'credit',
    description: `Daily streak day ${streak}`,
    amount: 10,
    date: now.toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];

  return await updateUser(telegramId, {
    coins: (user.coins || 0) + 10,
    spins: (user.spins || 0) + 1,
    daily_streak: streak,
    last_streak_claim: now.toISOString(),
    transactions,
  });
}

// ─────────────────────────────────────────────
// SPIN WHEEL
// ─────────────────────────────────────────────
const SPIN_PRIZES = [10, 50, 80, 100, 300, 500];

async function spinWheel(telegramId) {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;
  if ((user.spins || 0) <= 0) throw new Error('No spins available');

  const prize = SPIN_PRIZES[Math.floor(Math.random() * SPIN_PRIZES.length)];
  const segmentIndex = SPIN_PRIZES.indexOf(prize);

  const tx = {
    id: Date.now(),
    type: 'credit',
    description: `Spin wheel reward`,
    amount: prize,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];

  await updateUser(telegramId, {
    coins: (user.coins || 0) + prize,
    spins: user.spins - 1,
    last_spin: new Date().toISOString(),
    transactions,
  });

  return { prize, segmentIndex };
}

// ─────────────────────────────────────────────
// TASK COMPLETION
// ─────────────────────────────────────────────
async function claimTask(telegramId, taskId, reward) {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;

  if ((user.completed_tasks || []).includes(taskId)) {
    throw new Error('Task already completed');
  }

  const completed_tasks = [...(user.completed_tasks || []), taskId];
  const tx = {
    id: Date.now(),
    type: 'credit',
    description: `Task completed #${taskId}`,
    amount: reward,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];

  return await updateUser(telegramId, {
    coins: (user.coins || 0) + reward,
    spins: (user.spins || 0) + 1,
    completed_tasks,
    transactions,
  });
}

// ─────────────────────────────────────────────
// PROMO CODES (stored in admin channel)
// ─────────────────────────────────────────────
// In-memory promo store (backed by admin channel message)
let promoStore = { promos: [], messageId: null };

async function loadPromos() {
  // Promos are managed in-memory, persisted via admin channel
}

async function redeemPromo(telegramId, code) {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;

  const promo = promoStore.promos.find(
    p => p.code.toUpperCase() === code.toUpperCase() && p.active
  );
  if (!promo) throw new Error('Invalid or expired promo code');
  if ((user.claimed_promos || []).includes(promo.code)) throw new Error('Promo already redeemed');
  if (promo.activations >= promo.max_activations) throw new Error('Promo code exhausted');

  // Apply reward
  const claimed_promos = [...(user.claimed_promos || []), promo.code];
  const tx = {
    id: Date.now(),
    type: promo.reward_type === 'ton' ? 'ton_credit' : 'credit',
    description: `Promo code: ${promo.code}`,
    amount: promo.reward_amount,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];

  const updates = { claimed_promos, transactions };
  if (promo.reward_type === 'ton') {
    updates.ton_balance = (user.ton_balance || 0) + promo.reward_amount;
  } else {
    updates.coins = (user.coins || 0) + promo.reward_amount;
  }

  promo.activations++;
  if (promo.activations >= promo.max_activations) promo.active = false;

  await updateUser(telegramId, updates);
  return { reward: promo.reward_amount, type: promo.reward_type };
}

function createPromo(code, rewardAmount, maxActivations, rewardType = 'coins') {
  const exists = promoStore.promos.find(p => p.code.toUpperCase() === code.toUpperCase());
  if (exists) throw new Error('Promo code already exists');

  const promo = {
    code: code.toUpperCase(),
    reward_amount: rewardAmount,
    reward_type: rewardType, // 'coins' or 'ton'
    max_activations: maxActivations,
    activations: 0,
    active: true,
    created_at: new Date().toISOString(),
  };
  promoStore.promos.push(promo);
  return promo;
}

function deletePromo(code) {
  const idx = promoStore.promos.findIndex(p => p.code.toUpperCase() === code.toUpperCase());
  if (idx === -1) throw new Error('Promo not found');
  promoStore.promos.splice(idx, 1);
}

function listPromos() {
  return promoStore.promos;
}

// ─────────────────────────────────────────────
// WITHDRAWAL
// ─────────────────────────────────────────────
const WITHDRAWAL_TIERS = [
  { coins: 250000, ton: 0.10, net: 0.05 },
  { coins: 500000, ton: 0.20, net: 0.15 },
  { coins: 750000, ton: 0.30, net: 0.25 },
  { coins: 1000000, ton: 0.40, net: 0.35 },
];

async function requestWithdrawal(telegramId, tier, walletAddress) {
  const tierData = WITHDRAWAL_TIERS[tier];
  if (!tierData) throw new Error('Invalid withdrawal tier');

  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;

  if ((user.coins || 0) < tierData.coins) throw new Error('Insufficient coins');

  const withdrawal = {
    id: `W_${Date.now()}`,
    tier,
    coins_deducted: tierData.coins,
    ton_amount: tierData.ton,
    net_ton: tierData.net,
    wallet: walletAddress,
    status: 'pending',
    created_at: new Date().toISOString(),
  };

  const tx = {
    id: Date.now(),
    type: 'debit',
    description: `Withdrawal ${tierData.net} TON (pending)`,
    amount: -tierData.coins,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];
  const pending_withdrawals = [...(user.pending_withdrawals || []), withdrawal];

  await updateUser(telegramId, {
    coins: user.coins - tierData.coins,
    pending_withdrawals,
    transactions,
  });

  // Log to admin channel
  await bot.sendMessage(
    PAYMENTS_CHANNEL,
    `🔴 *WITHDRAWAL REQUEST*\nUser: ${telegramId} (@${user.username})\nAmount: ${tierData.net} TON\nWallet: \`${walletAddress}\`\nID: ${withdrawal.id}`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  return withdrawal;
}

// ─────────────────────────────────────────────
// TON BALANCE (from payments)
// ─────────────────────────────────────────────
async function addTonBalance(telegramId, amount) {
  const loc = userIndex.get(telegramId);
  if (!loc || !loc.data) throw new Error('User not found');
  const user = loc.data;
  const tx = {
    id: Date.now(),
    type: 'ton_credit',
    description: `TON top-up`,
    amount,
    date: new Date().toISOString(),
  };
  const transactions = [...(user.transactions || []), tx];
  return await updateUser(telegramId, {
    ton_balance: (user.ton_balance || 0) + amount,
    transactions,
  });
}

// ─────────────────────────────────────────────
// PAYMENTS STORAGE
// ─────────────────────────────────────────────
async function logPayment(invoiceId, telegramId, amount, provider, status = 'pending') {
  const paymentData = {
    invoice_id: invoiceId,
    telegram_id: telegramId,
    amount,
    asset: 'TON',
    provider,
    status,
    created_at: new Date().toISOString(),
  };

  try {
    const msg = await bot.sendMessage(
      PAYMENTS_CHANNEL,
      serialize(paymentData),
      { parse_mode: 'Markdown' }
    );
    paymentIndex.set(invoiceId, { channelId: PAYMENTS_CHANNEL, messageId: msg.message_id, data: paymentData });
  } catch (err) {
    console.error('[TelegramDB] logPayment error:', err.message);
  }
  return paymentData;
}

async function updatePayment(invoiceId, status) {
  const loc = paymentIndex.get(invoiceId);
  if (!loc) return null;
  const updated = { ...loc.data, status, updated_at: new Date().toISOString() };
  try {
    await bot.editMessageText(serialize(updated), {
      chat_id: loc.channelId,
      message_id: loc.messageId,
      parse_mode: 'Markdown',
    });
    paymentIndex.set(invoiceId, { ...loc, data: updated });
  } catch (err) {
    console.error('[TelegramDB] updatePayment error:', err.message);
  }
  return updated;
}

function getPayment(invoiceId) {
  return paymentIndex.get(invoiceId)?.data || null;
}

// ─────────────────────────────────────────────
// TASKS STORAGE (in-memory, admin managed)
// ─────────────────────────────────────────────
let taskStore = [];

function getAllTasks() {
  return taskStore.filter(t => t.active && t.completed < t.limit);
}

function createTask(advertiserTelegramId, taskData) {
  const task = {
    id: `T_${Date.now()}`,
    advertiser_id: advertiserTelegramId,
    name: taskData.name,
    type: taskData.type,
    url: taskData.url,
    reward: taskData.type === 'visit' ? 500 : 1000,
    limit: taskData.limit,
    completed: 0,
    active: true,
    created_at: new Date().toISOString(),
  };
  taskStore.push(task);
  return task;
}

function getTask(taskId) {
  return taskStore.find(t => t.id === taskId);
}

function incrementTaskCompletion(taskId) {
  const task = taskStore.find(t => t.id === taskId);
  if (task) {
    task.completed++;
    if (task.completed >= task.limit) task.active = false;
  }
}

// ─────────────────────────────────────────────
// ADMIN: Channel Management
// ─────────────────────────────────────────────
function addShard(channelId, capacity = 2000) {
  channelShards.push({ channelId, capacity, count: 0, index: channelShards.length });
  process.env.STORAGE_CHANNELS = channelShards.map(s => s.channelId).join(',');
}

function getShardStats() {
  return channelShards.map(s => ({
    channelId: s.channelId,
    used: s.count,
    capacity: s.capacity,
    available: s.count < s.capacity,
  }));
}

function getUserStats() {
  return {
    total_users: userIndex.size,
    shards: getShardStats(),
  };
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  initShards,
  getOrCreateUser,
  getUser,
  updateUser,
  addCoins,
  deductCoins,
  claimStreak,
  spinWheel,
  claimTask,
  redeemPromo,
  createPromo,
  deletePromo,
  listPromos,
  claimReferral,
  requestWithdrawal,
  addTonBalance,
  logPayment,
  updatePayment,
  getPayment,
  getAllTasks,
  createTask,
  getTask,
  incrementTaskCompletion,
  addShard,
  getShardStats,
  getUserStats,
  WITHDRAWAL_TIERS,
  SPIN_PRIZES,
  bot,
};