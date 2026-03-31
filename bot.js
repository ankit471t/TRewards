// TRewards Bot — AWS Lambda (ES Module)
// Responds ONLY to: /start, /amiadminyes, /stars (callback), Stars payments
// Admin broadcast via /amiadminyes in Telegram bot

const BOT_TOKEN     = process.env.BOT_TOKEN;
const FRONTEND_URL  = process.env.FRONTEND_URL || 'https://trewards.onrender.com';
const ADMIN_IDS     = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const BOT_USERNAME  = process.env.BOT_USERNAME || 'treward_ton_bot';
const STARS_PER_TON = 65;
const MIN_STARS     = 50;

// In-memory admin wizard sessions (broadcast only, lives per Lambda warm instance)
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

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCurrentWeekId() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((d - jan1) / 86400000);
  const weekNum = Math.ceil((dayOfYear + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
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

  // Generate unique 6-digit comment ID
  let commentId = String(Math.floor(100000 + Math.random() * 900000));
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await sb(`users?ton_comment_id=eq.${commentId}&select=id`);
    if (!Array.isArray(existing) || existing.length === 0) break;
    commentId = String(Math.floor(100000 + Math.random() * 900000));
  }

  // Check if user already exists (to detect new vs returning)
  const existingUser = await sb(`users?id=eq.${id}&select=id,referrer_id`);
  const isNewUser = !Array.isArray(existingUser) || existingUser.length === 0;

  const rows = await sb('users', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      id,
      username: username || null,
      first_name: first_name || '',
      last_name: last_name || '',
      ton_comment_id: commentId,
      ...(validRef && isNewUser ? { referrer_id: validRef } : {}),
    }),
  });

  const user = Array.isArray(rows) ? rows[0] : rows;

  // Update weekly referral stats only for truly new users with a valid referrer
  if (isNewUser && validRef) {
    const weekId = getCurrentWeekId();
    await sb('weekly_referral_stats', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify({ referrer_id: validRef, week_id: weekId, friend_count: 1 }),
    }).catch(() => {});
  }

  return user;
}

// ─── /start handler ───────────────────────────────────────────────────────────
async function handleStart(msg, param) {
  const chatId    = msg.chat.id;
  const tgUser    = msg.from;
  const firstName = tgUser.first_name || tgUser.username || 'User';

  // Deep-link: c_<checkId> — open app to claim check
  if (param && param.startsWith('c_')) {
    // Register/upsert user WITHOUT referrer (referrer set by check claim in backend)
    await getOrCreateUser(tgUser, null).catch(e => console.error('upsert error:', e));

    // Send message with Mini App button — the frontend handles the check via start_param
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `💎 <b>You have a TON Check waiting for you!</b>\n\n` +
        `🎁 Someone sent you TON coins.\n` +
        `Open the app to claim your TON instantly!\n\n` +
        `✨ <i>New user? You'll be automatically registered.</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '💰 Claim Your TON Check Now', web_app: { url: `${FRONTEND_URL}?tgWebAppStartParam=${encodeURIComponent(param)}` } }
        ]]
      }
    });
    return;
  }

  // Normal /start — with or without referrer
  const referrerId = (param && /^\d+$/.test(param)) ? parseInt(param) : null;
  await getOrCreateUser(tgUser, referrerId).catch(e => console.error('upsert error:', e));

  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `👋 Welcome <b>${firstName}</b> to <b>TRewards</b>!\n\n` +
      `🏆 Complete tasks & earn <b>TR coins</b>\n` +
      `💰 Convert TR → <b>TON crypto</b> & withdraw\n` +
      `🎰 Spin the wheel for bonus coins\n` +
      `👥 Invite friends & earn <b>30% commission</b>\n` +
      `🧾 Send & receive TON checks\n\n` +
      `Tap below to open the app 👇`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '🚀 Open TRewards App', web_app: { url: FRONTEND_URL } }
      ]]
    }
  });
}

// ─── Stars invoice sender ─────────────────────────────────────────────────────
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

// ─── Stars pre-checkout ───────────────────────────────────────────────────────
async function handlePreCheckout(query) {
  await tgApi('answerPreCheckoutQuery', { pre_checkout_query_id: query.id, ok: true });
}

// ─── Stars successful_payment ─────────────────────────────────────────────────
async function handleSuccessfulPayment(msg) {
  const userId  = msg.from.id;
  const payment = msg.successful_payment;
  if (!payment || payment.currency !== 'XTR') return;

  const chargeId    = payment.telegram_payment_charge_id;
  const starsAmount = payment.total_amount;
  const tonAmount   = parseFloat((starsAmount / STARS_PER_TON).toFixed(4));

  try {
    // Idempotency check
    const existing = await sb(`stars_payments?telegram_charge_id=eq.${chargeId}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      await tgApi('sendMessage', {
        chat_id: msg.chat.id,
        text: `✅ Payment already credited: ${tonAmount} TON to your account.`,
      });
      return;
    }

    const userRows = await sb(`users?id=eq.${userId}&select=ton_balance`);
    if (Array.isArray(userRows) && userRows.length > 0) {
      const newBal = parseFloat(userRows[0].ton_balance || 0) + tonAmount;
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
            ton_credited: tonAmount,
          }),
        }),
        sb('transactions', {
          method: 'POST',
          prefer: 'return=minimal',
          body: JSON.stringify({
            user_id: userId,
            type: 'topup_stars',
            description: `Stars top-up: ${starsAmount} ⭐`,
            ton_amount: tonAmount,
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
      text: '⚠️ Payment received but crediting failed. Please contact support with your receipt.',
    });
  }
}

// ─── Admin broadcast panel ────────────────────────────────────────────────────
async function sendAdminPanel(chatId) {
  const users = await sb('users?select=id').catch(() => []);
  const total = Array.isArray(users) ? users.length : 0;
  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `👑 <b>TRewards Admin Panel</b>\n\n` +
      `👥 Total users: <b>${total}</b>\n\n` +
      `Use the button below to send a broadcast to all users:`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '📣 Send Broadcast', callback_data: 'admin_start_broadcast' }
      ]]
    }
  });
}

// ─── Admin wizard handler ─────────────────────────────────────────────────────
async function handleAdminWizard(msg) {
  const chatId  = msg.chat.id;
  const userId  = msg.from.id;
  const text    = msg.text || '';
  const session = adminSessions[userId];
  if (!session) return false;

  if (text === '/cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Broadcast cancelled.' });
    return true;
  }

  // Stars custom amount input (non-admin users too)
  if (session.step === 'stars_custom_amount') {
    const stars = parseInt(text);
    if (isNaN(stars) || stars < MIN_STARS) {
      await tgApi('sendMessage', { chat_id: chatId, text: `❌ Minimum ${MIN_STARS} Stars. Enter a valid amount:` });
      return true;
    }
    delete adminSessions[userId];
    await sendStarsInvoice(chatId, stars);
    return true;
  }

  // Broadcast wizard steps (admin only)
  if (session.step === 'broadcast_message') {
    session.data.message = text;
    session.step = 'broadcast_button';
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '🔘 Add a button? Send button label text, or /skip to send without button:',
    });
    return true;
  }

  if (session.step === 'broadcast_button') {
    if (text === '/skip') {
      session.step = 'broadcast_confirm';
      await askBroadcastConfirm(chatId, userId, session);
    } else {
      session.data.button_text = text;
      session.step = 'broadcast_button_url';
      await tgApi('sendMessage', { chat_id: chatId, text: '🔗 Now send the button URL (must start with https://):' });
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
    await askBroadcastConfirm(chatId, userId, session);
    return true;
  }

  return false;
}

async function askBroadcastConfirm(chatId, userId, session) {
  const users   = await sb('users?select=id');
  const total   = Array.isArray(users) ? users.length : '?';
  const preview = (session.data.message || '').slice(0, 200);
  const btnInfo = session.data.button_text
    ? `\n\n🔗 Button: "${session.data.button_text}" → ${session.data.button_url || 'N/A'}`
    : '';

  await tgApi('sendMessage', {
    chat_id: chatId,
    text:
      `<b>📣 Broadcast Preview</b>\n\n` +
      `${preview}${btnInfo}\n\n` +
      `⚠️ Will send to <b>${total} users</b>.\n\nConfirm?`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Send Now',  callback_data: 'broadcast_confirm' },
        { text: '❌ Cancel',   callback_data: 'broadcast_cancel' },
      ]]
    }
  });
}

// ─── Broadcast executor ───────────────────────────────────────────────────────
async function executeBroadcast(userIds, message, buttonText, buttonUrl) {
  let sent = 0, failed = 0;
  for (let i = 0; i < userIds.length; i += 30) {
    const batch = userIds.slice(i, i + 30);
    const results = await Promise.allSettled(batch.map(async uid => {
      const body = { chat_id: uid, text: message, parse_mode: 'HTML' };
      if (buttonText && buttonUrl) {
        body.reply_markup = { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] };
      }
      const r = await tgApi('sendMessage', body);
      return r.ok;
    }));
    for (const r of results) {
      r.status === 'fulfilled' && r.value ? sent++ : failed++;
    }
    if (i + 30 < userIds.length) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Broadcast complete: sent=${sent}, failed=${failed}`);
}

// ─── Callback query handler ───────────────────────────────────────────────────
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;

  await tgApi('answerCallbackQuery', { callback_query_id: query.id });

  // Stars purchase callbacks — available to all users
  const starsMap = { stars_65: 65, stars_130: 130, stars_325: 325, stars_650: 650 };
  if (data in starsMap) {
    await sendStarsInvoice(chatId, starsMap[data]);
    return;
  }

  if (data === 'stars_custom') {
    adminSessions[userId] = { step: 'stars_custom_amount', data: {} };
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `⭐ Enter the number of Stars you want to pay (minimum ${MIN_STARS}):`,
    });
    return;
  }

  // Admin-only callbacks
  if (data === 'admin_start_broadcast') {
    if (!isAdmin(userId)) return;
    adminSessions[userId] = { step: 'broadcast_message', data: {} };
    await tgApi('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        '<b>📣 Create Broadcast</b>\n\n' +
        'Type your message (HTML formatting supported: <b>bold</b>, <i>italic</i>, links).\n\n' +
        '<i>Send /cancel to abort.</i>',
    });
    return;
  }

  if (data === 'broadcast_confirm') {
    if (!isAdmin(userId)) return;
    const session = adminSessions[userId];
    if (!session || session.step !== 'broadcast_confirm') return;
    const { message, button_text, button_url } = session.data;
    delete adminSessions[userId];

    const users = await sb('users?select=id');
    const userIds = Array.isArray(users) ? users.map(u => u.id) : [];
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `📤 Sending broadcast to ${userIds.length} users... This may take a few minutes.`,
    });
    // Execute broadcast (fire and don't await to avoid Lambda timeout)
    executeBroadcast(userIds, message, button_text, button_url).catch(console.error);
    return;
  }

  if (data === 'broadcast_cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Broadcast cancelled.' });
    return;
  }
}

// ─── Main Lambda handler ──────────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    // Validate webhook secret if set
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
      await handleCallback(body.callback_query);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Messages ──────────────────────────────────────────────────────────────
    if (body.message) {
      const msg  = body.message;
      const text = (msg.text || '').trim();
      const uid  = msg.from?.id;

      // Stars successful payment — handle before any text check
      if (msg.successful_payment) {
        await handleSuccessfulPayment(msg);
        return { statusCode: 200, body: 'ok' };
      }

      // /start — with optional deep-link param
      const startMatch = text.match(/^\/start(?:\s+(.+))?$/);
      if (startMatch) {
        await handleStart(msg, startMatch[1]?.trim() || null);
        return { statusCode: 200, body: 'ok' };
      }

      // /amiadminyes — admin panel (admin only)
      if (text === '/amiadminyes') {
        if (isAdmin(uid)) {
          await sendAdminPanel(msg.chat.id);
        }
        // Silently ignore for non-admins (no response)
        return { statusCode: 200, body: 'ok' };
      }

      // Active wizard session (broadcast steps or stars custom amount)
      if (adminSessions[uid]) {
        await handleAdminWizard(msg);
        return { statusCode: 200, body: 'ok' };
      }

      // ── IMPORTANT: All other messages are IGNORED silently ────────────────
      // Bot only responds to /start and /amiadminyes + wizard flows + payments
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Lambda handler error:', err);
    return { statusCode: 200, body: 'ok' }; // Always return 200 to Telegram
  }
};