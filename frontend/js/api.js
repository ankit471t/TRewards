/* ════════════════════════════════════════
   api.js — Backend API Communication
   ════════════════════════════════════════ */

const tg = window.Telegram?.WebApp;

async function apiCall(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };

  if (tg?.initData) {
    headers['x-init-data'] = tg.initData;
  } else if (State.user?.user_id) {
    headers['x-telegram-id'] = String(State.user.user_id);
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(CONFIG.API_URL + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Network error' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── USER ──────────────────────────────────
async function apiInit(referrerId) {
  return apiCall('/api/init', 'POST', { referrer_id: referrerId });
}

async function apiClaimStreak() {
  return apiCall('/api/claim-streak', 'POST');
}

async function apiSpin() {
  return apiCall('/api/spin', 'POST');
}

async function apiRedeemPromo(code) {
  return apiCall('/api/redeem-promo', 'POST', { code });
}

async function apiClaimReferral() {
  return apiCall('/api/claim-referral', 'POST');
}

// ── TASKS ─────────────────────────────────
async function apiGetTasks() {
  return apiCall('/api/tasks');
}

async function apiClaimTask(taskId) {
  return apiCall('/api/claim-task', 'POST', { task_id: taskId });
}

async function apiVerifyJoin(taskId, chatId) {
  return apiCall('/api/verify-join', 'POST', { task_id: taskId, chat_id: chatId });
}

// ── WALLET ────────────────────────────────
async function apiWithdraw(tier, walletAddress) {
  return apiCall('/api/withdraw', 'POST', { tier, wallet_address: walletAddress });
}

async function apiCreateTopup(amount, method) {
  return apiCall('/api/create-topup', 'POST', { amount, method });
}

// ── ADVERTISER ────────────────────────────
async function apiCreateTask(name, type, url, limit) {
  return apiCall('/api/create-task', 'POST', { name, type, url, limit });
}