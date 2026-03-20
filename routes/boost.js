const express = require('express');
const Joi = require('joi');
const { startVolumeJob, stopVolumeJob, getJobStatus, listJobs, getSubWallets } = require('../services/boost');

const router = express.Router();

// GET /api/boost/wallets — returns sub-wallet addresses for user to fund
router.get('/wallets', (req, res) => {
  const wallets = getSubWallets();
  res.json({ wallets });
});

// POST /api/boost/volume/start
router.post('/volume/start', (req, res) => {
  try {
    const { error, value } = Joi.object({
      mintAddress:       Joi.string().required(),
      ownerWallet:       Joi.string().required(),
      dailySolTarget:    Joi.number().min(1).max(500).required(),
      frequencyMinutes:  Joi.number().min(1).max(60).default(2),
      maxTradeSol:       Joi.number().min(0.01).max(10).default(0.5),
      userWallets:       Joi.array().items(Joi.string()).max(5).default([]),
    }).validate(req.body);

    if (error) return res.status(400).json({ error: error.details[0].message });

    const job = startVolumeJob(value);
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/boost/volume/stop/:jobId
router.post('/volume/stop/:jobId', (req, res) => {
  const result = stopVolumeJob(req.params.jobId);
  if (result.error) return res.status(404).json(result);
  res.json({ success: true, ...result });
});

// GET /api/boost/volume/status/:jobId
router.get('/volume/status/:jobId', (req, res) => {
  const job = getJobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /api/boost/volume/list
router.get('/volume/list', (req, res) => {
  const jobs = listJobs(req.query.wallet);
  res.json({ jobs });
});

module.exports = router;
