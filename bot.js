// TRewards Bot — AWS Lambda (ES Module)
// Handles: /start, /amiadminyes, Stars payments, admin wizard

const BOT_TOKEN    = process.env.BOT_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards.onrender.com';
const CHANNEL      = process.env.CHANNEL_USERNAME || 'treward_ton';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const API_URL      = process.env.API_URL || 'https://trewards-api.onrender.com';
const STARS_PER_TON = 65;
const MIN_STARS     = 50;

// In-memory admin wizard sessions (Lambda warm instances)
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

  // Generate unique 6-digit comment ID for new users
  let commentId = String(Math.floor(100000 + Math.random() * 900000));
  // Check uniqueness (only matters if truly new)
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

  // Update weekly referral stats if this is a new referral
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

  // Deep-link: c_<checkId>
  if (param && param.startsWith('c_')) {
    const checkUrl = `${FRONTEND_URL}?check=${encodeURIComponent(param.slice(2))}`;
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `💎 You have a <b>TON check</b> waiting!\n\nOpen the app to claim it instantly.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '💰 Claim Check', web_app: { url: checkUrl } }
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
  const userId = msg.from.id;

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

// ─── Admin panel ──────────────────────────────────────────────────────────────
async function sendAdminPanel(chatId) {
  try {
    const [totalRes, todayRes, revenueRes, pendingRes, activeTasksRes] = await Promise.all([
      sb('users?select=id'),
      sb(`users?created_at=gte.${new Date(Date.now() - 86400000).toISOString()}&select=id`),
      sb('payments?status=eq.paid&select=amount_ton'),
      sb('withdrawals?status=eq.pending&select=id,net_ton,wallet_address,users(username,first_name)'),
      sb('tasks?status=eq.active&select=id'),
    ]);

    const totalUsers  = Array.isArray(totalRes)      ? totalRes.length   : 0;
    const newToday    = Array.isArray(todayRes)       ? todayRes.length   : 0;
    const revenue     = Array.isArray(revenueRes)
      ? revenueRes.reduce((s, r) => s + parseFloat(r.amount_ton || 0), 0).toFixed(4)
      : '0.0000';
    const pendingWd   = Array.isArray(pendingRes)     ? pendingRes.length : 0;
    const activeTasks = Array.isArray(activeTasksRes) ? activeTasksRes.length : 0;

    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `👑 <b>TRewards Admin Panel</b>\n\n` +
        `👥 Total users: <b>${totalUsers}</b>\n` +
        `🆕 New today: <b>${newToday}</b>\n` +
        `💰 Revenue: <b>${revenue} TON</b>\n` +
        `⏳ Pending withdrawals: <b>${pendingWd}</b>\n` +
        `📋 Active tasks: <b>${activeTasks}</b>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Create Promo',  callback_data: 'admin_create_promo' },
            { text: '📋 List Promos',   callback_data: 'admin_list_promos'  },
          ],
          [
            { text: '🗑 Delete Promo',  callback_data: 'admin_delete_promo' },
            { text: '📜 Activations',   callback_data: 'admin_activations'  },
          ],
          [
            { text: '💸 Payments',      callback_data: 'admin_payments'     },
            { text: '👥 User Stats',    callback_data: 'admin_users'        },
          ],
          [{ text: '⏳ Withdrawals',    callback_data: 'admin_withdrawals'  }],
          [{ text: '📣 Broadcast',      callback_data: 'admin_broadcast'    }],
        ]
      }
    });
  } catch (e) {
    console.error('Admin panel error:', e);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Could not load stats. Check SUPABASE_URL and SUPABASE_KEY.'
    });
  }
}

// ─── Callback query handler ───────────────────────────────────────────────────
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;

  await tgApi('answerCallbackQuery', { callback_query_id: query.id });

  // ── Stars payment callbacks ────────────────────────────────────────────────
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

  // ── Admin-only below ──────────────────────────────────────────────────────
  if (!isAdmin(userId)) {
    await tgApi('sendMessage', { chat_id: chatId, text: '❌ Access denied.' });
    return;
  }

  if (data === 'admin_list_promos') {
    const rows = await sb('promo_codes?order=created_at.desc&limit=20');
    if (!Array.isArray(rows) || !rows.length) {
      await tgApi('sendMessage', { chat_id: chatId, text: 'No promo codes yet.' });
      return;
    }
    let text = '<b>📋 Promo Codes:</b>\n\n';
    rows.forEach(p => {
      text += `${p.is_active ? '✅' : '❌'} <code>${p.code}</code> — ${p.reward_type} · ${p.reward_amount} · ${p.current_activations || 0}/${p.max_activations}\n`;
    });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    return;
  }

  if (data === 'admin_activations') {
    const rows = await sb('promo_activations?select=user_id,activated_at,promo_codes(code)&order=activated_at.desc&limit=20');
    if (!Array.isArray(rows) || !rows.length) {
      await tgApi('sendMessage', { chat_id: chatId, text: 'No activations yet.' });
      return;
    }
    let text = '<b>📜 Recent Activations:</b>\n\n';
    rows.forEach(a => {
      text += `• ${a.user_id} → <code>${a.promo_codes?.code || '?'}</code> · ${new Date(a.activated_at).toLocaleDateString()}\n`;
    });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    return;
  }

  if (data === 'admin_payments') {
    const rows = await sb('payments?status=eq.paid&select=amount_ton,provider,paid_at,users(username,first_name)&order=paid_at.desc&limit=20');
    if (!Array.isArray(rows) || !rows.length) {
      await tgApi('sendMessage', { chat_id: chatId, text: 'No payments yet.' });
      return;
    }
    let text = '<b>💸 Recent Payments:</b>\n\n';
    rows.forEach(p => {
      const who = p.users?.username ? `@${p.users.username}` : (p.users?.first_name || '?');
      text += `• ${who}: ${p.amount_ton} TON via ${p.provider}\n`;
    });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    return;
  }

  if (data === 'admin_users') {
    const [all, today, week] = await Promise.all([
      sb('users?select=id,coins'),
      sb(`users?created_at=gte.${new Date(Date.now() - 86400000).toISOString()}&select=id`),
      sb(`users?created_at=gte.${new Date(Date.now() - 604800000).toISOString()}&select=id`),
    ]);
    const totalCoins = Array.isArray(all) ? all.reduce((s, u) => s + parseInt(u.coins || 0), 0) : 0;
    await tgApi('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        `<b>👥 User Stats:</b>\n\n` +
        `Total: <b>${Array.isArray(all) ? all.length : 0}</b>\n` +
        `Today: <b>${Array.isArray(today) ? today.length : 0}</b>\n` +
        `This week: <b>${Array.isArray(week) ? week.length : 0}</b>\n` +
        `Total TR coins: <b>${totalCoins.toLocaleString()}</b>`
    });
    return;
  }

  if (data === 'admin_withdrawals') {
    const rows = await sb('withdrawals?status=eq.pending&select=id,net_ton,wallet_address,created_at,users(username,first_name)&order=created_at.asc&limit=20');
    if (!Array.isArray(rows) || !rows.length) {
      await tgApi('sendMessage', { chat_id: chatId, text: '✅ No pending withdrawals!' });
      return;
    }
    let text = '<b>⏳ Pending Withdrawals:</b>\n\n';
    rows.forEach(w => {
      const who = w.users?.username ? `@${w.users.username}` : (w.users?.first_name || '?');
      text += `#${w.id} ${who}: ${parseFloat(w.net_ton).toFixed(4)} TON → <code>${w.wallet_address}</code>\n`;
    });
    await tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    return;
  }

  if (data === 'admin_create_promo') {
    adminSessions[userId] = { step: 'promo_name', data: {} };
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: '<b>📝 Create Promo Code</b>\n\nStep 1/4: Enter the promo code (e.g. LAUNCH2025):'
    });
    return;
  }

  if (data === 'admin_delete_promo') {
    adminSessions[userId] = { step: 'delete_promo', data: {} };
    await tgApi('sendMessage', { chat_id: chatId, text: '🗑 Enter the promo code to deactivate:' });
    return;
  }

  if (data === 'admin_broadcast') {
    adminSessions[userId] = { step: 'broadcast_message', data: {} };
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: '<b>📣 Send Broadcast</b>\n\nType your message (HTML supported):\n\n<i>/cancel to abort.</i>'
    });
    return;
  }

  if (data === 'promo_type_coins' || data === 'promo_type_ton') {
    const session = adminSessions[userId];
    if (session?.step === 'promo_reward_type') {
      session.data.reward_type = data === 'promo_type_coins' ? 'coins' : 'ton';
      session.step = 'promo_amount';
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: `Step 3/4: Enter reward amount (${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'}):`
      });
    }
    return;
  }

  if (data === 'broadcast_confirm') {
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

  const chargeId   = payment.telegram_payment_charge_id;
  const starsAmount = payment.total_amount;  // in XTR smallest unit (== stars)
  const tonAmount  = (starsAmount / STARS_PER_TON).toFixed(4);

  // Credit via backend API (idempotent)
  try {
    // We need initData — for bot-side we call Supabase directly
    const existing = await sb(`stars_payments?telegram_charge_id=eq.${chargeId}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      await tgApi('sendMessage', {
        chat_id: msg.chat.id,
        text: `✅ Already credited ${tonAmount} TON to your account.`,
        parse_mode: 'HTML',
      });
      return;
    }

    // Credit TON in Supabase
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
        body.reply_markup = JSON.stringify({ inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] });
      }
      const r = await tgApi('sendMessage', body);
      r.ok ? sent++ : failed++;
    }));
    if (i + 30 < userIds.length) await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Broadcast done: sent=${sent}, failed=${failed}`);
}

// ─── Admin wizard ─────────────────────────────────────────────────────────────
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

  // Stars custom amount
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

  // Promo wizard
  if (session.step === 'promo_name') {
    if (!/^[A-Z0-9_]{3,30}$/i.test(text)) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ 3–30 alphanumeric chars only. Try again:' });
      return true;
    }
    session.data.code = text.toUpperCase();
    session.step = 'promo_reward_type';
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `Step 2/4: Select reward type for <code>${session.data.code}</code>:`,
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
    await tgApi('sendMessage', { chat_id: chatId, text: 'Step 4/4: Enter max activations allowed:' });
    return true;
  }

  if (session.step === 'promo_max_activations') {
    const max = parseInt(text);
    if (isNaN(max) || max <= 0) {
      await tgApi('sendMessage', { chat_id: chatId, text: '❌ Enter a positive integer:' });
      return true;
    }
    await sb('promo_codes', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        code: session.data.code,
        reward_type: session.data.reward_type,
        reward_amount: session.data.amount,
        max_activations: max,
        created_by: userId,
        is_active: true,
        current_activations: 0,
      }),
    });
    delete adminSessions[userId];
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `✅ Promo <b>${session.data.code}</b> created!\n${session.data.amount} ${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'} · max ${max} uses`
    });
    return true;
  }

  if (session.step === 'delete_promo') {
    const code = text.toUpperCase().trim();
    await sb(`promo_codes?code=eq.${code}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ is_active: false }),
    });
    delete adminSessions[userId];
    await tgApi('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: `✅ <code>${code}</code> deactivated.`
    });
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
    ? `\n🔗 ${session.data.button_text} → ${session.data.button_url}`
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

// ─── Main Lambda handler ──────────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    // Verify webhook secret
    const secret = process.env.WEBHOOK_SECRET_TOKEN;
    if (secret) {
      const provided = (event.headers || {})['x-telegram-bot-api-secret-token'];
      if (provided !== secret) return { statusCode: 403, body: 'Forbidden' };
    }

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    if (!body) return { statusCode: 200, body: 'ok' };

    // ── Message handling ──────────────────────────────────────────────────────
    if (body.message) {
      const msg  = body.message;
      const text = msg.text || '';
      const uid  = msg.from?.id;

      // Stars pre-checkout
      if (body.pre_checkout_query) {
        await handlePreCheckout(body.pre_checkout_query);
        return { statusCode: 200, body: 'ok' };
      }

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

      // /stars — buy TON with Stars
      if (text === '/stars') {
        await handleStarsCommand(msg);
        return { statusCode: 200, body: 'ok' };
      }

      // /amiadminyes — admin panel
      if (text === '/amiadminyes') {
        if (isAdmin(uid)) await sendAdminPanel(msg.chat.id);
        else await tgApi('sendMessage', { chat_id: msg.chat.id, text: '❌ Access denied.' });
        return { statusCode: 200, body: 'ok' };
      }

      // Admin wizard (text steps) — check stars custom too
      const session = adminSessions[uid];
      if (session && !text.startsWith('/')) {
        await handleAdminWizard(msg);
        return { statusCode: 200, body: 'ok' };
      }
      if (session?.step === 'stars_custom_amount') {
        await handleAdminWizard(msg);
        return { statusCode: 200, body: 'ok' };
      }
      if (isAdmin(uid) && !text.startsWith('/')) {
        await handleAdminWizard(msg);
      }
    }

    // ── pre_checkout_query at top level ───────────────────────────────────────
    if (body.pre_checkout_query) {
      await handlePreCheckout(body.pre_checkout_query);
      return { statusCode: 200, body: 'ok' };
    }

    // ── Callback queries ──────────────────────────────────────────────────────
    if (body.callback_query) {
      await handleCallback(body.callback_query);
    }

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Lambda error:', err);
    return { statusCode: 200, body: 'ok' };
  }
};