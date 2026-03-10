require('dotenv').config();

const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  DATA_CHANNEL_ID: process.env.DATA_CHANNEL_ID || '',
  BOT_USERNAME: process.env.BOT_USERNAME || 'trewards_ton_bot',
  MINI_APP_URL: process.env.MINI_APP_URL || 'http://localhost:3000',
  PORT: parseInt(process.env.PORT) || 3000,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || 'trewards_secret',
  ADMIN_ID: parseInt(process.env.ADMIN_ID) || 0,

  // Coin economy
  COINS_PER_TON: 2500000, // 1 TON = 2,500,000 TR => 1 TR = 0.0000004 TON
  TON_PER_COIN: 0.0000004,

  // Spin rewards (server-side probabilities)
  SPIN_SEGMENTS: [
    { value: 10,  weight: 30 },
    { value: 50,  weight: 25 },
    { value: 80,  weight: 20 },
    { value: 100, weight: 15 },
    { value: 300, weight: 7  },
    { value: 500, weight: 3  },
  ],

  // Streak reward
  STREAK_COINS: 10,
  STREAK_SPINS: 1,

  // Withdrawal tiers
  WITHDRAWAL_TIERS: [
    { coins: 250000,  ton: 0.10 },
    { coins: 500000,  ton: 0.20 },
    { coins: 750000,  ton: 0.30 },
    { coins: 1000000, ton: 0.40 },
  ],
  WITHDRAWAL_FEE: 0.05,

  // Task rewards
  TASK_REWARDS: {
    join_channel: 1000,
    join_group:   1000,
    play_game:    1000,
    visit_website: 500,
    daily_checkin: 10,
    check_updates: 20,
    share_friends: 30,
  },

  // Referral commission
  REFERRAL_PERCENT: 30,

  // Advertiser task cost per completion
  TASK_COST_PER_COMPLETION: 0.001, // TON
};

module.exports = config;