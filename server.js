'use strict';

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV ──────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN    || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_IDS    = (process.env.ADMIN_IDS||'').split(',').map(Number).filter(Boolean);

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is not set');
  process.exit(1);
}

// ── DATABASE (pg Pool → Supabase PostgreSQL) ─────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function db(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// ── MIDDLEWARE ───────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-telegram-init-data'],
}));
app.options('*', (_req, res) => res.sendStatus(200));
app.use(express.json());

// ── TELEGRAM AUTH ────────────────────────────────────
// Validates Telegram WebApp initData using HMAC-SHA256
// Returns the parsed user object or null
function parseTgUser(raw) {
  if (!raw) return null;
  try {
    // URLSearchParams handles the URL encoding correctly
    const params = new URLSearchParams(raw);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    // Validate HMAC only when BOT_TOKEN is set and this isn't a dev request
    if (BOT_TOKEN && hash !== 'devtest') {
      // data-check-string = params sorted by key, joined with \n
      // NOTE: params.entries() gives decoded values — that's correct for HMAC
      const dataCheckStr = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

      const secretKey  = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckStr).digest('hex');

      if (calculated !== hash) {
        console.warn('HMAC mismatch. data_check_string was:\n' + dataCheckStr.slice(0, 200));
        return null;
      }

      // Reject sessions older than 24 hours
      const authDate = parseInt(params.get('auth_date') || '0', 10);
      if (authDate && Date.now() / 1000 - authDate > 86400) {
        console.warn('initData expired (auth_date too old)');
        return null;
      }
    }

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch(e) {
    console.error('parseTgUser error:', e.message);
    return null;
  }
}

function auth(req, res, next) {
  const raw = req.headers['x-telegram-init-data'] || '';

  if (!raw) {
    return res.status(401).json({ error: 'Missing x-telegram-init-data header' });
  }

  const user = parseTgUser(raw);

  if (!user || !user.id) {
    console.warn('Auth failed. initData (first 150 chars):', raw.slice(0, 150));
    return res.status(401).json({ error: 'Invalid Telegram session. Please close and reopen the app.' });
  }

  req.uid    = Number(user.id);
  req.tgUser = user;
  next();
}

// ── UPSERT USER ──────────────────────────────────────
// INSERT … ON CONFLICT UPDATE — guaranteed atomic, works every time
async function upsertUser(uid, tgUser) {
  const rows = await db(`
    INSERT INTO users (user_id, first_name, last_name, username, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET first_name = EXCLUDED.first_name,
          last_name  = EXCLUDED.last_name,
          username   = EXCLUDED.username,
          updated_at = NOW()
    RETURNING *
  `, [uid, tgUser.first_name||'', tgUser.last_name||'', tgUser.username||'']);
  return rows[0];
}

// ── ROUTES ───────────────────────────────────────────

// Health — no auth required
app.get('/health', async (_req, res) => {
  try {
    await db('SELECT 1');
    res.json({ ok: true, db: 'connected', ts: Date.now() });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /me
app.get('/me', auth, async (req, res) => {
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
    console.error('/me:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /daily-tasks-status
app.get('/daily-tasks-status', auth, async (req, res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const rows = await db(
      `SELECT task_name FROM daily_completions WHERE user_id=$1 AND date=CURRENT_DATE`,
      [req.uid]
    );
    res.json({ done: rows.map(r => r.task_name) });
  } catch(e) {
    console.error('/daily-tasks-status:', e.message);
    res.json({ done: [] });
  }
});

// POST /claim-streak
app.post('/claim-streak', auth, async (req, res) => {
  try {
    const uid = req.uid;

    // Check already claimed today
    const already = await db(
      `SELECT id FROM daily_completions WHERE user_id=$1 AND task_name='streak' AND date=CURRENT_DATE`,
      [uid]
    );
    if (already.length) return res.status(400).json({ error: 'Already claimed today' });

    const user = await upsertUser(uid, req.tgUser);
    const newCoins  = (user.coins  || 0) + 10;
    const newSpins  = (user.spins  || 0) + 1;
    const newStreak = Math.min((user.streak || 1) + 1, 7);

    await db(`UPDATE users SET coins=$1, spins=$2, streak=$3 WHERE user_id=$4`,
             [newCoins, newSpins, newStreak, uid]);
    await db(`INSERT INTO daily_completions (user_id, task_name, date) VALUES ($1,'streak',CURRENT_DATE)`,
             [uid]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,10,'streak','Daily streak reward')`,
             [uid]);

    res.json({ coins: newCoins, spins: newSpins, streak: newStreak });
  } catch(e) {
    console.error('/claim-streak:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /daily-task
app.post('/daily-task', auth, async (req, res) => {
  try {
    const uid      = req.uid;
    const taskName = req.body.task_name;
    if (!taskName) return res.status(400).json({ error: 'task_name required' });

    const already = await db(
      `SELECT id FROM daily_completions WHERE user_id=$1 AND task_name=$2 AND date=CURRENT_DATE`,
      [uid, taskName]
    );
    if (already.length) return res.status(400).json({ error: 'Already completed today' });

    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins || 0) + 10;
    const newSpins = (user.spins || 0) + 1;

    await db(`UPDATE users SET coins=$1, spins=$2 WHERE user_id=$3`, [newCoins, newSpins, uid]);
    await db(`INSERT INTO daily_completions (user_id, task_name, date) VALUES ($1,$2,CURRENT_DATE)`, [uid, taskName]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,10,'daily_task',$2)`,
             [uid, `Daily task: ${taskName}`]);

    res.json({ coins: newCoins, spins: newSpins });
  } catch(e) {
    console.error('/daily-task:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /tasks
app.get('/tasks', auth, async (req, res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const tasks = await db(
      `SELECT * FROM tasks WHERE status='active' AND remaining_limit > 0 ORDER BY created_at DESC`
    );
    if (!tasks.length) return res.json([]);

    const comps = await db(
      `SELECT task_id FROM task_completions WHERE user_id=$1`, [req.uid]
    );
    const doneIds = new Set(comps.map(c => Number(c.task_id)));

    res.json(tasks.map(t => ({
      id:              t.id,
      title:           t.title,
      description:     t.description || t.url,
      url:             t.url,
      type:            t.type,
      reward:          t.reward,
      advertiser_name: t.advertiser_name,
      user_status:     doneIds.has(Number(t.id)) ? 'done' : 'pending',
    })));
  } catch(e) {
    console.error('/tasks:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /claim-task  (visit / game)
app.post('/claim-task', auth, async (req, res) => {
  try {
    const uid    = req.uid;
    const taskId = Number(req.body.task_id);
    if (!taskId) return res.status(400).json({ error: 'task_id required' });

    const already = await db(
      `SELECT id FROM task_completions WHERE user_id=$1 AND task_id=$2`, [uid, taskId]
    );
    if (already.length) return res.status(400).json({ error: 'Already completed' });

    const tasks = await db(`SELECT * FROM tasks WHERE id=$1 AND status='active'`, [taskId]);
    if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
    const task = tasks[0];
    if (task.remaining_limit <= 0) return res.status(400).json({ error: 'Task slots full' });

    const reward   = task.reward;
    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins || 0) + reward;
    const newSpins = (user.spins || 0) + 1;

    await db(`UPDATE users SET coins=$1, spins=$2 WHERE user_id=$3`, [newCoins, newSpins, uid]);
    await db(`INSERT INTO task_completions (user_id, task_id) VALUES ($1,$2)`, [uid, taskId]);
    await db(`UPDATE tasks SET remaining_limit=remaining_limit-1, completed_count=completed_count+1 WHERE id=$1`, [taskId]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'task',$3)`,
             [uid, reward, `Task: ${task.title}`]);
    await creditReferrer(uid, reward);

    res.json({ coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/claim-task:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /verify-join  (channel / group — backend calls getChatMember)
app.post('/verify-join', auth, async (req, res) => {
  try {
    const uid    = req.uid;
    const taskId = Number(req.body.task_id);
    const chatId = req.body.chat_id;
    if (!taskId || !chatId) return res.status(400).json({ error: 'task_id and chat_id required' });

    const already = await db(
      `SELECT id FROM task_completions WHERE user_id=$1 AND task_id=$2`, [uid, taskId]
    );
    if (already.length) return res.json({ joined: true, already: true });

    const tasks = await db(`SELECT * FROM tasks WHERE id=$1`, [taskId]);
    if (!tasks.length) return res.status(404).json({ error: 'Task not found' });
    const task = tasks[0];

    // getChatMember — server-side only
    let joined = false;
    if (BOT_TOKEN) {
      try {
        const url    = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${uid}`;
        const resp   = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data   = await resp.json();
        const valid  = ['member','administrator','creator'];
        joined = data.ok && valid.includes(data.result?.status);
      } catch(e) {
        return res.status(503).json({ error: 'Telegram API timeout, try again' });
      }
    } else {
      joined = true; // dev mode — no BOT_TOKEN
    }

    if (!joined) return res.json({ joined: false });

    const reward   = task.reward;
    const user     = await upsertUser(uid, req.tgUser);
    const newCoins = (user.coins || 0) + reward;
    const newSpins = (user.spins || 0) + 1;

    await db(`UPDATE users SET coins=$1, spins=$2 WHERE user_id=$3`, [newCoins, newSpins, uid]);
    await db(`INSERT INTO task_completions (user_id, task_id) VALUES ($1,$2)`, [uid, taskId]);
    await db(`UPDATE tasks SET remaining_limit=remaining_limit-1, completed_count=completed_count+1 WHERE id=$1`, [taskId]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'task',$3)`,
             [uid, reward, `Joined: ${task.title}`]);
    await creditReferrer(uid, reward);

    res.json({ joined: true, coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/verify-join:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /spin
app.post('/spin', auth, async (req, res) => {
  try {
    const uid  = req.uid;
    const user = await upsertUser(uid, req.tgUser);
    if ((user.spins || 0) <= 0) return res.status(400).json({ error: 'No spins left' });

    // Weighted prizes matching frontend wheel segments
    const prizes = [{v:500,w:3},{v:300,w:7},{v:100,w:20},{v:80,w:25},{v:50,w:25},{v:10,w:20}];
    const total  = prizes.reduce((s,p) => s+p.w, 0);
    let rand = Math.random() * total, reward = 10;
    for (const p of prizes) { rand -= p.w; if (rand <= 0) { reward = p.v; break; } }

    const newCoins = (user.coins || 0) + reward;
    const newSpins = (user.spins || 0) - 1;

    await db(`UPDATE users SET coins=$1, spins=$2 WHERE user_id=$3`, [newCoins, newSpins, uid]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'spin',$3)`,
             [uid, reward, `Spin: +${reward} TR`]);

    res.json({ coins: newCoins, spins: newSpins, reward });
  } catch(e) {
    console.error('/spin:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /redeem-promo
app.post('/redeem-promo', auth, async (req, res) => {
  try {
    const uid  = req.uid;
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'code required' });

    const promos = await db(`SELECT * FROM promo_codes WHERE code=$1`, [code]);
    if (!promos.length)         return res.status(404).json({ error: 'Invalid promo code' });
    if (promos[0].uses_left <= 0) return res.status(400).json({ error: 'Code expired' });

    const used = await db(`SELECT id FROM promo_uses WHERE code=$1 AND user_id=$2`, [code, uid]);
    if (used.length) return res.status(400).json({ error: 'Already used' });

    const user     = await upsertUser(uid, req.tgUser);
    const reward   = promos[0].reward;
    const newCoins = (user.coins || 0) + reward;

    await db(`UPDATE users SET coins=$1 WHERE user_id=$2`, [newCoins, uid]);
    await db(`UPDATE promo_codes SET uses_left=uses_left-1 WHERE code=$1`, [code]);
    await db(`INSERT INTO promo_uses (code, user_id) VALUES ($1,$2)`, [code, uid]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'promo',$3)`,
             [uid, reward, `Promo: ${code}`]);

    res.json({ coins: newCoins, reward });
  } catch(e) {
    console.error('/redeem-promo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /referrals
app.get('/referrals', auth, async (req, res) => {
  try {
    const uid  = req.uid;
    const user = await upsertUser(uid, req.tgUser);

    const refs = await db(
      `SELECT r.referee_id, r.earned_coins, u.first_name, u.coins
       FROM referrals r JOIN users u ON u.user_id=r.referee_id
       WHERE r.referrer_id=$1`, [uid]
    );

    res.json({
      friends:   refs.map(r => ({ first_name: r.first_name, coins: r.coins, my_share: r.earned_coins })),
      claimable: user.claimable_ref || 0,
    });
  } catch(e) {
    console.error('/referrals:', e.message);
    res.json({ friends: [], claimable: 0 });
  }
});

// POST /claim-referral
app.post('/claim-referral', auth, async (req, res) => {
  try {
    const uid  = req.uid;
    const user = await upsertUser(uid, req.tgUser);
    const amt  = user.claimable_ref || 0;
    if (amt <= 0) return res.status(400).json({ error: 'Nothing to claim' });

    const newCoins = (user.coins || 0) + amt;
    await db(`UPDATE users SET coins=$1, claimable_ref=0 WHERE user_id=$2`, [newCoins, uid]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'referral_claim','Referral earnings')`,
             [uid, amt]);

    res.json({ coins: newCoins, claimed: amt });
  } catch(e) {
    console.error('/claim-referral:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /transactions
app.get('/transactions', auth, async (req, res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const rows = await db(
      `SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.uid]
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

// GET /ad-balance
app.get('/ad-balance', auth, async (req, res) => {
  try {
    const user = await upsertUser(req.uid, req.tgUser);
    res.json({ balance_ton: parseFloat(user.ad_balance || 0) });
  } catch(e) { res.json({ balance_ton: 0 }); }
});

// POST /create-payment
app.post('/create-payment', auth, async (req, res) => {
  try {
    const uid    = req.uid;
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 0.1) return res.status(400).json({ error: 'Min 0.1 TON' });
    const cents = Math.round(amount * 100);
    res.json({
      cryptobot: `https://t.me/arcpay_bot?start=pay_adbalance_${uid}_${cents}`,
      xrocket:   `https://t.me/xrocket?start=pay_${uid}_${cents}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /create-task
app.post('/create-task', auth, async (req, res) => {
  try {
    const uid   = req.uid;
    const { title, type, url, description, total_limit } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'title and url required' });

    const limit  = parseInt(total_limit) || 1000;
    const cost   = parseFloat((limit * 0.001).toFixed(3));
    const reward = type === 'visit' ? 500 : 1000;

    const user = await upsertUser(uid, req.tgUser);
    if (parseFloat(user.ad_balance || 0) < cost)
      return res.status(400).json({ error: `Need ${cost} TON in ad balance` });

    const newBal = parseFloat(((user.ad_balance || 0) - cost).toFixed(6));
    await db(`UPDATE users SET ad_balance=$1 WHERE user_id=$2`, [newBal, uid]);

    const tasks = await db(`
      INSERT INTO tasks (title, description, url, type, reward, total_limit, remaining_limit, advertiser_id, advertiser_name, status)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,'active') RETURNING *
    `, [title, description||url, url, type, reward, limit, uid, req.tgUser.first_name||'Advertiser']);

    res.json({ task: tasks[0] });
  } catch(e) {
    console.error('/create-task:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /my-tasks
app.get('/my-tasks', auth, async (req, res) => {
  try {
    await upsertUser(req.uid, req.tgUser);
    const rows = await db(
      `SELECT * FROM tasks WHERE advertiser_id=$1 ORDER BY created_at DESC`, [req.uid]
    );
    res.json(rows);
  } catch(e) { res.json([]); }
});

// POST /withdraw
app.post('/withdraw', auth, async (req, res) => {
  try {
    const uid  = req.uid;
    const map  = {250000:0.10, 500000:0.20, 750000:0.30, 1000000:0.40};
    const ton  = map[req.body.coins_option];
    if (!ton) return res.status(400).json({ error: 'Invalid option' });

    const user = await upsertUser(uid, req.tgUser);
    if ((user.coins || 0) < req.body.coins_option)
      return res.status(400).json({ error: 'Not enough coins' });

    const spent    = req.body.coins_option;
    const netTon   = parseFloat((ton - 0.05).toFixed(2));
    const newCoins = (user.coins || 0) - spent;

    await db(`UPDATE users SET coins=$1 WHERE user_id=$2`, [newCoins, uid]);
    await db(`INSERT INTO transactions (user_id, amount, type, description) VALUES ($1,$2,'withdrawal',$3)`,
             [uid, -spent, `Withdrawal ${ton} TON`]);
    await db(`INSERT INTO withdrawals (user_id, coins_spent, ton_gross, ton_net, status) VALUES ($1,$2,$3,$4,'pending')`,
             [uid, spent, ton, netTon]);

    res.json({ coins: newCoins, net_ton: netTon });
  } catch(e) {
    console.error('/withdraw:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /webhook/arcpay
app.post('/webhook/arcpay', async (req, res) => {
  try {
    res.json({ ok: true });
    const { status, payload } = req.body;
    if (status !== 'paid') return;
    const m = (payload||'').match(/adbalance_(\d+)_(\d+)/);
    if (!m) return;
    const uid = Number(m[1]), ton = Number(m[2]) / 100;
    await db(`UPDATE users SET ad_balance=ad_balance+$1 WHERE user_id=$2`, [ton, uid]);
  } catch(e) { console.error('arcpay webhook:', e.message); }
});

// ── REFERRAL COMMISSION HELPER ───────────────────────
async function creditReferrer(uid, earnedCoins) {
  try {
    const refs = await db(`SELECT referrer_id FROM referrals WHERE referee_id=$1`, [uid]);
    if (!refs.length) return;
    const bonus = Math.floor(earnedCoins * 0.3);
    if (bonus <= 0) return;
    const rid = refs[0].referrer_id;
    await db(`UPDATE users SET claimable_ref=claimable_ref+$1 WHERE user_id=$2`, [bonus, rid]);
    await db(`UPDATE referrals SET earned_coins=earned_coins+$1 WHERE referee_id=$2`, [bonus, uid]);
  } catch(e) { /* non-fatal */ }
}

// ── ERROR HANDLER ────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ error: 'Internal error' });
});

// ── START ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TRewards backend running on :${PORT}`);
  console.log(`DATABASE_URL: ${DATABASE_URL ? 'SET ✓' : 'NOT SET ✗'}`);
  console.log(`BOT_TOKEN:    ${BOT_TOKEN    ? 'SET ✓' : 'not set (dev mode)'}`);
});