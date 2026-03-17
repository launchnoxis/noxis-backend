const express = require('express');
const Joi = require('joi');
const { startVolumeJob, stopVolumeJob, getJobStatus, listJobs, buildBoostBuyTransaction } = require('../services/boost');

const router = express.Router();

// ─── POST /api/boost/volume/start ─────────────────────────────────────────────
router.post('/volume/start', (req, res) => {
  const { error, value } = Joi.object({
    mintAddress: Joi.string().required(),
    ownerWallet: Joi.string().required(),
    dailySolTarget: Joi.number().min(1).max(500).required(),
    frequencyMinutes: Joi.number().min(1).max(60).default(2),
    maxTradeSol: Joi.number().min(0.01).max(10).default(0.5),
  }).validate(req.body);

  if (error) return res.status(400).json({ error: error.details[0].message });

  const job = startVolumeJob(value);
  res.json({ success: true, job });
});

// ─── POST /api/boost/volume/stop/:jobId ───────────────────────────────────────
router.post('/volume/stop/:jobId', (req, res) => {
  const result = stopVolumeJob(req.params.jobId);
  if (result.error) return res.status(404).json(result);
  res.json({ success: true, ...result });
});

// ─── GET /api/boost/volume/status/:jobId ──────────────────────────────────────
router.get('/volume/status/:jobId', (req, res) => {
  const job = getJobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── GET /api/boost/volume/list ───────────────────────────────────────────────
router.get('/volume/list', (req, res) => {
  const jobs = listJobs(req.query.wallet);
  res.json({ jobs });
});

// ─── POST /api/boost/buy ──────────────────────────────────────────────────────
// Build a manual single-buy transaction
router.post('/buy', async (req, res, next) => {
  try {
    const { error, value } = Joi.object({
      buyerWallet: Joi.string().required(),
      mintAddress: Joi.string().required(),
      solAmount: Joi.number().min(0.001).max(10).required(),
      slippageBps: Joi.number().min(100).max(5000).default(1000),
    }).validate(req.body);

    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await buildBoostBuyTransaction(value);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
