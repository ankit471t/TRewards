/* ════════════════════════════════════════
   pages/home.js — Home Tab
   ════════════════════════════════════════ */

// ── RENDER ────────────────────────────────
function renderHome() {
  const u = State.user;
  if (!u) return;
  _renderBalanceCard(u);
  _renderStreak(u);
  _renderSpinInfo(u);
  _renderDailyTasks(u);
  _injectHomeHTML();
}

function _injectHomeHTML() {
  const u = State.user;
  document.getElementById('page-home').innerHTML = `

    <!-- Balance Card -->
    <div class="card balance-card">
      <div class="card-title" data-i18n="balance">Balance</div>
      <div class="balance-main">
        <div class="balance-coins">${fmtCoins(u.coins)}</div>
        <div class="balance-unit">TR</div>
      </div>
      <div class="balance-ton">≈ ${(u.coins * CONFIG.TON_RATE).toFixed(8)} TON</div>
      <div class="balance-badges">
        <div class="badge">🔥 ${u.daily_streak || 0}d streak</div>
        <div class="badge">🎰 ${u.spins || 0} spins</div>
        <div class="badge ton-badge">💎 ${fmtTon(u.ton_balance)} TON</div>
      </div>
    </div>

    <!-- Daily Streak -->
    <div class="card">
      <div class="card-title">Daily Streak</div>
      <div class="streak-dots" id="streakDots">${_streakDotsHTML(u.daily_streak || 0)}</div>
      <button class="btn btn-gold" id="streakBtn" onclick="claimStreak()">
        🔥 Claim Daily Reward
      </button>
    </div>

    <!-- Spin Wheel -->
    <div class="card">
      <div class="card-title">Spin Wheel</div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
        <div style="font-size:26px;line-height:1;margin-bottom:-6px;filter:drop-shadow(0 0 8px #FFB800)">▼</div>
        <canvas id="wheel" width="230" height="230"
          style="border-radius:50%;border:3px solid #FFB800;box-shadow:0 0 28px rgba(255,184,0,0.3)"></canvas>
        <button class="btn btn-gold" id="spinBtn" onclick="doSpin()"
          style="max-width:200px" ${(u.spins||0)<=0?'disabled':''}>
          🎰 Spin (${u.spins || 0})
        </button>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="section-title">Quick Actions</div>
    <div class="quick-grid">
      <div class="quick-btn" onclick="switchTab('friends')">
        <div class="quick-btn-icon">👥</div>
        <div class="quick-btn-label">Invite Friend</div>
      </div>
      <div class="quick-btn" onclick="switchTab('wallet')">
        <div class="quick-btn-icon">💸</div>
        <div class="quick-btn-label">Withdraw</div>
      </div>
      <div class="quick-btn" onclick="switchTab('tasks')">
        <div class="quick-btn-icon">✅</div>
        <div class="quick-btn-label">Earn More</div>
      </div>
      <div class="quick-btn" onclick="copyReferralLink()">
        <div class="quick-btn-icon">🔗</div>
        <div class="quick-btn-label">Referral</div>
      </div>
    </div>

    <!-- Promo Code -->
    <div class="section-title">Promo Code</div>
    <div class="card">
      <div class="input-row">
        <input class="input-field" id="promoInput" placeholder="Enter code..." style="text-transform:uppercase;letter-spacing:1px">
        <button class="btn btn-gold" onclick="redeemPromo()">Redeem</button>
      </div>
    </div>

    <!-- Daily Tasks -->
    <div class="section-title">Daily Tasks</div>

    <div class="daily-task ${_isStreakDone(u) ? 'done' : ''}" onclick="claimStreak()">
      <div class="daily-task-icon">☀️</div>
      <div class="daily-task-info">
        <div class="daily-task-name">Daily Check-In</div>
        <div class="daily-task-rew">+10 TR &nbsp;+1 Spin</div>
      </div>
      <div class="daily-task-arrow">${_isStreakDone(u) ? '✓' : '›'}</div>
    </div>

    <div class="daily-task ${State.channelTaskDone ? 'done' : ''}" id="channelTask" onclick="channelTask()">
      <div class="daily-task-icon">📢</div>
      <div class="daily-task-info">
        <div class="daily-task-name">Check for Updates</div>
        <div class="daily-task-rew">+50 TR</div>
      </div>
      <div class="daily-task-arrow">${State.channelTaskDone ? '✓' : '›'}</div>
    </div>

    <div class="daily-task ${State.shareTaskDone ? 'done' : ''}" id="shareTask" onclick="shareTask()">
      <div class="daily-task-icon">📤</div>
      <div class="daily-task-info">
        <div class="daily-task-name">Share with Friends</div>
        <div class="daily-task-rew">+50 TR</div>
      </div>
      <div class="daily-task-arrow">${State.shareTaskDone ? '✓' : '›'}</div>
    </div>
  `;

  // Re-draw wheel after DOM update
  requestAnimationFrame(() => drawWheel());
  applyI18n();
}

function _streakDotsHTML(streak) {
  let html = '';
  for (let i = 1; i <= 7; i++) {
    html += `<div class="streak-dot ${i <= streak ? 'done' : ''}">${i <= streak ? '✓' : i}</div>`;
  }
  return html;
}

function _isStreakDone(u) {
  if (!u.last_streak_claim) return false;
  const diff = (Date.now() - new Date(u.last_streak_claim)) / 3600000;
  return diff < 20;
}

// Stubs — rendered inline so these are just aliases
function _renderBalanceCard() {}
function _renderStreak() {}
function _renderSpinInfo() {}
function _renderDailyTasks() {}

// ── ACTIONS ───────────────────────────────

async function claimStreak() {
  try {
    const data = await apiClaimStreak();
    if (data.success) {
      State.user = data.user;
      renderHome();
      toast('🔥 +10 TR +1 Spin claimed!', 'success');
    } else {
      toast(data.error || 'Already claimed today', 'error');
    }
  } catch (err) {
    toast(err.message || 'Already claimed today', 'error');
  }
}

async function redeemPromo() {
  const input = document.getElementById('promoInput');
  const code  = (input?.value || '').trim().toUpperCase();
  if (!code) return toast('Enter a promo code', 'error');

  try {
    const data = await apiRedeemPromo(code);
    if (data.success) {
      if (input) input.value = '';
      const unit = data.type === 'ton' ? 'TON' : 'TR';
      if (data.type === 'ton') State.user.ton_balance = (State.user.ton_balance || 0) + data.reward;
      else                     State.user.coins        = (State.user.coins || 0) + data.reward;
      renderHome();
      toast(`✅ +${data.reward} ${unit} from promo!`, 'success');
    } else {
      toast(data.error || 'Invalid promo code', 'error');
    }
  } catch (err) {
    toast(err.message || 'Failed to redeem', 'error');
  }
}

function channelTask() {
  if (State.channelTaskDone) return;
  const url = CONFIG.CHANNEL_URL;
  if (tg) tg.openLink(url);
  else    window.open(url, '_blank');

  setTimeout(() => {
    State.channelTaskDone = true;
    State.user.coins = (State.user.coins || 0) + 50;
    renderHome();
    toast('+50 TR — Thanks for checking!', 'success');
  }, 3000);
}

function shareTask() {
  if (State.shareTaskDone) return;
  const link = refLink();
  const text = 'Join TRewards and earn real TON! 🚀';
  if (tg) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  else    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}`, '_blank');

  setTimeout(() => {
    State.shareTaskDone = true;
    State.user.coins = (State.user.coins || 0) + 50;
    renderHome();
    toast('+50 TR — Thanks for sharing!', 'success');
  }, 2000);
}

function copyReferralLink() {
  copyText(refLink());
}