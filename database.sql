-- ═══════════════════════════════════════════════════════
-- TRewards — Supabase Schema
-- Run entire file in Supabase SQL Editor → Run All
-- ═══════════════════════════════════════════════════════

drop table if exists promo_uses        cascade;
drop table if exists promo_codes       cascade;
drop table if exists referrals         cascade;
drop table if exists withdrawals       cascade;
drop table if exists transactions      cascade;
drop table if exists task_completions  cascade;
drop table if exists tasks             cascade;
drop table if exists daily_completions cascade;
drop table if exists users             cascade;

-- USERS — user_id is the real Telegram integer ID
create table users (
  user_id       bigint primary key,
  first_name    text    not null default '',
  last_name     text             default '',
  username      text             default '',
  coins         integer not null default 0,
  spins         integer not null default 3,
  streak        integer not null default 1,
  ad_balance    numeric(14,6)    default 0,
  claimable_ref integer not null default 0,
  referrer_id   bigint,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- DAILY COMPLETIONS
create table daily_completions (
  id          bigserial primary key,
  user_id     bigint not null,
  task_name   text   not null,
  date        date   not null default current_date,
  unique(user_id, task_name, date)
);

-- TASKS
create table tasks (
  id               bigserial primary key,
  title            text    not null,
  description      text    default '',
  url              text    not null,
  type             text    not null,
  reward           integer not null default 1000,
  total_limit      integer not null default 1000,
  remaining_limit  integer not null default 1000,
  completed_count  integer not null default 0,
  advertiser_id    bigint  not null,
  advertiser_name  text    default 'Advertiser',
  status           text    default 'active',
  created_at       timestamptz default now()
);

-- TASK COMPLETIONS
create table task_completions (
  id          bigserial primary key,
  user_id     bigint  not null,
  task_id     bigint  not null,
  created_at  timestamptz default now(),
  unique(user_id, task_id)
);

-- TRANSACTIONS
create table transactions (
  id          bigserial primary key,
  user_id     bigint  not null,
  amount      integer not null,
  type        text    not null,
  description text    default '',
  created_at  timestamptz default now()
);

-- WITHDRAWALS
create table withdrawals (
  id             bigserial primary key,
  user_id        bigint        not null,
  coins_spent    integer       not null,
  ton_gross      numeric(10,4) not null,
  ton_net        numeric(10,4) not null,
  status         text          default 'pending',
  created_at     timestamptz   default now()
);

-- REFERRALS
create table referrals (
  id            bigserial primary key,
  referrer_id   bigint not null,
  referee_id    bigint not null unique,
  earned_coins  integer default 0,
  created_at    timestamptz default now()
);

-- PROMO CODES
create table promo_codes (
  code       text primary key,
  reward     integer not null default 1000,
  uses_left  integer not null default 100,
  created_at timestamptz default now()
);

-- PROMO USES
create table promo_uses (
  id          bigserial primary key,
  code        text    not null,
  user_id     bigint  not null,
  created_at  timestamptz default now(),
  unique(code, user_id)
);

-- INDEXES
create index on daily_completions(user_id, date);
create index on task_completions(user_id);
create index on transactions(user_id, created_at desc);
create index on referrals(referrer_id);
create index on tasks(status);

-- SAMPLE PROMO
insert into promo_codes (code, reward, uses_left) values ('TREWARDS', 1000, 9999);

-- DISABLE RLS (backend uses service_role key which bypasses RLS anyway)
alter table users              disable row level security;
alter table daily_completions  disable row level security;
alter table tasks              disable row level security;
alter table task_completions   disable row level security;
alter table transactions       disable row level security;
alter table withdrawals        disable row level security;
alter table referrals          disable row level security;
alter table promo_codes        disable row level security;
alter table promo_uses         disable row level security;