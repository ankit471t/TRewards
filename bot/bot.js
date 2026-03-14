require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards-frontend.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'trewards_ton_bot';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Admin conversation state ────────────────────────────────────────────────
const adminSessions = {}; // userId -> { step, data }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

async function getOrCreateUser(tgUser, referrerId = null) {
  const { id, username, first_name, last_name } = tgUser;

  // Prevent self-referral
  const safeRef = referrerId && referrerId !== id ? referrerId : null;

  // Verify referrer exists if provided
  let validRef = null;
  if (safeRef) {
    const ref = await db.query('SELECT id FROM users WHERE id = $1', [safeRef]);
    if (ref.rows.length > 0) validRef = safeRef;
  }

  const result = await db.query(`
    INSERT INTO users (id, username, first_name, last_name, referrer_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name
    RETURNING *
  `, [id, username || null, first_name || '', last_name || '', validRef]);

  return result.rows[0];
}

function getWelcomeMessage(user, lang = 'en') {
  const name = user.first_name || user.username || 'Explorer';
  if (lang === 'ru') {
    return `🏆 Добро пожаловать в *TRewards*, ${name}!\n\n` +
      `💰 Зарабатывайте TR монеты:\n` +
      `• Выполняйте задания рекламодателей\n` +
      `• Крутите колесо фортуны\n` +
      `• Поддерживайте ежедневную серию\n` +
      `• Приглашайте друзей\n\n` +
      `🚀 Выводите монеты в TON криптовалюту!\n\n` +
      `Нажмите кнопку ниже, чтобы начать:`;
  }
  return `🏆 Welcome to *TRewards*, ${name}!\n\n` +
    `💰 Earn TR coins by:\n` +
    `• Completing advertiser tasks\n` +
    `• Spinning the reward wheel\n` +
    `• Maintaining daily streaks\n` +
    `• Referring friends\n\n` +
    `🚀 Withdraw your coins as TON crypto!\n\n` +
    `Tap the button below to get started:`;
}

// ─── /start command ──────────────────────────────────────────────────────────

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const param = match ? match[1] : null;

  let referrerId = null;
  if (param && /^\d+$/.test(param)) {
    referrerId = parseInt(param);
  }

  try {
    const user = await getOrCreateUser(tgUser, referrerId);
    const lang = user.language || 'en';

    await bot.sendMessage(chatId, getWelcomeMessage(tgUser, lang), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {
            text: lang === 'ru' ? '🚀 Открыть TRewards' : '🚀 Open TRewards',
            web_app: { url: FRONTEND_URL }
          }
        ]]
      }
    });
  } catch (err) {
    console.error('Error in /start:', err);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// ─── /amiadminyes command ─────────────────────────────────────────────────────

bot.onText(/\/amiadminyes/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Access denied.');
  }

  try {
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COALESCE(SUM(amount_ton), 0) FROM payments WHERE status = 'paid') AS total_revenue,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') AS pending_withdrawals,
        (SELECT COUNT(*) FROM tasks WHERE status = 'active') AS active_tasks
    `);
    const s = stats.rows[0];

    await bot.sendMessage(chatId,
      `👑 *TRewards Admin Panel*\n\n` +
      `👥 Total Users: ${s.total_users}\n` +
      `💰 Total Revenue: ${parseFloat(s.total_revenue).toFixed(4)} TON\n` +
      `⏳ Pending Withdrawals: ${s.pending_withdrawals}\n` +
      `📋 Active Tasks: ${s.active_tasks}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '➕ Create Promo', callback_data: 'admin_create_promo' },
              { text: '📋 List Promos', callback_data: 'admin_list_promos' }
            ],
            [
              { text: '🗑️ Delete Promo', callback_data: 'admin_delete_promo' },
              { text: '📜 Activations', callback_data: 'admin_activations' }
            ],
            [
              { text: '💸 Payment History', callback_data: 'admin_payments' },
              { text: '👥 User Stats', callback_data: 'admin_users' }
            ],
            [
              { text: '⏳ Pending Withdrawals', callback_data: 'admin_withdrawals' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error('Admin panel error:', err);
    bot.sendMessage(chatId, '❌ Error loading admin panel.');
  }
});

// ─── Callback query handler ───────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Access denied.');
  }

  try {
    if (data === 'admin_create_promo') {
      adminSessions[userId] = { step: 'promo_name', data: {} };
      return bot.sendMessage(chatId,
        '📝 *Create Promo Code*\n\nStep 1/4: Enter the promo code name (e.g. LAUNCH2025):',
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_list_promos') {
      const promos = await db.query(
        'SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20'
      );
      if (promos.rows.length === 0) {
        return bot.sendMessage(chatId, '📋 No promo codes found.');
      }
      let text = '📋 *Promo Codes:*\n\n';
      promos.rows.forEach(p => {
        const status = p.is_active ? '✅' : '❌';
        text += `${status} \`${p.code}\`\n`;
        text += `  Type: ${p.reward_type} | Amount: ${p.reward_amount}\n`;
        text += `  Used: ${p.current_activations}/${p.max_activations}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    if (data === 'admin_delete_promo') {
      adminSessions[userId] = { step: 'delete_promo', data: {} };
      return bot.sendMessage(chatId,
        '🗑️ Enter the promo code to deactivate:',
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_activations') {
      const activations = await db.query(`
        SELECT pa.activated_at, pa.user_id, pc.code
        FROM promo_activations pa
        JOIN promo_codes pc ON pa.promo_id = pc.id
        ORDER BY pa.activated_at DESC LIMIT 20
      `);
      if (activations.rows.length === 0) {
        return bot.sendMessage(chatId, '📜 No activations yet.');
      }
      let text = '📜 *Recent Activations:*\n\n';
      activations.rows.forEach(a => {
        text += `• User ${a.user_id} used \`${a.code}\` on ${new Date(a.activated_at).toLocaleDateString()}\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    if (data === 'admin_payments') {
      const payments = await db.query(`
        SELECT p.*, u.username, u.first_name
        FROM payments p JOIN users u ON p.user_id = u.id
        WHERE p.status = 'paid'
        ORDER BY p.paid_at DESC LIMIT 20
      `);
      if (payments.rows.length === 0) {
        return bot.sendMessage(chatId, '💸 No payments yet.');
      }
      let text = '💸 *Recent Payments:*\n\n';
      payments.rows.forEach(p => {
        const name = p.username ? `@${p.username}` : p.first_name;
        text += `• ${name}: ${p.amount_ton} TON via ${p.provider}\n`;
        text += `  ${new Date(p.paid_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    if (data === 'admin_users') {
      const result = await db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as new_today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as new_week,
          COALESCE(SUM(coins), 0) as total_coins
        FROM users
      `);
      const s = result.rows[0];
      return bot.sendMessage(chatId,
        `👥 *User Statistics:*\n\n` +
        `Total: ${s.total}\n` +
        `New today: ${s.new_today}\n` +
        `New this week: ${s.new_week}\n` +
        `Total TR coins in circulation: ${parseInt(s.total_coins).toLocaleString()}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_withdrawals') {
      const withdrawals = await db.query(`
        SELECT w.*, u.username, u.first_name
        FROM withdrawals w JOIN users u ON w.user_id = u.id
        WHERE w.status = 'pending'
        ORDER BY w.created_at ASC LIMIT 20
      `);
      if (withdrawals.rows.length === 0) {
        return bot.sendMessage(chatId, '✅ No pending withdrawals!');
      }
      let text = '⏳ *Pending Withdrawals:*\n\n';
      withdrawals.rows.forEach(w => {
        const name = w.username ? `@${w.username}` : w.first_name;
        text += `• ID #${w.id}: ${name}\n`;
        text += `  ${parseFloat(w.net_ton).toFixed(4)} TON → \`${w.wallet_address}\`\n`;
        text += `  ${new Date(w.created_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    // Promo reward type selection
    if (data === 'promo_type_coins' || data === 'promo_type_ton') {
      const session = adminSessions[userId];
      if (session && session.step === 'promo_reward_type') {
        session.data.reward_type = data === 'promo_type_coins' ? 'coins' : 'ton';
        session.step = 'promo_amount';
        return bot.sendMessage(chatId,
          `Step 3/4: Enter the reward amount (${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'}):`,
        );
      }
    }

  } catch (err) {
    console.error('Callback error:', err);
    bot.sendMessage(chatId, '❌ Error processing request.');
  }
});

// ─── Message handler for admin wizard ────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;
  if (!isAdmin(userId)) return;

  const session = adminSessions[userId];
  if (!session) return;

  try {
    // Promo creation wizard
    if (session.step === 'promo_name') {
      if (text.length < 3 || text.length > 30 || !/^[A-Z0-9_]+$/i.test(text)) {
        return bot.sendMessage(chatId, '❌ Code must be 3-30 alphanumeric characters. Try again:');
      }
      session.data.code = text.toUpperCase();
      session.step = 'promo_reward_type';
      return bot.sendMessage(chatId,
        `Step 2/4: Select reward type for \`${session.data.code}\`:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🪙 TR Coins', callback_data: 'promo_type_coins' },
              { text: '💎 TON', callback_data: 'promo_type_ton' }
            ]]
          }
        }
      );
    }

    if (session.step === 'promo_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');
      }
      session.data.amount = amount;
      session.step = 'promo_max_activations';
      return bot.sendMessage(chatId, 'Step 4/4: Enter maximum number of activations:');
    }

    if (session.step === 'promo_max_activations') {
      const max = parseInt(text);
      if (isNaN(max) || max <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid number. Enter a positive integer:');
      }
      session.data.max_activations = max;

      // Create the promo
      await db.query(`
        INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by)
        VALUES ($1, $2, $3, $4, $5)
      `, [session.data.code, session.data.reward_type, session.data.amount, max, userId]);

      delete adminSessions[userId];

      return bot.sendMessage(chatId,
        `✅ *Promo code created!*\n\n` +
        `Code: \`${session.data.code}\`\n` +
        `Reward: ${session.data.amount} ${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'}\n` +
        `Max uses: ${max}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (session.step === 'delete_promo') {
      const code = text.toUpperCase().trim();
      const result = await db.query(
        'UPDATE promo_codes SET is_active = FALSE WHERE UPPER(code) = $1 RETURNING code',
        [code]
      );
      delete adminSessions[userId];
      if (result.rows.length === 0) {
        return bot.sendMessage(chatId, `❌ Promo code \`${code}\` not found.`, { parse_mode: 'Markdown' });
      }
      return bot.sendMessage(chatId,
        `✅ Promo code \`${code}\` deactivated.`,
        { parse_mode: 'Markdown' }
      );
    }

  } catch (err) {
    console.error('Admin wizard error:', err);
    delete adminSessions[userId];
    bot.sendMessage(chatId, '❌ Error. Please try again.');
  }
});

// ─── Polling error handler ────────────────────────────────────────────────────

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('✅ TRewards bot started');require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards-frontend.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'trewards_ton_bot';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ─── Admin conversation state ────────────────────────────────────────────────
const adminSessions = {}; // userId -> { step, data }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

async function getOrCreateUser(tgUser, referrerId = null) {
  const { id, username, first_name, last_name } = tgUser;

  // Prevent self-referral
  const safeRef = referrerId && referrerId !== id ? referrerId : null;

  // Verify referrer exists if provided
  let validRef = null;
  if (safeRef) {
    const ref = await db.query('SELECT id FROM users WHERE id = $1', [safeRef]);
    if (ref.rows.length > 0) validRef = safeRef;
  }

  const result = await db.query(`
    INSERT INTO users (id, username, first_name, last_name, referrer_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name
    RETURNING *
  `, [id, username || null, first_name || '', last_name || '', validRef]);

  return result.rows[0];
}

function getWelcomeMessage(user, lang = 'en') {
  const name = user.first_name || user.username || 'Explorer';
  if (lang === 'ru') {
    return `🏆 Добро пожаловать в *TRewards*, ${name}!\n\n` +
      `💰 Зарабатывайте TR монеты:\n` +
      `• Выполняйте задания рекламодателей\n` +
      `• Крутите колесо фортуны\n` +
      `• Поддерживайте ежедневную серию\n` +
      `• Приглашайте друзей\n\n` +
      `🚀 Выводите монеты в TON криптовалюту!\n\n` +
      `Нажмите кнопку ниже, чтобы начать:`;
  }
  return `🏆 Welcome to *TRewards*, ${name}!\n\n` +
    `💰 Earn TR coins by:\n` +
    `• Completing advertiser tasks\n` +
    `• Spinning the reward wheel\n` +
    `• Maintaining daily streaks\n` +
    `• Referring friends\n\n` +
    `🚀 Withdraw your coins as TON crypto!\n\n` +
    `Tap the button below to get started:`;
}

// ─── /start command ──────────────────────────────────────────────────────────

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const param = match ? match[1] : null;

  let referrerId = null;
  if (param && /^\d+$/.test(param)) {
    referrerId = parseInt(param);
  }

  try {
    const user = await getOrCreateUser(tgUser, referrerId);
    const lang = user.language || 'en';

    await bot.sendMessage(chatId, getWelcomeMessage(tgUser, lang), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {
            text: lang === 'ru' ? '🚀 Открыть TRewards' : '🚀 Open TRewards',
            web_app: { url: FRONTEND_URL }
          }
        ]]
      }
    });
  } catch (err) {
    console.error('Error in /start:', err);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
});

// ─── /amiadminyes command ─────────────────────────────────────────────────────

bot.onText(/\/amiadminyes/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Access denied.');
  }

  try {
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS total_users,
        (SELECT COALESCE(SUM(amount_ton), 0) FROM payments WHERE status = 'paid') AS total_revenue,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') AS pending_withdrawals,
        (SELECT COUNT(*) FROM tasks WHERE status = 'active') AS active_tasks
    `);
    const s = stats.rows[0];

    await bot.sendMessage(chatId,
      `👑 *TRewards Admin Panel*\n\n` +
      `👥 Total Users: ${s.total_users}\n` +
      `💰 Total Revenue: ${parseFloat(s.total_revenue).toFixed(4)} TON\n` +
      `⏳ Pending Withdrawals: ${s.pending_withdrawals}\n` +
      `📋 Active Tasks: ${s.active_tasks}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '➕ Create Promo', callback_data: 'admin_create_promo' },
              { text: '📋 List Promos', callback_data: 'admin_list_promos' }
            ],
            [
              { text: '🗑️ Delete Promo', callback_data: 'admin_delete_promo' },
              { text: '📜 Activations', callback_data: 'admin_activations' }
            ],
            [
              { text: '💸 Payment History', callback_data: 'admin_payments' },
              { text: '👥 User Stats', callback_data: 'admin_users' }
            ],
            [
              { text: '⏳ Pending Withdrawals', callback_data: 'admin_withdrawals' }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error('Admin panel error:', err);
    bot.sendMessage(chatId, '❌ Error loading admin panel.');
  }
});

// ─── Callback query handler ───────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Access denied.');
  }

  try {
    if (data === 'admin_create_promo') {
      adminSessions[userId] = { step: 'promo_name', data: {} };
      return bot.sendMessage(chatId,
        '📝 *Create Promo Code*\n\nStep 1/4: Enter the promo code name (e.g. LAUNCH2025):',
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_list_promos') {
      const promos = await db.query(
        'SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20'
      );
      if (promos.rows.length === 0) {
        return bot.sendMessage(chatId, '📋 No promo codes found.');
      }
      let text = '📋 *Promo Codes:*\n\n';
      promos.rows.forEach(p => {
        const status = p.is_active ? '✅' : '❌';
        text += `${status} \`${p.code}\`\n`;
        text += `  Type: ${p.reward_type} | Amount: ${p.reward_amount}\n`;
        text += `  Used: ${p.current_activations}/${p.max_activations}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    if (data === 'admin_delete_promo') {
      adminSessions[userId] = { step: 'delete_promo', data: {} };
      return bot.sendMessage(chatId,
        '🗑️ Enter the promo code to deactivate:',
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_activations') {
      const activations = await db.query(`
        SELECT pa.activated_at, pa.user_id, pc.code
        FROM promo_activations pa
        JOIN promo_codes pc ON pa.promo_id = pc.id
        ORDER BY pa.activated_at DESC LIMIT 20
      `);
      if (activations.rows.length === 0) {
        return bot.sendMessage(chatId, '📜 No activations yet.');
      }
      let text = '📜 *Recent Activations:*\n\n';
      activations.rows.forEach(a => {
        text += `• User ${a.user_id} used \`${a.code}\` on ${new Date(a.activated_at).toLocaleDateString()}\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    if (data === 'admin_payments') {
      const payments = await db.query(`
        SELECT p.*, u.username, u.first_name
        FROM payments p JOIN users u ON p.user_id = u.id
        WHERE p.status = 'paid'
        ORDER BY p.paid_at DESC LIMIT 20
      `);
      if (payments.rows.length === 0) {
        return bot.sendMessage(chatId, '💸 No payments yet.');
      }
      let text = '💸 *Recent Payments:*\n\n';
      payments.rows.forEach(p => {
        const name = p.username ? `@${p.username}` : p.first_name;
        text += `• ${name}: ${p.amount_ton} TON via ${p.provider}\n`;
        text += `  ${new Date(p.paid_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    if (data === 'admin_users') {
      const result = await db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as new_today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as new_week,
          COALESCE(SUM(coins), 0) as total_coins
        FROM users
      `);
      const s = result.rows[0];
      return bot.sendMessage(chatId,
        `👥 *User Statistics:*\n\n` +
        `Total: ${s.total}\n` +
        `New today: ${s.new_today}\n` +
        `New this week: ${s.new_week}\n` +
        `Total TR coins in circulation: ${parseInt(s.total_coins).toLocaleString()}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_withdrawals') {
      const withdrawals = await db.query(`
        SELECT w.*, u.username, u.first_name
        FROM withdrawals w JOIN users u ON w.user_id = u.id
        WHERE w.status = 'pending'
        ORDER BY w.created_at ASC LIMIT 20
      `);
      if (withdrawals.rows.length === 0) {
        return bot.sendMessage(chatId, '✅ No pending withdrawals!');
      }
      let text = '⏳ *Pending Withdrawals:*\n\n';
      withdrawals.rows.forEach(w => {
        const name = w.username ? `@${w.username}` : w.first_name;
        text += `• ID #${w.id}: ${name}\n`;
        text += `  ${parseFloat(w.net_ton).toFixed(4)} TON → \`${w.wallet_address}\`\n`;
        text += `  ${new Date(w.created_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    // Promo reward type selection
    if (data === 'promo_type_coins' || data === 'promo_type_ton') {
      const session = adminSessions[userId];
      if (session && session.step === 'promo_reward_type') {
        session.data.reward_type = data === 'promo_type_coins' ? 'coins' : 'ton';
        session.step = 'promo_amount';
        return bot.sendMessage(chatId,
          `Step 3/4: Enter the reward amount (${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'}):`,
        );
      }
    }

  } catch (err) {
    console.error('Callback error:', err);
    bot.sendMessage(chatId, '❌ Error processing request.');
  }
});

// ─── Message handler for admin wizard ────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;
  if (!isAdmin(userId)) return;

  const session = adminSessions[userId];
  if (!session) return;

  try {
    // Promo creation wizard
    if (session.step === 'promo_name') {
      if (text.length < 3 || text.length > 30 || !/^[A-Z0-9_]+$/i.test(text)) {
        return bot.sendMessage(chatId, '❌ Code must be 3-30 alphanumeric characters. Try again:');
      }
      session.data.code = text.toUpperCase();
      session.step = 'promo_reward_type';
      return bot.sendMessage(chatId,
        `Step 2/4: Select reward type for \`${session.data.code}\`:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🪙 TR Coins', callback_data: 'promo_type_coins' },
              { text: '💎 TON', callback_data: 'promo_type_ton' }
            ]]
          }
        }
      );
    }

    if (session.step === 'promo_amount') {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');
      }
      session.data.amount = amount;
      session.step = 'promo_max_activations';
      return bot.sendMessage(chatId, 'Step 4/4: Enter maximum number of activations:');
    }

    if (session.step === 'promo_max_activations') {
      const max = parseInt(text);
      if (isNaN(max) || max <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid number. Enter a positive integer:');
      }
      session.data.max_activations = max;

      // Create the promo
      await db.query(`
        INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, created_by)
        VALUES ($1, $2, $3, $4, $5)
      `, [session.data.code, session.data.reward_type, session.data.amount, max, userId]);

      delete adminSessions[userId];

      return bot.sendMessage(chatId,
        `✅ *Promo code created!*\n\n` +
        `Code: \`${session.data.code}\`\n` +
        `Reward: ${session.data.amount} ${session.data.reward_type === 'coins' ? 'TR coins' : 'TON'}\n` +
        `Max uses: ${max}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (session.step === 'delete_promo') {
      const code = text.toUpperCase().trim();
      const result = await db.query(
        'UPDATE promo_codes SET is_active = FALSE WHERE UPPER(code) = $1 RETURNING code',
        [code]
      );
      delete adminSessions[userId];
      if (result.rows.length === 0) {
        return bot.sendMessage(chatId, `❌ Promo code \`${code}\` not found.`, { parse_mode: 'Markdown' });
      }
      return bot.sendMessage(chatId,
        `✅ Promo code \`${code}\` deactivated.`,
        { parse_mode: 'Markdown' }
      );
    }

  } catch (err) {
    console.error('Admin wizard error:', err);
    delete adminSessions[userId];
    bot.sendMessage(chatId, '❌ Error. Please try again.');
  }
});

// ─── Polling error handler ────────────────────────────────────────────────────

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('✅ TRewards bot started');