const express = require('express');
const Joi = require('joi');
const { buildLaunchTransaction } = require('../services/tokenLaunch');

const router = express.Router();

const launchSchema = Joi.object({
  creatorWallet: Joi.string().min(32).max(44).required(),
  name: Joi.string().min(1).max(32).required(),
  symbol: Joi.string().min(1).max(10).uppercase().required(),
  description: Joi.string().max(500).allow('').default(''),
  imageUrl: Joi.string().allow('').default(''), // allow base64 or URL or empty
  twitter: Joi.string().allow('').default(''),
  telegram: Joi.string().allow('').default(''),
  website: Joi.string().allow('').default(''),
  devBuySol: Joi.number().min(0).max(10).default(0.1),
  slippageBps: Joi.number().min(100).max(5000).default(500),
});

// POST /api/token/build
router.post('/build', async (req, res, next) => {
  try {
    const { error, value } = launchSchema.validate(req.body);
    if (error) {
      console.error('[token/build] Validation error:', error.details[0].message);
      return res.status(400).json({ error: error.details[0].message });
    }

    console.log('[token/build] Building for wallet:', value.creatorWallet, 'token:', value.name);

    const result = await buildLaunchTransaction(value);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[token/build] Error:', err.message);
    next(err);
  }
});

// POST /api/token/submit
router.post('/submit', async (req, res, next) => {
  try {
    res.json({ success: true, message: 'Transaction submitted via frontend' });
  } catch (err) {
    next(err);
  }
});

// GET /api/token/info/:mint
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
