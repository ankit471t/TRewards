require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const BOT_TOKEN    = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards-frontend.onrender.com';
const BOT_USERNAME = process.env.BOT_USERNAME || 'trewards_ton_bot';
const ADMIN_IDS    = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const db  = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Admin wizard sessions: adminSessions[userId] = { step, data }
const adminSessions = {};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

async function getOrCreateUser(tgUser, referrerId = null) {
  const { id, username, first_name, last_name } = tgUser;
  const safeRef = (referrerId && referrerId !== id) ? referrerId : null;

  let validRef = null;
  if (safeRef) {
    const ref = await db.query('SELECT id FROM users WHERE id = $1', [safeRef]);
    if (ref.rows.length > 0) validRef = safeRef;
  }

  const result = await db.query(`
    INSERT INTO users (id, username, first_name, last_name, referrer_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      username   = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name  = EXCLUDED.last_name
    RETURNING *
  `, [id, username || null, first_name || '', last_name || '', validRef]);

  return result.rows[0];
}

function buildWelcomeMessage(tgUser, lang = 'en') {
  const name = tgUser.first_name || tgUser.username || 'Explorer';
  if (lang === 'ru') {
    return (
      `🏆 Добро пожаловать в *TRewards*, ${name}\\!\n\n` +
      `💰 *Как зарабатывать TR монеты:*\n` +
      `• ⚡ Выполняйте задания рекламодателей\n` +
      `• 🎰 Крутите колесо фортуны\n` +
      `• 🔥 Ежедневная серия — бонус каждый день\n` +
      `• 👥 Приглашайте друзей — получайте 30%\n` +
      `• 📺 Смотрите рекламу за монеты\n\n` +
      `🚀 *Выводите монеты в TON криптовалюту\\!*\n\n` +
      `Нажмите кнопку ниже, чтобы открыть приложение:`
    );
  }
  return (
    `🏆 Welcome to *TRewards*, ${name}\\!\n\n` +
    `💰 *Ways to earn TR coins:*\n` +
    `• ⚡ Complete advertiser tasks\n` +
    `• 🎰 Spin the reward wheel\n` +
    `• 🔥 Daily streak — bonus every day\n` +
    `• 👥 Refer friends — earn 30% of their rewards\n` +
    `• 📺 Watch ads for instant TR\n\n` +
    `🚀 *Withdraw your coins as TON crypto\\!*\n\n` +
    `Tap the button below to open the app:`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// /start — works for ALL users
// ─────────────────────────────────────────────────────────────────────────────

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId     = msg.chat.id;
  const tgUser     = msg.from;
  const param      = match ? match[1] : null;
  const referrerId = (param && /^\d+$/.test(param)) ? parseInt(param) : null;

  try {
    const user = await getOrCreateUser(tgUser, referrerId);
    const lang = user.language || 'en';
    const text = buildWelcomeMessage(tgUser, lang);

    await bot.sendMessage(chatId, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[{
          text:    lang === 'ru' ? '🚀 Открыть TRewards' : '🚀 Open TRewards',
          web_app: { url: FRONTEND_URL }
        }]]
      }
    });
  } catch (err) {
    console.error('/start error:', err);
    // Fallback plain message if markdown fails
    try {
      await bot.sendMessage(chatId,
        `🏆 Welcome to TRewards!\n\nEarn TR coins and withdraw as TON.\n\nOpen the app: ${FRONTEND_URL}`
      );
    } catch (e) {
      console.error('/start fallback error:', e);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /amiadminyes — admin panel (admin only)
// ─────────────────────────────────────────────────────────────────────────────

bot.onText(/\/amiadminyes/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Access denied.');
  }

  try {
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*)                      FROM users)                              AS total_users,
        (SELECT COALESCE(SUM(amount_ton), 0)  FROM payments   WHERE status = 'paid')  AS total_revenue,
        (SELECT COUNT(*)                      FROM withdrawals WHERE status = 'pending') AS pending_w,
        (SELECT COUNT(*)                      FROM tasks       WHERE status = 'active') AS active_tasks,
        (SELECT COUNT(*)                      FROM promo_codes WHERE is_active = TRUE)  AS active_promos
    `);
    const s = stats.rows[0];

    await bot.sendMessage(chatId,
      `👑 *TRewards Admin Panel*\n\n` +
      `👥 Total Users: *${s.total_users}*\n` +
      `💰 Total Revenue: *${parseFloat(s.total_revenue).toFixed(4)} TON*\n` +
      `⏳ Pending Withdrawals: *${s.pending_w}*\n` +
      `📋 Active Tasks: *${s.active_tasks}*\n` +
      `🎁 Active Promo Codes: *${s.active_promos}*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '➕ Create Promo',        callback_data: 'admin_create_promo'  },
              { text: '📋 List Promos',          callback_data: 'admin_list_promos'   }
            ],
            [
              { text: '🗑 Delete Promo',         callback_data: 'admin_delete_promo'  },
              { text: '📜 Activations',          callback_data: 'admin_activations'   }
            ],
            [
              { text: '💸 Payment History',      callback_data: 'admin_payments'      },
              { text: '👥 User Stats',           callback_data: 'admin_users'         }
            ],
            [
              { text: '⏳ Pending Withdrawals',  callback_data: 'admin_withdrawals'   }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error('/amiadminyes error:', err);
    bot.sendMessage(chatId, '❌ Error loading admin panel: ' + err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CALLBACK QUERIES — admin panel buttons
// ─────────────────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data   = query.data;

  // Always answer to remove loading spinner
  try { await bot.answerCallbackQuery(query.id); } catch (_) {}

  if (!isAdmin(userId)) {
    return bot.sendMessage(chatId, '❌ Access denied.');
  }

  try {

    // ── START PROMO WIZARD ─────────────────────────────────────────────────
    if (data === 'admin_create_promo') {
      adminSessions[userId] = { step: 'promo_code', data: {} };
      return bot.sendMessage(chatId,
        `📝 *Create Promo Code — Step 1/4*\n\n` +
        `Enter the promo code name:\n` +
        `• Uppercase letters, numbers, underscore only\n` +
        `• 3 to 30 characters\n\n` +
        `Example: LAUNCH2025`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── PROMO REWARD TYPE (inline button from step 2) ──────────────────────
    if (data === 'promo_type_coins' || data === 'promo_type_ton') {
      const session = adminSessions[userId];
      if (!session || session.step !== 'promo_reward_type') {
        return bot.sendMessage(chatId, '⚠️ Session expired. Please start again with /amiadminyes');
      }
      session.data.reward_type = (data === 'promo_type_coins') ? 'coins' : 'ton';
      session.step = 'promo_amount';
      const unit = session.data.reward_type === 'coins' ? 'TR coins (e.g. 5000)' : 'TON (e.g. 0.5)';
      return bot.sendMessage(chatId,
        `📝 *Create Promo Code — Step 3/4*\n\n` +
        `Code: \`${session.data.code}\`\n` +
        `Reward type: *${session.data.reward_type === 'coins' ? '🪙 TR Coins' : '💎 TON'}*\n\n` +
        `Enter the reward amount in ${unit}:`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── LIST PROMOS ────────────────────────────────────────────────────────
    if (data === 'admin_list_promos') {
      const rows = await db.query(
        'SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20'
      );
      if (!rows.rows.length) {
        return bot.sendMessage(chatId, '📋 No promo codes found.');
      }
      let text = '📋 *All Promo Codes:*\n\n';
      rows.rows.forEach(p => {
        const status = p.is_active ? '✅' : '❌';
        const reward = p.reward_type === 'coins'
          ? `${parseInt(p.reward_amount).toLocaleString()} TR`
          : `${parseFloat(p.reward_amount).toFixed(4)} TON`;
        text += `${status} \`${p.code}\`\n`;
        text += `  Reward: ${reward} | Used: ${p.current_activations}/${p.max_activations}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    // ── DELETE PROMO ───────────────────────────────────────────────────────
    if (data === 'admin_delete_promo') {
      adminSessions[userId] = { step: 'delete_promo', data: {} };
      return bot.sendMessage(chatId, '🗑 Enter the promo code to deactivate:');
    }

    // ── RECENT ACTIVATIONS ─────────────────────────────────────────────────
    if (data === 'admin_activations') {
      const rows = await db.query(`
        SELECT pa.activated_at, pa.user_id, pc.code, pc.reward_type, pc.reward_amount
        FROM promo_activations pa
        JOIN promo_codes pc ON pa.promo_id = pc.id
        ORDER BY pa.activated_at DESC LIMIT 20
      `);
      if (!rows.rows.length) return bot.sendMessage(chatId, '📜 No activations yet.');
      let text = '📜 *Recent Activations:*\n\n';
      rows.rows.forEach(a => {
        const reward = a.reward_type === 'coins'
          ? `${parseInt(a.reward_amount).toLocaleString()} TR`
          : `${parseFloat(a.reward_amount).toFixed(4)} TON`;
        text += `• User \`${a.user_id}\` → \`${a.code}\` (+${reward})\n`;
        text += `  ${new Date(a.activated_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    // ── PAYMENT HISTORY ────────────────────────────────────────────────────
    if (data === 'admin_payments') {
      const rows = await db.query(`
        SELECT p.*, u.username, u.first_name
        FROM payments p JOIN users u ON p.user_id = u.id
        WHERE p.status = 'paid'
        ORDER BY p.paid_at DESC LIMIT 20
      `);
      if (!rows.rows.length) return bot.sendMessage(chatId, '💸 No payments yet.');
      let text = '💸 *Recent Payments:*\n\n';
      rows.rows.forEach(p => {
        const name = p.username ? `@${p.username}` : p.first_name;
        text += `• ${name}: *${p.amount_ton} TON* via ${p.provider}\n`;
        text += `  ${new Date(p.paid_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

    // ── USER STATS ─────────────────────────────────────────────────────────
    if (data === 'admin_users') {
      const r = await db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as new_today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')   as new_week,
          COALESCE(SUM(coins), 0) as total_coins
        FROM users
      `);
      const s = r.rows[0];
      return bot.sendMessage(chatId,
        `👥 *User Statistics:*\n\n` +
        `Total: *${s.total}*\n` +
        `New today: *${s.new_today}*\n` +
        `New this week: *${s.new_week}*\n` +
        `TR coins in circulation: *${parseInt(s.total_coins).toLocaleString()}*`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── PENDING WITHDRAWALS ────────────────────────────────────────────────
    if (data === 'admin_withdrawals') {
      const rows = await db.query(`
        SELECT w.*, u.username, u.first_name
        FROM withdrawals w JOIN users u ON w.user_id = u.id
        WHERE w.status = 'pending'
        ORDER BY w.created_at ASC LIMIT 20
      `);
      if (!rows.rows.length) return bot.sendMessage(chatId, '✅ No pending withdrawals!');
      let text = '⏳ *Pending Withdrawals:*\n\n';
      rows.rows.forEach(w => {
        const name = w.username ? `@${w.username}` : w.first_name;
        text += `• ID #${w.id}: ${name}\n`;
        text += `  *${parseFloat(w.net_ton).toFixed(4)} TON* → \`${w.wallet_address}\`\n`;
        text += `  ${new Date(w.created_at).toLocaleDateString()}\n\n`;
      });
      return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    }

  } catch (err) {
    console.error('Callback error:', err);
    bot.sendMessage(chatId, '❌ Error: ' + err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER — admin wizard text input only
// Normal users ka /start upar handle ho chuka hai, yahan sirf admin wizard
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text   = msg.text;

  // Ignore commands — handled by onText above
  if (!text || text.startsWith('/')) return;

  // Only process further if admin AND has an active session
  if (!isAdmin(userId)) return;
  const session = adminSessions[userId];
  if (!session) return;

  try {

    // ── STEP 1: Enter promo code name ──────────────────────────────────────
    if (session.step === 'promo_code') {
      const code = text.trim().toUpperCase();

      if (code.length < 3 || code.length > 30 || !/^[A-Z0-9_]+$/.test(code)) {
        return bot.sendMessage(chatId,
          '❌ Invalid. Use only uppercase letters, numbers, underscore (3–30 chars). Try again:'
        );
      }

      const existing = await db.query(
        'SELECT id FROM promo_codes WHERE UPPER(code) = $1', [code]
      );
      if (existing.rows.length > 0) {
        return bot.sendMessage(chatId,
          `❌ Code "${code}" already exists. Enter a different code:`
        );
      }

      session.data.code = code;
      session.step = 'promo_reward_type';

      return bot.sendMessage(chatId,
        `📝 *Create Promo Code — Step 2/4*\n\n` +
        `Code: \`${code}\`\n\n` +
        `Select the reward type:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🪙 TR Coins', callback_data: 'promo_type_coins' },
              { text: '💎 TON',      callback_data: 'promo_type_ton'   }
            ]]
          }
        }
      );
    }

    // ── STEP 3: Enter reward amount ────────────────────────────────────────
    if (session.step === 'promo_amount') {
      const amount = parseFloat(text.trim());

      if (isNaN(amount) || amount <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid amount. Enter a positive number:');
      }
      if (session.data.reward_type === 'coins' && !Number.isInteger(amount)) {
        return bot.sendMessage(chatId, '❌ TR coins must be a whole number (e.g. 5000). Try again:');
      }

      session.data.amount = amount;
      session.step = 'promo_max';

      const unit = session.data.reward_type === 'coins'
        ? `${parseInt(amount).toLocaleString()} TR coins`
        : `${amount} TON`;

      return bot.sendMessage(chatId,
        `📝 *Create Promo Code — Step 4/4*\n\n` +
        `Code: \`${session.data.code}\`\n` +
        `Reward: *${unit}*\n\n` +
        `Enter max number of activations (e.g. 100):`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── STEP 4: Enter max activations → SAVE ──────────────────────────────
    if (session.step === 'promo_max') {
      const max = parseInt(text.trim());

      if (isNaN(max) || max <= 0) {
        return bot.sendMessage(chatId, '❌ Invalid. Enter a positive whole number:');
      }

      const { code, reward_type, amount } = session.data;

      await db.query(`
        INSERT INTO promo_codes
          (code, reward_type, reward_amount, max_activations, created_by, is_active)
        VALUES ($1, $2, $3, $4, $5, TRUE)
      `, [code, reward_type, amount, max, userId]);

      delete adminSessions[userId];

      const rewardStr = reward_type === 'coins'
        ? `${parseInt(amount).toLocaleString()} TR coins 🪙`
        : `${amount} TON 💎`;

      return bot.sendMessage(chatId,
        `✅ *Promo code created!*\n\n` +
        `Code: \`${code}\`\n` +
        `Reward: *${rewardStr}*\n` +
        `Max uses: *${max}*\n\n` +
        `Share this code with users to redeem in the app.`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── DELETE: Enter code name to deactivate ──────────────────────────────
    if (session.step === 'delete_promo') {
      const code = text.trim().toUpperCase();

      const result = await db.query(
        `UPDATE promo_codes SET is_active = FALSE
         WHERE UPPER(code) = $1 AND is_active = TRUE
         RETURNING code, reward_type, reward_amount`,
        [code]
      );

      delete adminSessions[userId];

      if (!result.rows.length) {
        return bot.sendMessage(chatId,
          `❌ Code "${code}" not found or already inactive.`
        );
      }

      const p = result.rows[0];
      const rewardStr = p.reward_type === 'coins'
        ? `${parseInt(p.reward_amount).toLocaleString()} TR`
        : `${parseFloat(p.reward_amount).toFixed(4)} TON`;

      return bot.sendMessage(chatId,
        `✅ Promo code \`${code}\` deactivated.\nWas giving: ${rewardStr}`,
        { parse_mode: 'Markdown' }
      );
    }

  } catch (err) {
    console.error('Wizard error:', err);
    delete adminSessions[userId];
    bot.sendMessage(chatId, `❌ Error: ${err.message}\n\nPlease start again with /amiadminyes`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

console.log('✅ TRewards bot started');
console.log('Admin IDs:', ADMIN_IDS);
console.log('Frontend URL:', FRONTEND_URL);