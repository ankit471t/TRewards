// ===== CONFIG =====
const API_BASE = 'https://trewards-backend.onrender.com'; // Update after deploy
const BOT_USERNAME = 'trewards_ton_bot';
const CHANNEL_URL = 'https://t.me/trewards_tonfirst';
const TR_TO_TON = 0.0000004;
const SPIN_SEGMENTS = [10, 50, 80, 100, 300, 500];

// ===== I18N =====
const i18n = {
  en: {
    home: 'Home', tasks: 'Tasks', friends: 'Friends', wallet: 'Wallet',
    total_balance: 'Total Balance', daily_streak: 'Daily Streak',
    spin_wheel: 'Spin Wheel', quick_actions: 'Quick Actions',
    promo_code: 'Promo Code', daily_tasks: 'Daily Tasks',
    invite_friend: 'Invite Friend', withdraw: 'Withdraw',
    earn_more: 'Earn More', referral: 'Referral',
    enter_code: 'Enter code...', redeem: 'Redeem',
    daily_checkin: 'Daily Check-In', check_updates: 'Check for Updates',
    share_friends: 'Share with Friends', claim: 'Claim',
    open: 'Open', share: 'Share', spin: 'SPIN',
    spins_left: 'spins left', claim_streak: 'Claim Daily Reward',
    earn_tasks: 'Earn with Tasks', all: 'All', channel: 'Channel',
    group: 'Group', visit: 'Visit', game: 'Game',
    friends_referrals: 'Friends & Referrals',
    your_referral_link: 'Your Referral Link',
    invite_via_telegram: 'Invite via Telegram',
    pending_referral: 'Pending Referral Earnings',
    total_friends: 'Total Friends', total_earned: 'Total Earned',
    your_friends: 'Your Friends', no_friends_yet: 'No friends yet. Invite someone!',
    your_balance: 'Your Balance',
    withdraw_options: 'Withdrawal Options',
    withdraw_notice: 'Processed within 24 hours. 0.05 TON network fee applies.',
    transaction_history: 'Transaction History', no_transactions: 'No transactions yet',
    verify_membership: 'Verify Membership',
    join_and_verify: 'Please join the channel/group and then verify.',
    open_link: 'Open Link', ive_joined: "I've Joined ✓", cancel: 'Cancel',
    confirm_withdrawal: 'Confirm Withdrawal',
    you_spend: 'You Spend', gross_ton: 'Gross TON',
    network_fee: 'Network Fee', you_receive: 'You Receive',
    withdraw_24h: 'Withdrawal will be processed within 24 hours.',
    confirm: 'Confirm', advertiser_dashboard: 'Advertiser Dashboard',
    ad_balance: 'Ad Balance', top_up: 'Top Up',
    add_task: 'Add Task', my_tasks: 'My Tasks',
    task_name: 'Task Name', task_type: 'Task Type',
    target_url: 'Target URL', completion_target: 'Completion Target',
    estimated_cost: 'Estimated Cost:', publish_task: 'Publish Task',
    no_tasks_yet: 'No tasks published yet', task: 'TASK',
    join_channel: 'Join Channel (+1000 TR)', join_group: 'Join Group (+1000 TR)',
    visit_website: 'Visit Website (+500 TR)', play_game: 'Play Game Bot (+1000 TR)',
  },
  ru: {
    home: 'Главная', tasks: 'Задания', friends: 'Друзья', wallet: 'Кошелёк',
    total_balance: 'Баланс', daily_streak: 'Ежедневная серия',
    spin_wheel: 'Колесо удачи', quick_actions: 'Быстрые действия',
    promo_code: 'Промокод', daily_tasks: 'Ежедневные задания',
    invite_friend: 'Пригласить', withdraw: 'Вывод',
    earn_more: 'Зарабатывать', referral: 'Реферал',
    enter_code: 'Введите код...', redeem: 'Применить',
    daily_checkin: 'Ежедневный вход', check_updates: 'Проверить обновления',
    share_friends: 'Поделиться', claim: 'Получить',
    open: 'Открыть', share: 'Поделиться', spin: 'КРУТИТЬ',
    spins_left: 'прокруток', claim_streak: 'Получить награду',
    earn_tasks: 'Задания', all: 'Все', channel: 'Канал',
    group: 'Группа', visit: 'Сайт', game: 'Игра',
    friends_referrals: 'Друзья и рефералы',
    your_referral_link: 'Ваша реферальная ссылка',
    invite_via_telegram: 'Пригласить в Telegram',
    pending_referral: 'Реферальные начисления',
    total_friends: 'Всего друзей', total_earned: 'Всего заработано',
    your_friends: 'Ваши друзья', no_friends_yet: 'Пока нет друзей. Пригласите кого-нибудь!',
    your_balance: 'Ваш баланс',
    withdraw_options: 'Варианты вывода',
    withdraw_notice: 'Обработка до 24 часов. Комиссия сети 0.05 TON.',
    transaction_history: 'История транзакций', no_transactions: 'Нет транзакций',
    verify_membership: 'Подтверждение членства',
    join_and_verify: 'Вступите в канал/группу и подтвердите.',
    open_link: 'Открыть ссылку', ive_joined: 'Я вступил ✓', cancel: 'Отмена',
    confirm_withdrawal: 'Подтвердить вывод',
    you_spend: 'Вы тратите', gross_ton: 'TON брутто',
    network_fee: 'Комиссия сети', you_receive: 'Вы получаете',
    withdraw_24h: 'Вывод будет обработан в течение 24 часов.',
    confirm: 'Подтвердить', advertiser_dashboard: 'Панель рекламодателя',
    ad_balance: 'Рекламный баланс', top_up: 'Пополнить',
    add_task: 'Добавить задание', my_tasks: 'Мои задания',
    task_name: 'Название задания', task_type: 'Тип задания',
    target_url: 'Целевой URL', completion_target: 'Количество выполнений',
    estimated_cost: 'Оценочная стоимость:', publish_task: 'Опубликовать',
    no_tasks_yet: 'Нет опубликованных заданий', task: 'ЗАДАНИЕ',
    join_channel: 'Канал (+1000 TR)', join_group: 'Группа (+1000 TR)',
    visit_website: 'Сайт (+500 TR)', play_game: 'Игровой бот (+1000 TR)',
  }
};

// ===== STATE =====
let state = {
  lang: 'en',
  user: null,
  balance: 0,
  spins: 0,
  streak: 0,
  streakDays: [],
  tasks: [],
  friends: [],
  transactions: [],
  pendingReferral: 0,
  adBalance: 0,
  adTasks: [],
  currentTaskFilter: 'all',
  spinInProgress: false,
  pendingVerifyTask: null,
  pendingWithdraw: null,
  updatesTaskOpened: false,
  telegramId: null,
  initData: null,
};

// ===== TELEGRAM WEBAPP =====
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0A0800');
  tg.setBackgroundColor('#0A0800');
}

// ===== API HELPER =====
async function api(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': state.initData || '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(API_BASE + path, opts);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'API error');
    return data;
  } catch (e) {
    console.error('API error:', e);
    throw e;
  }
}

// ===== TOAST =====
let toastTimer;
function showToast(msg, type = 'info', duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.add('hidden'); }, duration);
}

// ===== I18N APPLY =====
function applyLang() {
  const t = i18n[state.lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t[key]) el.textContent = t[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (t[key]) el.placeholder = t[key];
  });
  document.getElementById('langToggle').textContent = state.lang.toUpperCase();
}

// ===== TAB SWITCHING =====
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${tab}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`)?.classList.add('active');
  if (tab === 'tasks') loadTasks();
  if (tab === 'friends') loadFriends();
  if (tab === 'wallet') loadWallet();
}
window.switchTab = switchTab;

// ===== FORMAT NUMBERS =====
function fmt(n) { return Number(n || 0).toLocaleString(); }
function fmtTon(n) { return parseFloat(n || 0).toFixed(6); }

// ===== UPDATE UI =====
function updateBalanceUI() {
  const b = state.balance;
  const ton = (b * TR_TO_TON).toFixed(6);
  document.getElementById('homeBalance').textContent = fmt(b);
  document.getElementById('homeTon').textContent = ton;
  document.getElementById('walletBalance').textContent = fmt(b);
  document.getElementById('walletTon').textContent = ton;
  document.getElementById('streakCount').textContent = state.streak;
  document.getElementById('spinsCount').textContent = state.spins;
  document.getElementById('spinsLeft').textContent = state.spins;
}

// ===== STREAK DOTS =====
function renderStreakDots() {
  const container = document.getElementById('streakDots');
  container.innerHTML = '';
  for (let i = 1; i <= 7; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot';
    const day = state.streakDays?.[i - 1];
    if (day?.claimed) dot.classList.add('done');
    else if (i === (state.streak % 7) + 1) dot.classList.add('today');
    dot.textContent = i;
    container.appendChild(dot);
  }
}

// ===== SPIN WHEEL =====
let wheelAngle = 0;
let wheelAnimFrame = null;

function drawWheel() {
  const canvas = document.getElementById('wheelCanvas');
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = cx - 8;
  const slices = SPIN_SEGMENTS.length;
  const arc = (2 * Math.PI) / slices;

  const colors = ['#1A1200', '#2A1E00', '#1A1200', '#2A1E00', '#1A1200', '#2A1E00'];
  const goldBorder = '#FFB800';

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, 2 * Math.PI);
  ctx.strokeStyle = goldBorder;
  ctx.lineWidth = 4;
  ctx.stroke();

  for (let i = 0; i < slices; i++) {
    const startAngle = wheelAngle + i * arc;
    const endAngle = startAngle + arc;

    // Segment
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.strokeStyle = goldBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(startAngle + arc / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#FFB800';
    ctx.font = 'bold 13px Orbitron, monospace';
    ctx.fillText(SPIN_SEGMENTS[i], r - 14, 5);
    ctx.restore();
  }

  // Center circle
  ctx.beginPath();
  ctx.arc(cx, cy, 32, 0, 2 * Math.PI);
  ctx.fillStyle = '#0A0800';
  ctx.fill();
  ctx.strokeStyle = goldBorder;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function spinWheelAnimation(targetIndex, duration, callback) {
  const arc = (2 * Math.PI) / SPIN_SEGMENTS.length;
  const targetAngle = -targetIndex * arc - arc / 2 + Math.PI / 2;
  const spins = 5;
  const fullTarget = spins * 2 * Math.PI + ((targetAngle - wheelAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const start = performance.now();
  const startAngle = wheelAngle;

  function easeOut(t) { return 1 - Math.pow(1 - t, 4); }

  function frame(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    wheelAngle = startAngle + fullTarget * easeOut(progress);
    drawWheel();
    if (progress < 1) {
      wheelAnimFrame = requestAnimationFrame(frame);
    } else {
      wheelAngle = wheelAngle % (2 * Math.PI);
      state.spinInProgress = false;
      callback();
    }
  }

  requestAnimationFrame(frame);
}

async function doSpin() {
  if (state.spinInProgress) return;
  if (state.spins <= 0) { showToast('No spins available!', 'error'); return; }

  state.spinInProgress = true;
  document.getElementById('spinBtn').disabled = true;

  try {
    const result = await api('POST', '/spin');
    state.balance = result.balance;
    state.spins = result.spins;
    const idx = SPIN_SEGMENTS.indexOf(result.prize);
    spinWheelAnimation(idx < 0 ? 0 : idx, 5000, () => {
      updateBalanceUI();
      document.getElementById('spinBtn').disabled = false;
      showToast(`+${result.prize} TR!`, 'success');
      addTxToHistory({ type: 'Spin', desc: `Spin reward`, amount: result.prize, date: new Date() });
    });
  } catch (e) {
    state.spinInProgress = false;
    document.getElementById('spinBtn').disabled = false;
    showToast(e.message, 'error');
  }
}

function addTxToHistory(tx) {
  state.transactions.unshift(tx);
  renderTransactions();
}

// ===== DAILY STREAK CLAIM =====
async function claimStreak() {
  const btn = document.getElementById('claimStreakBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/claim-streak');
    state.balance = r.balance;
    state.spins = r.spins;
    state.streak = r.streak;
    state.streakDays = r.streakDays;
    updateBalanceUI();
    renderStreakDots();
    showToast('+10 TR +1 🎰 Streak claimed!', 'success');
    btn.textContent = '✓ Claimed';
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, 'error');
  }
}

// ===== DAILY TASKS =====
async function claimDailyCheckIn() {
  const btn = document.getElementById('checkinBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/claim-daily-task', { taskId: 'checkin' });
    state.balance = r.balance;
    updateBalanceUI();
    btn.textContent = '✓';
    btn.classList.add('completed');
    showToast('+10 TR +1 🎰', 'success');
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, 'error');
  }
}

function handleUpdatesTask() {
  const btn = document.getElementById('updatesBtn');
  if (!state.updatesTaskOpened) {
    window.open(CHANNEL_URL, '_blank');
    state.updatesTaskOpened = true;
    btn.textContent = i18n[state.lang].claim;
    btn.setAttribute('data-i18n', 'claim');
  } else {
    claimUpdatesTask();
  }
}

async function claimUpdatesTask() {
  const btn = document.getElementById('updatesBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/claim-daily-task', { taskId: 'updates' });
    state.balance = r.balance;
    updateBalanceUI();
    btn.textContent = '✓';
    btn.classList.add('completed');
    showToast('+50 TR', 'success');
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, 'error');
  }
}

async function handleShareTask() {
  const btn = document.getElementById('shareBtn');
  const link = `https://t.me/${BOT_USERNAME}?start=${state.telegramId}`;
  const text = encodeURIComponent(`🚀 Join TRewards and earn TR coins!\n${link}`);
  if (tg) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`);
  } else {
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
  }
  btn.disabled = true;
  setTimeout(async () => {
    try {
      const r = await api('POST', '/claim-daily-task', { taskId: 'share' });
      state.balance = r.balance;
      updateBalanceUI();
      btn.textContent = '✓';
      btn.classList.add('completed');
      showToast('+30 TR', 'success');
    } catch (e) {
      btn.disabled = false;
      showToast(e.message, 'error');
    }
  }, 3000);
}

// ===== PROMO CODE =====
async function redeemPromo() {
  const code = document.getElementById('promoInput').value.trim();
  if (!code) return;
  try {
    const r = await api('POST', '/redeem-promo', { code });
    state.balance = r.balance;
    updateBalanceUI();
    document.getElementById('promoInput').value = '';
    showToast(`+${r.reward} TR! Promo redeemed!`, 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ===== LOAD TASKS =====
async function loadTasks() {
  const list = document.getElementById('tasksList');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
  try {
    const data = await api('GET', '/tasks');
    state.tasks = data.tasks || [];
    renderTasks();
  } catch (e) {
    list.innerHTML = `<div class="empty-state">Failed to load tasks</div>`;
  }
}

function renderTasks() {
  const list = document.getElementById('tasksList');
  const filter = state.currentTaskFilter;
  const filtered = filter === 'all' ? state.tasks : state.tasks.filter(t => t.type === filter);
  if (!filtered.length) { list.innerHTML = '<div class="empty-state">No tasks available</div>'; return; }

  list.innerHTML = '';
  filtered.forEach(task => {
    const card = document.createElement('div');
    card.className = 'ad-task-card';
    const claimed = task.claimedByUser;
    const pct = Math.round((task.completedCount / task.limit) * 100);
    const reward = ['channel', 'group', 'game'].includes(task.type) ? 1000 : 500;
    const typeLabel = { visit: 'Visit Website', channel: 'Join Channel', group: 'Join Group', game: 'Play Game' }[task.type] || task.type;

    card.innerHTML = `
      <div class="ad-task-header">
        <div class="ad-task-info">
          <div class="ad-task-name">${escHtml(task.name)}</div>
          <div class="ad-task-type">${typeLabel}</div>
        </div>
        <div class="ad-task-reward">+${fmt(reward)} TR</div>
      </div>
      <div class="ad-task-progress"><div class="ad-task-progress-bar" style="width:${pct}%"></div></div>
      <div class="ad-task-footer">
        <div class="ad-task-completed-count">${fmt(task.completedCount)}/${fmt(task.limit)}</div>
        <div>
          <div class="task-timer-bar" id="timer-${task.id}"><div class="task-timer-fill" id="timerfill-${task.id}" style="width:100%"></div></div>
          <button class="btn-start ${claimed ? 'claimed' : ''}" id="taskbtn-${task.id}"
            onclick="handleTaskAction('${task.id}','${task.type}','${escHtml(task.url)}')" ${claimed ? 'disabled' : ''}>
            ${claimed ? '✓ Done' : 'Start'}
          </button>
        </div>
      </div>`;
    list.appendChild(card);
  });
}

const taskTimers = {};

function handleTaskAction(taskId, type, url) {
  const btn = document.getElementById(`taskbtn-${taskId}`);
  const timerBar = document.getElementById(`timer-${taskId}`);
  const timerFill = document.getElementById(`timerfill-${taskId}`);

  if (btn.dataset.phase === 'claim') {
    claimTask(taskId);
    return;
  }

  if (type === 'channel' || type === 'group') {
    // Show verify overlay
    state.pendingVerifyTask = { taskId, url };
    document.getElementById('verifyOpenLink').href = url;
    document.getElementById('verifyOverlay').classList.remove('hidden');
    return;
  }

  // visit / game
  window.open(url, '_blank');
  btn.disabled = true;
  btn.textContent = 'Waiting...';
  timerBar.style.display = 'block';

  const duration = type === 'game' ? 10000 : 15000;
  const start = Date.now();

  taskTimers[taskId] = setInterval(() => {
    const elapsed = Date.now() - start;
    const pct = Math.max(0, 100 - (elapsed / duration) * 100);
    timerFill.style.width = pct + '%';
    if (elapsed >= duration) {
      clearInterval(taskTimers[taskId]);
      timerBar.style.display = 'none';
      btn.textContent = 'Claim';
      btn.disabled = false;
      btn.dataset.phase = 'claim';
    }
  }, 100);
}

async function claimTask(taskId) {
  const btn = document.getElementById(`taskbtn-${taskId}`);
  btn.disabled = true;
  try {
    const r = await api('POST', '/claim-task', { taskId });
    state.balance = r.balance;
    state.spins = r.spins;
    updateBalanceUI();
    btn.textContent = '✓ Done';
    btn.classList.add('claimed');
    // Update local task state
    const t = state.tasks.find(t => t.id === taskId);
    if (t) { t.claimedByUser = true; t.completedCount++; }
    showToast(`+${r.reward} TR +1 🎰`, 'success');
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, 'error');
  }
}

async function verifyJoin() {
  if (!state.pendingVerifyTask) return;
  const btn = document.getElementById('verifyJoinedBtn');
  btn.disabled = true;
  btn.textContent = 'Verifying...';
  try {
    const r = await api('POST', '/verify-join', { taskId: state.pendingVerifyTask.taskId });
    state.balance = r.balance;
    state.spins = r.spins;
    updateBalanceUI();
    document.getElementById('verifyOverlay').classList.add('hidden');
    const taskBtn = document.getElementById(`taskbtn-${state.pendingVerifyTask.taskId}`);
    if (taskBtn) { taskBtn.textContent = '✓ Done'; taskBtn.classList.add('claimed'); taskBtn.disabled = true; }
    const t = state.tasks.find(t => t.id === state.pendingVerifyTask.taskId);
    if (t) { t.claimedByUser = true; t.completedCount++; }
    state.pendingVerifyTask = null;
    showToast(`+${r.reward} TR +1 🎰`, 'success');
  } catch (e) {
    btn.disabled = false;
    btn.textContent = i18n[state.lang].ive_joined;
    showToast(e.message, 'error');
  }
}

// ===== FRIENDS =====
async function loadFriends() {
  try {
    const r = await api('GET', '/friends');
    state.friends = r.friends || [];
    state.pendingReferral = r.pendingReferral || 0;
    const link = `https://t.me/${BOT_USERNAME}?start=${state.telegramId}`;
    document.getElementById('referralLink').textContent = link;
    document.getElementById('pendingReferral').textContent = fmt(state.pendingReferral);
    document.getElementById('totalFriends').textContent = state.friends.length;
    document.getElementById('totalReferralEarned').textContent = fmt(r.totalReferralEarned || 0);
    renderFriends();
  } catch (e) {
    showToast('Failed to load friends', 'error');
  }
}

function renderFriends() {
  const list = document.getElementById('friendsList');
  if (!state.friends.length) {
    list.innerHTML = `<div class="empty-state">${i18n[state.lang].no_friends_yet}</div>`;
    return;
  }
  list.innerHTML = state.friends.map(f => `
    <div class="friend-item">
      <div>
        <div class="friend-name">${escHtml(f.name)}</div>
        <div class="friend-coins">${fmt(f.coins)} TR</div>
      </div>
      <div class="friend-share">+${fmt(f.yourShare)} TR earned</div>
    </div>`).join('');
}

async function claimReferral() {
  if (state.pendingReferral <= 0) { showToast('No pending referral earnings', 'info'); return; }
  const btn = document.getElementById('claimReferralBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/claim-referral');
    state.balance = r.balance;
    state.pendingReferral = 0;
    updateBalanceUI();
    document.getElementById('pendingReferral').textContent = '0';
    showToast(`+${r.claimed} TR from referrals!`, 'success');
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, 'error');
  }
}

// ===== WALLET =====
async function loadWallet() {
  try {
    const r = await api('GET', '/transactions');
    state.transactions = r.transactions || [];
    renderTransactions();
  } catch (e) {
    showToast('Failed to load transactions', 'error');
  }
}

function renderTransactions() {
  const list = document.getElementById('txHistory');
  if (!state.transactions.length) {
    list.innerHTML = `<div class="empty-state">${i18n[state.lang].no_transactions}</div>`;
    return;
  }
  list.innerHTML = state.transactions.slice(0, 50).map(tx => `
    <div class="tx-item">
      <div class="tx-left">
        <div class="tx-type">${escHtml(tx.type)}</div>
        <div class="tx-desc">${escHtml(tx.desc || tx.description || '')}</div>
      </div>
      <div class="tx-right">
        <div class="tx-amount ${tx.amount > 0 ? 'credit' : 'debit'}">${tx.amount > 0 ? '+' : ''}${fmt(tx.amount)} TR</div>
        <div class="tx-date">${formatDate(tx.date || tx.createdAt)}</div>
      </div>
    </div>`).join('');
}

function formatDate(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ===== WITHDRAW =====
function openWithdrawConfirm(tr, ton, net) {
  state.pendingWithdraw = { tr, ton, net };
  document.getElementById('wdTR').textContent = fmt(tr) + ' TR';
  document.getElementById('wdTON').textContent = ton + ' TON';
  document.getElementById('wdNet').textContent = net + ' TON';
  document.getElementById('withdrawOverlay').classList.remove('hidden');
}

async function confirmWithdraw() {
  if (!state.pendingWithdraw) return;
  const { tr, ton, net } = state.pendingWithdraw;
  if (state.balance < tr) { showToast('Insufficient balance', 'error'); return; }
  const btn = document.getElementById('confirmWithdrawBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/withdraw', { tr, ton, net });
    state.balance = r.balance;
    updateBalanceUI();
    document.getElementById('withdrawOverlay').classList.add('hidden');
    state.pendingWithdraw = null;
    showToast(`Withdrawal of ${net} TON queued!`, 'success');
    addTxToHistory({ type: 'Withdraw', desc: `${net} TON pending`, amount: -tr, date: new Date() });
  } catch (e) {
    btn.disabled = false;
    showToast(e.message, 'error');
  }
}

// ===== ADVERTISER =====
async function loadAdvertiserData() {
  try {
    const r = await api('GET', '/advertiser');
    state.adBalance = r.balance || 0;
    state.adTasks = r.tasks || [];
    document.getElementById('adBalance').textContent = parseFloat(state.adBalance).toFixed(3);
    renderAdTasks();
  } catch (e) {
    // Not an advertiser yet – that's fine
  }
}

function renderAdTasks() {
  const list = document.getElementById('adTasksList');
  if (!state.adTasks.length) {
    list.innerHTML = `<div class="empty-state">${i18n[state.lang].no_tasks_yet}</div>`;
    return;
  }
  list.innerHTML = state.adTasks.map(t => `
    <div class="ad-task-row">
      <div class="ad-task-row-header">
        <div class="ad-task-row-name">${escHtml(t.name)}</div>
        <span class="ad-task-status status-${t.status}">${t.status}</span>
      </div>
      <div style="font-size:12px;color:var(--text-muted)">${fmt(t.completedCount)}/${fmt(t.limit)} completions</div>
    </div>`).join('');
}

async function publishTask() {
  const name = document.getElementById('adTaskName').value.trim();
  const type = document.getElementById('adTaskType').value;
  const url = document.getElementById('adTaskUrl').value.trim();
  const limit = parseInt(document.getElementById('adTaskLimit').value);

  if (!name || !url) { showToast('Fill all fields', 'error'); return; }
  const cost = (limit * 0.001).toFixed(3);
  if (parseFloat(state.adBalance) < parseFloat(cost)) {
    showToast(`Insufficient ad balance. Need ${cost} TON`, 'error'); return;
  }

  const btn = document.getElementById('publishTaskBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/create-task', { name, type, url, limit });
    state.adBalance = r.adBalance;
    document.getElementById('adBalance').textContent = parseFloat(r.adBalance).toFixed(3);
    document.getElementById('adTaskName').value = '';
    document.getElementById('adTaskUrl').value = '';
    showToast('Task published!', 'success');
    await loadAdvertiserData();
    switchAdTab('mytasks');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function switchAdTab(tab) {
  document.querySelectorAll('.ad-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`adTab-${tab}`)?.classList.add('active');
  document.querySelector(`.tab-btn[data-adtab="${tab}"]`)?.classList.add('active');
}

// ===== COPY =====
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
  } else {
    const el = document.createElement('textarea');
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    showToast('Copied!', 'success');
  }
}

// ===== INIT =====
async function init() {
  // Get Telegram user
  if (tg?.initDataUnsafe?.user) {
    state.telegramId = tg.initDataUnsafe.user.id;
    state.initData = tg.initData;
  } else {
    // Dev fallback
    state.telegramId = '0';
    state.initData = 'dev';
  }

  try {
    const r = await api('GET', '/me');
    state.balance = r.balance || 0;
    state.spins = r.spins || 0;
    state.streak = r.streak || 0;
    state.streakDays = r.streakDays || [];

    // Set daily task states
    if (r.dailyTasksClaimed?.checkin) {
      const btn = document.getElementById('checkinBtn');
      btn.textContent = '✓'; btn.classList.add('completed'); btn.disabled = true;
    }
    if (r.dailyTasksClaimed?.updates) {
      const btn = document.getElementById('updatesBtn');
      btn.textContent = '✓'; btn.classList.add('completed'); btn.disabled = true;
    }
    if (r.dailyTasksClaimed?.share) {
      const btn = document.getElementById('shareBtn');
      btn.textContent = '✓'; btn.classList.add('completed'); btn.disabled = true;
    }
    if (r.streakClaimed) {
      const btn = document.getElementById('claimStreakBtn');
      btn.textContent = '✓ Claimed'; btn.disabled = true;
    }
  } catch (e) {
    console.error('Init failed:', e);
  }

  // Set referral link
  const link = `https://t.me/${BOT_USERNAME}?start=${state.telegramId}`;
  document.getElementById('referralLink').textContent = link;

  applyLang();
  updateBalanceUI();
  renderStreakDots();
  drawWheel();
}

// ===== ESCAPE HTML =====
function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== EVENT LISTENERS =====
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Lang toggle
  document.getElementById('langToggle').addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'ru' : 'en';
    applyLang();
    renderTasks();
    renderFriends();
    renderTransactions();
  });

  // Spin button
  document.getElementById('spinBtn').addEventListener('click', doSpin);

  // Streak claim
  document.getElementById('claimStreakBtn').addEventListener('click', claimStreak);

  // Daily tasks
  document.getElementById('checkinBtn').addEventListener('click', claimDailyCheckIn);
  document.getElementById('updatesBtn').addEventListener('click', handleUpdatesTask);
  document.getElementById('shareBtn').addEventListener('click', handleShareTask);

  // Promo
  document.getElementById('redeemPromoBtn').addEventListener('click', redeemPromo);

  // Task category filter
  document.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentTaskFilter = btn.dataset.cat;
      renderTasks();
    });
  });

  // Friends
  document.getElementById('copyLinkBtn').addEventListener('click', () => {
    copyText(`https://t.me/${BOT_USERNAME}?start=${state.telegramId}`);
  });
  document.getElementById('inviteBtn').addEventListener('click', () => {
    const link = `https://t.me/${BOT_USERNAME}?start=${state.telegramId}`;
    const text = encodeURIComponent('🚀 Join TRewards and earn TR coins!\n' + link);
    if (tg) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`);
    else window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
  });
  document.getElementById('claimReferralBtn').addEventListener('click', claimReferral);

  // Withdraw tiers
  document.querySelectorAll('.btn-withdraw').forEach(btn => {
    btn.addEventListener('click', () => {
      const tier = btn.closest('.tier-card');
      const tr = parseInt(tier.dataset.tr);
      const ton = parseFloat(tier.dataset.ton);
      const net = parseFloat(tier.dataset.net);
      openWithdrawConfirm(tr, ton, net);
    });
  });
  document.getElementById('confirmWithdrawBtn').addEventListener('click', confirmWithdraw);
  document.getElementById('withdrawCloseBtn').addEventListener('click', () => {
    document.getElementById('withdrawOverlay').classList.add('hidden');
  });

  // Verify overlay
  document.getElementById('verifyJoinedBtn').addEventListener('click', verifyJoin);
  document.getElementById('verifyCloseBtn').addEventListener('click', () => {
    document.getElementById('verifyOverlay').classList.add('hidden');
    state.pendingVerifyTask = null;
  });

  // Advertiser
  document.getElementById('advertiserBtn').addEventListener('click', () => {
    document.getElementById('advertiserOverlay').classList.remove('hidden');
    loadAdvertiserData();
  });
  document.getElementById('advertiserCloseBtn').addEventListener('click', () => {
    document.getElementById('advertiserOverlay').classList.add('hidden');
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.adtab;
      if (tab) switchAdTab(tab);
    });
  });
  document.getElementById('publishTaskBtn').addEventListener('click', publishTask);
  document.getElementById('topUpBtn').addEventListener('click', () => switchAdTab('topup'));

  // Ad cost preview
  document.getElementById('adTaskLimit').addEventListener('change', e => {
    const cost = (parseInt(e.target.value) * 0.001).toFixed(3);
    document.getElementById('adCostPreview').textContent = cost + ' TON';
  });
});