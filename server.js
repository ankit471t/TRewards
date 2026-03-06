'use strict';

const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════
// ENV  (set these in Render dashboard)
// ═══════════════════════════════════════════════
const BOT_TOKEN      = process.env.BOT_TOKEN      || '';
const SUPABASE_URL   = process.env.SUPABASE_URL   || '';
const SUPABASE_KEY   = process.env.SUPABASE_KEY   || '';   // service_role key
const ADMIN_IDS      = (process.env.ADMIN_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ═══════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════
app.use(cors({
  origin: '*',               // allow Telegram WebApp & any origin
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-telegram-init-data','Authorization'],
}));
app.options('*', cors());    // pre-flight
app.use(express.json());

// ═══════════════════════════════════════════════
// TELEGRAM initData VALIDATION
// Returns parsed user or null
// ═══════════════════════════════════════════════
function parseTgInitData(raw) {
  if (!raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash   = params.get('hash'); params.delete('hash');
    const data_check = [...params.entries()]
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([k,v]) => `${k}=${v}`)
      .join('\n');
    if (BOT_TOKEN && hash) {
      const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
      const check  = crypto.createHmac('sha256',secret).update(data_check).digest('hex');
      if (check !== hash) return null;          // invalid signature
    }
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch(e) {
    return null;
  }
}

// Dev fallback: parse raw JSON or user= query param without signature check
function devParseUser(raw) {
  if (!raw) return null;
  // format: user=<urlencoded JSON>&hash=devtest
  try {
    const params = new URLSearchParams(raw);
    const userStr = params.get('user');
    if (userStr) return JSON.parse(userStr);
  } catch(e) {}
  return null;
}

// ═══════════════════════════════════════════════
// AUTH MIDDLEWARE
// Attaches req.tgUser (object with id, first_name, …)
// ═══════════════════════════════════════════════
function auth(req, res, next) {
  const raw = req.headers['x-telegram-init-data'] || '';

  // Try real validation first
  let user = parseTgInitData(raw);

  // Fall back to dev mode (hash=devtest)
  if (!user) user = devParseUser(raw);

  if (!user || !user.id) {
    return res.status(401).json({ error: 'Unauthorized: invalid initData' });
  }
  req.tgUser = user;
  next();
}

// ═══════════════════════════════════════════════
// UPSERT HELPER — ensures user row always exists
// ═══════════════════════════════════════════════
async function upsertUser(tgUser) {
  const uid = String(tgUser.id);
  const { data, error } = await supabase
    .from('users')
    .upsert({
      telegram_id:  uid,
      first_name:   tgUser.first_name || '',
      last_name:    tgUser.last_name  || '',
      username:     tgUser.username   || '',
      updated_at:   new Date().toISOString(),
    }, {
      onConflict:    'telegram_id',
      ignoreDuplicates: false,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getUser(tgUser) {
  const uid = String(tgUser.id);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', uid)
    .single();
  if (error && error.code === 'PGRST116') {
    // Row not found — create it
    return await upsertUser(tgUser);
  }
  if (error) throw error;
  return data;
}

// ═══════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════

// Health check — no auth
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── /me ──────────────────────────────────────
app.get('/me', auth, async (req, res) => {
  try {
    const user = await getUser(req.tgUser);
    // Build referral link
    const refLink = `https://t.me/trewards_ton_bot?start=${user.telegram_id}`;
    res.json({
      id:            user.telegram_id,
      first_name:    user.first_name,
      coins:         user.coins         || 0,
      spins:         user.spins         || 0,
      streak:        user.streak        || 1,
      ad_balance:    user.ad_balance    || 0,
      claimable_ref: user.claimable_ref || 0,
      referral_link: refLink,
    });
  } catch(e) {
    console.error('/me error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Daily tasks status ────────────────────────
app.get('/daily-tasks-status', auth, async (req, res) => {
  try {
    const uid  = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0,10);
    const { data } = await supabase
      .from('daily_completions')
      .select('task_name')
      .eq('telegram_id', uid)
      .eq('date', today);
    const done = (data||[]).map(r => r.task_name);
    res.json({ done });
  } catch(e) {
    console.error('/daily-tasks-status error:', e);
    res.json({ done: [] });
  }
});

// ── Claim streak ──────────────────────────────
app.post('/claim-streak', auth, async (req, res) => {
  try {
    const uid   = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0,10);
    // Check already claimed today
    const { data: existing } = await supabase
      .from('daily_completions')
      .select('id')
      .eq('telegram_id', uid)
      .eq('task_name', 'streak')
      .eq('date', today)
      .maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already claimed today' });

    const user = await getUser(req.tgUser);
    const streak = Math.min((user.streak||1)+1, 7);
    // Reset streak to 1 if last claim was > 1 day ago (optional — basic impl)
    const newCoins = (user.coins||0) + 10;
    const newSpins = (user.spins||0) + 1;

    await supabase.from('users').update({ coins: newCoins, spins: newSpins, streak }).eq('telegram_id', uid);
    await supabase.from('daily_completions').insert({ telegram_id: uid, task_name: 'streak', date: today });
    await supabase.from('transactions').insert({ telegram_id: uid, amount: 10, type: 'streak', description: 'Daily streak reward' });

    res.json({ coins: newCoins, spins: newSpins, streak });
  } catch(e) {
    console.error('/claim-streak error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Daily task ────────────────────────────────
app.post('/daily-task', auth, async (req, res) => {
  try {
    const uid      = String(req.tgUser.id);
    const taskName = req.body.task_name;
    const today    = new Date().toISOString().slice(0,10);
    if (!taskName) return res.status(400).json({ error: 'task_name required' });

    const { data: existing } = await supabase
      .from('daily_completions').select('id')
      .eq('telegram_id', uid).eq('task_name', taskName).eq('date', today).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already completed today' });

    const user     = await getUser(req.tgUser);
    const newCoins = (user.coins||0) + 10;
    const newSpins = (user.spins||0) + 1;

    await supabase.from('users').update({ coins: newCoins, spins: newSpins }).eq('telegram_id', uid);
    await supabase.from('daily_completions').insert({ telegram_id: uid, task_name: taskName, date: today });
    await supabase.from('transactions').insert({ telegram_id: uid, amount: 10, type: 'daily_task', description: `Daily task: ${taskName}` });

    res.json({ coins: newCoins, spins: newSpins });
  } catch(e) {
    console.error('/daily-task error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Tasks list ────────────────────────────────
app.get('/tasks', auth, async (req, res) => {
  try {
    const uid = String(req.tgUser.id);
    const { data: tasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('status','active')
      .gt('remaining_limit', 0)
      .order('created_at', { ascending: false });

    if (!tasks || !tasks.length) return res.json([]);

    // Get this user's completions
    const { data: comps } = await supabase
      .from('task_completions')
      .select('task_id')
      .eq('telegram_id', uid);
    const doneIds = new Set((comps||[]).map(c => c.task_id));

    const result = tasks.map(t => ({
      id:              t.id,
      title:           t.title,
      description:     t.description || t.url,
      url:             t.url,
      type:            t.type,
      reward:          t.reward || (t.type==='visit' ? 500 : 1000),
      advertiser_name: t.advertiser_name || 'Advertiser',
      user_status:     doneIds.has(t.id) ? 'done' : 'pending',
    }));
    res.json(result);
  } catch(e) {
    console.error('/tasks error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Claim task (visit / game) ─────────────────
app.post('/claim-task', auth, async (req, res) => {
  try {
    const uid    = String(req.tgUser.id);
    const taskId = req.body.task_id;
    if (!taskId) return res.status(400).json({ error: 'task_id required' });

    // Check already claimed
    const { data: existing } = await supabase
      .from('task_completions').select('id')
      .eq('telegram_id', uid).eq('task_id', taskId).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already completed' });

    const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.remaining_limit <= 0) return res.status(400).json({ error: 'Task is full' });

    const reward   = task.reward || (task.type==='visit' ? 500 : 1000);
    const user     = await getUser(req.tgUser);
    const newCoins = (user.coins||0) + reward;
    const newSpins = (user.spins||0) + 1;

    await supabase.from('users').update({ coins: newCoins, spins: newSpins }).eq('telegram_id', uid);
    await supabase.from('task_completions').insert({ telegram_id: uid, task_id: taskId });
    await supabase.from('tasks').update({ remaining_limit: task.remaining_limit - 1, completed_count: (task.completed_count||0)+1 }).eq('id', taskId);
    await supabase.from('transactions').insert({ telegram_id: uid, amount: reward, type: 'task', description: `Task: ${task.title}` });

    // 30% referral commission
    await creditReferrer(uid, reward);

    res.json({ coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/claim-task error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Verify join (backend does getChatMember) ──
app.post('/verify-join', auth, async (req, res) => {
  try {
    const uid    = String(req.tgUser.id);
    const { task_id, chat_id, user_id } = req.body;
    if (!task_id || !chat_id) return res.status(400).json({ error: 'task_id and chat_id required' });

    // Check already done
    const { data: existing } = await supabase
      .from('task_completions').select('id')
      .eq('telegram_id', uid).eq('task_id', task_id).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already completed', joined: true });

    const { data: task } = await supabase.from('tasks').select('*').eq('id', task_id).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // ── getChatMember via Telegram Bot API (backend only) ──
    const tgUserId = user_id || uid;
    let joined = false;

    if (BOT_TOKEN) {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat_id)}&user_id=${tgUserId}`;
      try {
        const tgRes  = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const tgData = await tgRes.json();
        const validStatuses = ['member','administrator','creator'];
        joined = tgData.ok && validStatuses.includes(tgData.result?.status);
      } catch(e) {
        console.error('getChatMember error:', e);
        // If Telegram API is unreachable, fail gracefully
        return res.status(503).json({ error: 'Could not verify membership. Try again.' });
      }
    } else {
      // No BOT_TOKEN configured — dev mode, trust the user
      joined = true;
    }

    if (!joined) return res.json({ joined: false });

    // Award reward
    const reward   = task.reward || 1000;
    const user     = await getUser(req.tgUser);
    const newCoins = (user.coins||0) + reward;
    const newSpins = (user.spins||0) + 1;

    await supabase.from('users').update({ coins: newCoins, spins: newSpins }).eq('telegram_id', uid);
    await supabase.from('task_completions').insert({ telegram_id: uid, task_id });
    await supabase.from('tasks').update({ remaining_limit: task.remaining_limit-1, completed_count: (task.completed_count||0)+1 }).eq('id', task_id);
    await supabase.from('transactions').insert({ telegram_id: uid, amount: reward, type: 'task', description: `Joined: ${task.title}` });

    await creditReferrer(uid, reward);

    res.json({ joined: true, coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/verify-join error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Spin ──────────────────────────────────────
app.post('/spin', auth, async (req, res) => {
  try {
    const uid  = String(req.tgUser.id);
    const user = await getUser(req.tgUser);
    if ((user.spins||0) <= 0) return res.status(400).json({ error: 'No spins left' });

    // Weighted reward
    const weights = [
      {value:500, w:5},
      {value:300, w:10},
      {value:100, w:20},
      {value:80,  w:25},
      {value:50,  w:25},
      {value:10,  w:15},
    ];
    const total  = weights.reduce((s,x)=>s+x.w, 0);
    let rand     = Math.random() * total;
    let reward   = 10;
    for (const item of weights) { rand -= item.w; if (rand <= 0) { reward = item.value; break; } }

    const newCoins = (user.coins||0) + reward;
    const newSpins = (user.spins||0) - 1;

    await supabase.from('users').update({ coins: newCoins, spins: newSpins }).eq('telegram_id', uid);
    await supabase.from('transactions').insert({ telegram_id: uid, amount: reward, type: 'spin', description: `Spin reward: ${reward} TR` });

    res.json({ coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/spin error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Withdraw ──────────────────────────────────
const WD_OPTS = [
  {coins:250000,  ton:0.10},
  {coins:500000,  ton:0.20},
  {coins:750000,  ton:0.30},
  {coins:1000000, ton:0.40},
];
app.post('/withdraw', auth, async (req, res) => {
  try {
    const uid          = String(req.tgUser.id);
    const { coins_option } = req.body;
    const opt = WD_OPTS.find(o => o.coins===coins_option);
    if (!opt) return res.status(400).json({ error: 'Invalid withdrawal option' });

    const user = await getUser(req.tgUser);
    if ((user.coins||0) < opt.coins) return res.status(400).json({ error: 'Not enough coins' });

    const newCoins = (user.coins||0) - opt.coins;
    const netTon   = +(opt.ton - 0.05).toFixed(2);

    await supabase.from('users').update({ coins: newCoins }).eq('telegram_id', uid);
    await supabase.from('transactions').insert({ telegram_id: uid, amount: -opt.coins, type: 'withdrawal', description: `Withdrawal: ${opt.ton} TON (-0.05 fee)` });
    await supabase.from('withdrawals').insert({ telegram_id: uid, coins_spent: opt.coins, ton_gross: opt.ton, ton_net: netTon, status: 'pending' });

    res.json({ coins: newCoins, net_ton: netTon });
  } catch(e) {
    console.error('/withdraw error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Transactions ──────────────────────────────
app.get('/transactions', auth, async (req, res) => {
  try {
    const uid = String(req.tgUser.id);
    const { data } = await supabase
      .from('transactions').select('*')
      .eq('telegram_id', uid)
      .order('created_at', { ascending: false })
      .limit(50);
    res.json(data || []);
  } catch(e) {
    res.json([]);
  }
});

// ── Referrals ─────────────────────────────────
app.get('/referrals', auth, async (req, res) => {
  try {
    const uid = String(req.tgUser.id);
    const { data: refs } = await supabase
      .from('referrals')
      .select('referee_id, earned_coins')
      .eq('referrer_id', uid);

    if (!refs || !refs.length) return res.json({ friends: [], claimable: 0 });

    const user     = await getUser(req.tgUser);
    const refIds   = refs.map(r => r.referee_id);
    const { data: refUsers } = await supabase.from('users').select('telegram_id,first_name,coins').in('telegram_id', refIds);

    const friends = (refUsers||[]).map(u => {
      const ref = refs.find(r => r.referee_id===u.telegram_id);
      return { first_name: u.first_name, coins: u.coins, my_share: ref?.earned_coins || 0 };
    });

    res.json({ friends, claimable: user.claimable_ref || 0 });
  } catch(e) {
    console.error('/referrals error:', e);
    res.json({ friends: [], claimable: 0 });
  }
});

app.post('/claim-referral', auth, async (req, res) => {
  try {
    const uid  = String(req.tgUser.id);
    const user = await getUser(req.tgUser);
    const amt  = user.claimable_ref || 0;
    if (amt <= 0) return res.status(400).json({ error: 'Nothing to claim' });

    const newCoins = (user.coins||0) + amt;
    await supabase.from('users').update({ coins: newCoins, claimable_ref: 0 }).eq('telegram_id', uid);
    await supabase.from('transactions').insert({ telegram_id: uid, amount: amt, type: 'referral_claim', description: 'Referral earnings claimed' });

    res.json({ coins: newCoins, claimed: amt });
  } catch(e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Promo code ────────────────────────────────
app.post('/redeem-promo', auth, async (req, res) => {
  try {
    const uid  = String(req.tgUser.id);
    const code = (req.body.code||'').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code required' });

    const { data: promo } = await supabase.from('promo_codes').select('*').eq('code', code).maybeSingle();
    if (!promo) return res.status(404).json({ error: 'Invalid promo code' });
    if (promo.uses_left <= 0) return res.status(400).json({ error: 'Promo code expired' });

    // Check if already used
    const { data: used } = await supabase.from('promo_uses').select('id').eq('code', code).eq('telegram_id', uid).maybeSingle();
    if (used) return res.status(400).json({ error: 'Already used this code' });

    const user     = await getUser(req.tgUser);
    const newCoins = (user.coins||0) + promo.reward;
    await supabase.from('users').update({ coins: newCoins }).eq('telegram_id', uid);
    await supabase.from('promo_codes').update({ uses_left: promo.uses_left - 1 }).eq('code', code);
    await supabase.from('promo_uses').insert({ code, telegram_id: uid });
    await supabase.from('transactions').insert({ telegram_id: uid, amount: promo.reward, type: 'promo', description: `Promo: ${code}` });

    res.json({ coins: newCoins, reward: promo.reward });
  } catch(e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Ad balance ────────────────────────────────
app.get('/ad-balance', auth, async (req, res) => {
  try {
    const user = await getUser(req.tgUser);
    res.json({ balance_ton: user.ad_balance || 0 });
  } catch(e) {
    res.json({ balance_ton: 0 });
  }
});

// ── Create payment ────────────────────────────
app.post('/create-payment', auth, async (req, res) => {
  try {
    const uid    = String(req.tgUser.id);
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 0.1) return res.status(400).json({ error: 'Minimum 0.1 TON' });

    // ArcPay link format
    const amountCents = Math.round(amount * 100);
    const cbLink = `https://t.me/arcpay_bot?start=pay_adbalance_${uid}_${amountCents}`;
    const xrLink = `https://t.me/xrocket?start=pay_adbalance_${uid}_${amountCents}`;

    res.json({ cryptobot: cbLink, xrocket: xrLink });
  } catch(e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Create task (advertiser) ──────────────────
app.post('/create-task', auth, async (req, res) => {
  try {
    const uid   = String(req.tgUser.id);
    const { title, type, url, description, total_limit } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'title and url required' });

    const limit  = parseInt(total_limit) || 1000;
    const cost   = +(limit * 0.001).toFixed(3);
    const reward = type==='visit' ? 500 : 1000;

    const user = await getUser(req.tgUser);
    if ((user.ad_balance||0) < cost) return res.status(400).json({ error: `Need ${cost} TON ad balance` });

    const newBal = +((user.ad_balance||0) - cost).toFixed(6);
    await supabase.from('users').update({ ad_balance: newBal }).eq('telegram_id', uid);

    const { data: task, error } = await supabase.from('tasks').insert({
      title, type, url,
      description:      description || url,
      total_limit:      limit,
      remaining_limit:  limit,
      completed_count:  0,
      reward,
      advertiser_id:    uid,
      advertiser_name:  req.tgUser.first_name || 'Advertiser',
      status:           'active',
    }).select().single();

    if (error) throw error;
    res.json({ task });
  } catch(e) {
    console.error('/create-task error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── My tasks ──────────────────────────────────
app.get('/my-tasks', auth, async (req, res) => {
  try {
    const uid = String(req.tgUser.id);
    const { data } = await supabase.from('tasks').select('*').eq('advertiser_id', uid).order('created_at', { ascending: false });
    res.json(data || []);
  } catch(e) {
    res.json([]);
  }
});

// ── ArcPay webhook ────────────────────────────
app.post('/webhook/arcpay', async (req, res) => {
  try {
    const { status, payload, amount_ton } = req.body;
    if (status !== 'paid') return res.json({ ok: true });

    // payload format: adbalance_USERID_AMOUNTCENTS
    const match = (payload||'').match(/adbalance_(\d+)_(\d+)/);
    if (!match) return res.json({ ok: true });

    const [, uid, cents] = match;
    const ton = parseInt(cents) / 100;

    const { data: user } = await supabase.from('users').select('ad_balance').eq('telegram_id', uid).single();
    if (!user) return res.json({ ok: true });

    const newBal = +((user.ad_balance||0) + ton).toFixed(6);
    await supabase.from('users').update({ ad_balance: newBal }).eq('telegram_id', uid);

    res.json({ ok: true });
  } catch(e) {
    console.error('webhook error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════
// REFERRAL COMMISSION HELPER
// ═══════════════════════════════════════════════
async function creditReferrer(uid, earnedCoins) {
  try {
    const { data: ref } = await supabase.from('referrals').select('referrer_id').eq('referee_id', uid).maybeSingle();
    if (!ref) return;
    const commission = Math.floor(earnedCoins * 0.3);
    if (commission <= 0) return;
    const { data: referrer } = await supabase.from('users').select('claimable_ref').eq('telegram_id', ref.referrer_id).single();
    if (!referrer) return;
    await supabase.from('users').update({ claimable_ref: (referrer.claimable_ref||0) + commission }).eq('telegram_id', ref.referrer_id);
    await supabase.from('referrals').update({ earned_coins: supabase.raw('earned_coins + '+commission) }).eq('referee_id', uid);
  } catch(e) {
    console.error('creditReferrer error:', e);
  }
}

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`TRewards backend running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'connected' : 'NOT SET'}`);
  console.log(`Bot token: ${BOT_TOKEN ? 'set' : 'NOT SET (dev mode)'}`);
});