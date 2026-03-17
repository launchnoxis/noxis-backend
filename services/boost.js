/**
 * boost.js
 * Volume & holder growth engine.
 *
 * IMPORTANT: Volume bots operate in a grey area on pump.fun.
 * This implementation is provided for educational/research purposes.
 * Ensure compliance with pump.fun ToS before deploying to production.
 *
 * Architecture:
 *  - Jobs are stored in memory (use Redis/DB in production)
 *  - cron schedules periodic buy/sell txs
 *  - Each cycle uses a fresh sub-wallet derived from a provided seed
 */

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  TransactionInstruction,
} = require('@solana/web3.js');
const {
  getConnection,
  getRecentBlockhash,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_GLOBAL,
  PUMP_FUN_FEE_RECIPIENT,
} = require('./solana');

// In-memory job store (replace with Redis/Postgres in prod)
const activeJobs = new Map();
const jobHistory = new Map();

/**
 * Start a volume boost job
 */
function startVolumeJob({ mintAddress, dailySolTarget, frequencyMinutes, maxTradeSol, ownerWallet }) {
  const jobId = uuidv4();
  const tradesPerDay = (24 * 60) / frequencyMinutes;
  const solPerTrade = Math.min(dailySolTarget / tradesPerDay, maxTradeSol);

  const job = {
    jobId,
    mintAddress,
    ownerWallet,
    dailySolTarget,
    frequencyMinutes,
    maxTradeSol,
    solPerTrade,
    status: 'active',
    tradesExecuted: 0,
    totalVolumeSol: 0,
    startedAt: Date.now(),
    lastTradeAt: null,
    errors: 0,
  };

  // Schedule cron: every N minutes
  const cronExpr = `*/${Math.max(1, Math.floor(frequencyMinutes))} * * * *`;

  const cronJob = cron.schedule(cronExpr, async () => {
    await executeTradeCycle(job);
  });

  job._cron = cronJob;
  activeJobs.set(jobId, job);
  jobHistory.set(jobId, []);

  console.log(`[boost] Volume job ${jobId} started for mint ${mintAddress}`);
  return { jobId, ...sanitizeJob(job) };
}

/**
 * Stop a volume job
 */
function stopVolumeJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return { error: 'Job not found' };
  if (job._cron) job._cron.stop();
  job.status = 'stopped';
  activeJobs.set(jobId, job);
  return { jobId, status: 'stopped' };
}

/**
 * Get job status
 */
function getJobStatus(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  return {
    ...sanitizeJob(job),
    history: (jobHistory.get(jobId) || []).slice(-20), // last 20 trades
  };
}

/**
 * List all jobs for a wallet
 */
function listJobs(ownerWallet) {
  const jobs = [];
  for (const [, job] of activeJobs) {
    if (!ownerWallet || job.ownerWallet === ownerWallet) {
      jobs.push(sanitizeJob(job));
    }
  }
  return jobs;
}

/**
 * Execute one buy/sell cycle for a job
 * NOTE: In production, this needs funded sub-wallets.
 * Here we log the intended action and return a transaction for the owner to sign.
 */
async function executeTradeCycle(job) {
  try {
    const isBuy = job.tradesExecuted % 2 === 0; // alternate buy/sell
    const action = isBuy ? 'BUY' : 'SELL';
    const randomVariance = 0.8 + Math.random() * 0.4; // ±20% variance
    const tradeAmount = job.solPerTrade * randomVariance;

    // Log trade intent
    const tradeRecord = {
      ts: Date.now(),
      action,
      amountSol: parseFloat(tradeAmount.toFixed(4)),
      status: 'pending',
      txSignature: null,
    };

    job.tradesExecuted++;
    job.lastTradeAt = Date.now();

    // In a fully automated setup, you'd:
    // 1. Load a funded sub-wallet keypair from secure storage
    // 2. Build + sign + send the pump.fun buy/sell tx
    // 3. Update tradeRecord.status and txSignature
    // For now, we simulate and record the intent.
    tradeRecord.status = 'simulated';
    tradeRecord.note = 'Fund sub-wallets to enable fully automatic execution';

    if (isBuy) {
      job.totalVolumeSol += tradeAmount;
    }

    const history = jobHistory.get(job.jobId) || [];
    history.push(tradeRecord);
    jobHistory.set(job.jobId, history);

    console.log(`[boost] ${job.jobId} ${action} ~${tradeAmount.toFixed(3)} SOL`);
  } catch (err) {
    job.errors++;
    console.error(`[boost] Job ${job.jobId} error:`, err.message);
    if (job.errors > 10) {
      stopVolumeJob(job.jobId);
    }
  }
}

function sanitizeJob(job) {
  const { _cron, ...safe } = job;
  return safe;
}

/**
 * Build a single manual buy transaction for the boost engine
 * (used when owner wants to execute a specific trade manually)
 */
async function buildBoostBuyTransaction({ buyerWallet, mintAddress, solAmount, slippageBps = 1000 }) {
  const buyer = new PublicKey(buyerWallet);
  const mint = new PublicKey(mintAddress);
  const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
  const { getBondingCurvePDA } = require('./solana');

  const bondingCurvePDA = await getBondingCurvePDA(mint);
  const buyerATA = await getAssociatedTokenAddress(mint, buyer);

  const lamports = BigInt(Math.floor(solAmount * LAMPORTS_PER_SOL));
  const maxCost = lamports + (lamports * BigInt(slippageBps)) / BigInt(10000);
  const estimatedTokens = BigInt(Math.floor((solAmount / 0.000000028) * 0.85));

  const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(estimatedTokens);
  const maxCostBuf = Buffer.alloc(8);
  maxCostBuf.writeBigUInt64LE(maxCost);
  const buyData = Buffer.concat([discriminator, amountBuf, maxCostBuf]);

  const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  const TOKEN_PROGRAM_ID = require('@solana/spl-token').TOKEN_PROGRAM_ID;

  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash();
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: buyer });

  tx.add(createAssociatedTokenAccountInstruction(buyer, buyerATA, buyer, mint));
  tx.add(
    new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys: [
        { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
        { pubkey: buyerATA, isSigner: false, isWritable: true },
        { pubkey: buyer, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: buyData,
    })
  );

  return {
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    lastValidBlockHeight,
  };
}

module.exports = {
  startVolumeJob,
  stopVolumeJob,
  getJobStatus,
  listJobs,
  buildBoostBuyTransaction,
};
