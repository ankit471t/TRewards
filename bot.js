// TRewards Bot — AWS Lambda (ES Module)
// Responds ONLY to: /start, /amiadminyes (admin broadcast)

const BOT_TOKEN    = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards.onrender.com';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// In-memory admin wizard sessions (lives per Lambda warm instance)
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

// ─── Week ID helper ───────────────────────────────────────────────────────────
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

  // Check if user already exists
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

  // Track weekly referral stats for new users with a valid referrer
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

  // Deep-link: c_<checkId> — open app to claim a TON check
  if (param && param.startsWith('c_')) {
    await getOrCreateUser(tgUser, null).catch(e => console.error('upsert error:', e));
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

// ─── Admin panel ──────────────────────────────────────────────────────────────
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

// ─── Admin broadcast wizard ───────────────────────────────────────────────────
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
        { text: '✅ Send Now', callback_data: 'broadcast_confirm' },
        { text: '❌ Cancel',  callback_data: 'broadcast_cancel' },
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
  console.log(`Broadcast done: sent=${sent}, failed=${failed}`);
}

// ─── Callback query handler ───────────────────────────────────────────────────
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;

  await tgApi('answerCallbackQuery', { callback_query_id: query.id });

  if (data === 'admin_start_broadcast') {
    if (!isAdmin(userId)) return;
    adminSessions[userId] = { step: 'broadcast_message', data: {} };
    await tgApi('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        '<b>📣 Create Broadcast</b>\n\n' +
        'Type your message (HTML supported: <b>bold</b>, <i>italic</i>, links).\n\n' +
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

    const users   = await sb('users?select=id');
    const userIds = Array.isArray(users) ? users.map(u => u.id) : [];
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `📤 Sending to ${userIds.length} users… This may take a few minutes.`,
    });
    executeBroadcast(userIds, message, button_text, button_url).catch(console.error);
    return;
  }

  if (data === 'broadcast_cancel') {
    delete adminSessions[userId];
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Broadcast cancelled.' });
    return;
  }

  // All other callbacks silently ignored
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

      // /start with optional deep-link param
      const startMatch = text.match(/^\/start(?:\s+(.+))?$/);
      if (startMatch) {
        await handleStart(msg, startMatch[1]?.trim() || null);
        return { statusCode: 200, body: 'ok' };
      }

      // /amiadminyes — admin panel (admins only, silently ignored otherwise)
      if (text === '/amiadminyes') {
        if (isAdmin(uid)) await sendAdminPanel(msg.chat.id);
        return { statusCode: 200, body: 'ok' };
      }

      // Active broadcast wizard session
      if (adminSessions[uid]) {
        await handleAdminWizard(msg);
        return { statusCode: 200, body: 'ok' };
      }

      // ── Everything else is silently ignored ───────────────────────────────
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Lambda handler error:', err);
    return { statusCode: 200, body: 'ok' }; // Always 200 to Telegram
  }
};