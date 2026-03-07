/**
 * TRewards Telegram Bot - bot.js
 * Handles /start, admin commands, and webhook registration
 * 
 * Can run standalone or integrated with server.js
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://yourdomain.com';
const DB_PATH = process.env.DB_PATH || './trewards.db';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = process.env.BOT_PORT || 3001;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set in .env');
  process.exit(1);
}

// ─── Database ───────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`);

function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(telegramId));
}

function ensureUser(telegramId, firstName='', username='', referrerId=null) {
  const existing = getUser(telegramId);
  if (existing) return existing;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, first_name, username, referrer_id, spins)
    VALUES (?, ?, ?, ?, 1)
  `);
  stmt.run(String(telegramId), firstName, username, referrerId);
  return getUser(telegramId);
}

// ─── Telegram API helper ─────────────────────────────────
function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, extra={}) {
  return tgRequest('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  });
}

function answerCallbackQuery(id, text='') {
  return tgRequest('answerCallbackQuery', { callback_query_id: id, text });
}

// ─── Admin sessions (promo wizard) ──────────────────────
const sessions = new Map();

// ─── Message handler ─────────────────────────────────────
async function handleMessage(msg) {
  if (!msg || !msg.from) return;
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const firstName = msg.from.first_name || '';
  const username = msg.from.username || '';

  // ─ Admin wizard steps ─
  if (sessions.has(userId) && userId === ADMIN_ID) {
    await handleAdminSession(userId, chatId, text);
    return;
  }

  // ─ /start ─
  if (text.startsWith('/start')) {
    const args = text.split(' ').slice(1);
    const referralId = args[0] || null;

    const existing = getUser(userId);
    let isNew = !existing;
    let validReferrer = null;

    if (!existing) {
      if (referralId && referralId !== userId) {
        const referrer = getUser(referralId);
        if (referrer) validReferrer = referralId;
      }
      ensureUser(userId, firstName, username, validReferrer);
    }

    const welcomeMsg = isNew
      ? `🎉 <b>Welcome to TRewards, ${firstName}!</b>\n\n` +
        `You've joined the #1 Telegram rewards platform.\n\n` +
        `🪙 Complete tasks to earn <b>TR coins</b>\n` +
        `🎰 Spin the wheel for instant rewards\n` +
        `👥 Invite friends & earn <b>30%</b> of their coins\n` +
        `💎 Withdraw earnings as <b>TON cryptocurrency</b>\n\n` +
        `<b>You start with 1 free spin!</b> 🎁`
      : `👋 <b>Welcome back, ${firstName}!</b>\n\nYour rewards are waiting for you.`;

    await sendMessage(chatId, welcomeMsg, {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Open TRewards', web_app: { url: WEBAPP_URL } }
        ]]
      }
    });

    if (isNew && validReferrer) {
      // Notify referrer
      try {
        const referrerUser = getUser(validReferrer);
        if (referrerUser) {
          await sendMessage(validReferrer,
            `🎉 <b>New referral!</b>\n${firstName} joined using your link.\nYou'll earn 30% of their coins automatically!`
          );
        }
      } catch {}
    }
    return;
  }

  // ─ /amiadminyes (admin panel) ─
  if (text === '/amiadminyes') {
    if (userId !== ADMIN_ID) {
      await sendMessage(chatId, '❌ Unauthorized');
      return;
    }
    const stats = getAdminStats();
    await sendMessage(chatId,
      `🔐 <b>TRewards Admin Panel</b>\n\n` +
      `👥 Total users: <b>${stats.users}</b>\n` +
      `📊 Total transactions: <b>${stats.transactions}</b>\n` +
      `⏳ Pending withdrawals: <b>${stats.pendingWd}</b> (${stats.pendingTon} TON)\n` +
      `✅ Active tasks: <b>${stats.activeTasks}</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Create Promo Code', callback_data: 'admin_create_promo' }],
            [{ text: '📋 List Promo Codes', callback_data: 'admin_list_promos' }],
            [{ text: '🗑 Delete Promo Code', callback_data: 'admin_delete_promo' }],
            [{ text: '📊 Activation History', callback_data: 'admin_promo_history' }],
            [{ text: '💰 Pending Withdrawals', callback_data: 'admin_withdrawals' }],
            [{ text: '👥 Total Users', callback_data: 'admin_total_users' }],
          ]
        }
      }
    );
    return;
  }

  // ─ /balance (quick check) ─
  if (text === '/balance') {
    const user = getUser(userId);
    if (!user) { await sendMessage(chatId, '❌ User not found. Send /start first.'); return; }
    await sendMessage(chatId,
      `💰 <b>Your Balance</b>\n\n` +
      `TR Coins: <b>${user.balance.toLocaleString()}</b>\n` +
      `TON: <b>${(user.balance * 0.0000004).toFixed(8)}</b>\n` +
      `Spins: <b>${user.spins}</b>\n` +
      `Streak: <b>${user.streak} days</b>`
    );
    return;
  }

  // ─ /help ─
  if (text === '/help') {
    await sendMessage(chatId,
      `ℹ️ <b>TRewards Commands</b>\n\n` +
      `/start - Open TRewards app\n` +
      `/balance - Check your balance\n` +
      `/help - Show this message\n\n` +
      `Tap the button below to open the full app 👇`,
      { reply_markup: { inline_keyboard: [[{ text: '🚀 Open TRewards', web_app: { url: WEBAPP_URL } }]] } }
    );
    return;
  }
}

// ─── Callback query handler ──────────────────────────────
async function handleCallback(callback) {
  const userId = String(callback.from.id);
  const chatId = callback.message.chat.id;
  const data = callback.data;

  await answerCallbackQuery(callback.id);

  if (userId !== ADMIN_ID) return;

  if (data === 'admin_total_users') {
    const stats = getAdminStats();
    await sendMessage(chatId,
      `👥 <b>User Statistics</b>\n\n` +
      `Total: <b>${stats.users}</b>\n` +
      `New today: <b>${stats.newToday}</b>\n` +
      `New this week: <b>${stats.newWeek}</b>`
    );
  }

  else if (data === 'admin_list_promos') {
    const promos = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20').all();
    if (!promos.length) { await sendMessage(chatId, '📭 No promo codes found.'); return; }
    const list = promos.map(p =>
      `• <code>${p.code}</code>: <b>${p.reward} TR</b> | ${p.current_uses}/${p.max_uses} uses | ${p.active ? '✅' : '❌'}`
    ).join('\n');
    await sendMessage(chatId, `📋 <b>Promo Codes:</b>\n\n${list}`);
  }

  else if (data === 'admin_promo_history') {
    const recent = db.prepare(`
      SELECT pa.*, pc.code, pc.reward, u.first_name 
      FROM promo_activations pa 
      JOIN promo_codes pc ON pc.id=pa.code_id
      JOIN users u ON u.telegram_id=pa.user_id
      ORDER BY pa.activated_at DESC LIMIT 20
    `).all();
    if (!recent.length) { await sendMessage(chatId, '📭 No activations yet.'); return; }
    const list = recent.map(a =>
      `• ${a.first_name} used <code>${a.code}</code> (+${a.reward} TR) - ${a.activated_at.split('T')[0]}`
    ).join('\n');
    await sendMessage(chatId, `📊 <b>Recent Activations:</b>\n\n${list}`);
  }

  else if (data === 'admin_withdrawals') {
    const pending = db.prepare(`
      SELECT w.*, u.first_name, u.username 
      FROM withdrawals w JOIN users u ON u.telegram_id=w.user_id 
      WHERE w.status='pending' ORDER BY w.created_at ASC LIMIT 15
    `).all();
    if (!pending.length) { await sendMessage(chatId, '✅ No pending withdrawals.'); return; }
    const list = pending.map(w =>
      `• User: ${w.first_name} (@${w.username||'-'})\n  ${w.coins.toLocaleString()} TR → ${w.net_amount} TON\n  ID: #${w.id}`
    ).join('\n\n');
    await sendMessage(chatId, `💰 <b>Pending Withdrawals (${pending.length}):</b>\n\n${list}`);
  }

  else if (data === 'admin_create_promo') {
    sessions.set(userId, { step: 'promo_name' });
    await sendMessage(chatId,
      '➕ <b>Create Promo Code</b>\n\nStep 1/3: Enter the promo code name\n<i>(e.g. WELCOME2025, SUMMER50)</i>'
    );
  }

  else if (data === 'admin_delete_promo') {
    sessions.set(userId, { step: 'delete_promo' });
    await sendMessage(chatId, '🗑 Enter the promo code to deactivate:');
  }
}

// ─── Admin wizard ────────────────────────────────────────
async function handleAdminSession(userId, chatId, text) {
  const session = sessions.get(userId);
  if (!session) return;

  if (session.step === 'promo_name') {
    const code = text.toUpperCase().trim().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
    if (!code || code.length < 3) {
      await sendMessage(chatId, '❌ Invalid code name. Use letters, numbers, underscores. Min 3 chars:');
      return;
    }
    session.code = code;
    session.step = 'promo_reward';
    sessions.set(userId, session);
    await sendMessage(chatId,
      `Code: <code>${code}</code>\n\nStep 2/3: Enter reward amount (TR coins):\n<i>(e.g. 100, 500, 1000)</i>`
    );
  }

  else if (session.step === 'promo_reward') {
    const reward = parseInt(text);
    if (isNaN(reward) || reward <= 0 || reward > 1000000) {
      await sendMessage(chatId, '❌ Invalid amount. Enter a number between 1 and 1,000,000:');
      return;
    }
    session.reward = reward;
    session.step = 'promo_max_uses';
    sessions.set(userId, session);
    await sendMessage(chatId,
      `Reward: <b>${reward} TR</b>\n\nStep 3/3: Enter maximum activations:\n<i>(e.g. 100, 500, 10000)</i>`
    );
  }

  else if (session.step === 'promo_max_uses') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses) || maxUses <= 0 || maxUses > 1000000) {
      await sendMessage(chatId, '❌ Invalid number. Enter between 1 and 1,000,000:');
      return;
    }
    try {
      db.prepare('INSERT INTO promo_codes (code, reward, max_uses) VALUES (?,?,?)')
        .run(session.code, session.reward, maxUses);
      sessions.delete(userId);
      await sendMessage(chatId,
        `✅ <b>Promo Code Created!</b>\n\n` +
        `Code: <code>${session.code}</code>\n` +
        `Reward: <b>${session.reward} TR</b>\n` +
        `Max uses: <b>${maxUses}</b>\n\n` +
        `Share this code with your users!`
      );
    } catch (e) {
      sessions.delete(userId);
      await sendMessage(chatId, `❌ Error: Code <code>${session.code}</code> already exists.`);
    }
  }

  else if (session.step === 'delete_promo') {
    const code = text.toUpperCase().trim();
    const result = db.prepare('UPDATE promo_codes SET active=0 WHERE code=?').run(code);
    sessions.delete(userId);
    if (result.changes > 0) {
      await sendMessage(chatId, `✅ Promo code <code>${code}</code> has been deactivated.`);
    } else {
      await sendMessage(chatId, `❌ Code <code>${code}</code> not found.`);
    }
  }
}

// ─── Admin stats helper ──────────────────────────────────
function getAdminStats() {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const transactions = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
  const pendingWd = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(net_amount),0) as total FROM withdrawals WHERE status='pending'").get();
  const activeTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='active'").get().c;
  const newToday = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at)=date('now')").get().c;
  const newWeek = db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at >= datetime('now','-7 days')").get().c;
  return { users, transactions, pendingWd: pendingWd.c, pendingTon: pendingWd.total.toFixed(4), activeTasks, newToday, newWeek };
}

// ─── Webhook server ──────────────────────────────────────
function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200); res.end('TRewards Bot OK');
      return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        if (update.message) await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
      } catch (e) {
        console.error('Error processing update:', e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.listen(PORT, () => {
    console.log(`🤖 Bot webhook server running on port ${PORT}`);
  });
}

// ─── Register webhook with Telegram ─────────────────────
async function registerWebhook() {
  if (!WEBHOOK_URL) {
    console.log('⚠️  WEBHOOK_URL not set. Skipping webhook registration.');
    console.log('   Set WEBHOOK_URL in .env to register webhook automatically.');
    return;
  }
  try {
    const result = await tgRequest('setWebhook', {
      url: `${WEBHOOK_URL}/bot-webhook`,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    if (result.ok) {
      console.log(`✅ Webhook registered: ${WEBHOOK_URL}/bot-webhook`);
    } else {
      console.error('❌ Webhook registration failed:', result.description);
    }
  } catch (e) {
    console.error('❌ Error registering webhook:', e.message);
  }
}

// ─── Main ────────────────────────────────────────────────
console.log('\n🤖 TRewards Bot starting...');
console.log(`📊 DB: ${DB_PATH}`);
console.log(`🔑 Admin ID: ${ADMIN_ID || 'NOT SET'}`);
console.log(`🌐 WebApp URL: ${WEBAPP_URL}\n`);

registerWebhook();
startWebhookServer();

module.exports = { handleMessage, handleCallback };