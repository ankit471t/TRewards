/* ════════════════════════════════════════
   config.js — App Configuration
   ════════════════════════════════════════ */

const CONFIG = {
  API_URL:       'https://trewards-api.onrender.com',   // ← your backend URL
  BOT_USERNAME:  'trewards_ton_bot',
  CHANNEL_URL:   'https://t.me/trewards_tonfirst',

  SPIN_PRIZES:   [10, 50, 80, 100, 300, 500],

  WITHDRAWAL_TIERS: [
    { coins: 250000,  ton: 0.10, net: 0.05 },
    { coins: 500000,  ton: 0.20, net: 0.15 },
    { coins: 750000,  ton: 0.30, net: 0.25 },
    { coins: 1000000, ton: 0.40, net: 0.35 },
  ],

  TON_RATE: 0.0000004,  // coins → TON conversion
};