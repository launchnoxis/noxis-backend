const express = require('express');
const Joi = require('joi');
const { buildLaunchTransaction } = require('../services/tokenLaunch');
const { logLaunch } = require('../services/db');

const router = express.Router();

const launchSchema = Joi.object({
  creatorWallet: Joi.string().min(32).max(44).required(),
  name: Joi.string().min(1).max(32).required(),
  symbol: Joi.string().min(1).max(10).uppercase().required(),
  description: Joi.string().max(500).allow('').default(''),
  imageUrl: Joi.string().allow('').default(''),
  twitter: Joi.string().allow('').default(''),
  telegram: Joi.string().allow('').default(''),
  website: Joi.string().allow('').default(''),
  devBuySol: Joi.number().min(0).max(10).default(1),
  slippageBps: Joi.number().min(100).max(5000).default(500),
});

// Test endpoint - call this to debug PumpPortal directly
router.get('/test-pumpportal', async (req, res) => {
  try {
    const { Keypair } = require('@solana/web3.js');
    const mintKeypair = Keypair.generate();

    const testBody = {
      publicKey: 'JC7u7ezyKdHy7oPPLj6uHWn7w38jHp6scVDJb6u1egRQ',
      action: 'create',
      tokenMetadata: {
        name: 'Test',
        symbol: 'TEST',
        uri: 'https://ipfs.io/ipfs/QmTGtCqZquSCm8F3nZZhb5iBHVFhbgynfhGpRFKVPZHPCF',
      },
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: 'true',
      amount: 1,
      slippage: 10,
      priorityFee: 0.0005,
      pool: 'pump',
      isMayhemMode: 'false',
    };

    console.log('[test] Sending to PumpPortal:', JSON.stringify(testBody));

    const response = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testBody),
    });

    const text = await response.text();
    console.log('[test] Status:', response.status, 'Body length:', text.length, 'Preview:', text.slice(0, 100));

    res.json({
      status: response.status,
      ok: response.ok,
      bodyLength: text.length,
      bodyPreview: text.slice(0, 200),
      isBase64: /^[A-Za-z0-9+/]+=*$/.test(text.trim()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/build', async (req, res, next) => {
  try {
    const { error, value } = launchSchema.validate(req.body);
    if (error) {
      console.error('[token/build] Validation error:', error.details[0].message);
      return res.status(400).json({ error: error.details[0].message });
    }
    console.log('[token/build] Building for wallet:', value.creatorWallet, 'token:', value.name);
    const result = await buildLaunchTransaction(value);

    // Log to our database — never throws, won't affect launch
    logLaunch({
      mintAddress:   result.mintAddress,
      creatorWallet: value.creatorWallet,
      name:          value.name,
      symbol:        value.symbol,
      features: {
        mintRenounced:   true,
        freezeRenounced: true,
        lpLocked:        value.lpLocked   ?? false,
        devVesting:      value.devVesting ?? false,
        lpLockDuration:  value.lpLockDuration || null,
        vestingMonths:   value.vestingMonths  || null,
      },
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[token/build] Error:', err.message);
    next(err);
  }
});

router.post('/submit', async (req, res) => {
  res.json({ success: true, message: 'Transaction submitted via frontend' });
});

router.get('/info/:mint', async (req, res, next) => {
  try {
    const axios = require('axios');
    const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${req.params.mint}`, { timeout: 5000 });
    res.json(pumpRes.data);
  } catch (err) {
    if (err.response?.status === 404) return res.status(404).json({ error: 'Token not found' });
    next(err);
  }
});

module.exports = router;
