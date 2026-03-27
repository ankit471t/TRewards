/**
 * TRewards Telegram Bot — AWS Lambda handler
 *
 * Bot username : @treward_ton_bot
 * Channel      : @treward_ton
 *
 * Required env vars:
 *   BOT_TOKEN, DATABASE_URL, FRONTEND_URL,
 *   BOT_USERNAME, ADMIN_IDS, WEBHOOK_SECRET_TOKEN (optional)
 */

const { Pool } = require('pg');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'treward_ton_bot';   // @treward_ton_bot
const CHANNEL      = process.env.CHANNEL_USERNAME || 'treward_ton';    // @treward_ton
const API_URL      = process.env.API_URL || 'https://trewards-api.onrender.com';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

// ─── DB pool ──────────────────────────────────────────────────────────────────
let db;
function getDb() {
  if (!db) db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  return db;
}

// ─── Admin in-memory sessions ─────────────────────────────────────────────────
const adminSessions = {};

// ─── Telegram API helper ──────────────────────────────────────────────────────
async function tgApi(method, body) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isAdmin(uid) { return ADMIN_IDS.includes(uid); }

function currentWeekId() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((d - jan1) / 86400000);
  return `${d.getFullYear()}-W${String(Math.ceil((dayOfYear + 1) / 7)).padStart(2, '0')}`;
}

async function getOrCreateUser(tgUser, referrerId = null) {
  const pool = getDb();
  const { id, username, first_name, last_name } = tgUser;
  const safeRef = referrerId && referrerId !== id ? referrerId : null;
  let validRef = null;
  if (safeRef) {
    const r = await pool.query('SELECT id FROM users WHERE id = $1', [safeRef]);
    if (r.rows.length > 0) validRef = safeRef;
  }
  const result = await pool.query(`
    INSERT INTO users (id, username, first_name, last_name, referrer_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name
    RETURNING *
  `, [id, username || null, first_name || '', last_name || '', validRef]);
  const user = result.rows[0];
  if (validRef && user.referrer_id === validRef) {
    const wid = currentWeekId();
    await pool.query(`
      INSERT INTO weekly_referral_stats (referrer_id, week_id, friend_count) VALUES ($1, $2, 1)
      ON CONFLICT (referrer_id, week_id)
      DO UPDATE SET friend_count = weekly_referral_stats.friend_count + 1, updated_at = NOW()
    `, [validRef, wid]);
  }
  return user;
}

function welcomeMsg(tgUser, lang) {
  const name = tgUser.first_name || tgUser.username || 'Explorer';
  if (lang === 'ru') {
    return `🏆 Добро пожаловать в *TRewards*, ${name}!\n\n` +
      `💰 Зарабатывайте TR монеты и конвертируйте в TON!\n\n` +
      `📢 Наш канал: @${CHANNEL}\n\nНажмите кнопку ниже:`;
  }
  return `🏆 Welcome to *TRewards*, ${name}!\n\n` +
    `💰 Earn TR coins & convert to TON crypto!\n\n` +
    `📢 Our channel: @${CHANNEL}\n\nTap below to get started:`;
}

// ─── /start ───────────────────────────────────────────────────────────────────
async function handleStart(msg, param) {
  const chatId = msg.chat.id;
  const tgUser = msg.from;

  // Check deep-link: c_<checkId>
  if (param && param.startsWith('c_')) {
    const checkId = param.slice(2);
    const user = await getOrCreateUser(tgUser, null);
    const lang = user.language || 'en';
    const checkUrl = `${FRONTEND_URL}?check=${encodeURIComponent(checkId)}`;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: lang === 'ru'
        ? `💎 Вам отправили TON чек! Откройте приложение, чтобы получить его.`
        : `💎 You have a TON check waiting! Open the app to claim it.`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: lang === 'ru' ? '💰 Получить чек' : '💰 Claim Check', web_app: { url: checkUrl } }
      ]]}
    });
    return;
  }

  const referrerId = (param && /^\d+$/.test(param)) ? parseInt(param) : null;
  const user = await getOrCreateUser(tgUser, referrerId);
  const lang = user.language || 'en';

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: welcomeMsg(tgUser, lang),
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: lang === 'ru' ? '🚀 Открыть TRewards' : '🚀 Open TRewards', web_app: { url: FRONTEND_URL } }
    ]]}
  });
}

// ─── Admin panel ──────────────────────────────────────────────────────────────
async function sendAdminPanel(chatId) {
  const pool = getDb();
  const s = (await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users)                                           AS total_users,
      (SELECT COALESCE(SUM(amount_ton),0) FROM payments WHERE status='paid') AS total_revenue,
      (SELECT COUNT(*) FROM withdrawals WHERE status='pending')              AS pending_withdrawals,
      (SELECT COUNT(*) FROM tasks WHERE status='active')                     AS active_tasks
  `)).rows[0];

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `👑 *TRewards Admin Panel*\n\n` +
      `👥 Users: ${s.total_users}\n` +
      `💰 Revenue: ${parseFloat(s.total_revenue).toFixed(4)} TON\n` +
      `⏳ Pending withdrawals: ${s.pending_withdrawals}\n` +
      `📋 Active tasks: ${s.active_tasks}`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [
      [{ text: '➕ Create Promo',   callback_data: 'admin_create_promo' },
       { text: '📋 List Promos',    callback_data: 'admin_list_promos'  }],
      [{ text: '🗑 Delete Promo',   callback_data: 'admin_delete_promo' },
       { text: '📜 Activations',    callback_data: 'admin_activations'  }],
      [{ text: '💸 Payments',       callback_data: 'admin_payments'     },
       { text: '👥 User Stats',     callback_data: 'admin_users'        }],
      [{ text: '⏳ Withdrawals',    callback_data: 'admin_withdrawals'  }],
      [{ text: '📣 Send Broadcast', callback_data: 'admin_broadcast'    }],
    ]}
  });
}

// ─── Callback handler ─────────────────────────────────────────────────────────
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;
  const pool   = getDb();

  await tgApi('answerCallbackQuery', { callback_query_id: query.id });

  if (!isAdmin(userId)) {
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Access denied.' });
    return;
  }

  if (data === 'admin_create_promo') {
    adminSessions[userId] = { step: 'promo_name', data: {} };
    await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown',
      text: '📝 *Create Promo Code*\n\nStep 1/4: Enter the promo code (e.g. LAUNCH2025):' });
    return;
  }
  if (data === 'admin_list_promos') {
    const rows = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20');
    if (!rows.rows.length) { await tgApi('sendMessage', { chat_id: chatId, text: 'No promo codes.' }); return; }
    let text = '📋 *Promo Codes:*\n\n';
    rows.rows.forEach(p => { text += `${p.is_active ? '✅' : '❌'} \`${p.code}\` — ${p.reward_type} · ${p.reward_amount} · ${p.current_activations}/${p.max_activations}\n`; });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    return;
  }
  if (data === 'admin_delete_promo') {
    adminSessions[userId] = { step: 'delete_promo', data: {} };
    await tgApi('sendMessage', { chat_id: chatId, text: '🗑 Enter the promo code to deactivate:' });
    return;
  }
  if (data === 'admin_activations') {
    const rows = await pool.query(`
      SELECT pa.activated_at, pa.user_id, pc.code FROM promo_activations pa
      JOIN promo_codes pc ON pa.promo_id = pc.id ORDER BY pa.activated_at DESC LIMIT 20`);
    if (!rows.rows.length) { await tgApi('sendMessage', { chat_id: chatId, text: 'No activations yet.' }); return; }
    let text = '📜 *Recent Activations:*\n\n';
    rows.rows.forEach(a => { text += `• ${a.user_id} → \`${a.code}\` · ${new Date(a.activated_at).toLocaleDateString()}\n`; });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    return;
  }
  if (data === 'admin_payments') {
    const rows = await pool.query(`
      SELECT p.amount_ton, p.provider, p.paid_at, u.username, u.first_name FROM payments p
      JOIN users u ON p.user_id = u.id WHERE p.status='paid' ORDER BY p.paid_at DESC LIMIT 20`);
    if (!rows.rows.length) { await tgApi('sendMessage', { chat_id: chatId, text: 'No payments yet.' }); return; }
    let text = '💸 *Payments:*\n\n';
    rows.rows.forEach(p => { text += `• ${p.username ? '@'+p.username : p.first_name}: ${p.amount_ton} TON via ${p.provider}\n`; });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    return;
  }
  if (data === 'admin_users') {
    const r = (await pool.query(`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours') AS today,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')   AS week,
        COALESCE(SUM(coins),0) AS coins FROM users`)).rows[0];
    await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown',
      text: `👥 *Users:*\nTotal: ${r.total}\nToday: ${r.today}\nThis week: ${r.week}\nTotal TR: ${parseInt(r.coins).toLocaleString()}` });
    return;
  }
  if (data === 'admin_withdrawals') {
    const rows = await pool.query(`
      SELECT w.id, w.net_ton, w.wallet_address, w.created_at, u.username, u.first_name FROM withdrawals w
      JOIN users u ON w.user_id = u.id WHERE w.status='pending' ORDER BY w.created_at ASC LIMIT 20`);
    if (!rows.rows.length) { await tgApi('sendMessage', { chat_id: chatId, text: '✅ No pending withdrawals!' }); return; }
    let text = '⏳ *Pending Withdrawals:*\n\n';
    rows.rows.forEach(w => { text += `#${w.id} ${w.username ? '@'+w.username : w.first_name}: ${parseFloat(w.net_ton).toFixed(4)} TON → \`${w.wallet_address}\`\n`; });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    return;
  }

  // ── NEW: Broadcast ──────────────────────────────────────────────────────────
  if (data === 'admin_broadcast') {
    adminSessions[userId] = { step: 'broadcast_message', data: {} };
    await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown',
      text: '📣 *Send Broadcast*\n\nStep 1/3: Type the message text (HTML tags supported, e.g. <b>bold</b>):\n\n_Send /cancel to abort._' });
    return;
  }

  // Promo type inline buttons
  if (data === 'promo_type_coins' || data === 'promo_type_ton') {
    const session = adminSessions[userId];
    if (session && session.step === 'promo_reward_type') {
      session.data.reward_type = data === 'promo_type_coins' ? 'coins' : 'ton';
      session.step = 'promo_amount';
      await tgApi('sendMessage', { chat_id: chatId,
        text: `Step 3/4: Enter reward amount (${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'}):` });
    }
    return;
  }

  // Broadcast confirm inline buttons
  if (data === 'broadcast_confirm') {
    const session = adminSessions[userId];
    if (!session || session.step !== 'broadcast_confirm') return;
    delete adminSessions[userId];

    const { message, button_text, button_url } = session.data;

    // Call backend broadcast API
    const https = require('https');
    const payload = JSON.stringify({ message, parse_mode: 'HTML', button_text: button_text || null, button_url: button_url || null });

    // We call our own backend with a simple internal token approach (reuse first admin's fake initData)
    // Simpler: call the Telegram API loop directly from here for small user bases
    const pool = getDb();
    const users = await pool.query('SELECT id FROM users ORDER BY id');
    const total = users.rows.length;

    await tgApi('sendMessage', { chat_id: chatId,
      text: `📤 Sending to ${total} users... (this runs in background)` });

    // Fire and forget — don't await the loop
    sendBroadcastFromBot(users.rows.map(r => r.id), message, button_text, button_url);
    return;
  }
  if (data === 'broadcast_cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Broadcast cancelled.' });
    return;
  }
}

// ─── Bot-side broadcast sender ────────────────────────────────────────────────
async function sendBroadcastFromBot(userIds, message, buttonText, buttonUrl) {
  const BATCH = 30;
  const DELAY = 1000; // ms
  let sent = 0, failed = 0;

  for (let i = 0; i < userIds.length; i += BATCH) {
    const batch = userIds.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async uid => {
      const body = { chat_id: uid, text: message, parse_mode: 'HTML' };
      if (buttonText && buttonUrl) {
        body.reply_markup = JSON.stringify({ inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] });
      }
      try {
        const r = await tgApi('sendMessage', body);
        if (r.ok) sent++; else failed++;
      } catch { failed++; }
    }));
    if (i + BATCH < userIds.length) await new Promise(r => setTimeout(r, DELAY));
  }
  console.log(`Broadcast done: sent=${sent}, failed=${failed}`);
}

// ─── Admin wizard message handler ─────────────────────────────────────────────
async function handleAdminWizard(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text || '';
  const pool   = getDb();
  const session = adminSessions[userId];
  if (!session) return false;

  // Cancel
  if (text === '/cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Cancelled.' });
    return true;
  }

  // ── Promo wizard ────────────────────────────────────────────────────────────
  if (session.step === 'promo_name') {
    if (!/^[A-Z0-9_]{3,30}$/i.test(text)) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ 3–30 alphanumeric characters. Try again:' });
      return true;
    }
    session.data.code = text.toUpperCase();
    session.step = 'promo_reward_type';
    await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown',
      text: `Step 2/4: Select reward type for \`${session.data.code}\`:`,
      reply_markup: { inline_keyboard: [[
        { text: '🪙 TR Coins', callback_data: 'promo_type_coins' },
        { text: '💎 TON',      callback_data: 'promo_type_ton'   }
      ]]}
    });
    return true;
  }
  if (session.step === 'promo_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ Enter a positive number:' });
      return true;
    }
    session.data.amount = amount;
    session.step = 'promo_max_activations';
    await tgApi('sendMessage', { chat_id: chatId, text: 'Step 4/4: Enter max number of activations:' });
    return true;
  }
  if (session.step === 'promo_max_activations') {
    const max = parseInt(text);
    if (isNaN(max) || max <= 0) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ Enter a positive integer:' });
      return true;
    }
    await pool.query(
      'INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by) VALUES ($1,$2,$3,$4,$5)',
      [session.data.code, session.data.reward_type, session.data.amount, max, userId]
    );
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown',
      text: `✅ Promo *${session.data.code}* created!\n${session.data.amount} ${session.data.reward_type === 'coins' ? 'TR' : 'TON'} · max ${max} uses` });
    return true;
  }
  if (session.step === 'delete_promo') {
    const code = (text || '').toUpperCase().trim();
    const r = await pool.query("UPDATE promo_codes SET is_active=FALSE WHERE UPPER(code)=$1 RETURNING code", [code]);
    delete adminSessions[userId];
    if (!r.rows.length) await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown', text: `❌ Code \`${code}\` not found.` });
    else await tgApi('sendMessage', { chat_id: chatId, parse_mode: 'Markdown', text: `✅ \`${code}\` deactivated.` });
    return true;
  }

  // ── Broadcast wizard ────────────────────────────────────────────────────────
  if (session.step === 'broadcast_message') {
    session.data.message = text;
    session.step = 'broadcast_button';
    await tgApi('sendMessage', { chat_id: chatId,
      text: 'Step 2/3: Send an inline button label (e.g. "Open App") or type /skip to skip:' });
    return true;
  }
  if (session.step === 'broadcast_button') {
    if (text !== '/skip') {
      session.data.button_text = text;
      session.step = 'broadcast_button_url';
      await tgApi('sendMessage', { chat_id: chatId, text: 'Step 3/3: Now send the button URL (https://...):' });
    } else {
      session.step = 'broadcast_confirm';
      await _askBroadcastConfirm(chatId, session);
    }
    return true;
  }
  if (session.step === 'broadcast_button_url') {
    if (!text.startsWith('http')) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ URL must start with https://. Try again:' });
      return true;
    }
    session.data.button_url = text;
    session.step = 'broadcast_confirm';
    await _askBroadcastConfirm(chatId, session);
    return true;
  }

  return false;
}

async function _askBroadcastConfirm(chatId, session) {
  const pool = getDb();
  const total = (await pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n;
  const preview = session.data.message.length > 120
    ? session.data.message.slice(0, 120) + '...'
    : session.data.message;
  const btnInfo = session.data.button_text
    ? `\n🔗 Button: ${session.data.button_text} → ${session.data.button_url}`
    : '';
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `📣 *Broadcast Preview*\n\n${preview}${btnInfo}\n\n⚠️ This will send to *${total} users*. Confirm?`,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Send Now',  callback_data: 'broadcast_confirm' },
      { text: '❌ Cancel',   callback_data: 'broadcast_cancel'  }
    ]]}
  });
}

// ─── Lambda handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    const secret = process.env.WEBHOOK_SECRET_TOKEN;
    if (secret) {
      const provided = (event.headers || {})['x-telegram-bot-api-secret-token'];
      if (provided !== secret) return { statusCode: 403, body: 'Forbidden' };
    }

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (!body) return { statusCode: 200, body: 'ok' };

    if (body.message) {
      const msg = body.message;
      const text = msg.text || '';
      const uid = msg.from?.id;

      const startMatch = text.match(/^\/start(?:\s+(.+))?/);
      if (startMatch) { await handleStart(msg, startMatch[1] || null); return { statusCode: 200, body: 'ok' }; }

      if (text === '/amiadminyes') {
        if (isAdmin(uid)) await sendAdminPanel(msg.chat.id);
        else await tgApi('sendMessage', { chat_id: msg.chat.id, text: '❌ Access denied.' });
        return { statusCode: 200, body: 'ok' };
      }

      if (isAdmin(uid) && !text.startsWith('/')) {
        await handleAdminWizard(msg);
      }
    }

    if (body.callback_query) {
      await handleCallback(body.callback_query);
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Lambda error:', err);
    return { statusCode: 200, body: 'ok' };
  }
};

// ─── Local polling (dev) ─────────────────────────────────────────────────────
if (require.main === module) {
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.on('message', async msg => {
    const text = msg.text || '';
    const uid = msg.from?.id;
    const startMatch = text.match(/^\/start(?:\s+(.+))?/);
    if (startMatch) { await handleStart(msg, startMatch[1] || null); return; }
    if (text === '/amiadminyes') {
      if (isAdmin(uid)) await sendAdminPanel(msg.chat.id);
      else await tgApi('sendMessage', { chat_id: msg.chat.id, text: '❌ Access denied.' });
      return;
    }
    if (isAdmin(uid) && !text.startsWith('/')) await handleAdminWizard(msg);
  });
  bot.on('callback_query', handleCallback);
  bot.on('polling_error', err => console.error('Polling error:', err.message));
  console.log('✅ @treward_ton_bot running in polling mode');
}