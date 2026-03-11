/* ════════════════════════════════════════
   pages/friends.js — Friends Tab
   ════════════════════════════════════════ */

function renderFriends() {
  const u    = State.user;
  if (!u) return;
  const refs = u.referrals || [];
  const link = refLink();

  const friendsHTML = refs.length
    ? refs.map(f => `
        <div class="friend-item">
          <div class="friend-avatar">👤</div>
          <div class="friend-info">
            <div class="friend-name">@${f.username || f.user_id}</div>
            <div class="friend-coins">${fmtCoins(f.coins || 0)} TR total</div>
          </div>
          <div class="friend-earn">+${fmtCoins(Math.floor((f.coins||0)*0.3))} TR</div>
        </div>`).join('')
    : '<div class="empty-state">No friends yet.<br>Share your link to earn 30% commissions!</div>';

  document.getElementById('page-friends').innerHTML = `

    <!-- Referral Link -->
    <div class="card">
      <div class="card-title" data-i18n="yourReferralLink">Your Referral Link</div>
      <div class="referral-link-box">${link}</div>
      <div class="referral-actions">
        <button class="btn btn-outline" onclick="copyReferralLink()">📋 Copy</button>
        <button class="btn btn-gold"    onclick="shareReferralLink()">📤 Invite</button>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-row">
      <div class="stat-box">
        <div class="stat-num">${refs.length}</div>
        <div class="stat-label">Friends</div>
      </div>
      <div class="stat-box">
        <div class="stat-num">${fmtCoins(u.referral_earnings || 0)}</div>
        <div class="stat-label">Earned TR</div>
      </div>
      <div class="stat-box">
        <div class="stat-num" style="color:var(--gold)">${fmtCoins(u.pending_referral || 0)}</div>
        <div class="stat-label">Pending</div>
      </div>
    </div>

    <!-- Pending Claim -->
    <div class="card">
      <div class="card-title">Pending Referral Earnings</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:11px">
        <div>
          <span style="font-family:Orbitron;font-size:22px;color:var(--gold)">${fmtCoins(u.pending_referral||0)}</span>
          <span style="font-size:13px;color:var(--text-muted);margin-left:4px">TR</span>
        </div>
        <button class="btn btn-gold" onclick="claimReferral()" style="width:auto;padding:10px 20px">Claim</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);line-height:1.5">
        You earn <strong style="color:var(--gold)">30%</strong> of all coins your friends earn automatically.
        Claim your pending earnings above.
      </div>
    </div>

    <!-- Friends List -->
    <div class="section-title" data-i18n="friendsList">Friends List</div>
    ${friendsHTML}
  `;

  applyI18n();
}

function copyReferralLink() {
  copyText(refLink());
}

function shareReferralLink() {
  const link = refLink();
  const text = 'Join TRewards — earn TR coins & withdraw as TON! 🚀💰';
  if (tg) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  else    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}`, '_blank');
}

async function claimReferral() {
  try {
    const data = await apiClaimReferral();
    if (data.success) {
      State.user = data.user;
      renderFriends();
      renderHome();
      toast('Referral earnings claimed! 🎉', 'success');
    } else {
      toast(data.error || 'Nothing to claim yet', 'error');
    }
  } catch (err) {
    toast(err.message || 'Claim failed', 'error');
  }
}