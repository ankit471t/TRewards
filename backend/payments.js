// payments.js — xRocket & CryptoPay Integration
const axios = require('axios');
const crypto = require('crypto');

// ─────────────────────────────────────────────
// xRocket Pay
// ─────────────────────────────────────────────
const XROCKET_BASE = 'https://pay.xrocket.tg';

async function createXRocketInvoice(userId, amount) {
  const payload = {
    currency: 'TON',
    amount: amount.toString(),
    description: `TRewards Top-Up for user ${userId}`,
    payload: JSON.stringify({ user_id: userId, provider: 'xrocket' }),
    expiredIn: 3600, // 1 hour
  };

  const res = await axios.post(`${XROCKET_BASE}/tg-invoices`, payload, {
    headers: {
      'Rocket-Pay-Key': process.env.XROCKET_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!res.data?.success) {
    throw new Error(`xRocket error: ${JSON.stringify(res.data)}`);
  }

  return {
    invoice_id: res.data.data.id,
    payment_url: res.data.data.link,
    amount,
    provider: 'xrocket',
  };
}

function verifyXRocketWebhook(rawBody, signature) {
  const secret = process.env.XROCKET_WEBHOOK_SECRET;
  if (!secret) return true; // Skip if not configured
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

function parseXRocketWebhook(body) {
  // xRocket sends status in body.status
  const { status, id, amount, currency, payload: pl } = body;
  let userPayload = {};
  try { userPayload = JSON.parse(pl || '{}'); } catch {}

  return {
    invoice_id: String(id),
    status: status === 'paid' ? 'paid' : status,
    amount: parseFloat(amount),
    currency,
    user_id: userPayload.user_id,
    provider: 'xrocket',
  };
}

// ─────────────────────────────────────────────
// Crypto Pay (TON-based)
// ─────────────────────────────────────────────
const CRYPTOPAY_BASE = 'https://pay.crypt.bot/api'; // mainnet
// Testnet: https://testnet-pay.crypt.bot/api

async function createCryptoPayInvoice(userId, amount) {
  const res = await axios.post(
    `${CRYPTOPAY_BASE}/createInvoice`,
    {
      asset: 'TON',
      amount: amount.toFixed(9),
      description: `TRewards Top-Up`,
      payload: JSON.stringify({ user_id: userId, provider: 'cryptopay' }),
      expires_in: 3600,
    },
    {
      headers: {
        'Crypto-Pay-API-Token': process.env.CRYPTOPAY_API_TOKEN,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!res.data?.ok) {
    throw new Error(`CryptoPay error: ${JSON.stringify(res.data)}`);
  }

  const inv = res.data.result;
  return {
    invoice_id: String(inv.invoice_id),
    payment_url: inv.bot_invoice_url,
    amount,
    provider: 'cryptopay',
  };
}

function verifyCryptoPayWebhook(rawBody, signature) {
  const secret = crypto
    .createHash('sha256')
    .update(process.env.CRYPTOPAY_API_TOKEN)
    .digest('hex');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

function parseCryptoPayWebhook(body) {
  const { update_type, payload: inv } = body;
  if (update_type !== 'invoice_paid') return null;

  let userPayload = {};
  try { userPayload = JSON.parse(inv.payload || '{}'); } catch {}

  return {
    invoice_id: String(inv.invoice_id),
    status: 'paid',
    amount: parseFloat(inv.amount),
    currency: inv.asset,
    user_id: userPayload.user_id,
    provider: 'cryptopay',
  };
}

module.exports = {
  createXRocketInvoice,
  verifyXRocketWebhook,
  parseXRocketWebhook,
  createCryptoPayInvoice,
  verifyCryptoPayWebhook,
  parseCryptoPayWebhook,
};