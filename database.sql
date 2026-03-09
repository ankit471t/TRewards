CREATE TABLE users(
id SERIAL PRIMARY KEY,
telegram_id BIGINT UNIQUE,
username TEXT,
coins BIGINT DEFAULT 0,
spins INT DEFAULT 0,
streak INT DEFAULT 0,
referrer_id BIGINT,
referral_earnings BIGINT DEFAULT 0,
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE tasks(
id SERIAL PRIMARY KEY,
name TEXT,
type TEXT,
url TEXT,
reward INT,
limit_count INT,
completed INT DEFAULT 0,
status TEXT DEFAULT 'active'
);

CREATE TABLE withdrawals(
id SERIAL PRIMARY KEY,
user_id BIGINT,
tr_amount BIGINT,
ton_amount FLOAT,
status TEXT DEFAULT 'pending',
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE promo_codes(
id SERIAL PRIMARY KEY,
code TEXT UNIQUE,
reward INT,
max_uses INT,
used INT DEFAULT 0
);