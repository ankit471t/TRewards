/**
 * lang.js
 * English / Russian translations for TRewards
 */

const LANGS = {
  en: {
    // Navigation
    nav_home: 'Home',
    nav_tasks: 'Tasks',
    nav_friends: 'Friends',
    nav_wallet: 'Wallet',

    // Home
    balance: 'Balance',
    ton_equiv: 'TON Equivalent',
    streak: 'Streak',
    spins: 'Spins',
    daily_streak: 'Daily Streak',
    claim_streak: 'Claim Reward',
    streak_claimed: 'Come back tomorrow!',
    spin_wheel: 'Spin Wheel',
    spin_btn: 'SPIN',
    no_spins: 'No spins left',
    promo_code: 'Promo Code',
    promo_placeholder: 'Enter code...',
    redeem: 'Redeem',
    daily_tasks: 'Daily Tasks',
    task_checkin: 'Daily Check-in',
    task_updates: 'Check for Updates',
    task_share: 'Share with Friends',
    claim: 'Claim',
    claimed: 'Claimed',

    // Tasks
    tasks_title: 'Tasks',
    add_task: '+ Task',
    join_channel: 'Join Channel',
    join_group: 'Join Group',
    play_game: 'Play Game Bot',
    visit_website: 'Visit Website',
    start: 'Start',
    verify: 'Verify',
    timer_wait: 'Wait {n}s...',
    completed: 'Completed ✓',

    // Friends
    friends_title: 'Friends',
    total_friends: 'Total Friends',
    total_earned: 'Total Earned',
    pending: 'Pending',
    referral_link: 'Your Referral Link',
    copy_link: 'Copy Link',
    claim_referral: 'Claim Earnings',
    invite_text: 'Invite friends and earn 30% of their rewards!',
    link_copied: 'Link copied!',

    // Wallet
    wallet_title: 'Wallet',
    withdraw: 'Withdraw',
    your_balance: 'Your Balance',
    select_tier: 'Select Withdrawal Tier',
    wallet_address: 'TON Wallet Address',
    wallet_placeholder: 'Enter your TON wallet address...',
    fee_note: 'Network fee: 0.05 TON',
    confirm_withdraw: 'Confirm Withdrawal',
    insufficient: 'Insufficient coins',
    withdraw_success: 'Withdrawal submitted!',
    topup: 'Top Up',
    coming_soon: 'Coming Soon',

    // Advertiser
    advertiser: 'Advertiser Dashboard',
    ad_balance: 'Ad Balance',
    create_task: 'Create Task',
    my_tasks: 'My Tasks',
    task_name: 'Task Name',
    task_type: 'Task Type',
    task_url: 'URL',
    task_target: 'Target Completions',
    task_cost: 'Cost',
    submit_task: 'Create Task',
    completions: 'Completions',
    active: 'Active',

    // Common
    loading: 'Loading...',
    error: 'Error',
    success: 'Success!',
    close: 'Close',
    days: 'days',
    coins: 'TR',
  },
  ru: {
    // Navigation
    nav_home: 'Главная',
    nav_tasks: 'Задания',
    nav_friends: 'Друзья',
    nav_wallet: 'Кошелёк',

    // Home
    balance: 'Баланс',
    ton_equiv: 'Эквивалент TON',
    streak: 'Серия',
    spins: 'Спины',
    daily_streak: 'Ежедневная серия',
    claim_streak: 'Получить награду',
    streak_claimed: 'Возвращайтесь завтра!',
    spin_wheel: 'Колесо фортуны',
    spin_btn: 'КРУТИТЬ',
    no_spins: 'Нет спинов',
    promo_code: 'Промо-код',
    promo_placeholder: 'Введите код...',
    redeem: 'Активировать',
    daily_tasks: 'Ежедневные задания',
    task_checkin: 'Ежедневный вход',
    task_updates: 'Проверить обновления',
    task_share: 'Поделиться с друзьями',
    claim: 'Получить',
    claimed: 'Получено',

    // Tasks
    tasks_title: 'Задания',
    add_task: '+ Задание',
    join_channel: 'Вступить в канал',
    join_group: 'Вступить в группу',
    play_game: 'Играть в бот',
    visit_website: 'Посетить сайт',
    start: 'Начать',
    verify: 'Проверить',
    timer_wait: 'Подождите {n}с...',
    completed: 'Выполнено ✓',

    // Friends
    friends_title: 'Друзья',
    total_friends: 'Всего друзей',
    total_earned: 'Всего заработано',
    pending: 'Ожидает',
    referral_link: 'Ваша реферальная ссылка',
    copy_link: 'Копировать',
    claim_referral: 'Забрать заработок',
    invite_text: 'Приглашайте друзей и получайте 30% от их наград!',
    link_copied: 'Ссылка скопирована!',

    // Wallet
    wallet_title: 'Кошелёк',
    withdraw: 'Вывод',
    your_balance: 'Ваш баланс',
    select_tier: 'Выберите уровень вывода',
    wallet_address: 'TON Кошелёк',
    wallet_placeholder: 'Введите адрес TON кошелька...',
    fee_note: 'Сетевая комиссия: 0.05 TON',
    confirm_withdraw: 'Подтвердить вывод',
    insufficient: 'Недостаточно монет',
    withdraw_success: 'Вывод отправлен!',
    topup: 'Пополнить',
    coming_soon: 'Скоро',

    // Advertiser
    advertiser: 'Панель рекламодателя',
    ad_balance: 'Рекламный баланс',
    create_task: 'Создать задание',
    my_tasks: 'Мои задания',
    task_name: 'Название',
    task_type: 'Тип задания',
    task_url: 'URL',
    task_target: 'Цель выполнений',
    task_cost: 'Стоимость',
    submit_task: 'Создать задание',
    completions: 'Выполнений',
    active: 'Активно',

    // Common
    loading: 'Загрузка...',
    error: 'Ошибка',
    success: 'Успешно!',
    close: 'Закрыть',
    days: 'дней',
    coins: 'TR',
  }
};

// Current language
let currentLang = 'en';

function setLang(lang) {
  if (LANGS[lang]) {
    currentLang = lang;
    localStorage.setItem('tr_lang', lang);
  }
}

function getLang() {
  return currentLang;
}

function t(key, vars) {
  let str = (LANGS[currentLang] || LANGS.en)[key] || key;
  if (vars) {
    Object.keys(vars).forEach(k => {
      str = str.replace(`{${k}}`, vars[k]);
    });
  }
  return str;
}

function initLang() {
  const saved = localStorage.getItem('tr_lang');
  if (saved && LANGS[saved]) currentLang = saved;
}

// Export for browser
if (typeof window !== 'undefined') {
  window.t = t;
  window.setLang = setLang;
  window.getLang = getLang;
  window.initLang = initLang;
}