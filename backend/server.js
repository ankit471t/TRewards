// server.js — TRewards Backend Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const db = require('./telegramDB');
const payments = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Raw body needed for webhook signature verification
app.use('/payment-webhook', express.raw({ type: '*/*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use('/api', limiter);

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE — Verify Telegram initData
// ─────────────────────────────────────────────
function verifyTelegramAuth(req, res, next) {
  // For development/testing, allow bypass
  if (process.env.NODE_ENV === 'development') {
    req.telegramId = parseInt(req.headers['x-telegram-id'] || req.body?.user_id || 0);
    return next();
  }

  const initData = req.headers['x-init-data'] || req.body?.initData;
  if (!initData) return res.status(401).json({ error: 'Missing initData' });

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = [...urlParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) return res.status(401).json({ error: 'Invalid auth' });

    const userStr = urlParams.get('user');
    const user = userStr ? JSON.parse(userStr) : null;
    req.telegramId = user?.id;
    req.telegramUsername = user?.username || user?.first_name;
    next();
  } catch {
    res.status(401).json({ error: 'Auth failed' });
  }
}

function requireAdmin(req, res, next) {
  const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
  if (!adminIds.includes(req.telegramId)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── USER ──────────────────────────────────────

// Initialize user session
app.post('/api/init', verifyTelegramAuth, async (req, res) => {
  try {
    const { referrer_id } = req.body;
    const user = await db.getOrCreateUser(
      req.telegramId,
      req.telegramUsername,
      referrer_id ? parseInt(referrer_id) : null
    );
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user data
app.get('/api/me', verifyTelegramAuth, async (req, res) => {
  try {
    const user = await db.getUser(req.telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STREAK ────────────────────────────────────
app.post('/api/claim-streak', verifyTelegramAuth, async (req, res) => {
  try {
    const user = await db.claimStreak(req.telegramId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── SPIN WHEEL ────────────────────────────────
app.post('/api/spin', verifyTelegramAuth, async (req, res) => {
  try {
    const result = await db.spinWheel(req.telegramId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── TASKS ─────────────────────────────────────
app.get('/api/tasks', verifyTelegramAuth, async (req, res) => {
  try {
    const tasks = db.getAllTasks();
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-task', verifyTelegramAuth, async (req, res) => {
  try {
    const { task_id } = req.body;
    const task = db.getTask(task_id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.active) return res.status(400).json({ error: 'Task no longer active' });

    const user = await db.claimTask(req.telegramId, task_id, task.reward);
    db.incrementTaskCompletion(task_id);
    res.json({ success: true, reward: task.reward, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify channel/group membership
app.post('/api/verify-join', verifyTelegramAuth, async (req, res) => {
  try {
    const { task_id, chat_id } = req.body;
    const task = db.getTask(task_id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Check Telegram membership
    const member = await db.bot.getChatMember(chat_id, req.telegramId).catch(() => null);
    const validStatuses = ['member', 'administrator', 'creator'];

    if (!member || !validStatuses.includes(member.status)) {
      return res.status(400).json({ error: 'Not a member. Please join first.' });
    }

    const user = await db.claimTask(req.telegramId, task_id, task.reward);
    db.incrementTaskCompletion(task_id);
    res.json({ success: true, reward: task.reward, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── PROMO CODES ───────────────────────────────
app.post('/api/redeem-promo', verifyTelegramAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const result = await db.redeemPromo(req.telegramId, code);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── REFERRALS ─────────────────────────────────
app.post('/api/claim-referral', verifyTelegramAuth, async (req, res) => {
  try {
    const user = await db.claimReferral(req.telegramId);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── WITHDRAWAL ────────────────────────────────
app.post('/api/withdraw', verifyTelegramAuth, async (req, res) => {
  try {
    const { tier, wallet_address } = req.body;
    if (tier === undefined || !wallet_address) {
      return res.status(400).json({ error: 'tier and wallet_address required' });
    }
    const withdrawal = await db.requestWithdrawal(req.telegramId, tier, wallet_address);
    res.json({ success: true, withdrawal });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── TOP-UP ────────────────────────────────────
app.post('/api/create-topup', verifyTelegramAuth, async (req, res) => {
  try {
    const { amount, method } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!['xrocket', 'cryptopay'].includes(method)) {
      return res.status(400).json({ error: 'Invalid payment method' });
    }

    let invoice;
    if (method === 'xrocket') {
      invoice = await payments.createXRocketInvoice(req.telegramId, amount);
    } else {
      invoice = await payments.createCryptoPayInvoice(req.telegramId, amount);
    }

    // Log pending payment
    await db.logPayment(invoice.invoice_id, req.telegramId, amount, method, 'pending');

    res.json({ success: true, payment_url: invoice.payment_url, invoice_id: invoice.invoice_id });
  } catch (err) {
    console.error('[TopUp] Error:', err.message);
    res.status(500).json({ error: 'Payment creation failed' });
  }
});

// ── PAYMENT WEBHOOKS ──────────────────────────

// Prevent double-credit: track processed invoices
const processedInvoices = new Set();

async function handlePaymentConfirmed(parsed) {
  if (!parsed || parsed.status !== 'paid') return;
  if (!parsed.user_id) return;
  if (parsed.currency !== 'TON' && parsed.currency !== 'TONCOIN') return;
  if (processedInvoices.has(parsed.invoice_id)) {
    console.log(`[Webhook] Duplicate invoice ${parsed.invoice_id} — skipped`);
    return;
  }

  const existing = db.getPayment(parsed.invoice_id);
  if (existing && existing.status === 'paid') {
    console.log(`[Webhook] Already processed ${parsed.invoice_id}`);
    return;
  }

  processedInvoices.add(parsed.invoice_id);
  await db.updatePayment(parsed.invoice_id, 'paid');
  await db.addTonBalance(parsed.user_id, parsed.amount);

  console.log(`[Webhook] Credited ${parsed.amount} TON to user ${parsed.user_id}`);

  // Notify user via bot
  db.bot.sendMessage(
    parsed.user_id,
    `✅ *Top-Up Successful!*\n\n+${parsed.amount} TON added to your TRewards balance.`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
}

// xRocket webhook
app.post('/payment-webhook/xrocket', async (req, res) => {
  const rawBody = req.body;
  const sig = req.headers['rocket-pay-signature'] || '';

  if (!payments.verifyXRocketWebhook(rawBody.toString(), sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let body;
  try { body = JSON.parse(rawBody.toString()); } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const parsed = payments.parseXRocketWebhook(body);
  await handlePaymentConfirmed(parsed);
  res.json({ ok: true });
});

// CryptoPay webhook
app.post('/payment-webhook/cryptopay', async (req, res) => {
  const rawBody = req.body;
  const sig = req.headers['crypto-pay-api-signature'] || '';

  if (!payments.verifyCryptoPayWebhook(rawBody.toString(), sig)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let body;
  try { body = JSON.parse(rawBody.toString()); } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const parsed = payments.parseCryptoPayWebhook(body);
  await handlePaymentConfirmed(parsed);
  res.json({ ok: true });
});

// ── ADVERTISER ────────────────────────────────
app.post('/api/create-task', verifyTelegramAuth, async (req, res) => {
  try {
    const { name, type, url, limit } = req.body;
    if (!name || !type || !url || !limit) {
      return res.status(400).json({ error: 'All fields required' });
    }

    // Cost in TON
    const cost = parseInt(limit) * 0.001;
    const userLoc = db.getUserIndex ? db.getUserIndex(req.telegramId) : null;
    // Deduct from TON balance
    const user = await db.getUser(req.telegramId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if ((user.ton_balance || 0) < cost) {
      return res.status(400).json({ error: `Insufficient TON balance. Need ${cost} TON` });
    }

    const task = db.createTask(req.telegramId, { name, type, url, limit: parseInt(limit) });
    await db.updateUser(req.telegramId, { ton_balance: user.ton_balance - cost });

    res.json({ success: true, task, cost });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ROUTES ──────────────────────────────
app.use('/api/admin', verifyTelegramAuth, requireAdmin);

app.post('/api/admin/create-promo', async (req, res) => {
  try {
    const { code, reward_amount, max_activations, reward_type } = req.body;
    const promo = db.createPromo(code, parseFloat(reward_amount), parseInt(max_activations), reward_type || 'coins');
    res.json({ success: true, promo });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/promos', async (req, res) => {
  res.json({ success: true, promos: db.listPromos() });
});

app.delete('/api/admin/promo/:code', async (req, res) => {
  try {
    db.deletePromo(req.params.code);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/add-channel', async (req, res) => {
  try {
    const { channel_id, capacity } = req.body;
    db.addShard(channel_id, capacity || 2000);
    res.json({ success: true, shards: db.getShardStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  res.json({ success: true, stats: db.getUserStats(), tasks: db.getAllTasks() });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
db.initShards();
app.listen(PORT, () => console.log(`[TRewards] Server running on port ${PORT}`));