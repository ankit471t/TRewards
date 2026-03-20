/**
 * TRewards Telegram Bot
 * node-telegram-bot-api
 * 
 * Install: npm install node-telegram-bot-api axios dotenv
 * Run:     node bot.js
 */

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_BASE = process.env.BACKEND_URL || "http://localhost:8000";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(Number).filter(Boolean);
const WEBAPP_URL = process.env.WEBAPP_URL || "https://trewards.onrender.com";
const CHANNEL_ID = process.env.WITHDRAWAL_CHANNEL_ID || "";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── State for wizard ─────────────────────────────────────
const promoWizard = {}; // userId → wizard state

// ─── /start ───────────────────────────────────────────────
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const param = match[1]?.trim() || "";
  const referrerId = param && !isNaN(param) && Number(param) !== userId ? Number(param) : null;

  try {
    await axios.post(`${API_BASE}/api/user`, {
      user_id: userId,
      first_name: msg.from.first_name || "",
      last_name: msg.from.last_name || "",
      username: msg.from.username || "",
    });

    // Set referrer if valid
    if (referrerId) {
      await axios.post(`${API_BASE}/api/set-referrer`, {
        user_id: userId,
        referrer_id: referrerId,
      }).catch(() => {});
    }
  } catch (e) {
    console.error("Register user error:", e.message);
  }

  const firstName = msg.from.first_name || "Friend";
  const welcomeText =
    `🏆 *Welcome to TRewards, ${firstName}!*\n\n` +
    `Earn *TR Coins* by completing tasks, spinning the wheel, and inviting friends.\n\n` +
    `💎 *Withdraw your coins as TON cryptocurrency!*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔥 Daily streak bonuses\n` +
    `🎰 Spin the wheel for prizes\n` +
    `👥 30% referral commission\n` +
    `📢 Advertiser task rewards\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Tap the button below to open TRewards! 👇`;

  const keyboard = {
    inline_keyboard: [[
      {
        text: "🚀 Open TRewards",
        web_app: { url: WEBAPP_URL }
      }
    ], [
      {
        text: "📢 TRewards Channel",
        url: "https://t.me/trewards_ton"
      }
    ]]
  };

  await bot.sendMessage(chatId, welcomeText, {
    parse_mode: "Markdown",
    reply_markup: keyboard
  });
});

// ─── /amiadminyes ──────────────────────────────────────────
bot.onText(/\/amiadminyes/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ADMIN_IDS.includes(userId)) {
    return bot.sendMessage(chatId, "⛔ Access denied.");
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: "🎁 Create Promo Code", callback_data: "admin_promo_create" }],
      [{ text: "📋 List Promo Codes", callback_data: "admin_promo_list" }],
      [{ text: "🗑 Delete Promo Code", callback_data: "admin_promo_delete" }],
      [{ text: "📈 Activation History", callback_data: "admin_promo_history" }],
      [{ text: "💸 Payment History", callback_data: "admin_payment_history" }],
      [{ text: "👥 Total Users", callback_data: "admin_total_users" }],
    ]
  };

  await bot.sendMessage(chatId,
    "⚙️ *TRewards Admin Panel*\n\nWelcome, Admin. Choose an action:",
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
});

// ─── Callback queries ──────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const msgId = query.message.message_id;

  await bot.answerCallbackQuery(query.id);

  // ── Withdrawal admin actions ──
  if (data.startsWith("wd_")) {
    if (!ADMIN_IDS.includes(userId)) {
      return bot.answerCallbackQuery(query.id, { text: "⛔ Not authorized", show_alert: true });
    }
    const [, action, wId] = data.split("_");
    const withdrawalId = parseInt(wId);

    const res = await axios.post(`${API_BASE}/api/withdrawal-action`, {
      admin_id: userId,
      withdrawal_id: withdrawalId,
      action
    }).catch(e => ({ data: { error: e.message } }));

    if (res.data?.error) {
      return bot.sendMessage(chatId, `❌ Error: ${res.data.error}`);
    }

    if (action === "complete") {
      // Remove inline keyboard from message (buttons disappear)
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: msgId }
      );
      await bot.editMessageText(
        query.message.text + "\n\n✅ *COMPLETED — Payment sent*",
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      );
    } else if (action === "approve") {
      await bot.editMessageText(
        query.message.text + "\n\n✅ *APPROVED — Processing...*",
        {
          chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "❌ Decline", callback_data: `wd_decline_${wId}` },
              { text: "💸 Complete", callback_data: `wd_complete_${wId}` }
            ]]
          }
        }
      );
    } else if (action === "decline") {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: chatId, message_id: msgId }
      );
      await bot.editMessageText(
        query.message.text + "\n\n❌ *DECLINED — Coins refunded*",
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      );
    }
    return;
  }

  // ── Admin panel actions ──
  if (!ADMIN_IDS.includes(userId)) return;

  if (data === "admin_promo_create") {
    promoWizard[userId] = { step: 1 };
    await bot.sendMessage(chatId,
      "🎁 *Create Promo Code — Step 1/4*\n\nEnter the promo code name (e.g. WELCOME100):",
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "admin_promo_list") {
    try {
      const r = await axios.get(`${API_BASE}/api/admin/promo-codes?admin_id=${userId}`);
      const codes = r.data.codes || [];
      if (!codes.length) return bot.sendMessage(chatId, "📋 No promo codes found.");
      const text = codes.map(c =>
        `• \`${c.code}\` — ${c.reward_amount} ${c.reward_type.toUpperCase()}\n  Used: ${c.used}/${c.max_activations} | ${c.is_active ? '✅ Active' : '❌ Inactive'}`
      ).join("\n\n");
      return bot.sendMessage(chatId, `📋 *Promo Codes:*\n\n${text}`, { parse_mode: "Markdown" });
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
  }

  if (data === "admin_promo_delete") {
    promoWizard[userId] = { step: "delete" };
    return bot.sendMessage(chatId, "🗑 Enter the promo code to delete:");
  }

  if (data === "admin_promo_history") {
    try {
      const r = await axios.get(`${API_BASE}/api/admin/promo-history?admin_id=${userId}`);
      const acts = r.data.activations || [];
      if (!acts.length) return bot.sendMessage(chatId, "No activations yet.");
      const text = acts.slice(0, 20).map(a =>
        `• ${a.code} → User ${a.user_id} at ${new Date(a.created_at).toLocaleDateString()}`
      ).join("\n");
      return bot.sendMessage(chatId, `📈 *Recent Activations:*\n\n${text}`, { parse_mode: "Markdown" });
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
  }

  if (data === "admin_payment_history") {
    try {
      const r = await axios.get(`${API_BASE}/api/admin/payments?admin_id=${userId}`);
      const pays = r.data.payments || [];
      if (!pays.length) return bot.sendMessage(chatId, "No payments yet.");
      const text = pays.slice(0, 10).map(p =>
        `• ${p.amount} TON via ${p.method} — ${p.status} (User ${p.user_id})`
      ).join("\n");
      return bot.sendMessage(chatId, `💸 *Recent Payments:*\n\n${text}`, { parse_mode: "Markdown" });
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
  }

  if (data === "admin_total_users") {
    try {
      const r = await axios.get(`${API_BASE}/api/admin/stats?admin_id=${userId}`);
      const s = r.data;
      return bot.sendMessage(chatId,
        `👥 *Platform Stats*\n\n` +
        `Total Users: *${s.total_users}*\n` +
        `Active Today: *${s.active_today}*\n` +
        `Total Withdrawals: *${s.total_withdrawals} TON*\n` +
        `Total Tasks Completed: *${s.total_completions}*`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
  }

  // Reward type selection for promo wizard
  if (data.startsWith("promo_type_") && promoWizard[userId]?.step === 2) {
    promoWizard[userId].reward_type = data.replace("promo_type_", "");
    promoWizard[userId].step = 3;
    await bot.sendMessage(chatId,
      `🎁 *Create Promo Code — Step 3/4*\n\nEnter reward amount (e.g. 5000 for TR, 0.5 for TON):`,
      { parse_mode: "Markdown" }
    );
  }
});

// ─── Message handler (promo wizard) ───────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  if (!text || text.startsWith("/")) return;
  if (!promoWizard[userId]) return;
  if (!ADMIN_IDS.includes(userId)) return;

  const wizard = promoWizard[userId];

  if (wizard.step === "delete") {
    delete promoWizard[userId];
    try {
      await axios.delete(`${API_BASE}/api/admin/promo-codes/${text.trim().toUpperCase()}?admin_id=${userId}`);
      return bot.sendMessage(chatId, `✅ Promo code \`${text.trim().toUpperCase()}\` deleted.`, { parse_mode: "Markdown" });
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
  }

  if (wizard.step === 1) {
    wizard.code = text.trim().toUpperCase();
    wizard.step = 2;
    await bot.sendMessage(chatId,
      `🎁 *Create Promo Code — Step 2/4*\n\nCode: \`${wizard.code}\`\n\nSelect reward type:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "🪙 TR Coins", callback_data: "promo_type_tr" },
            { text: "💎 TON", callback_data: "promo_type_ton" }
          ]]
        }
      }
    );
    return;
  }

  if (wizard.step === 3) {
    const amount = parseFloat(text.trim());
    if (isNaN(amount) || amount <= 0) {
      return bot.sendMessage(chatId, "❌ Invalid amount. Enter a valid number:");
    }
    wizard.reward_amount = amount;
    wizard.step = 4;
    await bot.sendMessage(chatId,
      `🎁 *Create Promo Code — Step 4/4*\n\nEnter maximum number of activations (e.g. 100):`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (wizard.step === 4) {
    const maxAct = parseInt(text.trim());
    if (isNaN(maxAct) || maxAct <= 0) {
      return bot.sendMessage(chatId, "❌ Invalid number. Enter a positive integer:");
    }
    wizard.max_activations = maxAct;

    // Create promo
    delete promoWizard[userId];
    try {
      await axios.post(`${API_BASE}/api/admin/create-promo`, {
        admin_id: userId,
        code: wizard.code,
        reward_type: wizard.reward_type,
        reward_amount: wizard.reward_amount,
        max_activations: wizard.max_activations
      });
      await bot.sendMessage(chatId,
        `✅ *Promo Code Created!*\n\n` +
        `Code: \`${wizard.code}\`\n` +
        `Reward: ${wizard.reward_amount} ${wizard.reward_type.toUpperCase()}\n` +
        `Max Uses: ${wizard.max_activations}`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error creating promo: ${e.message}`);
    }
    return;
  }
});

console.log("🤖 TRewards Bot started!");