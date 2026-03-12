/* ═══════════════════════════════════════
   TREWARDS — BOT.JS
   Telegram Bot Handler
═══════════════════════════════════════ */

'use strict';

const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(Boolean);
const BOT_USERNAME = process.env.BOT_USERNAME || 'trewards_ton_bot';
const APP_URL = process.env.APP_URL || 'https://your-app-url.com';

// In-memory state for admin wizard sessions
const adminSessions = new Map();

module.exports = function setupBot(bot, pool, db) {
  // ── /start ──────────────────────────────────────────────────────
  bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const userId = msg.from.id;
    const referralId = match?.[1] ? parseInt(match[1]) : null;

    try {
      let user = await db.getUser(userId);

      if (!user) {
        // New user - register
        const actualReferrer = referralId && referralId !== userId ? referralId : null;

        user = await db.createUser({
          telegram_id: userId,
          first_name: msg.from.first_name || '',
          last_name: msg.from.last_name || '',
          username: msg.from.username || '',
          referrer_id: actualReferrer,
        });

        // Notify referrer
        if (actualReferrer) {
          try {
            await bot.sendMessage(actualReferrer,
              `🎉 *New referral!*\n\n${msg.from.first_name} joined using your link!\nYou'll earn 30% of their coin rewards automatically.`,
              { parse_mode: 'Markdown' }
            );
          } catch { /* referrer may have blocked bot */ }
        }
      }

      // Send welcome message
      await bot.sendMessage(userId,
        `🏆 *Welcome to TRewards!*\n\n` +
        `Earn TR coins by completing tasks, spinning the wheel, and inviting friends!\n\n` +
        `💰 *Your Balance:* ${(user.coins || 0).toLocaleString()} TR\n` +
        `🔥 *Streak:* ${user.streak_count || 0} days\n` +
        `🎰 *Spins:* ${user.spins || 0}\n\n` +
        `Tap the button below to open TRewards 👇`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{
              text: '🚀 Open TRewards',
              web_app: { url: APP_URL }
            }]]
          }
        }
      );
    } catch (e) {
      console.error('Start command error:', e);
      await bot.sendMessage(userId, '⚠️ Something went wrong. Please try again.');
    }
  });

  // ── Admin Command ─────────────────────────────────────────────
  bot.onText(/^\/amiadminyes$/, async (msg) => {
    const userId = msg.from.id;
    if (!ADMIN_IDS.includes(userId)) {
      return bot.sendMessage(userId, '❌ Access denied.');
    }

    await showAdminPanel(bot, userId, pool);
  });

  // ── Callback Query Handler ────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    if (!ADMIN_IDS.includes(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Access denied', show_alert: true });
    }

    await bot.answerCallbackQuery(query.id);

    if (data === 'admin_panel') {
      return showAdminPanel(bot, userId, pool, query.message.message_id);
    }

    if (data === 'admin_create_promo') {
      adminSessions.set(userId, { step: 'name', type: 'create_promo' });
      return bot.sendMessage(userId,
        `📝 *Create Promo Code*\n\nStep 1/4: Enter the promo code name (e.g. SUMMER2024):\n\nUse uppercase letters and numbers only.`,
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_list_promos') {
      const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 20');
      if (!rows.length) {
        return bot.sendMessage(userId, '📋 No promo codes found.', {
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
        });
      }
      const list = rows.map(p =>
        `• \`${p.code}\` — ${p.reward_amount} ${p.reward_type === 'ton' ? 'TON' : 'TR'} — ${p.activation_count}/${p.max_activations || '∞'} uses — ${p.is_active ? '✅' : '❌'}`
      ).join('\n');
      return bot.sendMessage(userId, `📋 *Promo Codes:*\n\n${list}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
      });
    }

    if (data === 'admin_delete_promo') {
      adminSessions.set(userId, { step: 'delete_code', type: 'delete_promo' });
      return bot.sendMessage(userId, '🗑 Enter the promo code to delete:');
    }

    if (data === 'admin_activation_history') {
      const { rows } = await pool.query(`
        SELECT pa.*, pc.code, pc.reward_amount, pc.reward_type,
               u.first_name, u.username
        FROM promo_activations pa
        JOIN promo_codes pc ON pa.promo_code_id = pc.id
        JOIN users u ON pa.telegram_id = u.telegram_id
        ORDER BY pa.activated_at DESC LIMIT 15
      `);
      if (!rows.length) return bot.sendMessage(userId, '📊 No activations yet.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
      });
      const hist = rows.map(r =>
        `• ${r.first_name} (@${r.username || 'N/A'}) — \`${r.code}\` — ${r.reward_amount} ${r.reward_type === 'ton' ? 'TON' : 'TR'} — ${new Date(r.activated_at).toLocaleDateString()}`
      ).join('\n');
      return bot.sendMessage(userId, `📊 *Recent Activations:*\n\n${hist}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
      });
    }

    if (data === 'admin_payment_history') {
      const { rows } = await pool.query(`
        SELECT p.*, u.first_name, u.username
        FROM payments p
        JOIN users u ON p.telegram_id = u.telegram_id
        ORDER BY p.created_at DESC LIMIT 15
      `);
      if (!rows.length) return bot.sendMessage(userId, '💳 No payments yet.', {
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
      });
      const hist = rows.map(r =>
        `• ${r.first_name} — ${r.amount} TON via ${r.provider} — ${r.status} — ${new Date(r.created_at).toLocaleDateString()}`
      ).join('\n');
      return bot.sendMessage(userId, `💳 *Payment History:*\n\n${hist}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
      });
    }

    if (data === 'admin_total_users') {
      const { rows: [stats] } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as week,
          COALESCE(SUM(coins), 0) as total_coins,
          COALESCE(SUM(ton_balance), 0) as total_ton
        FROM users
      `);
      return bot.sendMessage(userId,
        `👥 *User Statistics:*\n\n` +
        `Total Users: *${stats.total}*\n` +
        `New Today: *${stats.today}*\n` +
        `New This Week: *${stats.week}*\n\n` +
        `Total TR Coins: *${parseInt(stats.total_coins).toLocaleString()}*\n` +
        `Total TON Balance: *${parseFloat(stats.total_ton).toFixed(3)} TON*`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
        }
      );
    }
  });

  // ── Message Handler (Wizard steps) ───────────────────────────
  bot.on('message', async (msg) => {
    const userId = msg.from.id;
    if (!msg.text || msg.text.startsWith('/')) return;
    if (!ADMIN_IDS.includes(userId)) return;

    const session = adminSessions.get(userId);
    if (!session) return;

    if (session.type === 'create_promo') {
      await handlePromoWizard(bot, msg, userId, session, pool);
    } else if (session.type === 'delete_promo') {
      await handleDeletePromo(bot, msg, userId, session, pool);
    }
  });
};

// ── ADMIN PANEL ──────────────────────────────────────────────────
async function showAdminPanel(bot, userId, pool, editMessageId = null) {
  const { rows: [stats] } = await pool.query('SELECT COUNT(*) as total FROM users');
  const { rows: [pending] } = await pool.query("SELECT COUNT(*) as cnt FROM withdrawals WHERE status = 'pending'");

  const text =
    `🛡 *TRewards Admin Panel*\n\n` +
    `👥 Total Users: *${stats.total}*\n` +
    `⏳ Pending Withdrawals: *${pending.cnt}*\n\n` +
    `Select an action:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🎟 Create Promo', callback_data: 'admin_create_promo' },
        { text: '📋 List Promos', callback_data: 'admin_list_promos' },
      ],
      [
        { text: '🗑 Delete Promo', callback_data: 'admin_delete_promo' },
        { text: '📊 Activation History', callback_data: 'admin_activation_history' },
      ],
      [
        { text: '💳 Payment History', callback_data: 'admin_payment_history' },
        { text: '👥 Total Users', callback_data: 'admin_total_users' },
      ],
    ]
  };

  if (editMessageId) {
    return bot.editMessageText(text, {
      chat_id: userId,
      message_id: editMessageId,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    }).catch(() => bot.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: keyboard }));
  } else {
    return bot.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }
}

// ── PROMO WIZARD ─────────────────────────────────────────────────
async function handlePromoWizard(bot, msg, userId, session, pool) {
  const text = msg.text.trim();

  if (session.step === 'name') {
    const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || code.length < 3 || code.length > 20) {
      return bot.sendMessage(userId, '❌ Code must be 3-20 alphanumeric characters. Try again:');
    }

    // Check if exists
    const { rows } = await pool.query('SELECT id FROM promo_codes WHERE code = $1', [code]);
    if (rows.length) {
      return bot.sendMessage(userId, '❌ Code already exists. Enter a different name:');
    }

    session.code = code;
    session.step = 'reward_type';
    adminSessions.set(userId, session);
    return bot.sendMessage(userId,
      `✅ Code: \`${code}\`\n\nStep 2/4: Select reward type:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🪙 TR Coins', callback_data: 'promo_type_coins' }],
            [{ text: '💎 TON', callback_data: 'promo_type_ton' }],
          ]
        }
      }
    );
  }

  if (session.step === 'reward_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(userId, '❌ Enter a valid positive number:');
    }
    if (session.reward_type === 'ton' && amount > 1000) {
      return bot.sendMessage(userId, '❌ Max 1000 TON per promo. Enter a smaller amount:');
    }
    if (session.reward_type === 'coins' && amount > 10000000) {
      return bot.sendMessage(userId, '❌ Max 10,000,000 TR per promo. Enter a smaller amount:');
    }

    session.reward_amount = amount;
    session.step = 'max_activations';
    adminSessions.set(userId, session);
    return bot.sendMessage(userId,
      `✅ Reward: ${amount} ${session.reward_type === 'ton' ? 'TON' : 'TR'}\n\nStep 3/4: Enter max activations (or "unlimited" for no limit):`,
      { parse_mode: 'Markdown' }
    );
  }

  if (session.step === 'max_activations') {
    let maxActivations = null;
    if (text.toLowerCase() !== 'unlimited') {
      maxActivations = parseInt(text);
      if (isNaN(maxActivations) || maxActivations < 1) {
        return bot.sendMessage(userId, '❌ Enter a valid number or "unlimited":');
      }
    }

    // Create promo
    try {
      await pool.query(`
        INSERT INTO promo_codes (code, reward_amount, reward_type, max_activations, is_active)
        VALUES ($1, $2, $3, $4, true)
      `, [session.code, session.reward_amount, session.reward_type, maxActivations]);

      adminSessions.delete(userId);
      return bot.sendMessage(userId,
        `🎉 *Promo Code Created!*\n\n` +
        `Code: \`${session.code}\`\n` +
        `Reward: *${session.reward_amount} ${session.reward_type === 'ton' ? 'TON' : 'TR'}*\n` +
        `Max Uses: *${maxActivations || 'Unlimited'}*\n` +
        `Status: ✅ Active`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Panel', callback_data: 'admin_panel' }]] }
        }
      );
    } catch (e) {
      console.error('Create promo error:', e);
      adminSessions.delete(userId);
      return bot.sendMessage(userId, '❌ Failed to create promo code. Please try again.');
    }
  }
}

// Handle reward type selection via callback
// We need to also handle the inline callback for promo type selection
const originalCallbackHandler = module.exports;
// This is handled by patching the callback_query listener above
// For reward_type selection, add these cases to the callback_query handler in bot.js
// 'promo_type_coins' and 'promo_type_ton'

async function handleDeletePromo(bot, msg, userId, session, pool) {
  const code = msg.text.trim().toUpperCase();
  try {
    const { rows: [promo] } = await pool.query('SELECT id FROM promo_codes WHERE code = $1', [code]);
    if (!promo) {
      adminSessions.delete(userId);
      return bot.sendMessage(userId, `❌ Promo code \`${code}\` not found.`, { parse_mode: 'Markdown' });
    }
    await pool.query('UPDATE promo_codes SET is_active = false WHERE code = $1', [code]);
    adminSessions.delete(userId);
    return bot.sendMessage(userId, `✅ Promo code \`${code}\` deactivated.`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '◀️ Back', callback_data: 'admin_panel' }]] }
    });
  } catch (e) {
    adminSessions.delete(userId);
    return bot.sendMessage(userId, '❌ Error deleting promo code.');
  }
}

// Patch: export callback extension for promo type
module.exports.handlePromoTypeCallback = async function(bot, query, userId, data, adminSessions, pool) {
  if (data === 'promo_type_coins' || data === 'promo_type_ton') {
    const session = adminSessions.get(userId);
    if (!session || session.step !== 'reward_type') return;

    session.reward_type = data === 'promo_type_coins' ? 'coins' : 'ton';
    session.step = 'reward_amount';
    adminSessions.set(userId, session);

    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(userId,
      `✅ Type: ${session.reward_type === 'ton' ? '💎 TON' : '🪙 TR Coins'}\n\nStep 3/4: Enter reward amount:`,
      { parse_mode: 'Markdown' }
    );
  }
};