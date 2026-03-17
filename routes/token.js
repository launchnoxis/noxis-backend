const express = require('express');
const Joi = require('joi');
const { buildLaunchTransaction } = require('../services/tokenLaunch');
const { sendRawTransaction, confirmTransaction, getSolBalance } = require('../services/solana');

const router = express.Router();

// ─── Validation schemas ───────────────────────────────────────────────────────
const launchSchema = Joi.object({
  creatorWallet: Joi.string().length(44).required(),
  name: Joi.string().min(1).max(32).required(),
  symbol: Joi.string().min(1).max(10).uppercase().required(),
  description: Joi.string().max(500).allow('').default(''),
  imageUrl: Joi.string().uri().allow('').default(''),
  twitter: Joi.string().uri().allow('').default(''),
  telegram: Joi.string().uri().allow('').default(''),
  website: Joi.string().uri().allow('').default(''),
  devBuySol: Joi.number().min(0).max(10).default(0),
  slippageBps: Joi.number().min(100).max(5000).default(500),
});

const submitSchema = Joi.object({
  signedTransaction: Joi.string().required(), // base64
  lastValidBlockHeight: Joi.number().required(),
  mintAddress: Joi.string().required(),
});

// ─── POST /api/token/build ────────────────────────────────────────────────────
// Build an unsigned launch transaction. Returns base64 tx + mint address.
router.post('/build', async (req, res, next) => {
  try {
    const { error, value } = launchSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Check creator has enough SOL
    const balance = await getSolBalance(value.creatorWallet);
    const minRequired = value.devBuySol + 0.05; // 0.05 SOL for fees
    if (balance < minRequired) {
      return res.status(400).json({
        error: `Insufficient SOL. Need at least ${minRequired.toFixed(3)} SOL, wallet has ${balance.toFixed(4)} SOL`,
      });
    }

    const result = await buildLaunchTransaction(value);
    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/token/submit ───────────────────────────────────────────────────
// Submit a signed transaction to the network.
router.post('/submit', async (req, res, next) => {
  try {
    const { error, value } = submitSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const signature = await sendRawTransaction(value.signedTransaction);

    // Confirm asynchronously — return signature immediately
    res.json({
      success: true,
      signature,
      mintAddress: value.mintAddress,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      pumpFunUrl: `https://pump.fun/${value.mintAddress}`,
    });

    // Background confirmation logging
    confirmTransaction(signature, value.lastValidBlockHeight)
      .then(() => console.log(`[token] Confirmed: ${signature}`))
      .catch((err) => console.error(`[token] Confirm error: ${err.message}`));
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/token/status/:signature ────────────────────────────────────────
router.get('/status/:signature', async (req, res, next) => {
  try {
    const { getConnection } = require('../services/solana');
    const connection = getConnection();
    const status = await connection.getSignatureStatus(req.params.signature, {
      searchTransactionHistory: true,
    });
    res.json({
      signature: req.params.signature,
      status: status.value,
      confirmed: status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized',
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/token/info/:mint ────────────────────────────────────────────────
// Fetch token info from pump.fun API
router.get('/info/:mint', async (req, res, next) => {
  try {
    const axios = require('axios');
    const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${req.params.mint}`, {
      timeout: 5000,
    });
    res.json(pumpRes.data);
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Token not found on pump.fun' });
    }
    next(err);
  }
});

module.exports = router;
