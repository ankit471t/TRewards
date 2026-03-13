/**
 * TRewards Telegram Bot
 * Uses node-telegram-bot-api
 */
const TelegramBot = require('node-telegram-bot-api');

const TOKEN      = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;  // e.g. https://trewards.onrender.com
const API_URL    = process.env.API_URL;     // e.g. https://trewards-api.onrender.com
const ADMIN_IDS  = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

const bot = new TelegramBot(TOKEN, { polling: true });
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

// ─── /start ────────────────────────────────────────────────────────────────
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const refId   = match[1] ? parseInt(match[1]) : null;

  // Register user via API
  try {
    await fetch(`${API_URL}/api/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        telegram_id: userId,
        username:    msg.from.username || '',
        first_name:  msg.from.first_name || '',
        last_name:   msg.from.last_name || '',
        init_data:   refId ? `start_param=${refId}` : '',
      })
    });
  } catch (e) { console.error('Register error', e.message); }

  const welcomeText = `🏆 *Welcome to TRewards!*\n\n` +
    `Earn TR coins by:\n` +
    `🎰 Spinning the wheel\n` +
    `✅ Completing tasks\n` +
    `🔥 Daily streaks\n` +
    `👥 Referring friends\n\n` +
    `💸 Withdraw earnings as TON cryptocurrency\n\n` +
    `_Press the button below to open TRewards_`;

  bot.sendMessage(chatId, welcomeText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{
        text: '🚀 Open TRewards',
        web_app: { url: WEBAPP_URL }
      }]]
    }
  });
});

// ─── /amiadminyes ──────────────────────────────────────────────────────────
bot.onText(/\/amiadminyes/, async (msg) => {
  const userId = msg.from.id;
  if (!ADMIN_IDS.includes(userId)) {
    return bot.sendMessage(msg.chat.id, '❌ Access denied');
  }

  bot.sendMessage(msg.chat.id, '👑 *Admin Panel*', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Create Promo Code', callback_data: 'admin_promo_create' }],
        [{ text: '📋 List Promo Codes',  callback_data: 'admin_promo_list' }],
        [{ text: '🗑 Delete Promo Code', callback_data: 'admin_promo_delete' }],
        [{ text: '📊 Activation History', callback_data: 'admin_activations' }],
        [{ text: '💳 Payment History',   callback_data: 'admin_payments' }],
        [{ text: '👥 Total Users',       callback_data: 'admin_users' }],
      ]
    }
  });
});

// ─── ADMIN STATE MACHINE ─────────────────────────────────────────────────
const adminSessions = {}; // userId → { step, data }

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;

  bot.answerCallbackQuery(query.id);

  if (!ADMIN_IDS.includes(userId) && data.startsWith('admin_')) {
    return bot.sendMessage(chatId, '❌ Access denied');
  }

  if (data === 'admin_promo_create') {
    adminSessions[userId] = { step: 'promo_name', data: {} };
    bot.sendMessage(chatId, '📝 Step 1/4: Enter promo code name:');
  }

  else if (data === 'admin_promo_list') {
    const promos = await adminFetch('/admin/promos');
    if (!promos.length) return bot.sendMessage(chatId, 'No promo codes.');
    const text = promos.map(p =>
      `*${p.code}* — ${p.reward_amount} ${p.reward_type} | ${p.activations}/${p.max_activations}`
    ).join('\n');
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  else if (data === 'admin_promo_delete') {
    adminSessions[userId] = { step: 'promo_delete', data: {} };
    bot.sendMessage(chatId, '🗑 Enter promo code to delete:');
  }

  else if (data === 'admin_activations') {
    const list = await adminFetch('/admin/activations');
    const text = list.slice(0, 20).map(a =>
      `${a.code} → user ${a.telegram_id} @ ${a.created_at?.slice(0,10)}`
    ).join('\n') || 'No activations';
    bot.sendMessage(chatId, `📊 *Activations:*\n\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown' });
  }

  else if (data === 'admin_payments') {
    const list = await adminFetch('/admin/payments');
    const text = list.slice(0, 20).map(p =>
      `${p.telegram_id} — ${p.amount} TON — ${p.status} — ${p.method}`
    ).join('\n') || 'No payments';
    bot.sendMessage(chatId, `💳 *Payments:*\n\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown' });
  }

  else if (data === 'admin_users') {
    const info = await adminFetch('/admin/stats');
    bot.sendMessage(chatId, `👥 *Total Users:* ${info.total_users}`, { parse_mode: 'Markdown' });
  }

  else if (data.startsWith('promo_type_')) {
    const type = data.replace('promo_type_', '');
    if (adminSessions[userId]) {
      adminSessions[userId].data.reward_type = type;
      adminSessions[userId].step = 'promo_amount';
      bot.sendMessage(chatId, `💰 Step 3/4: Enter reward amount (${type === 'coins' ? 'TR coins' : 'TON'}):`)
    }
  }
});

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text   = msg.text;

  if (!text || text.startsWith('/')) return;
  if (!adminSessions[userId]) return;

  const session = adminSessions[userId];

  if (session.step === 'promo_name') {
    session.data.code = text.trim().toUpperCase();
    session.step = 'promo_type';
    bot.sendMessage(chatId, '🎁 Step 2/4: Select reward type:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🪙 TR Coins', callback_data: 'promo_type_coins' }],
          [{ text: '💎 TON',      callback_data: 'promo_type_ton' }],
        ]
      }
    });
  }

  else if (session.step === 'promo_amount') {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Invalid amount');
    session.data.reward_amount = amount;
    session.step = 'promo_max';
    bot.sendMessage(chatId, '🔢 Step 4/4: Enter max activations:');
  }

  else if (session.step === 'promo_max') {
    const max = parseInt(text.trim());
    if (isNaN(max) || max <= 0) return bot.sendMessage(chatId, '❌ Invalid number');
    session.data.max_activations = max;

    // Create promo via API
    try {
      await fetch(`${API_URL}/admin/create-promo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_KEY || '' },
        body: JSON.stringify(session.data)
      });
      bot.sendMessage(chatId, `✅ Promo *${session.data.code}* created!\n` +
        `Reward: ${session.data.reward_amount} ${session.data.reward_type}\n` +
        `Max uses: ${session.data.max_activations}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    delete adminSessions[userId];
  }

  else if (session.step === 'promo_delete') {
    const code = text.trim().toUpperCase();
    try {
      await fetch(`${API_URL}/admin/delete-promo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': process.env.ADMIN_KEY || '' },
        body: JSON.stringify({ code })
      });
      bot.sendMessage(chatId, `✅ Promo *${code}* deleted`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    delete adminSessions[userId];
  }
});

// ─── ADMIN API HELPER ────────────────────────────────────────────────────
async function adminFetch(path) {
  const r = await fetch(`${API_URL}${path}`, {
    headers: { 'X-Admin-Key': process.env.ADMIN_KEY || '' }
  });
  return r.json();
}

console.log('TRewards bot started ✅');