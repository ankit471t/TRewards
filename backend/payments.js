/* ═══════════════════════════════════════
   TREWARDS — PAYMENTS.JS
   xRocket & Crypto Pay Integration
═══════════════════════════════════════ */

'use strict';

const axios = require('axios');
const crypto = require('crypto');

// ── xRocket Pay ───────────────────────────────────────────────────
// Docs: https://pay.xrocket.tg/

async function createXRocketInvoice(telegram_id, amount) {
  const apiToken = process.env.XROCKET_API_TOKEN;
  if (!apiToken) throw new Error('xRocket API token not configured');

  const payload = {
    currency: 'TONCOIN',
    amount: String(amount),
    description: `TRewards top-up for user ${telegram_id}`,
    payload: JSON.stringify({ telegram_id, app: 'trewards' }),
    callbackUrl: `${process.env.WEBHOOK_URL}/payment-webhook/xrocket`,
    expiredIn: 3600, // 1 hour
  };

  const response = await axios.post(
    'https://pay.xrocket.tg/tg-invoices',
    payload,
    {
      headers: {
        'Rocket-Pay-Key': apiToken,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  if (!response.data?.success) {
    throw new Error(response.data?.message || 'xRocket invoice creation failed');
  }

  return {
    invoice_id: String(response.data.data.id),
    payment_url: response.data.data.link,
  };
}

function verifyXRocketWebhook(body, signature) {
  if (!signature) return false;
  const secret = process.env.XROCKET_API_TOKEN;
  if (!secret) return false;
  const data = JSON.stringify(body);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return expected === signature;
}

// ── Crypto Pay (CryptoBot) ────────────────────────────────────────
// Docs: https://help.crypt.bot/crypto-pay-api

async function createCryptoPayInvoice(telegram_id, amount) {
  const apiToken = process.env.CRYPTOPAY_API_TOKEN;
  if (!apiToken) throw new Error('Crypto Pay API token not configured');

  // Use mainnet or testnet
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://pay.crypt.bot/api'
    : 'https://testnet-pay.crypt.bot/api';

  const params = new URLSearchParams({
    asset: 'TON',
    amount: String(amount),
    description: `TRewards top-up for user ${telegram_id}`,
    payload: JSON.stringify({ telegram_id, app: 'trewards' }),
    paid_btn_name: 'openBot',
    paid_btn_url: `https://t.me/${process.env.BOT_USERNAME}`,
    allow_comments: false,
    allow_anonymous: false,
    expires_in: 3600,
  });

  const response = await axios.get(
    `${baseUrl}/createInvoice?${params.toString()}`,
    {
      headers: {
        'Crypto-Pay-API-Token': apiToken,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  if (!response.data?.ok) {
    throw new Error(response.data?.error?.name || 'Crypto Pay invoice creation failed');
  }

  return {
    invoice_id: String(response.data.result.invoice_id),
    payment_url: response.data.result.mini_app_invoice_url || response.data.result.bot_invoice_url,
  };
}

function verifyCryptoPayWebhook(body, signature) {
  if (!signature) return false;
  const token = process.env.CRYPTOPAY_API_TOKEN;
  if (!token) return false;

  const secret = crypto.createHash('sha256').update(token).digest();
  const data = JSON.stringify(body);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return expected === signature;
}

module.exports = {
  createXRocketInvoice,
  createCryptoPayInvoice,
  verifyXRocketWebhook,
  verifyCryptoPayWebhook,
};