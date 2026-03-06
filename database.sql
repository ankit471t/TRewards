-- ═══════════════════════════════════════════════
-- TRewards — Supabase Schema
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════

-- USERS
create table if not exists users (
  id            bigserial primary key,
  telegram_id   text unique not null,
  first_name    text default '',
  last_name     text default '',
  username      text default '',
  coins         integer default 0,
  spins         integer default 3,   -- give 3 free spins on signup
  streak        integer default 1,
  ad_balance    numeric(12,6) default 0,
  claimable_ref integer default 0,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- DAILY COMPLETIONS
create table if not exists daily_completions (
  id          bigserial primary key,
  telegram_id text not null,
  task_name   text not null,
  date        date not null default current_date,
  created_at  timestamptz default now(),
  unique(telegram_id, task_name, date)
);

-- TASKS (advertiser-created)
create table if not exists tasks (
  id               bigserial primary key,
  title            text not null,
  description      text default '',
  url              text not null,
  type             text not null check (type in ('channel','group','game','visit')),
  reward           integer default 1000,
  total_limit      integer default 1000,
  remaining_limit  integer default 1000,
  completed_count  integer default 0,
  advertiser_id    text not null,
  advertiser_name  text default 'Advertiser',
  status           text default 'active' check (status in ('active','paused','completed')),
  created_at       timestamptz default now()
);

-- TASK COMPLETIONS
create table if not exists task_completions (
  id          bigserial primary key,
  telegram_id text not null,
  task_id     bigint not null references tasks(id),
  created_at  timestamptz default now(),
  unique(telegram_id, task_id)
);

-- TRANSACTIONS
create table if not exists transactions (
  id          bigserial primary key,
  telegram_id text not null,
  amount      integer not null,   -- TR coins (positive = credit, negative = debit)
  type        text not null,      -- spin | task | streak | daily_task | referral_claim | promo | withdrawal
  description text default '',
  created_at  timestamptz default now()
);

-- WITHDRAWALS
create table if not exists withdrawals (
  id          bigserial primary key,
  telegram_id text not null,
  coins_spent integer not null,
  ton_gross   numeric(10,4) not null,
  ton_net     numeric(10,4) not null,
  status      text default 'pending',   -- pending | processing | done | failed
  created_at  timestamptz default now()
);

-- REFERRALS
create table if not exists referrals (
  id           bigserial primary key,
  referrer_id  text not null,   -- who invited
  referee_id   text not null unique,   -- who was invited
  earned_coins integer default 0,
  created_at   timestamptz default now()
);

-- PROMO CODES
create table if not exists promo_codes (
  id        bigserial primary key,
  code      text unique not null,
  reward    integer not null default 1000,
  uses_left integer not null default 100,
  created_at timestamptz default now()
);

-- PROMO USES
create table if not exists promo_uses (
  id          bigserial primary key,
  code        text not null,
  telegram_id text not null,
  created_at  timestamptz default now(),
  unique(code, telegram_id)
);

-- ── INDEXES ──────────────────────────────────
create index if not exists idx_daily_completions_user_date on daily_completions(telegram_id, date);
create index if not exists idx_task_completions_user       on task_completions(telegram_id);
create index if not exists idx_transactions_user           on transactions(telegram_id, created_at desc);
create index if not exists idx_referrals_referrer          on referrals(referrer_id);
create index if not exists idx_tasks_active                on tasks(status, remaining_limit);

-- ── SAMPLE PROMO CODE ────────────────────────
insert into promo_codes (code, reward, uses_left)
values ('TREWARDS100', 1000, 999)
on conflict (code) do nothing;

-- ── RLS (disable for service_role key — backend uses service_role) ──
-- If you use anon key, enable RLS and add policies.
-- With service_role key, RLS is bypassed automatically.