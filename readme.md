# 🏆 TRewards — Telegram Mini App

A gamified rewards and advertising platform for Telegram.
Users earn TR coins by completing tasks, spinning a wheel, maintaining daily streaks, and referring friends.

---

## 📁 Project Structure

```
trewards/
├── frontend/
│   ├── index.html       ← Main app UI
│   ├── styles.css       ← All styles
│   └── app.js           ← All frontend logic
├── backend/
│   ├── server.js        ← Express API + Telegram Bot webhook
│   ├── package.json
│   └── .env.example     ← Copy to .env and fill in values
├── render.yaml          ← Render.com deployment config
└── README.md
```

---

## ⚡ STEP-BY-STEP DEPLOYMENT GUIDE

### STEP 1 — Create Your Telegram Bot

1. Open Telegram → search **@BotFather**
2. Send `/newbot`
3. Enter bot name: `TRewards`
4. Enter username: `trewards_ton_bot`
5. **Save the Bot Token** (looks like `1234567890:ABCdef...`)
6. Send `/setmenubutton` to BotFather → select your bot → enter your frontend URL

---

### STEP 2 — Create Your Private Data Channel

1. In Telegram, create a **new private channel** (e.g. "TRewards Data")
2. Add your bot as **Administrator** to this channel
3. Get the Channel ID:
   - Forward any message from the channel to **@getidsbot**
   - It will show you the ID (e.g. `-1001234567890`)
4. **Save this Channel ID**

---

### STEP 3 — Push Code to GitHub

1. Create a GitHub account if you don't have one
2. Create a new repository: `trewards`
3. Upload all files maintaining the folder structure:
   ```
   trewards/
   ├── frontend/  (index.html, styles.css, app.js)
   ├── backend/   (server.js, package.json)
   └── render.yaml
   ```
4. Commit and push

---

### STEP 4 — Deploy to Render.com

#### Deploy Frontend (Static Site):
1. Go to [render.com](https://render.com) → Sign up/Login
2. Click **New +** → **Static Site**
3. Connect your GitHub repo
4. Settings:
   - **Name:** `trewards-frontend`
   - **Root Directory:** `frontend`
   - **Build Command:** *(leave empty)*
   - **Publish Directory:** `.`
5. Click **Create Static Site**
6. Wait for deploy → **Copy the URL** (e.g. `https://trewards-frontend.onrender.com`)

#### Deploy Backend (Web Service):
1. Click **New +** → **Web Service**
2. Connect same GitHub repo
3. Settings:
   - **Name:** `trewards-backend`
   - **Root Directory:** `backend`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add **Environment Variables** (click "Add Environment Variable"):
   ```
   BOT_TOKEN          = your_bot_token_from_step_1
   DATA_CHANNEL_ID    = your_channel_id_from_step_2
   ADMIN_IDS          = your_telegram_user_id (find via @userinfobot)
   ADMIN_KEY          = any_secret_string_you_choose
   BACKEND_URL        = https://trewards-backend.onrender.com
   WEBAPP_URL         = https://trewards-frontend.onrender.com
   ```
5. Click **Create Web Service**
6. Wait for deploy → **Copy the URL**

---

### STEP 5 — Update Frontend API URL

1. Open `frontend/app.js`
2. Find line: `const API_BASE = 'https://trewards-backend.onrender.com';`
3. Replace with your actual backend URL
4. Commit and push → Render will auto-redeploy

---

### STEP 6 — Set Telegram Webhook

After backend is deployed, open this URL in your browser:
```
https://trewards-backend.onrender.com/set-webhook
```
You should see: `{"ok":true,"result":true,...}`

This connects your bot to the backend.

---

### STEP 7 — Configure Bot Web App Button

1. Go to BotFather → `/mybots` → select `trewards_ton_bot`
2. **Bot Settings** → **Menu Button**
3. Set button URL to your frontend URL:
   `https://trewards-frontend.onrender.com`
4. Set button text: `Open TRewards`

---

### STEP 8 — Test Your Bot

1. Search your bot on Telegram: `@trewards_ton_bot`
2. Send `/start`
3. Tap **🚀 Open TRewards** button
4. The Mini App should open!
5. Check your private data channel — user data should appear

---

### STEP 9 — Admin Panel

1. Find your Telegram User ID:
   - Message **@userinfobot** on Telegram
   - It will show your ID
2. Make sure it's in `ADMIN_IDS` environment variable
3. Send `/amiadminyes` to your bot
4. Admin panel appears with inline keyboard!

---

## 🔧 Admin Commands

| Command | Description |
|---------|-------------|
| `/amiadminyes` | Opens admin panel |
| Create Promo | 3-step wizard to create promo codes |
| List Promos | Shows all active promo codes |
| Delete Promo | Delete a promo code |
| Total Users | Shows user statistics |

---

## 💡 How Data Storage Works

Since you're using **Telegram as the database**:

- Every user gets **one message** in your private channel when they first join
- Every time user data changes (balance, spins, streak, etc.) → that **same message is edited**
- This means you can see all user data in real-time in your channel!
- Message format shows: name, ID, balance, streak, referrals, transactions, etc.

---

## 📢 How to Add Advertiser Balance Manually

Until the top-up system is ready, you credit advertiser balances manually via API:

```bash
curl -X POST https://trewards-backend.onrender.com/admin/add-ad-balance \
  -H "Content-Type: application/json" \
  -d '{"adminKey":"your_admin_key","telegramId":"123456","amount":5.0}'
```

---

## ⚠️ Important Notes

1. **Render Free Tier** — services sleep after 15 min of inactivity. Upgrade to paid for production.
2. **Bot must be admin** in channels/groups for join verification to work.
3. **In-memory storage** — backend restarts clear all data! For production, consider adding Redis or a database. Currently Telegram channel is the write-through backup.
4. **Withdrawal processing** — when a user withdraws, you receive a message in your data channel and must process it manually by sending TON.

---

## 🌐 Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token | `123:ABC...` |
| `DATA_CHANNEL_ID` | Private channel ID | `-1001234567890` |
| `ADMIN_IDS` | Comma-separated admin user IDs | `123456,789012` |
| `ADMIN_KEY` | Secret for admin API | `mysecret123` |
| `BACKEND_URL` | Your backend Render URL | `https://...onrender.com` |
| `WEBAPP_URL` | Your frontend Render URL | `https://...onrender.com` |

---

## 🎯 Features Summary

- ✅ Dark gold futuristic UI (Orbitron + Exo 2 fonts)
- ✅ 4-tab navigation (Home, Tasks, Friends, Wallet)
- ✅ Balance card with TR → TON conversion
- ✅ Daily 7-day streak system (+10 TR +1 spin/day)
- ✅ Canvas spin wheel (6 segments, server-side fairness)
- ✅ Advertiser task system (Visit, Channel, Group, Game)
- ✅ Channel/Group join verification via Telegram API
- ✅ 15s/10s timer for website/game tasks
- ✅ Referral system (30% commission, auto-credit)
- ✅ 4-tier withdrawal system (250K–1M TR → TON)
- ✅ Transaction history
- ✅ Promo code system
- ✅ Advertiser dashboard
- ✅ Admin panel via bot commands
- ✅ English + Russian language support
- ✅ All user data stored in Telegram private channel
- ✅ One message per user, edited on every update