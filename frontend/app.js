// ============================================================
// TREWARDS - Main Application JS
// ============================================================

const API = '/api'; // relative path — served from same domain

// i18n translations
const TRANSLATIONS = {
  en: {
    home: 'Home', tasks: 'Tasks', friends: 'Friends', wallet: 'Wallet',
    trCoins: 'TR Coins', dailyStreak: 'Daily Streak', claimStreak: 'Claim Streak',
    spinWheel: 'Spin Wheel', spin: 'Spin', quickActions: 'Quick Actions',
    inviteFriend: 'Invite Friend', withdraw: 'Withdraw', earnMore: 'Earn More',
    referral: 'Referral', promoCode: 'Promo Code', enterPromo: 'Enter promo code',
    redeem: 'Redeem', dailyTasks: 'Daily Tasks', all: 'All', channel: 'Channel',
    group: 'Group', game: 'Game', website: 'Website', yourReferral: 'Your Referral Link',
    inviteViaTelegram: 'Invite via Telegram', totalFriends: 'Total Friends',
    totalEarned: 'Total Earned', pendingReferral: 'Pending Referral Earnings',
    claim: 'Claim', friendsList: 'Friends List', topUpTon: 'Top Up TON',
    customAmount: 'Custom amount (TON)', transactions: 'Transaction History',
    withdrawNote: 'Network fee: 0.05 TON. Processed within 24h.',
    advertiserPanel: 'Advertiser Panel', adBalance: 'Ad Balance:',
    topUp: 'Top Up', addTask: '+ Add Task', myTasks: 'My Tasks',
    taskName: 'Task Name', joinChannel: 'Join Channel', joinGroup: 'Join Group',
    playGame: 'Play Game Bot', visitWebsite: 'Visit Website', publishTask: 'Publish Task',
    verifyJoin: 'Verify Join', joinPrompt: 'Please join the channel/group, then verify.',
    openLink: 'Open Link', iJoined: "I've Joined", confirmWithdraw: 'Confirm Withdrawal',
    confirm: 'Confirm', tonEquiv: '≈', start: 'Start', checkIn: 'Check-In',
    updates: 'Check for Updates', share: 'Share with Friends', done: '✓ Done',
    claimed: 'Claimed', claimNow: 'Claim', pending: 'Pending',
  },
  ru: {
    home: 'Главная', tasks: 'Задания', friends: 'Друзья', wallet: 'Кошелёк',
    trCoins: 'TR Монеты', dailyStreak: 'Ежедневная серия', claimStreak: 'Получить',
    spinWheel: 'Колесо удачи', spin: 'Крутить', quickActions: 'Быстрые действия',
    inviteFriend: 'Пригласить', withdraw: 'Вывести', earnMore: 'Заработать',
    referral: 'Реферал', promoCode: 'Промо-код', enterPromo: 'Введите промо-код',
    redeem: 'Активировать', dailyTasks: 'Ежедневные задания', all: 'Все', channel: 'Канал',
    group: 'Группа', game: 'Игра', website: 'Сайт', yourReferral: 'Ваша реферальная ссылка',
    inviteViaTelegram: 'Пригласить в Telegram', totalFriends: 'Всего друзей',
    totalEarned: 'Всего заработано', pendingReferral: 'Реферальный доход',
    claim: 'Получить', friendsList: 'Список друзей', topUpTon: 'Пополнить TON',
    customAmount: 'Произвольная сумма (TON)', transactions: 'История транзакций',
    withdrawNote: 'Сетевая комиссия: 0.05 TON. Обрабатывается в течение 24ч.',
    advertiserPanel: 'Панель рекламодателя', adBalance: 'Рекламный баланс:',
    topUp: 'Пополнить', addTask: '+ Добавить задание', myTasks: 'Мои задания',
    taskName: 'Название задания', joinChannel: 'Подписаться на канал', joinGroup: 'Вступить в группу',
    playGame: 'Запустить игру', visitWebsite: 'Посетить сайт', publishTask: 'Опубликовать',
    verifyJoin: 'Подтвердить вступление', joinPrompt: 'Вступите в канал/группу, затем подтвердите.',
    openLink: 'Открыть ссылку', iJoined: 'Я вступил(а)', confirmWithdraw: 'Подтвердить вывод',
    confirm: 'Подтвердить', tonEquiv: '≈', start: 'Старт', checkIn: 'Отметиться',
    updates: 'Проверить обновления', share: 'Поделиться', done: '✓ Выполнено',
    claimed: 'Получено', claimNow: 'Получить', pending: 'Ожидание',
  }
};

// ============================================================
// STATE
// ============================================================
let state = {
  lang: localStorage.getItem('lang') || 'en',
  user: null,
  tasks: [],
  friends: [],
  transactions: [],
  advertiserData: null,
  selectedTopupAmount: null,
  selectedWithdrawTier: null,
  pendingTaskId: null,
  pendingTaskUrl: null,
  taskTimers: {},
};

// ============================================================
// TELEGRAM WEBAPP INIT
// ============================================================
const tg = window.Telegram?.WebApp;
let tgUser = null;

if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0A0800');
  tg.setBackgroundColor('#0A0800');
  tgUser = tg.initDataUnsafe?.user || null;
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  applyLang();
  setupEventListeners();
  drawWheel();
  renderStreakDots(0, 0);
  renderWithdrawTiers();

  if (tgUser || true) { // allow testing without tg
    await initUser();
  }
});

async function initUser() {
  const payload = {
    telegram_id: tgUser?.id || 0,
    username: tgUser?.username || 'demo_user',
    first_name: tgUser?.first_name || 'Demo',
    last_name: tgUser?.last_name || '',
    init_data: tg?.initData || '',
  };

  try {
    const data = await apiPost('/user', payload);
    state.user = data;
    updateUI();
    loadTasks();
    loadFriends();
    loadTransactions();
  } catch (e) {
    showToast('Failed to connect to server', 'error');
    console.error(e);
  }
}

// ============================================================
// UI UPDATE
// ============================================================
function updateUI() {
  const u = state.user;
  if (!u) return;

  const coins = u.coins || 0;
  const ton = (coins * 0.0000004).toFixed(8);

  document.getElementById('balanceAmount').textContent = coins.toLocaleString();
  document.getElementById('tonEquiv').textContent = ton;
  document.getElementById('walletBalance').textContent = coins.toLocaleString();
  document.getElementById('walletTon').textContent = ton;
  document.getElementById('streakBadge').textContent = `🔥 ${u.streak_days || 0} days`;
  document.getElementById('spinBadge').textContent = `🎰 ${u.spins || 0} spins`;

  const refLink = `https://t.me/trewards_ton_bot?start=${u.telegram_id}`;
  document.getElementById('referralLink').textContent = refLink;

  renderStreakDots(u.streak_days || 0, u.streak_claimed_today ? 1 : 0);
  renderDailyTasks(u.daily_tasks_claimed || []);

  // Streak claim button
  const streakBtn = document.getElementById('claimStreakBtn');
  if (u.streak_claimed_today) {
    streakBtn.disabled = true;
    streakBtn.textContent = t('claimed');
  } else {
    streakBtn.disabled = false;
    streakBtn.textContent = t('claimStreak');
  }
}

// ============================================================
// I18N
// ============================================================
function t(key) {
  return TRANSLATIONS[state.lang]?.[key] || TRANSLATIONS.en[key] || key;
}

function applyLang() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.getElementById('langBtn').textContent = state.lang === 'en' ? '🇺🇸 EN' : '🇷🇺 RU';
}

// ============================================================
// EVENT LISTENERS
// ============================================================
function setupEventListeners() {
  // Language toggle
  document.getElementById('langBtn').addEventListener('click', () => {
    state.lang = state.lang === 'en' ? 'ru' : 'en';
    localStorage.setItem('lang', state.lang);
    applyLang();
    updateUI();
    renderDailyTasks(state.user?.daily_tasks_claimed || []);
    renderWithdrawTiers();
  });

  // Nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Claim streak
  document.getElementById('claimStreakBtn').addEventListener('click', claimStreak);

  // Spin
  document.getElementById('spinBtn').addEventListener('click', doSpin);

  // Promo
  document.getElementById('redeemBtn').addEventListener('click', redeemPromo);

  // Task filters
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderAdvertiserTasks(btn.dataset.cat);
    });
  });

  // Copy referral
  document.getElementById('copyReferralBtn').addEventListener('click', () => {
    const link = document.getElementById('referralLink').textContent;
    navigator.clipboard?.writeText(link) || copyFallback(link);
    showToast('Link copied!', 'success');
  });

  // Invite via Telegram
  document.getElementById('inviteViaBtn').addEventListener('click', () => {
    const link = document.getElementById('referralLink').textContent;
    const text = encodeURIComponent(`Join TRewards and earn TR coins! ${link}`);
    openUrl(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`);
  });

  // Claim referral
  document.getElementById('claimReferralBtn').addEventListener('click', claimReferral);

  // Preset topup amounts
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedTopupAmount = parseFloat(btn.dataset.amount);
      document.getElementById('customTopup').value = '';
    });
  });

  // Payment methods
  document.querySelectorAll('.pay-btn').forEach(btn => {
    btn.addEventListener('click', () => doTopup(btn.dataset.method));
  });

  // Advertiser panel
  document.getElementById('advertiserBtn').addEventListener('click', openAdvertiserPanel);
  document.getElementById('adTopupBtn').addEventListener('click', () => {
    state.selectedTopupAmount = 1;
    doTopup('xrocket');
  });

  // Advertiser tabs
  document.querySelectorAll('.tab-bar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-bar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('addTaskPanel').classList.toggle('hidden', btn.dataset.atab !== 'addTask');
      document.getElementById('myTasksPanel').classList.toggle('hidden', btn.dataset.atab !== 'myTasks');
      if (btn.dataset.atab === 'myTasks') loadMyTasks();
    });
  });

  // Task limit → cost preview
  document.getElementById('adTaskLimit').addEventListener('change', updateCostPreview);
  updateCostPreview();

  // Publish task
  document.getElementById('publishTaskBtn').addEventListener('click', publishTask);

  // Verify overlay
  document.getElementById('verifyJoinedBtn').addEventListener('click', verifyJoin);

  // Confirm withdraw
  document.getElementById('confirmWithdrawBtn').addEventListener('click', confirmWithdraw);
}

// ============================================================
// TAB SWITCHING
// ============================================================
function switchTab(tabId) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId)?.classList.add('active');
  document.querySelector(`[data-tab="${tabId}"]`)?.classList.add('active');
}

// ============================================================
// STREAK
// ============================================================
function renderStreakDots(days, claimedToday) {
  const container = document.getElementById('streakDots');
  container.innerHTML = '';
  const icons = ['☀️','🌙','⭐','💫','🌟','✨','🏆'];
  for (let i = 0; i < 7; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot';
    dot.textContent = icons[i];
    if (i < days % 7) dot.classList.add('active');
    if (i === days % 7 && !claimedToday) dot.classList.add('today');
    container.appendChild(dot);
  }
}

async function claimStreak() {
  try {
    const data = await apiPost('/claim-streak', { telegram_id: state.user.telegram_id });
    state.user = { ...state.user, ...data };
    updateUI();
    showToast(`+${data.coins_earned} TR & +1 Spin!`, 'success');
  } catch (e) {
    showToast(e.message || 'Already claimed today', 'error');
  }
}

// ============================================================
// SPIN WHEEL
// ============================================================
const WHEEL_SEGMENTS = [
  { value: 10, color: '#1A1600' },
  { value: 50, color: '#2A2000' },
  { value: 80, color: '#1A1600' },
  { value: 100, color: '#2A2000' },
  { value: 300, color: '#FFB800', textColor: '#0A0800' },
  { value: 500, color: '#CC9200', textColor: '#0A0800' },
];
let wheelAngle = 0;
let isSpinning = false;

function drawWheel(angle = 0) {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r = cx - 6;
  const arc = (2 * Math.PI) / WHEEL_SEGMENTS.length;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  WHEEL_SEGMENTS.forEach((seg, i) => {
    const start = angle + i * arc;
    const end = start + arc;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    ctx.strokeStyle = '#FFB800';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + arc / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = seg.textColor || '#FFB800';
    ctx.font = 'bold 14px Orbitron, sans-serif';
    ctx.fillText(seg.value, r - 12, 5);
    ctx.restore();
  });

  // Center circle
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, 2 * Math.PI);
  ctx.fillStyle = '#0A0800';
  ctx.fill();
  ctx.strokeStyle = '#FFB800';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#FFB800';
  ctx.font = 'bold 18px Orbitron, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🎰', cx, cy);
}

async function doSpin() {
  if (isSpinning) return;
  if (!state.user) return;
  if ((state.user.spins || 0) < 1) {
    showToast('No spins available!', 'error');
    return;
  }

  isSpinning = true;
  const btn = document.getElementById('spinBtn');
  btn.disabled = true;

  try {
    const data = await apiPost('/spin', { telegram_id: state.user.telegram_id });
    const result = data.coins_won;
    const segIndex = WHEEL_SEGMENTS.findIndex(s => s.value === result);
    const arc = (2 * Math.PI) / WHEEL_SEGMENTS.length;
    const targetAngle = -(segIndex * arc + arc / 2) + Math.PI / 2;
    const spins = 5 + Math.random() * 3;
    const totalAngle = spins * 2 * Math.PI + targetAngle - (wheelAngle % (2 * Math.PI));

    const duration = 4000;
    const start = performance.now();
    const startAngle = wheelAngle;

    function animate(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      wheelAngle = startAngle + totalAngle * eased;
      drawWheel(wheelAngle);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        isSpinning = false;
        btn.disabled = false;
        document.getElementById('spinResult').textContent = `+${result} TR 🎉`;
        state.user.coins = (state.user.coins || 0) + result;
        state.user.spins = Math.max(0, (state.user.spins || 1) - 1);
        updateUI();
        showToast(`You won ${result} TR!`, 'success');
      }
    }
    requestAnimationFrame(animate);
  } catch (e) {
    isSpinning = false;
    btn.disabled = false;
    showToast(e.message || 'Spin failed', 'error');
  }
}

// ============================================================
// PROMO CODE
// ============================================================
async function redeemPromo() {
  const code = document.getElementById('promoInput').value.trim();
  if (!code) { showToast('Enter a promo code', 'error'); return; }

  try {
    const data = await apiPost('/redeem-promo', {
      telegram_id: state.user.telegram_id,
      code
    });
    showToast(`Redeemed! +${data.reward_amount} ${data.reward_type === 'ton' ? 'TON' : 'TR'}`, 'success');
    document.getElementById('promoInput').value = '';
    if (data.reward_type === 'coins') {
      state.user.coins = (state.user.coins || 0) + data.reward_amount;
      updateUI();
    }
  } catch (e) {
    showToast(e.message || 'Invalid code', 'error');
  }
}

// ============================================================
// TASKS
// ============================================================
async function loadTasks() {
  try {
    const data = await apiGet('/tasks', `telegram_id=${state.user.telegram_id}`);
    state.tasks = data.tasks || [];
    renderAdvertiserTasks('all');
  } catch (e) {
    console.error('Load tasks error', e);
  }
}

function renderDailyTasks(claimedList = []) {
  const container = document.getElementById('dailyTasksList');
  const dailyTasks = [
    { id: 'checkin', icon: '☀️', name: t('checkIn'), reward: '+10 TR +1 Spin', type: 'checkin' },
    { id: 'updates', icon: '📢', name: t('updates'), reward: '+10 TR', url: 'https://t.me/trewards_tonfirst', type: 'channel_tap' },
    { id: 'share', icon: '🔗', name: t('share'), reward: '+10 TR', type: 'share' },
  ];

  container.innerHTML = dailyTasks.map(task => {
    const done = claimedList.includes(task.id);
    return `
      <div class="task-card ${done ? 'completed' : ''}">
        <div class="task-icon">${task.icon}</div>
        <div class="task-info">
          <div class="task-name">${task.name}</div>
          <div class="task-reward">${task.reward}</div>
        </div>
        <div class="task-action">
          <button class="task-btn ${done ? 'done' : ''}"
            onclick="handleDailyTask('${task.id}', '${task.type}', '${task.url || ''}')"
            ${done ? 'disabled' : ''}>
            ${done ? t('done') : t('start')}
          </button>
        </div>
      </div>`;
  }).join('');
}

async function handleDailyTask(taskId, type, url) {
  if (type === 'checkin') {
    await claimDailyTask(taskId);
  } else if (type === 'channel_tap') {
    const btn = event.target;
    if (btn.dataset.stage === '2') {
      await claimDailyTask(taskId);
    } else {
      openUrl(url);
      btn.dataset.stage = '2';
      btn.textContent = t('claimNow');
      btn.classList.add('claiming');
    }
  } else if (type === 'share') {
    const refLink = `https://t.me/trewards_ton_bot?start=${state.user.telegram_id}`;
    const text = encodeURIComponent(`Join TRewards and earn TR coins! ${refLink}`);
    openUrl(`https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${text}`);
    setTimeout(() => claimDailyTask(taskId), 2000);
  }
}

async function claimDailyTask(taskId) {
  try {
    const data = await apiPost('/claim-daily-task', {
      telegram_id: state.user.telegram_id,
      task_id: taskId
    });
    state.user = { ...state.user, ...data };
    updateUI();
    showToast(`+${data.coins_earned} TR!`, 'success');
  } catch (e) {
    showToast(e.message || 'Already claimed', 'error');
  }
}

function renderAdvertiserTasks(category = 'all') {
  const container = document.getElementById('advertiserTasksList');
  const TYPE_ICONS = { channel: '📺', group: '👥', game: '🎮', website: '🌐' };
  const TYPE_REWARDS = { channel: 1000, group: 1000, game: 1000, website: 500 };

  let tasks = state.tasks;
  if (category !== 'all') tasks = tasks.filter(t => t.task_type === category);

  if (!tasks.length) {
    container.innerHTML = `<div class="empty">No tasks available</div>`;
    return;
  }

  container.innerHTML = tasks.map(task => {
    const done = task.user_completed;
    const reward = TYPE_REWARDS[task.task_type] || 500;
    return `
      <div class="task-card ${done ? 'completed' : ''}" id="task-${task.id}">
        <div class="task-icon">${TYPE_ICONS[task.task_type] || '📋'}</div>
        <div class="task-info">
          <div class="task-name">${task.name}</div>
          <div class="task-reward">+${reward.toLocaleString()} TR <span>+1 Spin</span></div>
          <div class="progress-bar-wrap" id="pb-wrap-${task.id}">
            <div class="progress-bar" id="pb-${task.id}" style="width:100%"></div>
          </div>
        </div>
        <div class="task-action">
          <button class="task-btn ${done ? 'done' : ''}"
            onclick="handleTaskAction('${task.id}','${task.task_type}','${task.target_url}')"
            id="task-btn-${task.id}"
            ${done ? 'disabled' : ''}>
            ${done ? t('done') : t('start')}
          </button>
        </div>
      </div>`;
  }).join('');
}

function handleTaskAction(taskId, type, url) {
  const btn = document.getElementById(`task-btn-${taskId}`);
  if (!btn || btn.disabled) return;

  if (type === 'channel' || type === 'group') {
    // Open verify overlay
    state.pendingTaskId = taskId;
    state.pendingTaskUrl = url;
    document.getElementById('verifyOpenLink').onclick = () => openUrl(url);
    openOverlay('verifyOverlay');
  } else {
    // Visit / game — timer flow
    const isGame = type === 'game';
    const waitTime = isGame ? 10 : 15;
    openUrl(url);
    startTaskTimer(taskId, waitTime);
  }
}

function startTaskTimer(taskId, seconds) {
  const btn = document.getElementById(`task-btn-${taskId}`);
  const pbWrap = document.getElementById(`pb-wrap-${taskId}`);
  const pb = document.getElementById(`pb-${taskId}`);
  if (!btn || !pbWrap || !pb) return;

  pbWrap.style.display = 'block';
  btn.disabled = true;
  btn.textContent = `${seconds}s`;

  let remaining = seconds;
  const interval = setInterval(() => {
    remaining--;
    btn.textContent = `${remaining}s`;
    pb.style.width = `${(remaining / seconds) * 100}%`;
    if (remaining <= 0) {
      clearInterval(interval);
      btn.disabled = false;
      btn.textContent = t('claimNow');
      btn.classList.add('claiming');
      btn.onclick = () => claimTask(taskId);
    }
  }, 1000);

  state.taskTimers[taskId] = interval;
}

async function claimTask(taskId) {
  const btn = document.getElementById(`task-btn-${taskId}`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  try {
    const data = await apiPost('/claim-task', {
      telegram_id: state.user.telegram_id,
      task_id: taskId
    });
    state.user.coins = (state.user.coins || 0) + (data.coins_earned || 0);
    state.user.spins = (state.user.spins || 0) + 1;
    updateUI();
    showToast(`+${data.coins_earned} TR & +1 Spin!`, 'success');
    if (btn) { btn.textContent = t('done'); btn.classList.remove('claiming'); btn.classList.add('done'); }
    // Mark completed
    const task = state.tasks.find(t => t.id == taskId);
    if (task) task.user_completed = true;
  } catch (e) {
    showToast(e.message || 'Claim failed', 'error');
    if (btn) { btn.disabled = false; btn.textContent = t('claimNow'); }
  }
}

async function verifyJoin() {
  const btn = document.getElementById('verifyJoinedBtn');
  btn.disabled = true;
  btn.textContent = '...';

  try {
    const data = await apiPost('/verify-join', {
      telegram_id: state.user.telegram_id,
      task_id: state.pendingTaskId
    });
    closeOverlay('verifyOverlay');
    state.user.coins = (state.user.coins || 0) + (data.coins_earned || 0);
    state.user.spins = (state.user.spins || 0) + 1;
    updateUI();
    showToast(`+${data.coins_earned} TR & +1 Spin!`, 'success');
    const task = state.tasks.find(t => t.id == state.pendingTaskId);
    if (task) task.user_completed = true;
    renderAdvertiserTasks('all');
  } catch (e) {
    showToast(e.message || 'Not a member yet!', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = t('iJoined');
  }
}

// ============================================================
// FRIENDS
// ============================================================
async function loadFriends() {
  try {
    const data = await apiGet('/friends', `telegram_id=${state.user.telegram_id}`);
    document.getElementById('totalFriendsCount').textContent = data.total_friends || 0;
    document.getElementById('totalEarnedReferral').textContent = (data.total_earned || 0).toLocaleString();
    document.getElementById('pendingReferralAmt').textContent = (data.pending || 0).toLocaleString();
    renderFriendsList(data.friends || []);
  } catch (e) { console.error(e); }
}

function renderFriendsList(friends) {
  const container = document.getElementById('friendsList');
  if (!friends.length) {
    container.innerHTML = `<div class="empty">No friends yet. Share your referral link!</div>`;
    return;
  }
  container.innerHTML = friends.map(f => `
    <div class="friend-item">
      <div class="friend-avatar">👤</div>
      <div class="friend-info">
        <div class="friend-name">${f.first_name || f.username || 'User'}</div>
        <div class="friend-coins">${(f.coins || 0).toLocaleString()} TR</div>
      </div>
      <div class="friend-earn">+${(f.your_share || 0).toLocaleString()} TR</div>
    </div>`).join('');
}

async function claimReferral() {
  try {
    const data = await apiPost('/claim-referral', { telegram_id: state.user.telegram_id });
    showToast(`+${data.coins_earned} TR claimed!`, 'success');
    state.user.coins = (state.user.coins || 0) + data.coins_earned;
    updateUI();
    document.getElementById('pendingReferralAmt').textContent = '0';
  } catch (e) {
    showToast(e.message || 'Nothing to claim', 'error');
  }
}

// ============================================================
// WALLET
// ============================================================
const WITHDRAW_TIERS = [
  { coins: 250000, ton: 0.10, net: 0.05 },
  { coins: 500000, ton: 0.20, net: 0.15 },
  { coins: 750000, ton: 0.30, net: 0.25 },
  { coins: 1000000, ton: 0.40, net: 0.35 },
];

function renderWithdrawTiers() {
  const container = document.getElementById('withdrawTiers');
  container.innerHTML = WITHDRAW_TIERS.map((tier, i) => `
    <div class="withdraw-tier" onclick="selectWithdrawTier(${i})">
      <div class="tier-info">
        <div class="tier-coins">${tier.coins.toLocaleString()} TR</div>
        <div class="tier-ton">→ ${tier.ton} TON (fee: 0.05)</div>
      </div>
      <div class="tier-net">${tier.net} TON</div>
    </div>`).join('');

  // Withdraw button at end
  const btn = document.createElement('button');
  btn.className = 'btn btn-gold btn-full';
  btn.textContent = t('withdraw');
  btn.style.marginTop = '4px';
  btn.onclick = openWithdrawConfirm;
  container.appendChild(btn);
}

function selectWithdrawTier(idx) {
  document.querySelectorAll('.withdraw-tier').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
  state.selectedWithdrawTier = idx;
}

function openWithdrawConfirm() {
  if (state.selectedWithdrawTier === null) {
    showToast('Select a withdrawal tier first', 'error');
    return;
  }
  const tier = WITHDRAW_TIERS[state.selectedWithdrawTier];
  if ((state.user?.coins || 0) < tier.coins) {
    showToast('Insufficient TR coins', 'error');
    return;
  }
  document.getElementById('withdrawSummary').innerHTML = `
    <div class="withdraw-summary">
      <div class="summary-row"><span>TR Coins</span><span>-${tier.coins.toLocaleString()}</span></div>
      <div class="summary-row"><span>Gross TON</span><span>${tier.ton} TON</span></div>
      <div class="summary-row"><span>Network Fee</span><span>-0.05 TON</span></div>
      <div class="summary-row net"><span>You Receive</span><span>${tier.net} TON</span></div>
    </div>`;
  openOverlay('withdrawOverlay');
}

async function confirmWithdraw() {
  const tier = WITHDRAW_TIERS[state.selectedWithdrawTier];
  const btn = document.getElementById('confirmWithdrawBtn');
  btn.disabled = true;
  try {
    await apiPost('/withdraw', {
      telegram_id: state.user.telegram_id,
      tier_index: state.selectedWithdrawTier
    });
    closeOverlay('withdrawOverlay');
    state.user.coins -= tier.coins;
    updateUI();
    showToast(`Withdrawal of ${tier.net} TON queued!`, 'success');
    loadTransactions();
  } catch (e) {
    showToast(e.message || 'Withdrawal failed', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadTransactions() {
  try {
    const data = await apiGet('/transactions', `telegram_id=${state.user.telegram_id}`);
    renderTransactions(data.transactions || []);
  } catch (e) { console.error(e); }
}

function renderTransactions(txs) {
  const container = document.getElementById('txList');
  if (!txs.length) {
    container.innerHTML = `<div class="empty">No transactions yet</div>`;
    return;
  }
  const TX_ICONS = { spin: '🎰', task: '✅', streak: '🔥', referral: '👥', promo: '🎁', withdraw: '💸', topup: '💳', daily: '☀️' };
  container.innerHTML = txs.map(tx => {
    const credit = tx.amount > 0;
    const icon = TX_ICONS[tx.type] || '💰';
    const date = new Date(tx.created_at).toLocaleDateString();
    return `
      <div class="tx-item">
        <div class="tx-icon">${icon}</div>
        <div class="tx-info">
          <div class="tx-desc">${tx.description}</div>
          <div class="tx-date">${date}</div>
        </div>
        <div class="tx-amount ${credit ? 'credit' : 'debit'}">
          ${credit ? '+' : ''}${tx.amount.toLocaleString()} ${tx.currency || 'TR'}
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// TOP UP
// ============================================================
async function doTopup(method) {
  const customVal = document.getElementById('customTopup')?.value;
  const amount = parseFloat(customVal) || state.selectedTopupAmount;

  if (!amount || amount <= 0) {
    showToast('Select or enter an amount', 'error');
    return;
  }

  try {
    const data = await apiPost('/create-topup', {
      telegram_id: state.user.telegram_id,
      amount,
      method
    });
    if (data.payment_url) openUrl(data.payment_url);
    showToast('Payment link opened', 'info');
  } catch (e) {
    showToast(e.message || 'Payment failed', 'error');
  }
}

// ============================================================
// ADVERTISER PANEL
// ============================================================
async function openAdvertiserPanel() {
  openOverlay('advertiserOverlay');
  try {
    const data = await apiGet('/advertiser', `telegram_id=${state.user.telegram_id}`);
    state.advertiserData = data;
    document.getElementById('adBalance').textContent = (data.ad_balance || 0).toFixed(2);
  } catch (e) { console.error(e); }
}

function updateCostPreview() {
  const limit = parseInt(document.getElementById('adTaskLimit').value) || 500;
  const cost = (limit * 0.001).toFixed(3);
  document.getElementById('costPreview').innerHTML = `Cost: <strong>${cost} TON</strong>`;
}

async function publishTask() {
  const name = document.getElementById('adTaskName').value.trim();
  const type = document.getElementById('adTaskType').value;
  const url = document.getElementById('adTaskUrl').value.trim();
  const limit = parseInt(document.getElementById('adTaskLimit').value);

  if (!name || !url) { showToast('Fill all fields', 'error'); return; }

  try {
    await apiPost('/create-task', {
      telegram_id: state.user.telegram_id,
      name, task_type: type, target_url: url, completion_limit: limit
    });
    showToast('Task published!', 'success');
    document.getElementById('adTaskName').value = '';
    document.getElementById('adTaskUrl').value = '';
    openAdvertiserPanel();
  } catch (e) {
    showToast(e.message || 'Publish failed', 'error');
  }
}

async function loadMyTasks() {
  try {
    const data = await apiGet('/advertiser', `telegram_id=${state.user.telegram_id}`);
    const container = document.getElementById('myTasksList');
    const tasks = data.tasks || [];
    if (!tasks.length) {
      container.innerHTML = `<div class="empty">No tasks yet</div>`;
      return;
    }
    container.innerHTML = tasks.map(t => `
      <div class="my-task-item">
        <div class="my-task-name">${t.name}</div>
        <div class="my-task-meta">
          <span>${t.completions || 0} / ${t.completion_limit}</span>
          <span class="status-${t.status}">${t.status}</span>
        </div>
      </div>`).join('');
  } catch (e) { console.error(e); }
}

// ============================================================
// OVERLAYS
// ============================================================
function openOverlay(id) {
  document.getElementById(id)?.classList.add('active');
}
function closeOverlay(id) {
  document.getElementById(id)?.classList.remove('active');
}

// Close overlay on backdrop click
document.querySelectorAll('.overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeOverlay(overlay.id);
  });
});

// ============================================================
// API HELPERS
// ============================================================
async function apiPost(endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Init-Data': tg?.initData || '' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.detail || 'Request failed');
  return data;
}

async function apiGet(endpoint, query = '') {
  const url = `${API}${endpoint}${query ? '?' + query : ''}`;
  const res = await fetch(url, {
    headers: { 'X-Init-Data': tg?.initData || '' }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.detail || 'Request failed');
  return data;
}

// ============================================================
// TOAST
// ============================================================
let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ============================================================
// UTILS
// ============================================================
function openUrl(url) {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank');
}

function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}