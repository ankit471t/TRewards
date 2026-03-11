// bot.js — TRewards Telegram Bot
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./telegramDB');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
const BOT_USERNAME = process.env.BOT_USERNAME || 'trewards_ton_bot';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://trewards.onrender.com';

db.initShards();

// ─────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  const param = (match[1] || '').trim();
  const referrerId = param && !isNaN(param) && parseInt(param) !== userId
    ? parseInt(param) : null;

  try {
    const user = await db.getOrCreateUser(userId, username, referrerId);

    const welcomeText = referrerId
      ? `🎉 *Welcome to TRewards!*\n\nYou were invited by a friend and both of you get bonus coins!\n\n💰 Your Balance: *${user.coins} TR*\n🎰 Spins: *${user.spins}*\n\nStart earning now! 👇`
      : `👋 *Welcome to TRewards!*\n\nEarn TR coins by completing tasks, inviting friends, and spinning the wheel.\nWithdraw as TON cryptocurrency! 🚀\n\n💰 Your Balance: *${user.coins} TR*\n\nLet's go! 👇`;

    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {
            text: '🎮 Open TRewards',
            web_app: { url: `${FRONTEND_URL}?ref=${userId}` },
          },
        ]],
      },
    });
  } catch (err) {
    console.error('[Bot] /start error:', err.message);
    await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
  }
});

// ─────────────────────────────────────────────
// Admin Panel
// ─────────────────────────────────────────────
bot.onText(/\/amiadminyes/, async (msg) => {
  const userId = msg.from.id;
  if (!ADMIN_IDS.includes(userId)) {
    return bot.sendMessage(msg.chat.id, '❌ Unauthorized');
  }

  await showAdminPanel(msg.chat.id);
});

async function showAdminPanel(chatId) {
  const stats = db.getUserStats();
  await bot.sendMessage(
    chatId,
    `🛡 *TRewards Admin Panel*\n\n👥 Total Users: *${stats.total_users}*\n📦 Shards: *${stats.shards.length}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Create Promo (Coins)', callback_data: 'admin:promo:coins' },
            { text: '➕ Create Promo (TON)', callback_data: 'admin:promo:ton' },
          ],
          [
            { text: '📋 List Promos', callback_data: 'admin:list_promos' },
            { text: '🗑 Delete Promo', callback_data: 'admin:delete_promo' },
          ],
          [
            { text: '📊 Stats', callback_data: 'admin:stats' },
            { text: '📡 Add Channel', callback_data: 'admin:add_channel' },
          ],
          [
            { text: '📜 Activation History', callback_data: 'admin:activations' },
            { text: '💸 Withdrawal Queue', callback_data: 'admin:withdrawals' },
          ],
        ],
      },
    }
  );
}

// ─────────────────────────────────────────────
// Conversation State Machine
// ─────────────────────────────────────────────
const conversations = new Map(); // userId → state

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  await bot.answerCallbackQuery(query.id);

  if (!ADMIN_IDS.includes(userId)) return;

  if (data === 'admin:promo:coins') {
    conversations.set(userId, { step: 'promo_name', type: 'coins' });
    await bot.sendMessage(chatId, '📝 Enter promo code name (e.g. SUMMER2025):');
  }

  if (data === 'admin:promo:ton') {
    conversations.set(userId, { step: 'promo_name', type: 'ton' });
    await bot.sendMessage(chatId, '📝 Enter promo code name (e.g. TONFEST):');
  }

  if (data === 'admin:list_promos') {
    const promos = db.listPromos();
    if (!promos.length) return bot.sendMessage(chatId, '📭 No promos yet.');
    const text = promos.map(p =>
      `• \`${p.code}\` — ${p.reward_amount} ${p.reward_type === 'ton' ? 'TON' : 'TR'} (${p.activations}/${p.max_activations}) ${p.active ? '✅' : '❌'}`
    ).join('\n');
    await bot.sendMessage(chatId, `*Promo Codes:*\n\n${text}`, { parse_mode: 'Markdown' });
  }

  if (data === 'admin:delete_promo') {
    conversations.set(userId, { step: 'delete_promo' });
    await bot.sendMessage(chatId, '🗑 Enter promo code to delete:');
  }

  if (data === 'admin:stats') {
    const stats = db.getUserStats();
    const shardText = stats.shards.map(s =>
      `Channel ${s.channelId}: ${s.used}/${s.capacity} users`
    ).join('\n');
    await bot.sendMessage(
      chatId,
      `📊 *Stats*\n\n👥 Total Users: ${stats.total_users}\n\n*Shards:*\n${shardText}`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'admin:add_channel') {
    conversations.set(userId, { step: 'add_channel' });
    await bot.sendMessage(chatId, '📡 Enter channel ID (e.g. -1001234567890):');
  }

  if (data === 'admin:activations') {
    const promos = db.listPromos();
    const text = promos.map(p =>
      `\`${p.code}\`: ${p.activations} activations`
    ).join('\n') || 'No data';
    await bot.sendMessage(chatId, `📜 *Activation History:*\n\n${text}`, { parse_mode: 'Markdown' });
  }

  if (data === 'admin:withdrawals') {
    await bot.sendMessage(chatId, '💸 Withdrawal queue is managed in the admin channel. Check there for pending requests.');
  }
});

// ─────────────────────────────────────────────
// Message Handler (Conversation steps)
// ─────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text.trim();

  if (!ADMIN_IDS.includes(userId)) return;

  const state = conversations.get(userId);
  if (!state) return;

  // Promo wizard
  if (state.step === 'promo_name') {
    state.code = text.toUpperCase();
    state.step = 'promo_amount';
    conversations.set(userId, state);
    const unit = state.type === 'ton' ? 'TON' : 'TR coins';
    return bot.sendMessage(chatId, `💰 Enter reward amount (in ${unit}):`);
  }

  if (state.step === 'promo_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, '❌ Invalid amount. Try again:');
    }
    state.amount = amount;
    state.step = 'promo_max';
    conversations.set(userId, state);
    return bot.sendMessage(chatId, '🔢 Max activations (how many users can use this):');
  }

  if (state.step === 'promo_max') {
    const max = parseInt(text);
    if (isNaN(max) || max <= 0) {
      return bot.sendMessage(chatId, '❌ Invalid number. Try again:');
    }
    try {
      const promo = db.createPromo(state.code, state.amount, max, state.type);
      conversations.delete(userId);
      const unit = state.type === 'ton' ? 'TON' : 'TR';
      await bot.sendMessage(
        chatId,
        `✅ *Promo Created!*\n\nCode: \`${promo.code}\`\nReward: ${promo.reward_amount} ${unit}\nMax Uses: ${max}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      conversations.delete(userId);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // Delete promo
  if (state.step === 'delete_promo') {
    try {
      db.deletePromo(text.toUpperCase());
      conversations.delete(userId);
      await bot.sendMessage(chatId, `✅ Promo \`${text.toUpperCase()}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      conversations.delete(userId);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // Add channel shard
  if (state.step === 'add_channel') {
    try {
      db.addShard(text, 2000);
      conversations.delete(userId);
      await bot.sendMessage(chatId, `✅ Channel \`${text}\` added as storage shard.`, { parse_mode: 'Markdown' });
    } catch (err) {
      conversations.delete(userId);
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }
});

console.log('[Bot] TRewards bot started');