# 🏆 TRewards — Gamified Telegram Mini App

A full-stack, production-ready Telegram Mini App where users earn TR coins through tasks, spins, daily streaks, and referrals — then withdraw as TON cryptocurrency.

---

## 📁 File Structure

```
trewards/
├── index.html          ← Complete frontend (single file Telegram Mini App)
├── server.js           ← Complete backend API (Node.js/Express + SQLite)
├── database.sql        ← Full database schema with indexes, views & triggers
├── bot.js              ← Telegram bot (webhook + admin panel)
├── package.json        ← Dependencies
├── ecosystem.config.js ← PM2 process manager config
├── nginx.conf          ← Production Nginx config
├── .env.example        ← Environment variables template
└── README.md           ← This file
```

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- A server with HTTPS (for Telegram WebApp)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
nano .env
```

Fill in:
- `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `ADMIN_ID` — your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
- `WEBAPP_URL` — your HTTPS domain (e.g. `https://trewards.yourdomain.com`)
- `ADMIN_API_KEY` — random secret for admin REST API

### 3. Start the Backend
```bash
node server.js
```

### 4. Start the Bot
```bash
node bot.js
```

### 5. Set Your Webapp URL
In [@BotFather](https://t.me/BotFather):
```
/newapp → select your bot → set URL to your WEBAPP_URL
```

---

## 🌐 Production Deployment (Ubuntu/VPS)

### Install Node.js 18+
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Install Nginx + Certbot
```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

### Install PM2
```bash
sudo npm install -g pm2
```

### Deploy
```bash
# Clone/upload your files to /var/www/trewards
cd /var/www/trewards
npm install --production
cp .env.example .env && nano .env   # Fill in your values

# Create logs directory
mkdir -p logs

# Start with PM2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # Follow the printed command to auto-start on reboot
```

### Configure Nginx
```bash
sudo cp nginx.conf /etc/nginx/sites-available/trewards
# Edit nginx.conf: replace yourdomain.com with your actual domain
sudo nano /etc/nginx/sites-available/trewards

sudo ln -s /etc/nginx/sites-available/trewards /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com
```

### Register Telegram Webhook
```bash
# Set WEBHOOK_URL=https://yourdomain.com in .env, then:
pm2 restart trewards-bot
# Or manually:
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://yourdomain.com/bot-webhook"
```

---

## 🤖 Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Register + open mini app |
| `/start <referral_id>` | Register with referral |
| `/balance` | Quick balance check |
| `/help` | Show help |
| `/amiadminyes` | Admin panel (admin only) |

### Admin Panel Features
- ➕ Create promo codes (wizard)
- 📋 List all promo codes
- 🗑 Delete/deactivate promo codes
- 📊 Activation history
- 💰 View pending withdrawals
- 👥 User statistics

---

## 🔌 API Endpoints

### User
| Method | Path | Description |
|--------|------|-------------|
| GET | `/me` | Get user profile + balance |
| POST | `/daily-checkin` | Claim daily streak (+10 TR + 1 spin) |
| POST | `/claim-daily-task` | Claim updates/share task |
| POST | `/spin` | Use a spin token |
| POST | `/redeem-promo` | Redeem promo code |

### Tasks
| Method | Path | Description |
|--------|------|-------------|
| GET | `/tasks` | List active tasks |
| POST | `/claim-task` | Claim visit/game task reward |
| POST | `/verify-join` | Verify channel/group join |

### Friends
| Method | Path | Description |
|--------|------|-------------|
| GET | `/friends` | Get friends list + stats |
| POST | `/claim-referral` | Claim pending referral earnings |

### Wallet
| Method | Path | Description |
|--------|------|-------------|
| POST | `/withdraw` | Request withdrawal |
| GET | `/transactions` | Get transaction history |

### Advertiser
| Method | Path | Description |
|--------|------|-------------|
| GET | `/advertiser/dashboard` | Get ad balance + tasks |
| POST | `/create-task` | Publish new task |

### Admin REST (requires `X-Admin-Key` header)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/stats` | Platform stats |
| GET | `/admin/withdrawals` | Pending withdrawals |
| POST | `/admin/withdrawal/:id/complete` | Mark as completed |
| POST | `/admin/withdrawal/:id/reject` | Reject + refund |

---

## 💰 Economics

| Action | Coins | Spins |
|--------|-------|-------|
| Daily check-in | +10 TR | +1 |
| Check for updates | +50 TR | +1 |
| Share with friends | +100 TR | +1 |
| Join channel | +1000 TR | +1 |
| Join group | +1000 TR | +1 |
| Play game bot | +1000 TR | +1 |
| Visit website | +500 TR | +1 |
| Referral commission | 30% of referee's earnings | — |

### Spin Wheel Prizes
| Prize | Probability |
|-------|-------------|
| 10 TR | 40% |
| 50 TR | 25% |
| 80 TR | 15% |
| 100 TR | 12% |
| 300 TR | 5% |
| 500 TR | 3% |

### Withdrawal Tiers
| TR Coins | TON (gross) | Net (after 0.05 fee) |
|----------|-------------|----------------------|
| 250,000 | 0.10 TON | 0.05 TON |
| 500,000 | 0.20 TON | 0.15 TON |
| 750,000 | 0.30 TON | 0.25 TON |
| 1,000,000 | 0.40 TON | 0.35 TON |

---

## 🔒 Security Notes

1. **Authentication**: All API calls require `X-User-Id` header. In production, enable `verifyTelegramData()` in `server.js` for full Telegram WebApp validation.

2. **Rate Limiting**: Install `express-rate-limit` and configure in `server.js` for production.

3. **SQL Injection**: All queries use parameterized statements via `better-sqlite3`.

4. **Admin key**: Use a long random string for `ADMIN_API_KEY`.

5. **Bot webhook**: Consider IP allowlisting for Telegram IPs in nginx.conf.

---

## 📝 Adding Seed Promo Codes

```bash
# Via bot: /amiadminyes → Create Promo Code
# Or via SQLite directly:
sqlite3 trewards.db "INSERT INTO promo_codes (code,reward,max_uses) VALUES ('LAUNCH',500,10000);"
```

---

## 🆘 Troubleshooting

**Bot not responding?**
```bash
pm2 logs trewards-bot
# Check webhook: 
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

**DB locked errors?**
```bash
# Make sure only one process is writing. Single-instance PM2 required for SQLite.
```

**CORS errors in frontend?**
```bash
# Check API_BASE in index.html matches your backend URL exactly.
```