// TRewards Bot — AWS Lambda (ES Module)
// Handles: /start, /stars, Stars payments, broadcast only

const BOT_TOKEN    = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards.onrender.com';
const CHANNEL      = process.env.CHANNEL_USERNAME || 'treward_ton';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_URL      = process.env.API_URL || 'https://trewards-api.onrender.com';
const STARS_PER_TON = 65;
const MIN_STARS     = 50;

// In-memory admin wizard sessions (broadcast only)
const adminSessions = {};

function isAdmin(uid) { return ADMIN_IDS.includes(uid); }

// ─── Telegram API helper ──────────────────────────────────────────────────────
async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Supabase REST helper ─────────────────────────────────────────────────────
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return [];
  return res.json();
}

// ─── Upsert user ──────────────────────────────────────────────────────────────
async function getOrCreateUser(tgUser, referrerId = null) {
  const { id, username, first_name, last_name } = tgUser;
  const safeRef = referrerId && referrerId !== id ? referrerId : null;
  let validRef = null;
  if (safeRef) {
    const r = await sb(`users?id=eq.${safeRef}&select=id`);
    if (Array.isArray(r) && r.length > 0) validRef = safeRef;
  }

  let commentId = String(Math.floor(100000 + Math.random() * 900000));
  let attempt = 0;
  while (attempt < 5) {
    const existing = await sb(`users?ton_comment_id=eq.${commentId}&select=id`);
    if (!Array.isArray(existing) || existing.length === 0) break;
    commentId = String(Math.floor(100000 + Math.random() * 900000));
    attempt++;
  }

  const rows = await sb('users', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      id,
      username: username || null,
      first_name: first_name || '',
      last_name: last_name || '',
      ton_comment_id: commentId,
      ...(validRef ? { referrer_id: validRef } : {}),
    }),
  });

  const user = Array.isArray(rows) ? rows[0] : rows;

  if (validRef && user && !user.referrer_id) {
    const weekId = getCurrentWeekId();
    await sb('weekly_referral_stats', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ referrer_id: validRef, week_id: weekId, friend_count: 1 }),
    });
  }

  return user;
}

function getCurrentWeekId() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((d - jan1) / 86400000);
  const weekNum = Math.ceil((dayOfYear + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ─── /start ───────────────────────────────────────────────────────────────────
async function handleStart(msg, param) {
  const chatId    = msg.chat.id;
  const tgUser    = msg.from;
  const firstName = tgUser.first_name || tgUser.username || 'User';

  // Deep-link: c_<checkId> — open app to claim check
  if (param && param.startsWith('c_')) {
    const checkId = param.slice(2);
    // Register user first (so they become referral of check creator)
    await getOrCreateUser(tgUser, null).catch(e => console.error('upsert error:', e));
    
    const appUrl = `${FRONTEND_URL}?tgWebAppStartParam=${encodeURIComponent(param)}`;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `💎 You have a <b>TON check</b> waiting!\n\nOpen the app to claim it instantly.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '💰 Claim Check Now', web_app: { url: FRONTEND_URL } }
        ]]
      }
    });
    return;
  }

  const referrerId = (param && /^\d+$/.test(param)) ? parseInt(param) : null;
  await getOrCreateUser(tgUser, referrerId).catch(e => console.error('upsert error:', e));

  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `👋 Welcome <b>${firstName}</b> to <b>TRewards</b>!\n\n` +
      `🏆 Complete tasks & earn <b>TR coins</b>\n` +
      `💰 Convert TR → <b>TON crypto</b> & withdraw\n` +
      `🎰 Spin the wheel for bonus coins\n` +
      `👥 Invite friends & earn <b>30% commission</b>\n\n` +
      `Tap below to open the app 👇`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '🚀 Open TRewards App', web_app: { url: FRONTEND_URL } }
      ]]
    }
  });
}

// ─── Telegram Stars payment flow ──────────────────────────────────────────────
async function handleStarsCommand(msg) {
  const chatId = msg.chat.id;

  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `⭐ <b>Top Up with Telegram Stars</b>\n\n` +
      `💱 Rate: <b>65 Stars = 1 TON</b>\n` +
      `🔔 Minimum: <b>50 Stars</b>\n\n` +
      `Choose an amount:`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⭐ 65 Stars (1 TON)',   callback_data: 'stars_65'  },
          { text: '⭐ 130 Stars (2 TON)',  callback_data: 'stars_130' },
        ],
        [
          { text: '⭐ 325 Stars (5 TON)',  callback_data: 'stars_325' },
          { text: '⭐ 650 Stars (10 TON)', callback_data: 'stars_650' },
        ],
        [{ text: '🔢 Custom amount', callback_data: 'stars_custom' }],
      ]
    }
  });
}

async function sendStarsInvoice(chatId, starsAmount) {
  const tonAmount = (starsAmount / STARS_PER_TON).toFixed(4);
  await tgApi('sendInvoice', {
    chat_id: chatId,
    title: 'TRewards TON Top-Up',
    description: `Top up ${tonAmount} TON to your TRewards balance. Rate: 65 Stars = 1 TON.`,
    payload: JSON.stringify({ type: 'ton_topup', stars: starsAmount }),
    currency: 'XTR',
    prices: [{ label: `${tonAmount} TON (${starsAmount} Stars)`, amount: starsAmount }],
  });
}

// ─── Stars pre-checkout answer ────────────────────────────────────────────────
async function handlePreCheckout(query) {
  await tgApi('answerPreCheckoutQuery', {
    pre_checkout_query_id: query.id,
    ok: true,
  });
}

// ─── Stars successful_payment ─────────────────────────────────────────────────
async function handleSuccessfulPayment(msg) {
  const userId  = msg.from.id;
  const payment = msg.successful_payment;
  if (!payment || payment.currency !== 'XTR') return;

  const chargeId    = payment.telegram_payment_charge_id;
  const starsAmount = payment.total_amount;
  const tonAmount   = (starsAmount / STARS_PER_TON).toFixed(4);

  try {
    const existing = await sb(`stars_payments?telegram_charge_id=eq.${chargeId}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      await tgApi('sendMessage', {
        chat_id: msg.chat.id,
        text: `✅ Already credited ${tonAmount} TON to your account.`,
        parse_mode: 'HTML',
      });
      return;
    }

    const user = await sb(`users?id=eq.${userId}&select=ton_balance`);
    if (Array.isArray(user) && user.length > 0) {
      const newBal = parseFloat(user[0].ton_balance || 0) + parseFloat(tonAmount);
      await Promise.all([
        sb(`users?id=eq.${userId}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: JSON.stringify({ ton_balance: newBal }),
        }),
        sb('stars_payments', {
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify({
            user_id: userId,
            telegram_charge_id: chargeId,
            stars_amount: starsAmount,
            ton_credited: parseFloat(tonAmount),
          }),
        }),
        sb('transactions', {
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify({
            user_id: userId,
            type: 'topup_stars',
            description: `Stars top-up: ${starsAmount} ⭐`,
            ton_amount: parseFloat(tonAmount),
          }),
        }),
      ]);
    }

    await tgApi('sendMessage', {
      chat_id: msg.chat.id,
      text:
        `✅ <b>Payment successful!</b>\n\n` +
        `⭐ ${starsAmount} Stars → <b>${tonAmount} TON</b> credited to your account.\n\n` +
        `Open TRewards to use your balance:`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🚀 Open TRewards', web_app: { url: FRONTEND_URL } }
        ]]
      }
    });
  } catch (e) {
    console.error('Stars payment error:', e);
    await tgApi('sendMessage', {
      chat_id: msg.chat.id,
      text: '⚠️ Payment received but crediting failed. Contact support with your receipt.'
    });
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────
async function sendBroadcastFromBot(userIds, message, buttonText, buttonUrl) {
  let sent = 0, failed = 0;
  for (let i = 0; i < userIds.length; i += 30) {
    const batch = userIds.slice(i, i + 30);
    await Promise.allSettled(batch.map(async uid => {
      const body = { chat_id: uid, text: message, parse_mode: 'HTML' };
      if (buttonText && buttonUrl) {
        body.reply_markup = { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] };
      }
      const r = await tgApi('sendMessage', body);
      r.ok ? sent++ : failed++;
    }));
    if (i + 30 < userIds.length) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Broadcast done: sent=${sent}, failed=${failed}`);
}

// ─── Admin wizard (broadcast only) ────────────────────────────────────────────
async function handleAdminWizard(msg) {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const text    = msg.text || '';
  const session = adminSessions[userId];
  if (!session) return false;

  if (text === '/cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Cancelled.' });
    return true;
  }

  // Stars custom amount (non-admin too)
  if (session.step === 'stars_custom_amount') {
    const stars = parseInt(text);
    if (isNaN(stars) || stars < MIN_STARS) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ Minimum ${MIN_STARS} Stars. Try again:` });
      return true;
    }
    delete adminSessions[userId];
    await sendStarsInvoice(chatId, stars);
    return true;
  }

  // Broadcast wizard
  if (session.step === 'broadcast_message') {
    session.data.message = text;
    session.step = 'broadcast_button';
    await tgApi('sendMessage', { chat_id: chatId, text: 'Button label (or /skip):' });
    return true;
  }
  if (session.step === 'broadcast_button') {
    if (text !== '/skip') {
      session.data.button_text = text;
      session.step = 'broadcast_button_url';
      await tgApi('sendMessage', { chat_id: chatId, text: 'Button URL (https://...):' });
    } else {
      session.step = 'broadcast_confirm';
      await askBroadcastConfirm(chatId, session);
    }
    return true;
  }
  if (session.step === 'broadcast_button_url') {
    if (!text.startsWith('http')) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ Must start with https://. Try again:' });
      return true;
    }
    session.data.button_url = text;
    session.step = 'broadcast_confirm';
    await askBroadcastConfirm(chatId, session);
    return true;
  }

  return false;
}

async function askBroadcastConfirm(chatId, session) {
  const users   = await sb('users?select=id');
  const total   = Array.isArray(users) ? users.length : 0;
  const preview = session.data.message.length > 150
    ? session.data.message.slice(0, 150) + '...'
    : session.data.message;
  const btnInfo = session.data.button_text
    ? `\n🔗 ${session.data.button_text} → ${session.data.button_url || 'N/A'}`
    : '';
  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `<b>📣 Broadcast Preview</b>\n\n${preview}${btnInfo}\n\n` +
      `⚠️ Will send to <b>${total} users</b>. Confirm?`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Send Now', callback_data: 'broadcast_confirm' },
      { text: '❌ Cancel',  callback_data: 'broadcast_cancel'  }
    ]]}
  });
}

// ─── Callback query handler ───────────────────────────────────────────────────
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;

  await tgApi('answerCallbackQuery', { callback_query_id: query.id });

  // ── Stars payment callbacks (available to all) ─────────────────────────────
  const starsMap = { stars_65: 65, stars_130: 130, stars_325: 325, stars_650: 650 };
  if (data in starsMap) {
    await sendStarsInvoice(chatId, starsMap[data]);
    return;
  }
  if (data === 'stars_custom') {
    adminSessions[userId] = { step: 'stars_custom_amount', data: {} };
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `⭐ Enter Stars amount (minimum ${MIN_STARS}):`,
    });
    return;
  }

  // ── Broadcast confirm/cancel (admin only) ─────────────────────────────────
  if (data === 'broadcast_confirm') {
    if (!isAdmin(userId)) return;
    const session = adminSessions[userId];
    if (!session || session.step !== 'broadcast_confirm') return;
    delete adminSessions[userId];
    const { message, button_text, button_url } = session.data;
    const users = await sb('users?select=id');
    const total = Array.isArray(users) ? users.length : 0;
    await tgApi('sendMessage', { chat_id: chatId, text: `📤 Sending to ${total} users...` });
    sendBroadcastFromBot(users.map(u => u.id), message, button_text, button_url);
    return;
  }

  if (data === 'broadcast_cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Broadcast cancelled.' });
    return;
  }
}

// ─── Admin broadcast panel ────────────────────────────────────────────────────
async function sendAdminBroadcastPanel(chatId) {
  const users = await sb('users?select=id').catch(() => []);
  const total = Array.isArray(users) ? users.length : 0;
  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `👑 <b>TRewards Admin</b>\n\n👥 Total users: <b>${total}</b>\n\nUse the button below to send a broadcast:`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '📣 Send Broadcast', callback_data: 'admin_start_broadcast' }
      ]]
    }
  });
}

// ─── Main Lambda handler ──────────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    const secret = process.env.WEBHOOK_SECRET_TOKEN;
    if (secret) {
      const provided = (event.headers || {})['x-telegram-bot-api-secret-token'];
      if (provided !== secret) return { statusCode: 403, body: 'Forbidden' };
    }

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (!body) return { statusCode: 200, body: 'ok' };

    // ── pre_checkout_query ────────────────────────────────────────────────────
    if (body.pre_checkout_query) {
      await handlePreCheckout(body.pre_checkout_query);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Callback queries ──────────────────────────────────────────────────────
    if (body.callback_query) {
      const q = body.callback_query;
      const uid = q.from.id;

      // Handle broadcast_start from admin panel button
      if (q.data === 'admin_start_broadcast') {
        await tgApi('answerCallbackQuery', { callback_query_id: q.id });
        if (!isAdmin(uid)) return { statusCode: 200, body: 'ok' };
        adminSessions[uid] = { step: 'broadcast_message', data: {} };
        await tgApi('sendMessage', {
          chat_id: q.message.chat.id,
          parse_mode: 'HTML',
          text: '<b>📣 Send Broadcast</b>\n\nType your message (HTML supported):\n\n<i>/cancel to abort.</i>'
        });
        return { statusCode: 200, body: 'ok' };
      }

      await handleCallback(q);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Message handling ──────────────────────────────────────────────────────
    if (body.message) {
      const msg  = body.message;
      const text = msg.text || '';
      const uid  = msg.from?.id;

      // Stars successful payment
      if (msg.successful_payment) {
        await handleSuccessfulPayment(msg);
        return { statusCode: 200, body: 'ok' };
      }

      // /start
      const startMatch = text.match(/^\/start(?:\s+(.+))?/);
      if (startMatch) {
        await handleStart(msg, startMatch[1] || null);
        return { statusCode: 200, body: 'ok' };
      }

      // /stars — buy TON with Stars (available from bot)
      if (text === '/stars') {
        await handleStarsCommand(msg);
        return { statusCode: 200, body: 'ok' };
      }

      // /amiadminyes — admin broadcast panel only
      if (text === '/amiadminyes') {
        if (isAdmin(uid)) await sendAdminBroadcastPanel(msg.chat.id);
        else await tgApi('sendMessage', { chat_id: msg.chat.id, text: '❌ Access denied.' });
        return { statusCode: 200, body: 'ok' };
      }

      // Wizard steps (broadcast + stars custom)
      const session = adminSessions[uid];
      if (session) {
        await handleAdminWizard(msg);
        return { statusCode: 200, body: 'ok' };
      }
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Lambda error:', err);
    return { statusCode: 200, body: 'ok' };
  }
};