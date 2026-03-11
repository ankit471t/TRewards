/* ════════════════════════════════════════
   app.js — Main Initializer
   ════════════════════════════════════════ */

// Telegram WebApp setup
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0A0800');
  tg.setBackgroundColor('#0A0800');
}

// ── BOOTSTRAP ─────────────────────────────
async function init() {
  applyI18n();

  // Get referrer from Telegram start_param or URL
  const startParam  = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('ref');
  const referrerId  = startParam && !isNaN(startParam) ? parseInt(startParam) : null;

  try {
    const data = await apiInit(referrerId);
    if (data.success) {
      State.user = data.user;
    } else {
      throw new Error('Init failed');
    }
  } catch {
    // Demo mode — no backend needed
    State.user = _demoUser();
    toast('Demo mode — connect backend', 'info');
  }

  // Render all sections
  renderHome();
  renderFriends();
  renderWallet();

  // Draw wheel (canvas)
  drawWheel();
}

function _demoUser() {
  return {
    user_id:          tg?.initDataUnsafe?.user?.id || 99999,
    username:         tg?.initDataUnsafe?.user?.username || 'demo_user',
    coins:            1250,
    spins:            3,
    ton_balance:      0.50,
    daily_streak:     3,
    referral_earnings:340,
    pending_referral: 120,
    last_streak_claim:null,
    completed_tasks:  [],
    claimed_promos:   [],
    referrals: [
      { user_id: 111, username: 'alice', coins: 800 },
      { user_id: 222, username: 'bob',   coins: 420 },
    ],
    transactions: [
      { id:1, type:'credit',     description:'Welcome bonus',    amount:100,  date: new Date().toISOString() },
      { id:2, type:'credit',     description:'Spin wheel',       amount:50,   date: new Date().toISOString() },
      { id:3, type:'ton_credit', description:'TON top-up',       amount:0.5,  date: new Date().toISOString() },
      { id:4, type:'debit',      description:'Withdrawal 0.05',  amount:-500, date: new Date().toISOString() },
    ],
  };
}

// ── START ─────────────────────────────────
window.addEventListener('DOMContentLoaded', init);