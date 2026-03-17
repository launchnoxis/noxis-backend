const express = require('express');
const Joi = require('joi');
const { buildVestingTransaction, calculateVestingSchedule } = require('../services/vesting');

const router = express.Router();

// ─── POST /api/vesting/preview ────────────────────────────────────────────────
// Returns a vesting schedule without building a tx (for UI display)
router.post('/preview', (req, res) => {
  const { error, value } = Joi.object({
    totalTokens: Joi.number().positive().required(),
    cliffDays: Joi.number().min(0).max(365).default(30),
    vestingMonths: Joi.number().min(1).max(36).default(6),
    releaseFrequencyDays: Joi.number().min(1).max(30).default(1),
  }).validate(req.body);

  if (error) return res.status(400).json({ error: error.details[0].message });

  const schedule = calculateVestingSchedule(value);
  res.json({ success: true, ...schedule });
});

// ─── POST /api/vesting/build ──────────────────────────────────────────────────
// Build an unsigned vesting transaction
router.post('/build', async (req, res, next) => {
  try {
    const { error, value } = Joi.object({
      senderWallet: Joi.string().required(),
      recipientWallet: Joi.string().required(),
      mintAddress: Joi.string().required(),
      totalTokens: Joi.number().positive().required(),
      cliffDays: Joi.number().min(0).max(365).default(30),
      vestingMonths: Joi.number().min(1).max(36).default(6),
      releaseFrequencyDays: Joi.number().min(1).max(30).default(1),
    }).validate(req.body);

    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await buildVestingTransaction({
      senderWallet: value.senderWallet,
      recipientWallet: value.recipientWallet,
      mintAddress: value.mintAddress,
      totalTokens: value.totalTokens,
      cliffSeconds: value.cliffDays * 86400,
      vestingSeconds: value.vestingMonths * 30 * 86400,
      releaseFrequency: value.releaseFrequencyDays * 86400,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
