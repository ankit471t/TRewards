/* ════════════════════════════════════════
   ui.js — Shared UI Utilities
   ════════════════════════════════════════ */

// ── TOAST ─────────────────────────────────
let _toastTimer;
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── TAB NAVIGATION ────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page-' + tab).classList.add('active');
  document.getElementById('nav-' + tab).classList.add('active');

  if (tab === 'tasks')   loadTasksPage();
  if (tab === 'wallet')  renderWallet();
  if (tab === 'friends') renderFriends();
}

// ── CLIPBOARD ─────────────────────────────
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => toast('Copied!', 'success'))
      .catch(() => _fallbackCopy(text));
  } else {
    _fallbackCopy(text);
  }
}

function _fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  toast('Copied!', 'success');
}

// ── FORMATTERS ────────────────────────────
function fmtCoins(n)  { return (n || 0).toLocaleString(); }
function fmtTon(n)    { return (n || 0).toFixed(4); }
function fmtDate(iso) { return new Date(iso).toLocaleDateString(); }

function refLink() {
  return `https://t.me/${CONFIG.BOT_USERNAME}?start=${State.user?.user_id}`;
}