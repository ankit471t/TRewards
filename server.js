'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV ─────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';  // service_role key
const ADMIN_IDS    = (process.env.ADMIN_IDS||'').split(',').map(Number).filter(Boolean);

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── MIDDLEWARE ───────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','x-telegram-init-data'] }));
app.options('*', (req,res) => res.sendStatus(200));
app.use(express.json());

// ── TELEGRAM AUTH ────────────────────────────────────
// Returns tg user object or null
function parseTgUser(raw) {
  if (!raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash   = params.get('hash');
    params.delete('hash');

    if (BOT_TOKEN && hash && hash !== 'devtest') {
      const sorted = [...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
      const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
      const expect = crypto.createHmac('sha256',secret).update(sorted).digest('hex');
      if (expect !== hash) return null;
    }

    const u = params.get('user');
    if (!u) return null;
    return JSON.parse(u);
  } catch(e) { return null; }
}

function auth(req, res, next) {
  const raw  = req.headers['x-telegram-init-data'] || '';
  const user = parseTgUser(raw);
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
  req.uid  = Number(user.id);   // always a real integer
  req.tgUser = user;
  next();
}

// ── UPSERT USER ──────────────────────────────────────
// Creates user row on first visit, updates on return
async function upsertUser(uid, tgUser) {
  const now = new Date().toISOString();
  // Try insert first
  const { error: insertErr } = await sb.from('users').insert({
    user_id:    uid,
    first_name: tgUser.first_name || '',
    last_name:  tgUser.last_name  || '',
    username:   tgUser.username   || '',
    created_at: now,
    updated_at: now,
  });

  if (insertErr && insertErr.code !== '23505') {
    // 23505 = unique violation = user already exists, that's fine
    throw insertErr;
  }

  // Always update name + updated_at so returning users are refreshed
  await sb.from('users').update({
    first_name: tgUser.first_name || '',
    last_name:  tgUser.last_name  || '',
    username:   tgUser.username   || '',
    updated_at: now,
  }).eq('user_id', uid);

  const { data, error } = await sb.from('users').select('*').eq('user_id', uid).single();
  if (error) throw error;
  return data;
}

// ── ROUTES ───────────────────────────────────────────

app.get('/health', (req,res) => res.json({ ok: true, ts: Date.now() }));

// GET /me — upsert user + return profile
app.get('/me', auth, async (req,res) => {
  try {
    const user = await upsertUser(req.uid, req.tgUser);
    res.json({
      user_id:       user.user_id,
      first_name:    user.first_name,
      coins:         user.coins         || 0,
      spins:         user.spins         || 3,
      streak:        user.streak        || 1,
      ad_balance:    parseFloat(user.ad_balance || 0),
      claimable_ref: user.claimable_ref || 0,
      referral_link: `https://t.me/trewards_ton_bot?start=${user.user_id}`,
    });
  } catch(e) {
    console.error('/me', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /daily-tasks-status
app.get('/daily-tasks-status', auth, async (req,res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const today = new Date().toISOString().slice(0,10);
    const { data } = await sb.from('daily_completions').select('task_name').eq('user_id', req.uid).eq('date', today);
    res.json({ done: (data||[]).map(r=>r.task_name) });
  } catch(e) {
    console.error('/daily-tasks-status', e.message);
    res.json({ done: [] });
  }
});

// POST /claim-streak
app.post('/claim-streak', auth, async (req,res) => {
  try {
    const uid   = req.uid;
    const today = new Date().toISOString().slice(0,10);

    const { data: existing } = await sb.from('daily_completions').select('id').eq('user_id',uid).eq('task_name','streak').eq('date',today).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already claimed today' });

    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins||0) + 10;
    const newSpins = (user.spins||0) + 1;
    const newStreak = Math.min((user.streak||1) + 1, 7);

    await sb.from('users').update({ coins: newCoins, spins: newSpins, streak: newStreak }).eq('user_id', uid);
    await sb.from('daily_completions').insert({ user_id: uid, task_name: 'streak', date: today });
    await sb.from('transactions').insert({ user_id: uid, amount: 10, type: 'streak', description: 'Daily streak reward' });

    res.json({ coins: newCoins, spins: newSpins, streak: newStreak });
  } catch(e) {
    console.error('/claim-streak', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /daily-task
app.post('/daily-task', auth, async (req,res) => {
  try {
    const uid      = req.uid;
    const taskName = req.body.task_name;
    const today    = new Date().toISOString().slice(0,10);
    if (!taskName) return res.status(400).json({ error: 'task_name required' });

    const { data: existing } = await sb.from('daily_completions').select('id').eq('user_id',uid).eq('task_name',taskName).eq('date',today).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already completed today' });

    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins||0) + 10;
    const newSpins = (user.spins||0) + 1;

    await sb.from('users').update({ coins: newCoins, spins: newSpins }).eq('user_id', uid);
    await sb.from('daily_completions').insert({ user_id: uid, task_name: taskName, date: today });
    await sb.from('transactions').insert({ user_id: uid, amount: 10, type: 'daily_task', description: `Daily task: ${taskName}` });

    res.json({ coins: newCoins, spins: newSpins });
  } catch(e) {
    console.error('/daily-task', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /tasks
app.get('/tasks', auth, async (req,res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const { data: tasks } = await sb.from('tasks').select('*').eq('status','active').gt('remaining_limit',0).order('created_at',{ascending:false});
    if (!tasks || !tasks.length) return res.json([]);

    const { data: comps } = await sb.from('task_completions').select('task_id').eq('user_id', req.uid);
    const doneIds = new Set((comps||[]).map(c=>c.task_id));

    res.json(tasks.map(t => ({
      id:              t.id,
      title:           t.title,
      description:     t.description || t.url,
      url:             t.url,
      type:            t.type,
      reward:          t.reward,
      advertiser_name: t.advertiser_name,
      user_status:     doneIds.has(t.id) ? 'done' : 'pending',
    })));
  } catch(e) {
    console.error('/tasks', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /claim-task  (visit / game — timer-based)
app.post('/claim-task', auth, async (req,res) => {
  try {
    const uid    = req.uid;
    const taskId = Number(req.body.task_id);
    if (!taskId) return res.status(400).json({ error: 'task_id required' });

    const { data: existing } = await sb.from('task_completions').select('id').eq('user_id',uid).eq('task_id',taskId).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Already completed' });

    const { data: task } = await sb.from('tasks').select('*').eq('id',taskId).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.remaining_limit <= 0) return res.status(400).json({ error: 'Task is full' });

    const reward   = task.reward;
    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins||0) + reward;
    const newSpins = (user.spins||0) + 1;

    await sb.from('users').update({ coins: newCoins, spins: newSpins }).eq('user_id',uid);
    await sb.from('task_completions').insert({ user_id: uid, task_id: taskId });
    await sb.from('tasks').update({ remaining_limit: task.remaining_limit-1, completed_count: task.completed_count+1 }).eq('id',taskId);
    await sb.from('transactions').insert({ user_id: uid, amount: reward, type: 'task', description: `Task: ${task.title}` });
    await creditReferrer(uid, reward);

    res.json({ coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/claim-task', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /verify-join  — backend calls getChatMember, frontend sends user_id
app.post('/verify-join', auth, async (req,res) => {
  try {
    const uid    = req.uid;
    const taskId = Number(req.body.task_id);
    const chatId = req.body.chat_id;
    if (!taskId || !chatId) return res.status(400).json({ error: 'task_id and chat_id required' });

    const { data: existing } = await sb.from('task_completions').select('id').eq('user_id',uid).eq('task_id',taskId).maybeSingle();
    if (existing) return res.json({ joined: true, already: true });

    const { data: task } = await sb.from('tasks').select('*').eq('id',taskId).single();
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Call Telegram getChatMember (server-side, BOT_TOKEN never exposed to frontend)
    let joined = false;
    if (BOT_TOKEN) {
      try {
        const tgUrl  = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${uid}`;
        const tgResp = await fetch(tgUrl, { signal: AbortSignal.timeout(8000) });
        const tgData = await tgResp.json();
        joined = tgData.ok && ['member','administrator','creator'].includes(tgData.result?.status);
      } catch(e) {
        return res.status(503).json({ error: 'Telegram API unreachable, try again' });
      }
    } else {
      joined = true; // dev mode — no BOT_TOKEN set
    }

    if (!joined) return res.json({ joined: false });

    const reward   = task.reward;
    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins||0) + reward;
    const newSpins = (user.spins||0) + 1;

    await sb.from('users').update({ coins: newCoins, spins: newSpins }).eq('user_id',uid);
    await sb.from('task_completions').insert({ user_id: uid, task_id: taskId });
    await sb.from('tasks').update({ remaining_limit: task.remaining_limit-1, completed_count: task.completed_count+1 }).eq('id',taskId);
    await sb.from('transactions').insert({ user_id: uid, amount: reward, type: 'task', description: `Joined: ${task.title}` });
    await creditReferrer(uid, reward);

    res.json({ joined: true, coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/verify-join', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /spin
app.post('/spin', auth, async (req,res) => {
  try {
    const uid  = req.uid;
    const user = await upsertUser(uid, req.tgUser);
    if ((user.spins||0) <= 0) return res.status(400).json({ error: 'No spins left' });

    // Weighted prizes
    const prizes = [{v:500,w:3},{v:300,w:7},{v:100,w:20},{v:80,w:25},{v:50,w:25},{v:10,w:20}];
    const total  = prizes.reduce((s,p)=>s+p.w, 0);
    let rand = Math.random()*total, reward = 10;
    for (const p of prizes) { rand -= p.w; if (rand <= 0) { reward = p.v; break; } }

    const newCoins = (user.coins||0) + reward;
    const newSpins = (user.spins||0) - 1;

    await sb.from('users').update({ coins: newCoins, spins: newSpins }).eq('user_id',uid);
    await sb.from('transactions').insert({ user_id: uid, amount: reward, type: 'spin', description: `Spin: +${reward} TR` });

    res.json({ coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/spin', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /redeem-promo
app.post('/redeem-promo', auth, async (req,res) => {
  try {
    const uid  = req.uid;
    const code = (req.body.code||'').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code required' });

    const { data: promo } = await sb.from('promo_codes').select('*').eq('code',code).maybeSingle();
    if (!promo)          return res.status(404).json({ error: 'Invalid promo code' });
    if (promo.uses_left <= 0) return res.status(400).json({ error: 'Code expired' });

    const { data: used } = await sb.from('promo_uses').select('id').eq('code',code).eq('user_id',uid).maybeSingle();
    if (used) return res.status(400).json({ error: 'Already used' });

    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins||0) + promo.reward;

    await sb.from('users').update({ coins: newCoins }).eq('user_id',uid);
    await sb.from('promo_codes').update({ uses_left: promo.uses_left-1 }).eq('code',code);
    await sb.from('promo_uses').insert({ code, user_id: uid });
    await sb.from('transactions').insert({ user_id: uid, amount: promo.reward, type: 'promo', description: `Promo: ${code}` });

    res.json({ coins: newCoins, reward: promo.reward });
  } catch(e) {
    console.error('/redeem-promo', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /referrals
app.get('/referrals', auth, async (req,res) => {
  try {
    const uid  = req.uid;
    const user = await upsertUser(uid, req.tgUser);

    const { data: refs } = await sb.from('referrals').select('referee_id,earned_coins').eq('referrer_id',uid);
    if (!refs || !refs.length) return res.json({ friends: [], claimable: user.claimable_ref||0 });

    const refIds = refs.map(r=>r.referee_id);
    const { data: refUsers } = await sb.from('users').select('user_id,first_name,coins').in('user_id',refIds);

    const friends = (refUsers||[]).map(u => {
      const ref = refs.find(r=>r.referee_id===u.user_id);
      return { first_name: u.first_name, coins: u.coins, my_share: ref?.earned_coins||0 };
    });

    res.json({ friends, claimable: user.claimable_ref||0 });
  } catch(e) {
    console.error('/referrals', e.message);
    res.json({ friends: [], claimable: 0 });
  }
});

// POST /claim-referral
app.post('/claim-referral', auth, async (req,res) => {
  try {
    const uid  = req.uid;
    const user = await upsertUser(uid, req.tgUser);
    const amt  = user.claimable_ref||0;
    if (amt <= 0) return res.status(400).json({ error: 'Nothing to claim' });

    const newCoins = (user.coins||0) + amt;
    await sb.from('users').update({ coins: newCoins, claimable_ref: 0 }).eq('user_id',uid);
    await sb.from('transactions').insert({ user_id: uid, amount: amt, type: 'referral_claim', description: 'Referral earnings claimed' });

    res.json({ coins: newCoins, claimed: amt });
  } catch(e) {
    console.error('/claim-referral', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /transactions
app.get('/transactions', auth, async (req,res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const { data } = await sb.from('transactions').select('*').eq('user_id',req.uid).order('created_at',{ascending:false}).limit(50);
    res.json(data||[]);
  } catch(e) {
    res.json([]);
  }
});

// GET /ad-balance
app.get('/ad-balance', auth, async (req,res) => {
  try {
    const user = await upsertUser(req.uid, req.tgUser);
    res.json({ balance_ton: parseFloat(user.ad_balance||0) });
  } catch(e) { res.json({ balance_ton: 0 }); }
});

// POST /create-payment
app.post('/create-payment', auth, async (req,res) => {
  try {
    const uid    = req.uid;
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 0.1) return res.status(400).json({ error: 'Min 0.1 TON' });
    const cents = Math.round(amount*100);
    res.json({
      cryptobot: `https://t.me/arcpay_bot?start=pay_adbalance_${uid}_${cents}`,
      xrocket:   `https://t.me/xrocket?start=pay_${uid}_${cents}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /create-task
app.post('/create-task', auth, async (req,res) => {
  try {
    const uid   = req.uid;
    const { title, type, url, description, total_limit } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'title and url required' });

    const limit  = parseInt(total_limit)||1000;
    const cost   = parseFloat((limit*0.001).toFixed(3));
    const reward = type==='visit' ? 500 : 1000;

    const user = await upsertUser(uid, req.tgUser);
    if (parseFloat(user.ad_balance||0) < cost) return res.status(400).json({ error: `Need ${cost} TON in ad balance` });

    const newBal = parseFloat(((user.ad_balance||0) - cost).toFixed(6));
    await sb.from('users').update({ ad_balance: newBal }).eq('user_id',uid);

    const { data: task, error } = await sb.from('tasks').insert({
      title, url, description: description||url, type,
      reward, total_limit: limit, remaining_limit: limit,
      advertiser_id: uid, advertiser_name: req.tgUser.first_name||'Advertiser',
      status: 'active',
    }).select().single();

    if (error) throw error;
    res.json({ task });
  } catch(e) {
    console.error('/create-task', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /my-tasks
app.get('/my-tasks', auth, async (req,res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const { data } = await sb.from('tasks').select('*').eq('advertiser_id',req.uid).order('created_at',{ascending:false});
    res.json(data||[]);
  } catch(e) { res.json([]); }
});

// POST /withdraw
app.post('/withdraw', auth, async (req,res) => {
  try {
    const uid  = req.uid;
    const opts = {250000:0.10, 500000:0.20, 750000:0.30, 1000000:0.40};
    const ton  = opts[req.body.coins_option];
    if (!ton) return res.status(400).json({ error: 'Invalid option' });

    const user = await upsertUser(uid, req.tgUser);
    if ((user.coins||0) < req.body.coins_option) return res.status(400).json({ error: 'Not enough coins' });

    const newCoins = (user.coins||0) - req.body.coins_option;
    const netTon   = parseFloat((ton - 0.05).toFixed(2));

    await sb.from('users').update({ coins: newCoins }).eq('user_id',uid);
    await sb.from('transactions').insert({ user_id: uid, amount: -req.body.coins_option, type: 'withdrawal', description: `Withdrawal ${ton} TON` });
    await sb.from('withdrawals').insert({ user_id: uid, coins_spent: req.body.coins_option, ton_gross: ton, ton_net: netTon, status: 'pending' });

    res.json({ coins: newCoins, net_ton: netTon });
  } catch(e) {
    console.error('/withdraw', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ArcPay webhook
app.post('/webhook/arcpay', async (req,res) => {
  try {
    res.json({ ok: true });
    const { status, payload } = req.body;
    if (status !== 'paid') return;
    const m = (payload||'').match(/adbalance_(\d+)_(\d+)/);
    if (!m) return;
    const uid = Number(m[1]), ton = Number(m[2])/100;
    const { data: user } = await sb.from('users').select('ad_balance').eq('user_id',uid).single();
    if (!user) return;
    const newBal = parseFloat(((user.ad_balance||0)+ton).toFixed(6));
    await sb.from('users').update({ ad_balance: newBal }).eq('user_id',uid);
  } catch(e) { console.error('webhook', e.message); }
});

// ── REFERRAL COMMISSION ──────────────────────────────
async function creditReferrer(uid, earnedCoins) {
  try {
    const { data: ref } = await sb.from('referrals').select('referrer_id').eq('referee_id',uid).maybeSingle();
    if (!ref) return;
    const bonus = Math.floor(earnedCoins * 0.3);
    if (bonus <= 0) return;
    const { data: referrer } = await sb.from('users').select('claimable_ref').eq('user_id',ref.referrer_id).single();
    if (!referrer) return;
    await sb.from('users').update({ claimable_ref: (referrer.claimable_ref||0)+bonus }).eq('user_id',ref.referrer_id);
  } catch(e) { /* non-fatal */ }
}

// ── START ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TRewards running on :${PORT}`);
  if (!SUPABASE_URL) console.warn('WARNING: SUPABASE_URL not set!');
  if (!SUPABASE_KEY) console.warn('WARNING: SUPABASE_KEY not set!');
  if (!BOT_TOKEN)    console.warn('WARNING: BOT_TOKEN not set (dev mode active)');
});