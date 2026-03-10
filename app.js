/**
 * app.js
 * TRewards main frontend logic
 */

'use strict';

// ─── API helper ───────────────────────────────────────────────────────────────
const API_BASE = '';

async function apiCall(method, endpoint, body) {
  const tg = window.Telegram?.WebApp;
  const headers = { 'Content-Type': 'application/json' };

  if (tg?.initData) {
    headers['X-Telegram-Init-Data'] = tg.initData;
  }

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(API_BASE + endpoint, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  } catch (e) {
    throw e;
  }
}

// ─── App State ────────────────────────────────────────────────────────────────
const State = {
  user: null,
  tasks: [],
  friends: { friends: 0, referralEarned: 0, pendingReferral: 0, referralLink: '' },
  cfg: {},
  currentTab: 'home',
  wheel: null,
  wheelSpinning: false,
  taskTimers: {},
};

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = '', duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, duration);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(tab) {
  State.currentTab = tab;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));

  if (tab === 'tasks') loadTasks();
  if (tab === 'friends') loadFriends();
  if (tab === 'wallet') renderWallet();
}

// ─── User data ────────────────────────────────────────────────────────────────
async function loadUser() {
  try {
    const data = await apiCall('GET', '/api/user');
    State.user = data.user;
    renderHome();
  } catch (e) {
    showToast('Connection error. Retrying...', 'error');
    setTimeout(loadUser, 3000);
  }
}

async function loadConfig() {
  try {
    const data = await apiCall('GET', '/api/config');
    State.cfg = data;
  } catch (e) {
    // defaults
    State.cfg = {
      withdrawalTiers: [
        { coins: 250000, ton: 0.10 },
        { coins: 500000, ton: 0.20 },
        { coins: 750000, ton: 0.30 },
        { coins: 1000000, ton: 0.40 },
      ],
      withdrawalFee: 0.05,
      tonPerCoin: 0.0000004,
      spinSegments: [10, 50, 80, 100, 300, 500],
      botUsername: 'trewards_ton_bot',
      taskCostPerCompletion: 0.001,
    };
  }
}

// ─── HOME PAGE ────────────────────────────────────────────────────────────────
function renderHome() {
  const u = State.user;
  if (!u) return;

  const tonEquiv = (u.coins * (State.cfg.tonPerCoin || 0.0000004)).toFixed(4);
  document.getElementById('balanceCoins').textContent = u.coins.toLocaleString();
  document.getElementById('balanceTon').textContent = `≈ ${tonEquiv} TON`;
  document.getElementById('badgeStreak').textContent = `🔥 ${u.streak || 0}`;
  document.getElementById('badgeSpins').textContent = `🎰 ${u.spins || 0}`;

  renderStreakDots(u.streak || 0, u.lastStreak);
  renderDailyTasks();

  // Update spin button
  const spinBtn = document.getElementById('spinBtn');
  if (u.spins > 0) {
    spinBtn.disabled = false;
    spinBtn.classList.remove('btn-disabled');
    spinBtn.textContent = t('spin_btn');
  } else {
    spinBtn.disabled = true;
    spinBtn.classList.add('btn-disabled');
    spinBtn.textContent = t('no_spins');
  }
}

function renderStreakDots(streak, lastStreak) {
  const container = document.getElementById('streakDots');
  if (!container) return;
  container.innerHTML = '';

  const today = new Date().toISOString().split('T')[0];
  const isClaimedToday = lastStreak === today;

  for (let i = 1; i <= 7; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot';
    dot.textContent = i;

    if (i < streak || (i === streak && isClaimedToday)) {
      dot.classList.add('filled');
    } else if (i === streak + 1 && !isClaimedToday) {
      dot.classList.add('today');
    }
    container.appendChild(dot);
  }

  const claimBtn = document.getElementById('claimStreakBtn');
  if (claimBtn) {
    if (isClaimedToday) {
      claimBtn.disabled = true;
      claimBtn.textContent = t('streak_claimed');
      claimBtn.classList.add('btn-disabled');
    } else {
      claimBtn.disabled = false;
      claimBtn.textContent = t('claim_streak');
      claimBtn.classList.remove('btn-disabled');
    }
  }
}

function renderDailyTasks() {
  const u = State.user;
  const today = new Date().toISOString().split('T')[0];

  const tasks = [
    { id: 'daily_checkin', icon: '✅', name: t('task_checkin'), reward: 10 },
    { id: 'check_updates', icon: '🔔', name: t('task_updates'), reward: 20, url: 'https://t.me/trewards_ton' },
    { id: 'share_friends', icon: '👥', name: t('task_share'), reward: 30, url: 'https://t.me/trewards_ton_bot' },
  ];

  const container = document.getElementById('dailyTasksList');
  if (!container) return;
  container.innerHTML = '';

  tasks.forEach(task => {
    const claimedKey = `${task.id}_${today}`;
    const claimed = u.completedTasks?.includes(claimedKey);

    const row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML = `
      <div class="task-info">
        <div class="task-icon">${task.icon}</div>
        <div>
          <div class="task-name">${task.name}</div>
          <div class="task-reward">+${task.reward} TR</div>
        </div>
      </div>
      <button class="btn btn-sm ${claimed ? 'btn-disabled' : 'btn-gold'}" 
              ${claimed ? 'disabled' : ''}
              data-taskid="${task.id}"
              data-url="${task.url || ''}">
        ${claimed ? t('claimed') : t('claim')}
      </button>
    `;

    if (!claimed) {
      row.querySelector('button').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const url = btn.dataset.url;

        // For redirect tasks, open URL first
        if (url) {
          window.Telegram?.WebApp?.openLink ? window.Telegram.WebApp.openLink(url) : window.open(url, '_blank');
        }

        try {
          btn.disabled = true;
          btn.textContent = '...';
          const res = await apiCall('POST', '/api/claim-daily', { taskType: task.id });
          State.user.coins = res.coins;
          State.user.completedTasks = State.user.completedTasks || [];
          State.user.completedTasks.push(`${task.id}_${today}`);
          showToast(`+${res.reward} TR!`, 'gold');
          renderHome();
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = t('claim');
        }
      });
    }

    container.appendChild(row);
  });
}

// ─── SPIN WHEEL ───────────────────────────────────────────────────────────────
function initWheel() {
  const canvas = document.getElementById('spinCanvas');
  if (!canvas) return;
  const segments = State.cfg.spinSegments || [10, 50, 80, 100, 300, 500];
  State.wheel = new SpinWheel(canvas, segments);
}

async function handleSpin() {
  if (State.wheelSpinning || !State.user || State.user.spins <= 0) return;
  State.wheelSpinning = true;

  const spinBtn = document.getElementById('spinBtn');
  spinBtn.disabled = true;
  spinBtn.textContent = '...';

  try {
    const res = await apiCall('POST', '/api/spin');
    const resultValue = res.reward;
    const segments = State.cfg.spinSegments || [10, 50, 80, 100, 300, 500];
    const resultIndex = segments.indexOf(resultValue) !== -1 ? segments.indexOf(resultValue) : 0;

    State.wheel.onComplete = (val) => {
      State.wheelSpinning = false;
      State.user.coins = res.coins;
      State.user.spins = res.spins;

      document.getElementById('spinResultValue').textContent = `+${val} TR 🎉`;
      showToast(`+${val} TR!`, 'gold', 3000);
      renderHome();
    };

    State.wheel.spin(resultIndex);
  } catch (err) {
    State.wheelSpinning = false;
    showToast(err.message, 'error');
    spinBtn.disabled = false;
    spinBtn.textContent = t('spin_btn');
  }
}

// ─── PROMO CODE ───────────────────────────────────────────────────────────────
async function redeemPromo() {
  const input = document.getElementById('promoInput');
  const code = input.value.trim().toUpperCase();
  if (!code) return;

  try {
    const res = await apiCall('POST', '/api/redeem-promo', { code });
    State.user.coins = res.coins;
    showToast(`+${res.reward} TR! Code activated ✓`, 'success', 3000);
    input.value = '';
    renderHome();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── STREAK ───────────────────────────────────────────────────────────────────
async function claimStreak() {
  try {
    const res = await apiCall('POST', '/api/claim-streak');
    State.user.coins = res.coins;
    State.user.spins = res.spins;
    State.user.streak = res.streak;
    State.user.lastStreak = new Date().toISOString().split('T')[0];
    showToast(`+${res.reward.coins} TR & +${res.reward.spins} Spin!`, 'gold', 3000);
    renderHome();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── TASKS PAGE ───────────────────────────────────────────────────────────────
async function loadTasks() {
  const container = document.getElementById('tasksList');
  container.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

  try {
    const data = await apiCall('GET', '/api/tasks');
    State.tasks = data.tasks;
    renderTasks();
  } catch (e) {
    container.innerHTML = `<p style="text-align:center;color:var(--error)">${e.message}</p>`;
  }
}

function getTaskIcon(type) {
  const icons = {
    join_channel:  '📢',
    join_group:    '👥',
    play_game:     '🎮',
    visit_website: '🌐',
  };
  return icons[type] || '📋';
}

function getTaskTypeName(type) {
  return t(type) || type;
}

function renderTasks() {
  const container = document.getElementById('tasksList');
  container.innerHTML = '';

  if (!State.tasks.length) {
    container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:40px">No tasks yet</p>`;
    return;
  }

  State.tasks.forEach(task => {
    const card = document.createElement('div');
    card.className = `task-card ${task.completed ? 'completed' : ''}`;
    card.dataset.taskId = task.taskId;

    const isJoin = task.type === 'join_channel' || task.type === 'join_group';
    const btnId = `taskbtn_${task.taskId}`;

    card.innerHTML = `
      <div class="task-card-icon">${getTaskIcon(task.type)}</div>
      <div class="task-card-info">
        <div class="task-card-name">${task.name}</div>
        <div class="task-card-meta">${getTaskTypeName(task.type)}</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${Math.min(100,(task.completions/Math.max(task.target,1)*100)).toFixed(1)}%"></div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
        <div class="task-card-reward">+${task.reward} TR</div>
        <button id="${btnId}" class="btn btn-sm ${task.completed ? 'btn-disabled' : 'btn-gold'}"
                ${task.completed ? 'disabled' : ''}>
          ${task.completed ? t('completed') : t('start')}
        </button>
        ${!task.completed && isJoin ? `<button id="${btnId}_verify" class="btn btn-sm btn-outline" style="display:none">${t('verify')}</button>` : ''}
        <span id="${btnId}_timer" class="task-timer" style="display:none"></span>
      </div>
    `;

    if (!task.completed) {
      const startBtn = card.querySelector(`#${btnId}`);
      const verifyBtn = card.querySelector(`#${btnId}_verify`);
      const timerEl = card.querySelector(`#${btnId}_timer`);

      if (isJoin) {
        // Join flow: open link → show verify button
        startBtn.addEventListener('click', () => {
          const url = task.url;
          if (window.Telegram?.WebApp?.openTelegramLink) {
            window.Telegram.WebApp.openTelegramLink(url);
          } else {
            window.open(url, '_blank');
          }
          startBtn.style.display = 'none';
          if (verifyBtn) verifyBtn.style.display = 'inline-flex';
        });

        if (verifyBtn) {
          verifyBtn.addEventListener('click', async () => {
            verifyBtn.disabled = true;
            verifyBtn.textContent = '...';
            try {
              // Extract channel username from URL
              const urlParts = task.url.split('/');
              const channelUsername = urlParts[urlParts.length - 1].replace('@', '');
              const res = await apiCall('POST', '/api/verify-join', {
                taskId: task.taskId,
                channelUsername,
              });
              State.user.coins = res.coins;
              showToast(`+${res.reward || 0} TR! Verified ✓`, 'success');
              loadTasks();
              renderHome();
            } catch (err) {
              showToast(err.message || 'Not joined yet', 'error');
              verifyBtn.disabled = false;
              verifyBtn.textContent = t('verify');
            }
          });
        }

      } else {
        // Visit/Game flow: open URL → 15s timer → claim
        startBtn.addEventListener('click', async () => {
          const url = task.url;
          if (window.Telegram?.WebApp?.openLink) {
            window.Telegram.WebApp.openLink(url);
          } else {
            window.open(url, '_blank');
          }

          startBtn.style.display = 'none';
          timerEl.style.display = 'inline';

          let seconds = 15;
          timerEl.textContent = t('timer_wait', { n: seconds });

          const interval = setInterval(() => {
            seconds--;
            if (seconds > 0) {
              timerEl.textContent = t('timer_wait', { n: seconds });
            } else {
              clearInterval(interval);
              timerEl.style.display = 'none';

              // Show claim button
              const claimBtn = document.createElement('button');
              claimBtn.className = 'btn btn-sm btn-gold';
              claimBtn.textContent = t('claim');
              claimBtn.addEventListener('click', async () => {
                claimBtn.disabled = true;
                claimBtn.textContent = '...';
                try {
                  const res = await apiCall('POST', '/api/complete-task', { taskId: task.taskId });
                  State.user.coins = res.coins;
                  showToast(`+${res.reward} TR!`, 'gold');
                  loadTasks();
                  renderHome();
                } catch (err) {
                  showToast(err.message, 'error');
                  claimBtn.disabled = false;
                  claimBtn.textContent = t('claim');
                }
              });

              timerEl.parentElement.appendChild(claimBtn);
            }
          }, 1000);

          State.taskTimers[task.taskId] = interval;
        });
      }
    }

    container.appendChild(card);
  });
}

// ─── FRIENDS PAGE ─────────────────────────────────────────────────────────────
async function loadFriends() {
  try {
    const data = await apiCall('GET', '/api/friends');
    State.friends = data;
    renderFriends();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function renderFriends() {
  const f = State.friends;
  document.getElementById('totalFriends').textContent = f.friends || 0;
  document.getElementById('totalEarned').textContent = (f.referralEarned || 0).toLocaleString();
  document.getElementById('pendingEarned').textContent = (f.pendingReferral || 0).toLocaleString();
  document.getElementById('referralLinkText').textContent = f.referralLink || '';

  const claimBtn = document.getElementById('claimReferralBtn');
  if (claimBtn) {
    claimBtn.disabled = !f.pendingReferral;
    claimBtn.classList.toggle('btn-disabled', !f.pendingReferral);
  }
}

async function copyReferralLink() {
  const link = State.friends.referralLink;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    showToast(t('link_copied'), 'success');
  } catch (e) {
    showToast(link, '', 4000);
  }
}

async function claimReferral() {
  try {
    const res = await apiCall('POST', '/api/claim-referral');
    State.user.coins = res.coins;
    State.friends.pendingReferral = 0;
    showToast(`+${res.claimed} TR claimed!`, 'gold');
    renderFriends();
    renderHome();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── WALLET PAGE ──────────────────────────────────────────────────────────────
let selectedTier = null;

function renderWallet() {
  const u = State.user;
  const tiers = State.cfg.withdrawalTiers || [];
  const coins = u?.coins || 0;

  document.getElementById('walletBalance').textContent = coins.toLocaleString();
  document.getElementById('walletTon').textContent = `≈ ${(coins * 0.0000004).toFixed(4)} TON`;

  const container = document.getElementById('tierGrid');
  container.innerHTML = '';

  tiers.forEach(tier => {
    const locked = coins < tier.coins;
    const div = document.createElement('div');
    div.className = `tier-card ${locked ? 'locked' : ''}`;
    div.innerHTML = `
      <div class="tier-coins">${(tier.coins / 1000).toFixed(0)}K TR</div>
      <div class="tier-ton">${tier.ton}</div>
      <div class="tier-ton-label">TON</div>
    `;
    if (!locked) {
      div.addEventListener('click', () => {
        selectedTier = tier;
        document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('selected'));
        div.classList.add('selected');
      });
    }
    container.appendChild(div);
  });
}

async function submitWithdraw() {
  if (!selectedTier) return showToast('Select a tier first', 'error');
  const wallet = document.getElementById('withdrawWallet').value.trim();
  if (!wallet || wallet.length < 10) return showToast('Enter valid wallet address', 'error');

  const btn = document.getElementById('withdrawBtn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const res = await apiCall('POST', '/api/withdraw', {
      coins: selectedTier.coins,
      walletAddress: wallet,
    });
    State.user.coins = res.coins;
    showToast(t('withdraw_success'), 'success', 3000);
    selectedTier = null;
    document.getElementById('withdrawWallet').value = '';
    renderWallet();
    renderHome();
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = t('confirm_withdraw');
  }
}

// ─── ADVERTISER OVERLAY ───────────────────────────────────────────────────────
let advTab = 'create';

function openAdvertiser() {
  document.getElementById('advertiserOverlay').classList.add('active');
  switchAdvTab('create');
  loadMyTasks();
}

function closeAdvertiser() {
  document.getElementById('advertiserOverlay').classList.remove('active');
}

function switchAdvTab(tab) {
  advTab = tab;
  document.querySelectorAll('.tab-pill').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  document.querySelectorAll('.adv-section').forEach(s => s.style.display = s.dataset.section === tab ? 'block' : 'none');
}

function updateTaskCost() {
  const target = parseInt(document.getElementById('taskTarget').value) || 0;
  const cost = (target * 0.001).toFixed(3);
  document.getElementById('taskCostNote').textContent = `Cost: ${cost} TON`;
}

async function submitTask() {
  const name   = document.getElementById('taskName').value.trim();
  const type   = document.getElementById('taskType').value;
  const url    = document.getElementById('taskUrl').value.trim();
  const target = parseInt(document.getElementById('taskTarget').value);

  if (!name || !type || !url || !target) return showToast('Fill all fields', 'error');

  const btn = document.getElementById('submitTaskBtn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    await apiCall('POST', '/api/create-task', { name, type, url, target });
    showToast('Task created!', 'success');
    document.getElementById('taskName').value = '';
    document.getElementById('taskUrl').value = '';
    document.getElementById('taskTarget').value = '';
    switchAdvTab('mytasks');
    loadMyTasks();
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = t('submit_task');
  }
}

async function loadMyTasks() {
  const container = document.getElementById('myTasksList');
  container.innerHTML = '<div class="loader"><div class="spinner"></div></div>';

  try {
    const data = await apiCall('GET', '/api/advertiser-tasks');
    if (!data.tasks.length) {
      container.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:20px">No tasks yet</p>`;
      return;
    }

    container.innerHTML = data.tasks.map(task => `
      <div class="task-card" style="margin-bottom:8px">
        <div class="task-card-icon">${getTaskIcon(task.type)}</div>
        <div class="task-card-info">
          <div class="task-card-name">${task.name}</div>
          <div class="task-card-meta">${task.completions}/${task.target} ${t('completions')}</div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${Math.min(100,(task.completions/Math.max(task.target,1)*100)).toFixed(1)}%"></div>
          </div>
        </div>
        <div style="font-size:11px;color:${task.active?'var(--success)':'var(--error)'}">
          ${task.active ? t('active') : 'Ended'}
        </div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = `<p style="text-align:center;color:var(--error)">${e.message}</p>`;
  }
}

// ─── Language toggle ──────────────────────────────────────────────────────────
function toggleLang() {
  const newLang = getLang() === 'en' ? 'ru' : 'en';
  setLang(newLang);
  document.getElementById('langBtn').textContent = newLang.toUpperCase();
  applyTranslations();
}

function applyTranslations() {
  // Nav labels
  document.querySelectorAll('.nav-label[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  // Section titles etc
  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (!el.classList.contains('nav-label')) {
      el.textContent = t(el.dataset.i18n);
    }
  });
  // Re-render home if active
  if (State.currentTab === 'home' && State.user) renderHome();
  if (State.currentTab === 'tasks' && State.tasks.length) renderTasks();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Init language
  initLang();
  applyTranslations();

  // Telegram WebApp init
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.expand();
    tg.ready();
    tg.setHeaderColor?.('#0A0800');
    tg.setBackgroundColor?.('#0A0800');
  }

  // Load config first
  await loadConfig();

  // Init wheel after config
  initWheel();

  // Load user
  await loadUser();
}

// ─── Event listeners (called from HTML) ──────────────────────────────────────
window.navigate = navigate;
window.handleSpin = handleSpin;
window.redeemPromo = redeemPromo;
window.claimStreak = claimStreak;
window.copyReferralLink = copyReferralLink;
window.claimReferral = claimReferral;
window.submitWithdraw = submitWithdraw;
window.openAdvertiser = openAdvertiser;
window.closeAdvertiser = closeAdvertiser;
window.switchAdvTab = switchAdvTab;
window.updateTaskCost = updateTaskCost;
window.submitTask = submitTask;
window.toggleLang = toggleLang;

document.addEventListener('DOMContentLoaded', init);