/**
 * bot.js
 * Telegram bot: /start, /amiadminyes, promo wizard, admin panel
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./database');

let bot;

// Admin wizard state
const adminState = new Map(); // userId -> { step, data }

function createBot() {
  if (!config.BOT_TOKEN) {
    console.warn('[Bot] BOT_TOKEN not set. Bot disabled.');
    return null;
  }

  bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
  db.setBot(bot);

  // ─── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const userId = msg.from.id;
    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'User';
    const referralParam = match[1] ? match[1].trim() : null;
    let referredBy = null;

    if (referralParam && !isNaN(referralParam)) {
      const refId = parseInt(referralParam);
      if (refId !== userId) {
        referredBy = refId;
      }
    }

    let user = await db.getUser(userId);

    if (!user) {
      user = await db.createUser(userId, name, referredBy);

      // Credit referrer
      if (referredBy) {
        const referrer = await db.getUser(referredBy);
        if (referrer) {
          referrer.friends += 1;
          // Pending referral — will be credited when referee earns coins
          await db.saveUser(referrer);
        }
      }

      await bot.sendMessage(userId,
        `🏆 *Welcome to TRewards, ${name}!*\n\n` +
        `Earn TR coins by completing tasks, spinning the wheel, and inviting friends!\n\n` +
        `💰 *Starting Balance:* 0 TR\n` +
        `🎰 *Free Spins:* 1\n\n` +
        `Tap the button below to open the app:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🚀 Open TRewards App', web_app: { url: config.MINI_APP_URL } }
            ]]
          }
        }
      );
    } else {
      await bot.sendMessage(userId,
        `👋 *Welcome back, ${name}!*\n\n` +
        `💰 *Balance:* ${user.coins.toLocaleString()} TR\n` +
        `🎰 *Spins:* ${user.spins}\n` +
        `🔥 *Streak:* ${user.streak} days`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '🚀 Open TRewards App', web_app: { url: config.MINI_APP_URL } }
            ]]
          }
        }
      );
    }
  });

  // ─── /amiadminyes ──────────────────────────────────────────────────────────
  bot.onText(/\/amiadminyes/, async (msg) => {
    const userId = msg.from.id;
    if (userId !== config.ADMIN_ID) {
      return bot.sendMessage(userId, '❌ Access denied.');
    }
    await sendAdminPanel(userId);
  });

  // ─── Callback queries ──────────────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    if (userId !== config.ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'Access denied.' });
    }

    bot.answerCallbackQuery(query.id);

    if (data === 'admin_panel') {
      await sendAdminPanel(userId);
    } else if (data === 'admin_create_promo') {
      adminState.set(userId, { step: 'promo_code', data: {} });
      await bot.sendMessage(userId, '📝 *Create Promo Code*\n\nStep 1/3: Enter the promo code:', { parse_mode: 'Markdown' });
    } else if (data === 'admin_list_promos') {
      const promos = await db.getAllPromos();
      if (!promos.length) {
        return bot.sendMessage(userId, '📋 No promo codes found.');
      }
      let text = '📋 *Active Promo Codes:*\n\n';
      promos.forEach(p => {
        text += `• \`${p.code}\` — +${p.reward} TR | Used: ${p.uses}/${p.maxUses}\n`;
      });
      await bot.sendMessage(userId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'admin_panel' }]] }
      });
    } else if (data === 'admin_delete_promo') {
      adminState.set(userId, { step: 'delete_promo', data: {} });
      await bot.sendMessage(userId, '🗑️ Enter the promo code to delete:');
    } else if (data === 'admin_activation_history') {
      const promos = await db.getAllPromos();
      let text = '📊 *Activation History:*\n\n';
      promos.forEach(p => {
        text += `*${p.code}*: ${p.uses} activations\n`;
        if (p.usedBy.length) {
          text += `Users: ${p.usedBy.slice(-5).join(', ')}\n`;
        }
        text += '\n';
      });
      await bot.sendMessage(userId, text || 'No data.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'admin_panel' }]] }
      });
    } else if (data === 'admin_total_users') {
      const stats = db.getStats();
      await bot.sendMessage(userId,
        `📊 *Platform Statistics*\n\n` +
        `👥 Total Users: ${stats.totalUsers}\n` +
        `🎟️ Promo Codes: ${stats.totalPromos}\n` +
        `📋 Ad Tasks: ${stats.totalTasks}\n` +
        `💸 Withdrawals: ${stats.totalWithdrawals}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'admin_panel' }]] }
        }
      );
    } else if (data === 'admin_payment_history') {
      await bot.sendMessage(userId, '💳 *Payment History*\n\nNo payments processed yet.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '« Back', callback_data: 'admin_panel' }]] }
      });
    }
  });

  // ─── Text message handler (wizard) ────────────────────────────────────────
  bot.on('message', async (msg) => {
    const userId = msg.from.id;
    if (!msg.text || msg.text.startsWith('/')) return;
    if (userId !== config.ADMIN_ID) return;

    const state = adminState.get(userId);
    if (!state) return;

    const text = msg.text.trim();

    if (state.step === 'promo_code') {
      if (!/^[A-Z0-9_]{2,20}$/i.test(text)) {
        return bot.sendMessage(userId, '❌ Invalid code. Use letters, numbers, underscores (2-20 chars).');
      }
      state.data.code = text.toUpperCase();
      state.step = 'promo_reward';
      adminState.set(userId, state);
      await bot.sendMessage(userId, `✅ Code: \`${state.data.code}\`\n\nStep 2/3: Enter the coin reward (e.g. 500):`, { parse_mode: 'Markdown' });

    } else if (state.step === 'promo_reward') {
      const reward = parseInt(text);
      if (isNaN(reward) || reward <= 0) {
        return bot.sendMessage(userId, '❌ Enter a positive number.');
      }
      state.data.reward = reward;
      state.step = 'promo_maxuses';
      adminState.set(userId, state);
      await bot.sendMessage(userId, `✅ Reward: ${reward} TR\n\nStep 3/3: Enter max uses (e.g. 100, or 0 for unlimited):`);

    } else if (state.step === 'promo_maxuses') {
      const maxUses = parseInt(text);
      if (isNaN(maxUses) || maxUses < 0) {
        return bot.sendMessage(userId, '❌ Enter 0 or a positive number.');
      }
      state.data.maxUses = maxUses === 0 ? 999999 : maxUses;
      adminState.delete(userId);

      const existing = await db.getPromo(state.data.code);
      if (existing) {
        return bot.sendMessage(userId, `❌ Promo code \`${state.data.code}\` already exists.`, { parse_mode: 'Markdown' });
      }

      await db.savePromo({
        code: state.data.code,
        reward: state.data.reward,
        maxUses: state.data.maxUses,
        uses: 0,
        usedBy: [],
        messageId: 0,
        active: true,
      });

      await bot.sendMessage(userId,
        `✅ *Promo Created!*\n\nCode: \`${state.data.code}\`\nReward: ${state.data.reward} TR\nMax Uses: ${state.data.maxUses}`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '« Admin Panel', callback_data: 'admin_panel' }]] }
        }
      );

    } else if (state.step === 'delete_promo') {
      adminState.delete(userId);
      const code = text.toUpperCase();
      const deleted = await db.deletePromo(code);
      if (deleted) {
        await bot.sendMessage(userId, `✅ Promo \`${code}\` deleted.`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '« Admin Panel', callback_data: 'admin_panel' }]] }
        });
      } else {
        await bot.sendMessage(userId, `❌ Promo \`${code}\` not found.`, { parse_mode: 'Markdown' });
      }
    }
  });

  console.log('[Bot] Telegram bot started (polling).');
  return bot;
}

async function sendAdminPanel(userId) {
  const stats = db.getStats();
  await bot.sendMessage(userId,
    `🔐 *TRewards Admin Panel*\n\n` +
    `👥 Users: ${stats.totalUsers}\n` +
    `🎟️ Promos: ${stats.totalPromos}\n` +
    `📋 Tasks: ${stats.totalTasks}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Create Promo Code', callback_data: 'admin_create_promo' }],
          [{ text: '📋 List Promo Codes',  callback_data: 'admin_list_promos'   }],
          [{ text: '🗑️ Delete Promo Code', callback_data: 'admin_delete_promo'  }],
          [{ text: '📊 Activation History',callback_data: 'admin_activation_history' }],
          [{ text: '💳 Payment History',   callback_data: 'admin_payment_history' }],
          [{ text: '👥 Total Users',       callback_data: 'admin_total_users'   }],
        ]
      }
    }
  );
}

function getBot() {
  return bot;
}

module.exports = { createBot, getBot };