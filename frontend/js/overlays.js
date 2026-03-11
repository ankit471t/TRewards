/* ════════════════════════════════════════
   overlays.js — All Overlay Logic
   ════════════════════════════════════════ */

// ── OPEN / CLOSE ──────────────────────────
function openOverlay(id) {
  document.getElementById(id).classList.add('open');
}

function closeOverlay(id) {
  document.getElementById(id).classList.remove('open');
}

// Close on backdrop tap
document.querySelectorAll('.overlay').forEach(ov => {
  ov.addEventListener('click', e => {
    if (e.target === ov) ov.classList.remove('open');
  });
});

// ═══════════════════════════════════════════
// TOP-UP OVERLAY
// (z-index 1200 — sits ABOVE advertiser panel)
// ═══════════════════════════════════════════

function openTopUp() {
  // Reset state
  State.selectedMethod = null;
  document.getElementById('topupAmount').value = '';
  document.querySelectorAll('.method-card').forEach(el => el.classList.remove('selected'));
  // Open — will appear above advertiserOverlay due to z-index:1200
  openOverlay('topupOverlay');
}

function selectMethod(method) {
  State.selectedMethod = method;
  document.querySelectorAll('.method-card').forEach(el => el.classList.remove('selected'));
  document.getElementById('method-' + method).classList.add('selected');
}

async function processTopUp() {
  const amount = parseFloat(document.getElementById('topupAmount').value);
  if (!amount || amount < 0.1) return toast('Minimum amount is 0.1 TON', 'error');
  if (!State.selectedMethod)   return toast('Please select a payment method', 'error');

  try {
    const data = await apiCreateTopup(amount, State.selectedMethod);
    if (data.success) {
      closeOverlay('topupOverlay');
      if (tg) tg.openLink(data.payment_url);
      else    window.open(data.payment_url, '_blank');
      toast('Payment page opened 💎', 'info');
    } else {
      toast(data.error || 'Payment creation failed', 'error');
    }
  } catch (err) {
    toast(err.message || 'Could not create payment', 'error');
  }
}

// ═══════════════════════════════════════════
// ADVERTISER OVERLAY
// ═══════════════════════════════════════════

function openAdvertiserPanel() {
  openOverlay('advertiserOverlay');
  adTab('create');
  // Sync TON balance display
  if (State.user) {
    document.getElementById('adBalance').textContent = fmtTon(State.user.ton_balance);
  }
}

function adTab(tab) {
  document.getElementById('adCreatePanel').style.display = tab === 'create' ? 'block' : 'none';
  document.getElementById('adMyPanel').style.display     = tab === 'my'     ? 'block' : 'none';
  document.querySelectorAll('.ad-tab').forEach(el => el.classList.remove('active'));
  document.getElementById('adTab' + (tab === 'create' ? 'Create' : 'My')).classList.add('active');
}

async function publishTask() {
  const name  = document.getElementById('adTaskName').value.trim();
  const type  = document.getElementById('adTaskType').value;
  const url   = document.getElementById('adTaskUrl').value.trim();
  const limit = parseInt(document.getElementById('adTaskLimit').value);

  if (!name || !url) return toast('Please fill all fields', 'error');

  try {
    const data = await apiCreateTask(name, type, url, limit);
    if (data.success) {
      closeOverlay('advertiserOverlay');
      if (data.user) State.user = data.user;
      renderHome();
      toast(`Task published! Cost: ${data.cost} TON`, 'success');
      loadTasksPage();
    } else {
      toast(data.error || 'Failed to publish', 'error');
    }
  } catch (err) {
    toast(err.message || 'Error publishing task', 'error');
  }
}

// ═══════════════════════════════════════════
// VERIFY JOIN OVERLAY
// ═══════════════════════════════════════════

function openVerifyOverlay(task, type) {
  State.currentVerifyTask = task;
  document.getElementById('verifyTitle').textContent =
    type === 'channel' ? 'Verify Channel Join' : 'Verify Group Join';
  openOverlay('verifyOverlay');
}

function verifyOpenLink() {
  if (State.currentVerifyTask) {
    const url = State.currentVerifyTask.url;
    if (tg) tg.openLink(url);
    else    window.open(url, '_blank');
  }
}

async function verifyJoin() {
  const task = State.currentVerifyTask;
  if (!task) return;

  try {
    // Extract chat username from URL
    const chatId = task.url.replace('https://t.me/', '@').split('?')[0];
    const data   = await apiVerifyJoin(task.id, chatId);

    if (data.success) {
      closeOverlay('verifyOverlay');
      if (data.user) State.user = data.user;
      renderHome();
      toast(`+${data.reward} TR Earned! 🎉`, 'success');
      loadTasksPage();
    } else {
      toast(data.error || 'Not a member yet', 'error');
    }
  } catch (err) {
    toast(err.message || 'Verification failed', 'error');
  }
}

// ═══════════════════════════════════════════
// WITHDRAW CONFIRM OVERLAY
// ═══════════════════════════════════════════

function openWithdrawConfirm(tierIndex, wallet) {
  const tier = CONFIG.WITHDRAWAL_TIERS[tierIndex];

  document.getElementById('withdrawDetails').innerHTML = `
    <div class="withdraw-row">
      <span class="label">Coins to spend</span>
      <span class="val gold">${fmtCoins(tier.coins)} TR</span>
    </div>
    <div class="withdraw-row">
      <span class="label">Gross amount</span>
      <span class="val">${tier.ton} TON</span>
    </div>
    <div class="withdraw-row">
      <span class="label">Network fee</span>
      <span class="val error">−0.05 TON</span>
    </div>
    <div class="withdraw-row">
      <span class="label">You receive</span>
      <span class="val success">${tier.net} TON</span>
    </div>
    <div class="withdraw-note">
      To: ${wallet.substring(0, 14)}...${wallet.slice(-8)}<br>
      Processed manually within 24 hours.
    </div>`;

  openOverlay('withdrawOverlay');
}

async function confirmWithdraw() {
  const wallet = document.getElementById('walletAddress').value.trim();

  try {
    const data = await apiWithdraw(State.selectedTier, wallet);
    if (data.success) {
      closeOverlay('withdrawOverlay');
      if (data.user) State.user = data.user;
      else {
        const tier = CONFIG.WITHDRAWAL_TIERS[State.selectedTier];
        State.user.coins -= tier.coins;
      }
      State.selectedTier = null;
      document.querySelectorAll('.tier-card').forEach(el => el.classList.remove('selected'));
      renderWallet();
      renderHome();
      toast('Withdrawal submitted! Processing in 24h ✅', 'success');
    } else {
      toast(data.error || 'Withdrawal failed', 'error');
    }
  } catch (err) {
    toast(err.message || 'Network error', 'error');
  }
}