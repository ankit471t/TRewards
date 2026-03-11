/* ════════════════════════════════════════
   i18n.js — English / Russian Translations
   ════════════════════════════════════════ */

const I18N = {
  en: {
    home: 'Home', tasks: 'Tasks', friends: 'Friends', wallet: 'Wallet',
    balance: 'Balance', dailyStreak: 'Daily Streak', claimStreak: 'Claim Daily Reward',
    spinWheel: 'Spin Wheel', spin: 'Spin', quickActions: 'Quick Actions',
    inviteFriend: 'Invite Friend', withdraw: 'Withdraw', earnMore: 'Earn More',
    referral: 'Referral', promoCode: 'Promo Code', redeem: 'Redeem',
    dailyTasks: 'Daily Tasks', checkIn: 'Daily Check-In',
    checkUpdates: 'Check for Updates', shareWithFriends: 'Share with Friends',
    yourReferralLink: 'Your Referral Link', copy: 'Copy', invite: 'Invite',
    friendsList: 'Friends List', earnedTR: 'Earned TR', pending: 'Pending',
    pendingReferral: 'Pending Referral Earnings', claim: 'Claim',
    topUp: 'Top Up TON', transactions: 'Transaction History',
  },
  ru: {
    home: 'Главная', tasks: 'Задания', friends: 'Друзья', wallet: 'Кошелёк',
    balance: 'Баланс', dailyStreak: 'Ежедневная серия', claimStreak: 'Забрать награду',
    spinWheel: 'Колесо удачи', spin: 'Крутить', quickActions: 'Быстрые действия',
    inviteFriend: 'Пригласить', withdraw: 'Вывести', earnMore: 'Заработать',
    referral: 'Реферал', promoCode: 'Промо-код', redeem: 'Активировать',
    dailyTasks: 'Ежедневные задания', checkIn: 'Ежедневный вход',
    checkUpdates: 'Проверить обновления', shareWithFriends: 'Поделиться',
    yourReferralLink: 'Ваша ссылка', copy: 'Копировать', invite: 'Пригласить',
    friendsList: 'Друзья', earnedTR: 'Заработано TR', pending: 'Ожидание',
    pendingReferral: 'Реферальные начисления', claim: 'Забрать',
    topUp: 'Пополнить TON', transactions: 'История',
  },
};

function t(key) {
  return I18N[State.lang][key] || I18N.en[key] || key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
}

function toggleLang() {
  State.lang = State.lang === 'en' ? 'ru' : 'en';
  document.getElementById('langBtn').textContent = State.lang === 'en' ? 'RU' : 'EN';
  applyI18n();
}