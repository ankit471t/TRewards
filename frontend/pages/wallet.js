/* ════════════════════════════════════════
   pages/wallet.js — Wallet Tab
   ════════════════════════════════════════ */

function renderWallet() {
  const u = State.user;
  if (!u) return;

  const txHTML = _renderTransactions(u.transactions || []);
  const tiers  = CONFIG.WITHDRAWAL_TIERS;

  document.getElementById('page-wallet').innerHTML = `

    <!-- TON Balance -->
    <div class="card">
      <div class="card-title">TON Balance</div>
      <div class="ton-display">
        <div class="ton-num">${fmtTon(u.ton_balance)}</div>
        <div class="ton-label">TON in Account</div>
      </div>
      <button class="btn btn-ton" onclick="openTopUp()">
        + Top Up TON
      </button>
    </div>

    <!-- TR Withdrawal -->
    <div class="card">
      <div class="card-title">TR Coins → TON Withdrawal</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-family:Orbitron;font-size:22px;color:var(--gold)">${fmtCoins(u.coins)}</span>
        <span style="font-size:12px;color:var(--text-muted)">TR Coins</span>
      </div>

      <!-- Tier Selection -->
      <div class="tier-grid">
        ${tiers.map((t, i) => `
          <div class="tier-card ${State.selectedTier === i ? 'selected' : ''}"
               onclick="selectTier(${i})" id="tier_${i}">
            <div class="tier-coins">${(t.coins/1000).toFixed(0)}K TR</div>
            <div class="tier-ton">${t.ton} TON</div>
            <div class="tier-net">You get: ${t.net} TON</div>
            <div class="tier-fee">Fee: 0.05 TON</div>
          </div>`).join('')}
      </div>

      <!-- Wallet Address -->
      <div class="wallet-addr-wrap">
        <div class="amount-label">Your TON Wallet Address</div>
        <input class="input-field" id="walletAddress"
               placeholder="EQD...your TON wallet address"
               style="margin-top:5px">
      </div>

      <button class="btn btn-gold" onclick="requestWithdraw()">
        💸 Withdraw
      </button>
      <div class="wallet-fee-note">
        Network fee: 0.05 TON deducted &nbsp;·&nbsp; Processed within 24 hours
      </div>
    </div>

    <!-- Transaction History -->
    <div class="section-title">Transaction History</div>
    <div id="txContainer">
      ${txHTML}
    </div>
  `;
}

function _renderTransactions(txs) {
  if (!txs.length) return '<div class="empty-state">No transactions yet</div>';

  const icons = {
    credit:     '⬆️',
    debit:      '⬇️',
    ton_credit: '💠',
  };

  return [...txs].reverse().slice(0, 50).map(tx => {
    const type = tx.type || 'credit';
    const icon = icons[type] || '•';
    const sign = (type === 'credit' || type === 'ton_credit') ? '+' : '';
    const unit = type === 'ton_credit' ? 'TON' : 'TR';
    return `
      <div class="tx-item">
        <div class="tx-icon ${type}">${icon}</div>
        <div class="tx-desc">
          ${tx.description}
          <span class="tx-date">${fmtDate(tx.date)}</span>
        </div>
        <div class="tx-amount ${type}">
          ${sign}${Math.abs(tx.amount).toLocaleString()} ${unit}
        </div>
      </div>`;
  }).join('');
}

// ── TIER SELECT ───────────────────────────
function selectTier(i) {
  State.selectedTier = i;
  document.querySelectorAll('.tier-card').forEach((el, idx) => {
    el.classList.toggle('selected', idx === i);
  });
}

// ── WITHDRAW FLOW ─────────────────────────
function requestWithdraw() {
  if (State.selectedTier === null || State.selectedTier === undefined) {
    return toast('Please select a withdrawal tier', 'error');
  }
  const wallet = document.getElementById('walletAddress').value.trim();
  if (!wallet) return toast('Enter your TON wallet address', 'error');

  const tier = CONFIG.WITHDRAWAL_TIERS[State.selectedTier];
  if ((State.user?.coins || 0) < tier.coins) {
    return toast(`Need ${fmtCoins(tier.coins)} TR. You have ${fmtCoins(State.user?.coins)} TR`, 'error');
  }

  openWithdrawConfirm(State.selectedTier, wallet);
}