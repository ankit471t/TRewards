/* ═══════════════════════════════════════
   TREWARDS — APP.JS
   Complete Frontend Application Logic
═══════════════════════════════════════ */

'use strict';

// ── CONFIG ─────────────────────────────────────────────────────
const CONFIG = {
  API_BASE: 'https://trewards-backend.onrender.com/api', // Replace with your backend URL
  BOT_USERNAME: 'trewards_ton_bot',
  CHANNEL_URL: 'https://t.me/trewards_tonfirst',
  TON_RATE: 0.0000004, // TR per TON
};

// ── STATE ───────────────────────────────────────────────────────
let state = {
  user: null,
  lang: 'en',
  tasks: [],
  friends: [],
  transactions: [],
  adTasks: [],
  adBalance: 0,
  currentTask: null,
  currentTaskTimer: null,
  pendingWithdraw: null,
  pendingTopup: null,
  selectedTopupAmount: 0,
  updatesTaskClicked: false,
  spinning: false,
};

// ── I18N ────────────────────────────────────────────────────────
const i18n = {
  en: {
    home: 'Home', tasks: 'Tasks', friends: 'Friends', wallet: 'Wallet',
    totalBalance: 'Total Balance', streak: 'Streak', spins: 'Spins',
    dailyStreak: 'Daily Streak', spinWheel: 'Spin Wheel', usesSpin: 'Uses 1 spin',
    spin: 'SPIN', quickActions: 'Quick Actions',
    inviteFriend: 'Invite Friend', withdraw: 'Withdraw', earnMore: 'Earn More',
    referral: 'Referral', promoCode: 'Promo Code', enterPromo: 'Enter promo code',
    redeem: 'Redeem', dailyTasks: 'Daily Tasks', dailyCheckin: 'Daily Check-In',
    checkUpdates: 'Check for Updates', shareWithFriends: 'Share with Friends',
    claim: 'Claim', start: 'Start', share: 'Share',
    earnTR: 'Earn TR Coins', completeTasks: 'Complete tasks to earn rewards',
    loadingTasks: 'Loading tasks...', claimStreak: 'Claim Daily Reward',
    friends: 'Friends', earn30: "Earn 30% from friends' coins",
    yourReferralLink: 'Your Referral Link', inviteViaTelegram: '📨 Invite via Telegram',
    referralEarnings: 'Referral Earnings', totalFriends: 'Total Friends',
    totalEarned: 'Total Earned', friendsList: 'Friends List',
    noFriendsYet: 'No friends yet. Start inviting!',
    wallet: 'Wallet', withdrawEarnings: 'Withdraw your earnings',
    topUp: 'Top Up TON', withdrawOptions: 'Withdrawal Options',
    networkFeeNote: '⚠️ 0.05 TON network fee deducted from all withdrawals',
    transactionHistory: 'Transaction History', noTransactions: 'No transactions yet',
    confirmWithdrawal: 'Confirm Withdrawal', coinsSpent: 'Coins Spent',
    grossAmount: 'Gross Amount', networkFee: 'Network Fee',
    youReceive: 'You Receive', withdrawNote: 'Processed within 24 hours manually',
    confirmWithdraw: 'Confirm Withdrawal',
    selectPaymentMethod: 'Select Payment Method', amount: 'Amount',
    advertiserDashboard: 'Advertiser Dashboard', adBalance: 'Ad Balance',
    addTask: 'Add Task', myTasks: 'My Tasks', taskName: 'Task Name',
    taskType: 'Task Type', targetUrl: 'Target URL',
    completionTarget: 'Completion Target', estimatedCost: 'Estimated Cost',
    publishTask: 'Publish Task', noTasksPublished: 'No tasks published yet',
    youWon: 'You Won!', awesome: 'Awesome!',
    joinChannelInstruction: 'Please join the channel/group to claim your reward',
    openLink: 'Open Link', claimReward: 'Claim Reward', iJoined: "✓ I've Joined",
    task: 'TASK',
  },
  ru: {
    home: 'Главная', tasks: 'Задания', friends: 'Друзья', wallet: 'Кошелёк',
    totalBalance: 'Баланс', streak: 'Серия', spins: 'Спины',
    dailyStreak: 'Ежедневная серия', spinWheel: 'Колесо', usesSpin: 'Тратит 1 спин',
    spin: 'КРУТИТЬ', quickActions: 'Действия',
    inviteFriend: 'Пригласить', withdraw: 'Вывод', earnMore: 'Заработать', referral: 'Реферал',
    promoCode: 'Промо-код', enterPromo: 'Введите промо-код',
    redeem: 'Активировать', dailyTasks: 'Задания дня', dailyCheckin: 'Ежедневный вход',
    checkUpdates: 'Проверить обновления', shareWithFriends: 'Поделиться',
    claim: 'Получить', start: 'Начать', share: 'Поделиться',
    earnTR: 'Зарабатывать TR', completeTasks: 'Выполняйте задания для наград',
    loadingTasks: 'Загрузка...', claimStreak: 'Получить награду',
    friends: 'Друзья', earn30: 'Получайте 30% от монет друзей',
    yourReferralLink: 'Ваша ссылка', inviteViaTelegram: '📨 Пригласить в Telegram',
    referralEarnings: 'Реферальный доход', totalFriends: 'Всего друзей',
    totalEarned: 'Заработано', friendsList: 'Список друзей',
    noFriendsYet: 'Нет друзей. Начните приглашать!',
    wallet: 'Кошелёк', withdrawEarnings: 'Вывод средств',
    topUp: 'Пополнить TON', withdrawOptions: 'Варианты вывода',
    networkFeeNote: '⚠️ Комиссия сети 0.05 TON вычитается из всех выводов',
    transactionHistory: 'История', noTransactions: 'Нет транзакций',
    confirmWithdrawal: 'Подтвердить вывод', coinsSpent: 'Монет потрачено',
    grossAmount: 'Сумма', networkFee: 'Комиссия сети',
    youReceive: 'Вы получите', withdrawNote: 'Обрабатывается вручную в течение 24 часов',
    confirmWithdraw: 'Подтвердить',
    selectPaymentMethod: 'Способ оплаты', amount: 'Сумма',
    advertiserDashboard: 'Панель рекламодателя', adBalance: 'Баланс рекламы',
    addTask: 'Добавить', myTasks: 'Мои задания', taskName: 'Название',
    taskType: 'Тип задания', targetUrl: 'URL цели',
    completionTarget: 'Цель выполнений', estimatedCost: 'Стоимость',
    publishTask: 'Опубликовать', noTasksPublished: 'Заданий нет',
    youWon: 'Вы выиграли!', awesome: 'Отлично!',
    joinChannelInstruction: 'Вступите в канал/группу для получения награды',
    openLink: 'Открыть ссылку', claimReward: 'Получить награду', iJoined: '✓ Я вступил(а)',
    task: 'ЗАДАНИЕ',
  }
};

function t(key) {
  return (i18n[state.lang] || i18n.en)[key] || key;
}

// ── TELEGRAM WEB APP ────────────────────────────────────────────
const tg = window.Telegram?.WebApp;

function getTgUser() {
  if (tg?.initDataUnsafe?.user) {
    return tg.initDataUnsafe.user;
  }
  // Dev fallback
  return { id: 123456789, first_name: 'Test', last_name: 'User', username: 'testuser' };
}

// ── API HELPERS ─────────────────────────────────────────────────
async function apiPost(endpoint, body = {}) {
  const user = getTgUser();
  const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      telegram_id: user.id,
      init_data: tg?.initData || '',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiGet(endpoint) {
  const user = getTgUser();
  const res = await fetch(`${CONFIG.API_BASE}${endpoint}?telegram_id=${user.id}&init_data=${encodeURIComponent(tg?.initData || '')}`, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── TOAST ────────────────────────────────────────────────────────
let toastTimeout;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${type ? ' ' + type : ''}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── NAVIGATION ───────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById(`page-${tab}`);
  if (page) page.classList.add('active');
  const navBtn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (navBtn) navBtn.classList.add('active');
  if (tab === 'tasks') loadTasks();
  if (tab === 'friends') loadFriends();
  if (tab === 'wallet') loadTransactions();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

document.querySelectorAll('[data-tab]').forEach(btn => {
  if (!btn.classList.contains('nav-btn')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
});

// ── LANGUAGE TOGGLE ──────────────────────────────────────────────
document.getElementById('langToggle').addEventListener('click', () => {
  state.lang = state.lang === 'en' ? 'ru' : 'en';
  document.getElementById('langToggle').textContent = state.lang.toUpperCase();
  applyI18n();
});

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

// ── BALANCE DISPLAY ──────────────────────────────────────────────
function updateBalanceDisplay() {
  if (!state.user) return;
  const coins = state.user.coins || 0;
  const ton = (coins * CONFIG.TON_RATE).toFixed(6);
  document.getElementById('balanceCoins').textContent = coins.toLocaleString();
  document.getElementById('balanceTon').textContent = ton;
  document.getElementById('streakBadge').textContent = state.user.streak_count || 0;
  document.getElementById('spinsBadge').textContent = state.user.spins || 0;
  document.getElementById('spinCount').textContent = state.user.spins || 0;
  document.getElementById('walletCoins').textContent = coins.toLocaleString();
  document.getElementById('walletTon').textContent = ton;
}

// ── STREAK DOTS ──────────────────────────────────────────────────
function renderStreakDots() {
  const container = document.getElementById('streakDots');
  container.innerHTML = '';
  const streak = state.user?.streak_count || 0;
  for (let i = 1; i <= 7; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot';
    if (i < streak % 7 + 1) dot.classList.add('active');
    if (i === (streak % 7) + 1 || (streak % 7 === 0 && i === 1 && streak > 0)) dot.classList.add('today');
    dot.textContent = i;
    container.appendChild(dot);
  }
}

// ── DAILY STREAK CLAIM ───────────────────────────────────────────
document.getElementById('claimStreakBtn').addEventListener('click', async () => {
  try {
    const res = await apiPost('/claim-streak');
    state.user.coins += res.reward || 10;
    state.user.spins = (state.user.spins || 0) + 1;
    state.user.streak_count = (state.user.streak_count || 0) + 1;
    updateBalanceDisplay();
    renderStreakDots();
    showToast(`+${res.reward || 10} TR +1 🎰`, 'success');
    document.getElementById('claimStreakBtn').disabled = true;
    document.getElementById('claimStreakBtn').textContent = '✓ Claimed';
  } catch (e) {
    showToast(e.message || 'Already claimed today', 'error');
  }
});

// ── SPIN WHEEL ───────────────────────────────────────────────────
const WHEEL_SEGMENTS = [
  { label: '10', value: 10, color: '#1A1200' },
  { label: '50', value: 50, color: '#221800' },
  { label: '80', value: 80, color: '#1A1200' },
  { label: '100', value: 100, color: '#2A2000' },
  { label: '300', value: 300, color: '#221800' },
  { label: '500', value: 500, color: '#FFB800' },
];

const SEGMENT_COUNT = WHEEL_SEGMENTS.length;
const ARC = (Math.PI * 2) / SEGMENT_COUNT;

let currentAngle = 0;

function drawWheel(angle = 0) {
  const canvas = document.getElementById('spinCanvas');
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = cx - 4;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const start = angle + i * ARC;
    const end = start + ARC;
    const seg = WHEEL_SEGMENTS[i];

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    ctx.strokeStyle = '#FFB800';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + ARC / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = seg.value === 500 ? '#0A0800' : '#FFB800';
    ctx.font = `bold 15px Orbitron, monospace`;
    ctx.fillText(seg.label, r - 12, 5);
    ctx.restore();
  }

  // Center circle
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.fillStyle = '#0A0800';
  ctx.fill();
  ctx.strokeStyle = '#FFB800';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function spinToResult(resultValue) {
  return new Promise((resolve) => {
    const targetIdx = WHEEL_SEGMENTS.findIndex(s => s.value === resultValue);
    if (targetIdx === -1) return resolve();

    const spinRevolutions = 5 + Math.random() * 3;
    const targetAngle = -(targetIdx * ARC + ARC / 2) + Math.PI / 2;
    const totalRotation = spinRevolutions * Math.PI * 2 + targetAngle - currentAngle;

    const duration = 4000;
    const startTime = performance.now();
    const startAngle = currentAngle;

    function easeOut(t) {
      return 1 - Math.pow(1 - t, 4);
    }

    function animate(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOut(progress);
      currentAngle = startAngle + totalRotation * eased;
      drawWheel(currentAngle);
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        currentAngle = targetAngle;
        resolve();
      }
    }

    requestAnimationFrame(animate);
  });
}

document.getElementById('spinBtn').addEventListener('click', async () => {
  if (state.spinning) return;
  const spins = state.user?.spins || 0;
  if (spins <= 0) { showToast('No spins left!', 'error'); return; }

  state.spinning = true;
  document.getElementById('spinBtn').disabled = true;

  try {
    const res = await apiPost('/spin');
    state.user.spins = Math.max(0, spins - 1);
    updateBalanceDisplay();

    await spinToResult(res.result);

    state.user.coins += res.result;
    updateBalanceDisplay();
    document.getElementById('spinResultAmount').textContent = res.result.toLocaleString();
    document.getElementById('spinResultOverlay').classList.remove('hidden');
  } catch (e) {
    showToast(e.message || 'Spin failed', 'error');
  } finally {
    state.spinning = false;
    document.getElementById('spinBtn').disabled = false;
  }
});

document.getElementById('spinResultClose').addEventListener('click', () => {
  document.getElementById('spinResultOverlay').classList.add('hidden');
});

// ── PROMO CODE ───────────────────────────────────────────────────
document.getElementById('redeemBtn').addEventListener('click', async () => {
  const code = document.getElementById('promoInput').value.trim();
  if (!code) { showToast('Enter a promo code', 'error'); return; }

  try {
    const res = await apiPost('/redeem-promo', { code });
    if (res.reward_type === 'ton') {
      showToast(`+${res.reward} TON added to your balance! 💎`, 'success');
      state.user.ton_balance = (state.user.ton_balance || 0) + res.reward;
    } else {
      state.user.coins += res.reward;
      showToast(`+${res.reward} TR coins added! 🎉`, 'success');
      updateBalanceDisplay();
    }
    document.getElementById('promoInput').value = '';
  } catch (e) {
    showToast(e.message || 'Invalid or expired code', 'error');
  }
});

// ── DAILY TASKS ──────────────────────────────────────────────────
function setupDailyTasks() {
  // Check-in
  const checkinBtn = document.querySelector('[data-task="checkin"]');
  checkinBtn.addEventListener('click', async () => {
    try {
      const res = await apiPost('/claim-daily-task', { task: 'checkin' });
      state.user.coins += res.reward || 10;
      state.user.spins = (state.user.spins || 0) + 1;
      updateBalanceDisplay();
      markDailyTask('checkin');
      showToast(`+${res.reward || 10} TR`, 'success');
    } catch (e) {
      showToast(e.message || 'Already claimed', 'error');
    }
  });

  // Updates - first click opens channel, second claims
  const updatesBtn = document.querySelector('[data-task="updates"]');
  updatesBtn.addEventListener('click', async () => {
    if (!state.updatesTaskClicked) {
      state.updatesTaskClicked = true;
      tg?.openLink(CONFIG.CHANNEL_URL);
      updatesBtn.textContent = t('claim');
      return;
    }
    try {
      const res = await apiPost('/claim-daily-task', { task: 'updates' });
      state.user.coins += res.reward || 50;
      updateBalanceDisplay();
      markDailyTask('updates');
      showToast(`+${res.reward || 50} TR`, 'success');
    } catch (e) {
      showToast(e.message || 'Already claimed', 'error');
    }
  });

  // Share
  const shareBtn = document.querySelector('[data-task="share"]');
  shareBtn.addEventListener('click', async () => {
    const user = getTgUser();
    const link = `https://t.me/${CONFIG.BOT_USERNAME}?start=${user.id}`;
    const text = `Join TRewards and earn TR coins! Use my referral link:`;
    tg?.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
    setTimeout(async () => {
      try {
        const res = await apiPost('/claim-daily-task', { task: 'share' });
        state.user.coins += res.reward || 100;
        updateBalanceDisplay();
        markDailyTask('share');
        showToast(`+${res.reward || 100} TR`, 'success');
      } catch (e) { /* Already claimed is ok */ }
    }, 1500);
  });
}

function markDailyTask(task) {
  const el = document.getElementById(`task-${task}`);
  if (el) {
    el.classList.add('completed');
    const btn = el.querySelector('.task-claim-btn');
    if (btn) btn.textContent = '✓';
  }
}

// ── TASKS PAGE ───────────────────────────────────────────────────
async function loadTasks() {
  try {
    const res = await apiGet('/tasks');
    state.tasks = res.tasks || [];
    renderTasks();
  } catch (e) {
    document.getElementById('tasksList').innerHTML = `<div class="empty-state">Failed to load tasks</div>`;
  }
}

function renderTasks() {
  const list = document.getElementById('tasksList');
  if (!state.tasks.length) {
    list.innerHTML = `<div class="empty-state">No tasks available right now</div>`;
    return;
  }

  const categories = {
    channel: { label: '📡 Join Channel', tasks: [] },
    group: { label: '👥 Join Group', tasks: [] },
    game: { label: '🎮 Play Game Bot', tasks: [] },
    visit: { label: '🌐 Visit Website', tasks: [] },
  };

  state.tasks.forEach(task => {
    if (categories[task.task_type]) categories[task.task_type].tasks.push(task);
  });

  let html = '';
  for (const [type, cat] of Object.entries(categories)) {
    if (!cat.tasks.length) continue;
    html += `<div class="tasks-category"><div class="category-label">${cat.label}</div></div>`;
    cat.tasks.forEach(task => {
      const reward = task.task_type === 'visit' ? 500 : 1000;
      const done = task.user_completed;
      html += `
        <div class="task-card">
          <div class="task-card-header">
            <div class="task-card-info">
              <span class="task-card-type type-${type}">${type}</span>
              <div class="task-card-name">${escapeHtml(task.task_name)}</div>
            </div>
            <div class="task-card-reward">
              +${reward.toLocaleString()} TR
              <small>+1 🎰</small>
            </div>
          </div>
          <div class="task-card-footer">
            <button class="task-start-btn ${done ? 'completed' : ''}"
              data-task-id="${task.id}"
              data-task-type="${type}"
              data-task-url="${escapeHtml(task.target_url)}"
              data-task-name="${escapeHtml(task.task_name)}"
              data-task-reward="${reward}"
              ${done ? 'disabled' : ''}>
              ${done ? '✓ Done' : t('start')}
            </button>
          </div>
        </div>`;
    });
  }
  list.innerHTML = html;

  // Attach listeners
  list.querySelectorAll('.task-start-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => openTask({
      id: btn.dataset.taskId,
      task_type: btn.dataset.taskType,
      target_url: btn.dataset.taskUrl,
      task_name: btn.dataset.taskName,
      reward: parseInt(btn.dataset.taskReward),
    }));
  });
}

function openTask(task) {
  state.currentTask = task;
  document.getElementById('overlayTaskName').textContent = task.task_name;
  document.getElementById('overlayTaskReward').textContent = `+${task.reward.toLocaleString()} TR`;

  // Reset overlay state
  document.getElementById('taskTimerSection').classList.add('hidden');
  document.getElementById('taskVerifySection').classList.add('hidden');
  document.getElementById('taskClaimBtn').classList.add('hidden');
  document.getElementById('taskVerifyBtn').classList.add('hidden');
  document.getElementById('taskOverlay').classList.remove('hidden');

  if (task.task_type === 'visit' || task.task_type === 'game') {
    // Open URL then start timer
    tg?.openLink(task.target_url) || window.open(task.target_url, '_blank');
    const duration = task.task_type === 'game' ? 10 : 15;
    startTaskTimer(duration, task);
  } else {
    // Channel / Group - show verify section
    document.getElementById('taskVerifySection').classList.remove('hidden');
    document.getElementById('overlayOpenLink').onclick = () => {
      tg?.openLink(task.target_url) || window.open(task.target_url, '_blank');
      setTimeout(() => {
        document.getElementById('taskVerifyBtn').classList.remove('hidden');
      }, 1500);
    };
  }
}

function startTaskTimer(duration, task) {
  document.getElementById('taskTimerSection').classList.remove('hidden');
  let remaining = duration;
  const circumference = 226;
  const progressEl = document.getElementById('timerProgress');
  const textEl = document.getElementById('timerText');
  const barEl = document.getElementById('progressBarFill');

  progressEl.style.strokeDashoffset = 0;
  textEl.textContent = remaining;
  barEl.style.width = '100%';

  state.currentTaskTimer = setInterval(() => {
    remaining--;
    textEl.textContent = remaining;
    const progress = remaining / duration;
    progressEl.style.strokeDashoffset = circumference * (1 - progress);
    barEl.style.width = `${progress * 100}%`;

    if (remaining <= 0) {
      clearInterval(state.currentTaskTimer);
      document.getElementById('taskClaimBtn').classList.remove('hidden');
    }
  }, 1000);
}

document.getElementById('taskClaimBtn').addEventListener('click', async () => {
  if (!state.currentTask) return;
  try {
    const res = await apiPost('/claim-task', { task_id: state.currentTask.id });
    state.user.coins += res.reward;
    state.user.spins = (state.user.spins || 0) + 1;
    updateBalanceDisplay();
    closeTaskOverlay();
    showToast(`+${res.reward} TR +1 🎰`, 'success');
    loadTasks(); // refresh
  } catch (e) {
    showToast(e.message || 'Failed to claim', 'error');
  }
});

document.getElementById('taskVerifyBtn').addEventListener('click', async () => {
  if (!state.currentTask) return;
  document.getElementById('taskVerifyBtn').disabled = true;
  document.getElementById('taskVerifyBtn').textContent = 'Verifying...';
  try {
    const res = await apiPost('/verify-join', { task_id: state.currentTask.id });
    state.user.coins += res.reward;
    state.user.spins = (state.user.spins || 0) + 1;
    updateBalanceDisplay();
    closeTaskOverlay();
    showToast(`+${res.reward} TR +1 🎰`, 'success');
    loadTasks();
  } catch (e) {
    showToast(e.message || 'Not a member yet. Please join first.', 'error');
    document.getElementById('taskVerifyBtn').disabled = false;
    document.getElementById('taskVerifyBtn').textContent = t('iJoined');
  }
});

function closeTaskOverlay() {
  clearInterval(state.currentTaskTimer);
  state.currentTask = null;
  document.getElementById('taskOverlay').classList.add('hidden');
}

document.getElementById('taskOverlayClose').addEventListener('click', closeTaskOverlay);

// ── FRIENDS PAGE ─────────────────────────────────────────────────
async function loadFriends() {
  const user = getTgUser();
  const link = `https://t.me/${CONFIG.BOT_USERNAME}?start=${user.id}`;
  document.getElementById('referralLink').textContent = link;

  try {
    const res = await apiGet('/friends');
    state.friends = res.friends || [];
    document.getElementById('pendingReferral').textContent = (res.pending_earnings || 0).toLocaleString();
    document.getElementById('totalFriends').textContent = res.total_friends || 0;
    document.getElementById('totalEarnedRef').textContent = (res.total_earned || 0).toLocaleString();
    renderFriends();
  } catch (e) {
    // ignore
  }
}

function renderFriends() {
  const list = document.getElementById('friendsList');
  if (!state.friends.length) {
    list.innerHTML = `<div class="empty-state">${t('noFriendsYet')}</div>`;
    return;
  }
  list.innerHTML = state.friends.map(f => `
    <div class="friend-item">
      <div>
        <div class="friend-name">${escapeHtml(f.name)}</div>
        <div class="friend-coins">${(f.coins || 0).toLocaleString()} TR total</div>
      </div>
      <div class="friend-share">+${(f.your_share || 0).toLocaleString()} TR</div>
    </div>
  `).join('');
}

document.getElementById('copyReferral').addEventListener('click', () => {
  const user = getTgUser();
  const link = `https://t.me/${CONFIG.BOT_USERNAME}?start=${user.id}`;
  navigator.clipboard.writeText(link).then(() => showToast('Link copied!', 'success')).catch(() => {
    // Fallback
    const el = document.createElement('textarea');
    el.value = link;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('Link copied!', 'success');
  });
});

document.getElementById('inviteBtn').addEventListener('click', () => {
  const user = getTgUser();
  const link = `https://t.me/${CONFIG.BOT_USERNAME}?start=${user.id}`;
  const text = `🚀 Join TRewards and earn TR coins! Complete tasks, spin the wheel, and withdraw TON!`;
  tg?.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
});

document.getElementById('claimReferralBtn').addEventListener('click', async () => {
  try {
    const res = await apiPost('/claim-referral');
    state.user.coins += res.reward;
    updateBalanceDisplay();
    document.getElementById('pendingReferral').textContent = '0';
    showToast(`+${res.reward} TR`, 'success');
  } catch (e) {
    showToast(e.message || 'Nothing to claim', 'error');
  }
});

// ── WALLET PAGE ──────────────────────────────────────────────────
async function loadTransactions() {
  try {
    const res = await apiGet('/transactions');
    state.transactions = res.transactions || [];
    renderTransactions();
  } catch (e) { /* ignore */ }
}

function renderTransactions() {
  const list = document.getElementById('txList');
  if (!state.transactions.length) {
    list.innerHTML = `<div class="empty-state">${t('noTransactions')}</div>`;
    return;
  }
  list.innerHTML = state.transactions.map(tx => {
    const isCredit = tx.amount > 0;
    const date = new Date(tx.created_at).toLocaleDateString();
    return `
      <div class="tx-item">
        <div class="tx-left">
          <div class="tx-type">${escapeHtml(tx.type)}</div>
          <div class="tx-desc">${escapeHtml(tx.description || '')}</div>
          <div class="tx-date">${date}</div>
        </div>
        <div class="tx-amount ${isCredit ? 'credit' : 'debit'}">
          ${isCredit ? '+' : ''}${tx.amount.toLocaleString()} TR
        </div>
      </div>`;
  }).join('');
}

// Withdraw tiers
document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tier = btn.closest('.withdraw-tier');
    const coins = parseInt(tier.dataset.coins);
    const ton = parseFloat(tier.dataset.ton);
    const net = parseFloat(tier.dataset.net);

    if ((state.user?.coins || 0) < coins) {
      showToast(`Need ${coins.toLocaleString()} TR`, 'error');
      return;
    }

    state.pendingWithdraw = { coins, ton, net };
    document.getElementById('wCoins').textContent = coins.toLocaleString() + ' TR';
    document.getElementById('wGross').textContent = ton.toFixed(2) + ' TON';
    document.getElementById('wNet').textContent = net.toFixed(2) + ' TON';
    document.getElementById('withdrawOverlay').classList.remove('hidden');
  });
});

document.getElementById('withdrawClose').addEventListener('click', () => {
  document.getElementById('withdrawOverlay').classList.add('hidden');
});

document.getElementById('confirmWithdrawBtn').addEventListener('click', async () => {
  if (!state.pendingWithdraw) return;
  const { coins, ton, net } = state.pendingWithdraw;
  document.getElementById('confirmWithdrawBtn').disabled = true;
  try {
    await apiPost('/withdraw', { coins_amount: coins, ton_amount: ton, net_amount: net });
    state.user.coins -= coins;
    updateBalanceDisplay();
    document.getElementById('withdrawOverlay').classList.add('hidden');
    showToast(`Withdrawal of ${net} TON queued!`, 'success');
    loadTransactions();
  } catch (e) {
    showToast(e.message || 'Withdrawal failed', 'error');
  } finally {
    document.getElementById('confirmWithdrawBtn').disabled = false;
    state.pendingWithdraw = null;
  }
});

// ── TOP UP ───────────────────────────────────────────────────────
document.querySelectorAll('.topup-amount-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.topup-amount-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.selectedTopupAmount = parseFloat(btn.dataset.amount);
    document.getElementById('customTopupAmount').value = '';
  });
});

document.getElementById('topUpBtn').addEventListener('click', () => {
  const custom = parseFloat(document.getElementById('customTopupAmount').value);
  const amount = custom > 0 ? custom : state.selectedTopupAmount;
  if (!amount || amount <= 0) { showToast('Select or enter an amount', 'error'); return; }
  state.pendingTopup = amount;
  document.getElementById('topupAmountDisplay').textContent = amount;
  document.getElementById('topupOverlay').classList.remove('hidden');
});

document.getElementById('topupClose').addEventListener('click', () => {
  document.getElementById('topupOverlay').classList.add('hidden');
});

async function createTopup(method) {
  if (!state.pendingTopup) return;
  document.getElementById('xrocketBtn').disabled = true;
  document.getElementById('cryptoPayBtn').disabled = true;
  try {
    const res = await apiPost('/create-topup', {
      amount: state.pendingTopup,
      method,
    });
    document.getElementById('topupOverlay').classList.add('hidden');
    if (res.payment_url) {
      tg?.openLink(res.payment_url) || window.open(res.payment_url, '_blank');
      showToast('Payment page opened', 'success');
    }
  } catch (e) {
    showToast(e.message || 'Failed to create invoice', 'error');
  } finally {
    document.getElementById('xrocketBtn').disabled = false;
    document.getElementById('cryptoPayBtn').disabled = false;
    state.pendingTopup = null;
  }
}

document.getElementById('xrocketBtn').addEventListener('click', () => createTopup('xrocket'));
document.getElementById('cryptoPayBtn').addEventListener('click', () => createTopup('cryptopay'));

// ── ADVERTISER DASHBOARD ─────────────────────────────────────────
document.getElementById('addTaskBtn').addEventListener('click', () => {
  loadAdvertiserData();
  document.getElementById('advertiserOverlay').classList.remove('hidden');
});

document.getElementById('advertiserClose').addEventListener('click', () => {
  document.getElementById('advertiserOverlay').classList.add('hidden');
});

document.querySelectorAll('.tab-switch-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-switch-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ad-tab').forEach(t => { t.classList.remove('active'); t.classList.add('hidden'); });
    btn.classList.add('active');
    const tab = document.getElementById(`adTab-${btn.dataset.adtab}`);
    if (tab) { tab.classList.remove('hidden'); tab.classList.add('active'); }
    if (btn.dataset.adtab === 'my') renderAdTasks();
  });
});

async function loadAdvertiserData() {
  try {
    const res = await apiGet('/advertiser');
    state.adBalance = res.ad_balance || 0;
    state.adTasks = res.tasks || [];
    document.getElementById('adBalance').textContent = state.adBalance.toFixed(3);
  } catch (e) { /* ignore */ }
}

// Cost preview
const targetSelect = document.getElementById('adTaskTarget');
targetSelect.addEventListener('change', updateCostPreview);
function updateCostPreview() {
  const target = parseInt(targetSelect.value) || 500;
  const cost = (target * 0.001).toFixed(1);
  document.getElementById('taskCostPreview').textContent = `${cost} TON`;
}

document.getElementById('adTopUpBtn').addEventListener('click', () => {
  state.pendingTopup = 1;
  document.getElementById('topupAmountDisplay').textContent = 1;
  document.getElementById('advertiserOverlay').classList.add('hidden');
  document.getElementById('topupOverlay').classList.remove('hidden');
});

document.getElementById('publishTaskBtn').addEventListener('click', async () => {
  const name = document.getElementById('adTaskName').value.trim();
  const type = document.getElementById('adTaskType').value;
  const url = document.getElementById('adTaskUrl').value.trim();
  const target = parseInt(document.getElementById('adTaskTarget').value);

  if (!name || !url) { showToast('Fill in all fields', 'error'); return; }

  const cost = target * 0.001;
  if (state.adBalance < cost) { showToast(`Insufficient ad balance. Need ${cost} TON`, 'error'); return; }

  document.getElementById('publishTaskBtn').disabled = true;
  try {
    await apiPost('/create-task', { task_name: name, task_type: type, target_url: url, completion_target: target });
    state.adBalance -= cost;
    document.getElementById('adBalance').textContent = state.adBalance.toFixed(3);
    document.getElementById('adTaskName').value = '';
    document.getElementById('adTaskUrl').value = '';
    showToast('Task published!', 'success');
  } catch (e) {
    showToast(e.message || 'Failed to publish task', 'error');
  } finally {
    document.getElementById('publishTaskBtn').disabled = false;
  }
});

function renderAdTasks() {
  const list = document.getElementById('adTasksList');
  if (!state.adTasks.length) {
    list.innerHTML = `<div class="empty-state">${t('noTasksPublished')}</div>`;
    return;
  }
  list.innerHTML = state.adTasks.map(task => {
    const pct = Math.min(100, Math.round((task.completed_count / task.completion_target) * 100));
    const statusClass = `status-${task.status}`;
    return `
      <div class="ad-task-item">
        <div class="ad-task-name">${escapeHtml(task.task_name)}</div>
        <div class="ad-task-progress">
          <div class="ad-task-progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="ad-task-meta">
          <span>${task.completed_count} / ${task.completion_target} completions</span>
          <span class="ad-task-status ${statusClass}">${task.status}</span>
        </div>
      </div>`;
  }).join('');
}

// ── INIT ─────────────────────────────────────────────────────────
async function init() {
  tg?.ready();
  tg?.expand();

  applyI18n();
  drawWheel(0);
  setupDailyTasks();
  updateCostPreview();

  // Build streak dots (placeholder)
  renderStreakDots();

  // Load user data
  try {
    const tgUser = getTgUser();
    const res = await apiPost('/user', {
      telegram_id: tgUser.id,
      first_name: tgUser.first_name,
      last_name: tgUser.last_name,
      username: tgUser.username,
    });
    state.user = res.user;
    updateBalanceDisplay();
    renderStreakDots();

    // Mark daily tasks if claimed today
    if (res.user.daily_checkin_claimed) markDailyTask('checkin');
    if (res.user.daily_updates_claimed) {
      markDailyTask('updates');
      state.updatesTaskClicked = true;
    }
    if (res.user.daily_share_claimed) markDailyTask('share');
    if (res.user.streak_claimed_today) {
      document.getElementById('claimStreakBtn').disabled = true;
      document.getElementById('claimStreakBtn').textContent = '✓ Claimed';
    }
  } catch (e) {
    // Use default state for dev
    state.user = { id: 0, coins: 0, spins: 0, streak_count: 0 };
    updateBalanceDisplay();
    console.warn('User load failed:', e.message);
  }
}

// ── UTILS ────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Start app
init();